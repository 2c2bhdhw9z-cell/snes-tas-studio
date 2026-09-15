// tools/leak-profile.mjs
//
// REAL, headless memory-leak PROFILER for the per-frame emulation path.
//
// PURPOSE (turn "likely" into "measured"): boot the REAL snes9x libretro WASM core + the
// REAL committed ROM through the REAL EmuCoreRunner, then run a LONG session driving the
// EXACT per-frame code path the app uses (runner._runOneFrame -> _afterFrame -> _emitHud ->
// readHudValues -> getMemoryView, plus the onVideoFrame decode sink), sampling memory every
// N frames so the FPS-decay hypotheses become numbers:
//
//   * WASM heap size (Module.HEAPU8.byteLength) over time -> a malloc-without-free leak shows
//     as MONOTONIC growth (ALLOW_MEMORY_GROWTH is on for these cores).
//   * JS heap (process.memoryUsage().heapUsed), sampled after an optional global.gc() when the
//     harness is run with --expose-gc -> a per-frame allocation storm shows as churn / growth.
//   * malloc/free BALANCE: Module._malloc / Module._free are wrapped with counters so we can
//     assert frees ~= mallocs in steady state (one-time boot allocs are excluded by snapshotting
//     the counters AFTER boot, before the measured run).
//   * ALLOCATION CHURN in the hot path: getMemoryView is wrapped with a counter so we can prove
//     how many times per frame the per-frame read path builds a fresh frozen view object
//     (BEFORE the fix: once per frame; AFTER the fix: ~0 across the whole run).
//
// This is NOT a pass/fail unit test; it is reproducible EVIDENCE. It prints BEFORE/AFTER-style
// numbers so the fix is measurement-driven. It exits non-zero only if it cannot boot the core.
//
// Run (from repo root):
//   node --expose-gc tools/leak-profile.mjs [coreJsPath] [FRAMES] [SAMPLE_EVERY]
// Examples:
//   node --expose-gc tools/leak-profile.mjs cores/snes9x_libretro.js 6000 500
//   FRAMES=10000 node --expose-gc tools/leak-profile.mjs
//
// The snes9x core is SYNCHRONOUS (no ASYNCIFY), so retro_run returns each frame — we drive it
// tight in a for-loop (no scheduler needed) which is the worst case for per-frame allocation.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { EmuCoreRunner } from '../emu-core-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argCore = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const CORE_REL = process.env.CORE || argCore || 'cores/snes9x_libretro.js';
const CORE_JS = isAbsolute(CORE_REL) ? CORE_REL : join(ROOT, CORE_REL);
const CORE_WASM = CORE_JS.replace(/\.js$/, '.wasm');
const ROM_PATH = join(ROOT, 'assets', 'Super Mario All-Stars (USA).sfc');

const numArgs = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const FRAMES = Number(process.env.FRAMES || numArgs[0] || 6000);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY || numArgs[1] || 500);

const log = (s = '') => console.log(s);

// --- instrumentation counters ----------------------------------------------------------
let mallocCalls = 0;
let freeCalls = 0;
let getMemoryViewCalls = 0; // times getMemoryView() was invoked (per-frame today)
let viewBuilds = 0; // DISTINCT frozen view objects actually constructed (the churn that matters)

// A loadCore that instantiates the REAL snes9x WASM in Node and wraps _malloc/_free so we
// can count allocation calls for the whole run (mirrors run-smoke.mjs instantiation).
async function nodeLoadCore() {
  let factory;
  const mod = await import(pathToFileURL(CORE_JS).href);
  factory = mod && (mod.default || mod);
  if (typeof factory !== 'function') throw new Error('core export is not a factory function');

  const wasmBytes = readFileSync(CORE_WASM);
  const Module = await factory({
    noInitialRun: true,
    locateFile: (p) => (p.endsWith('.wasm') ? CORE_WASM : p),
    print: () => {},
    printErr: () => {},
    instantiateWasm(imports, cb) {
      WebAssembly.instantiate(wasmBytes, imports).then((r) => cb(r.instance, r.module));
      return {};
    },
  });

  // Wrap _malloc/_free with counters. These are the actual C-heap allocation calls; a
  // per-frame malloc-without-free leak shows as mallocCalls climbing faster than freeCalls
  // during the measured (post-boot) window.
  const realMalloc = Module._malloc.bind(Module);
  const realFree = Module._free.bind(Module);
  Module._malloc = (n) => { mallocCalls += 1; return realMalloc(n); };
  Module._free = (p) => { freeCalls += 1; return realFree(p); };

  return { ok: true, Module, corePath: 'cores/snes9x_libretro.js' };
}

async function nodeFetchRom() {
  const bytes = new Uint8Array(readFileSync(ROM_PATH));
  return { ok: true, bytes };
}

// Sinks mirror production: onVideoFrame receives the decoded RGBA (we just note dims, exactly
// like the real present sink does before it blits/transfers — we do NOT retain frames), onHud
// receives the values object each frame (we read a field so the JIT cannot elide it).
let lastHud = null;
let videoFrames = 0;
let lastW = 0;
let lastH = 0;
const runner = new EmuCoreRunner({
  loadCore: nodeLoadCore,
  fetchRom: nodeFetchRom,
  onVideoFrame: (_rgba, w, h) => { videoFrames += 1; lastW = w; lastH = h; },
  onHud: (v) => { lastHud = v; },
  onStatus: () => {},
  onFrame: () => {},
  getFrameInputMask: () => 0,
});

log(`core:   ${CORE_REL}`);
log(`ROM:    ${ROM_PATH}`);
log(`frames: ${FRAMES}  sample-every: ${SAMPLE_EVERY}`);
log(`gc:     ${typeof global.gc === 'function' ? 'available (--expose-gc)' : 'NOT exposed (run with --expose-gc for stable JS-heap numbers)'}`);
log('');

const boot = await runner.boot();
if (!boot.ok) {
  log(`FATAL: boot failed: ${JSON.stringify(boot)}`);
  process.exit(2);
}
log('boot [OK] — core + real ROM loaded');

// Wrap getMemoryView AFTER boot so we count per-frame invocations AND, via identity tracking,
// how many DISTINCT frozen view objects are actually built during the run. Invocations stay
// ~1/frame (readHudValues asks each frame); the number of DISTINCT objects is the real churn:
// BEFORE the fix it equals the invocation count (a fresh object every frame); AFTER the fix it
// is ~1 for the whole run (the cached view is reused).
const realGetMemoryView = runner.getMemoryView.bind(runner);
let lastViewObj = null;
runner.getMemoryView = (...a) => {
  getMemoryViewCalls += 1;
  const v = realGetMemoryView(...a);
  if (v !== lastViewObj) {
    viewBuilds += 1;
    lastViewObj = v;
  }
  return v;
};

function wasmHeapBytes() {
  const M = runner.Module;
  if (M && M.HEAPU8 && M.HEAPU8.byteLength) return M.HEAPU8.byteLength;
  return 0;
}
function jsHeapUsed() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed;
}

// Snapshot counters AFTER boot (exclude all one-time boot allocations from the balance test).
const mallocAtStart = mallocCalls;
const freeAtStart = freeCalls;
const viewsAtStart = getMemoryViewCalls;
const buildsAtStart = viewBuilds;

const wasmHeapStart = wasmHeapBytes();
const jsHeapStart = jsHeapUsed();

const samples = [];
function sample(frame) {
  samples.push({
    frame,
    wasm: wasmHeapBytes(),
    js: jsHeapUsed(),
    malloc: mallocCalls - mallocAtStart,
    free: freeCalls - freeAtStart,
    views: getMemoryViewCalls - viewsAtStart,
    builds: viewBuilds - buildsAtStart,
  });
}

log('');
log('=== per-frame profile (measured window starts AFTER boot) ===');
log('  frame     wasmHeapMB    jsHeapMB   malloc     free     views    builds');

sample(0);
for (let f = 1; f <= FRAMES; f++) {
  // Drive the EXACT production per-frame path: retro_run + _afterFrame(_emitHud+_emitFrame).
  runner._runOneFrame();
  if (f % SAMPLE_EVERY === 0) sample(f);
}
sample(FRAMES);

for (const s of samples) {
  log(
    `  ${String(s.frame).padStart(6)}   ${(s.wasm / 1048576).toFixed(2).padStart(9)}   ${(s.js / 1048576).toFixed(2).padStart(9)}   ${String(s.malloc).padStart(7)}  ${String(s.free).padStart(7)}   ${String(s.views).padStart(7)}  ${String(s.builds).padStart(7)}`
  );
}

const wasmHeapEnd = wasmHeapBytes();
const jsHeapEnd = jsHeapUsed();
const mallocTotal = mallocCalls - mallocAtStart;
const freeTotal = freeCalls - freeAtStart;
const viewsTotal = getMemoryViewCalls - viewsAtStart;
const buildsTotal = viewBuilds - buildsAtStart;

log('');
log('=== summary (steady-state window: boot excluded) ===');
log(`  frames run:              ${FRAMES}`);
log(`  video frames decoded:    ${videoFrames} (last ${lastW}x${lastH})`);
log(`  last HUD hSpeed/x/y:     ${lastHud ? `${lastHud.hSpeed}/${lastHud.x}/${lastHud.y}` : 'n/a'}`);
log('');
log(`  WASM heap start:         ${(wasmHeapStart / 1048576).toFixed(2)} MB`);
log(`  WASM heap end:           ${(wasmHeapEnd / 1048576).toFixed(2)} MB`);
log(`  WASM heap growth:        ${((wasmHeapEnd - wasmHeapStart) / 1048576).toFixed(3)} MB  (${wasmHeapEnd === wasmHeapStart ? 'FLAT' : 'GREW'})`);
log('');
log(`  JS heapUsed start:       ${(jsHeapStart / 1048576).toFixed(2)} MB`);
log(`  JS heapUsed end:         ${(jsHeapEnd / 1048576).toFixed(2)} MB`);
log(`  JS heapUsed delta:       ${((jsHeapEnd - jsHeapStart) / 1048576).toFixed(3)} MB`);
log('');
log(`  malloc calls (post-boot): ${mallocTotal}   (${(mallocTotal / FRAMES).toFixed(4)} per frame)`);
log(`  free   calls (post-boot): ${freeTotal}   (${(freeTotal / FRAMES).toFixed(4)} per frame)`);
log(`  malloc - free balance:    ${mallocTotal - freeTotal}  (${mallocTotal === freeTotal ? 'BALANCED' : 'IMBALANCED'})`);
log('');
log(`  getMemoryView() calls:    ${viewsTotal}   (${(viewsTotal / FRAMES).toFixed(4)} per frame)`);
log(`  DISTINCT views BUILT:     ${buildsTotal}   (${(buildsTotal / FRAMES).toFixed(4)} per frame)  <- the churn that matters`);
log('');
log(`${'-'.repeat(64)}`);
log('NOTE: headless numbers PROVE per-frame allocation behavior; sustained-60-on-device');
log('is the final judge. Compare these numbers before vs after the fix.');
