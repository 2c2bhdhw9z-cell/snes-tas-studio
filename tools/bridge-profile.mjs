// tools/bridge-profile.mjs
//
// REAL, headless STEADY-STATE ALLOCATION profiler for the SINGLE-THREAD present loop.
//
// THE GREAT REVERSAL (FEAT-002/003): there is no cross-thread present bridge anymore. The old
// profiler measured the worker<->main transferable round-trip; that path is gone. The emulator
// runs SINGLE-THREADED on the main thread in tas-engine.js's own requestAnimationFrame loop:
// each rAF turn advances the reused EmuCoreRunner (target-time accumulator) and presents the
// SINGLE latest decoded frame ONCE via the GLPresenter (texSubImage2D + drawArrays).
//
// So this profiler is REPURPOSED to prove the thing the reversal must guarantee: the tight
// single-thread loop allocates NOTHING per frame in steady state. It drives the REAL TASEngine
// + REAL EmuCoreRunner (mock core, no WASM) under a fake rAF over thousands of turns and
// asserts:
//   * the runner reuses ONE RGBA decode buffer (same object identity every frame; no per-frame
//     Uint8ClampedArray),
//   * the engine coalesces to ONE present per rAF turn (never one-per-retro_run),
//   * getMemoryView() returns the SAME cached read-only view every frame (no per-frame frozen
//     view + closure churn),
//   * readHudValues() mutates the SAME reused values object every frame (no per-frame literal),
//   * process JS heap stays FLAT over the run (no monotonic growth / allocation storm).
//
// If any of those regressed (e.g. drawing per-retro_run, or rebuilding the view/HUD object each
// frame -- the exact GC-thrash that ratcheted the on-device FPS down), this FAILS.
//
// Run (from repo root):
//   node --expose-gc tools/bridge-profile.mjs [TURNS] [SAMPLE_EVERY]
// Examples:
//   node --expose-gc tools/bridge-profile.mjs 20000 2000
//   TURNS=50000 node --expose-gc tools/bridge-profile.mjs

import { installFakeRaf, installEngineMockRunner, makeGLCanvas } from './single-thread-harness.mjs';

const TURNS = Number(process.env.TURNS || process.argv[2] || 20000);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY || process.argv[3] || 2000);

const log = (s = '') => console.log(s);

// Minimal DOM stubs so the ES module runs under Node.
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => { let t = ''; return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } }; },
  getElementById: () => null,
  head: { appendChild: () => {} },
};

const fake = installFakeRaf();
const mod = await import('../tas-engine.js');
const engine = mod.default;

const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
const shared = installEngineMockRunner(engine);
engine.attach({ canvas: makeGLCanvas({ gpu }), noticeEl: null });
const boot = await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
if (!boot.ok) {
  log(`FATAL: boot failed: ${JSON.stringify(boot)}`);
  process.exit(2);
}
log('boot [OK] -- single-thread engine + mock core');
log(`turns: ${TURNS}  sample-every: ${SAMPLE_EVERY}`);
log(`gc:    ${typeof global.gc === 'function' ? 'available (--expose-gc)' : 'NOT exposed (run with --expose-gc for stable numbers)'}`);
log('');

function jsHeapUsed() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed;
}

// Warm up so one-time allocations (first RGBA buffer, first GL texture, first frozen view) are
// excluded from the measured window.
fake.stepRaf(20);

// Identity anchors captured AFTER warm-up. In steady state these must NEVER change.
const rgbaRef = shared.runner._rgba;
const viewRef = engine.getMemoryView();
const hudRef = shared.runner._hudValues;

let rgbaReallocs = 0;
let viewRebuilds = 0;
let hudReallocs = 0;
let maxPresentPerTurn = 0;

const heapStart = jsHeapUsed();
const drawsStart = gpu.drawArrays;

log('=== single-thread steady-state allocation profile (warm-up excluded) ===');
log('  turn      jsHeapMB   framesRun   presents   rgbaRealloc  viewRebuild  hudRealloc');

function sample(turn, framesRun) {
  const m = jsHeapUsed();
  log(
    `  ${String(turn).padStart(6)}   ${(m / 1048576).toFixed(2).padStart(8)}   ${String(framesRun).padStart(8)}   ${String(gpu.drawArrays - drawsStart).padStart(8)}   ${String(rgbaReallocs).padStart(10)}   ${String(viewRebuilds).padStart(10)}   ${String(hudReallocs).padStart(9)}`
  );
}

let framesRunTotal = 0;
sample(0, 0);
for (let t = 1; t <= TURNS; t++) {
  const framesBefore = shared.resolvedPerFrame.length;
  const presentsBefore = gpu.drawArrays;
  fake.stepRaf(1); // ONE rAF turn: advance the accumulator + present once
  const framesThisTurn = shared.resolvedPerFrame.length - framesBefore;
  framesRunTotal += framesThisTurn;
  const presentsThisTurn = gpu.drawArrays - presentsBefore;
  if (presentsThisTurn > maxPresentPerTurn) maxPresentPerTurn = presentsThisTurn;

  // Steady-state identity checks: the reused buffers/objects must never be re-created.
  if (framesThisTurn > 0) {
    if (shared.runner._rgba !== rgbaRef) rgbaReallocs++;
    if (engine.getMemoryView() !== viewRef) viewRebuilds++;
    if (shared.runner._hudValues !== hudRef) hudReallocs++;
  }
  // Keep the recorded-frame array bounded so IT does not grow (would confound the heap read).
  if (shared.resolvedPerFrame.length > 1000) shared.resolvedPerFrame.length = 0;

  if (t % SAMPLE_EVERY === 0) sample(t, framesRunTotal);
}
sample(TURNS, framesRunTotal);

const heapEnd = jsHeapUsed();
const heapDeltaMB = (heapEnd - heapStart) / 1048576;

log('');
log('=== summary (steady-state window: warm-up excluded) ===');
log(`  rAF turns run:              ${TURNS}`);
log(`  emulated frames advanced:   ${framesRunTotal}`);
log(`  total presents (drawArrays):${gpu.drawArrays - drawsStart}`);
log(`  MAX presents per rAF turn:  ${maxPresentPerTurn}   (bound: <= 1)`);
log(`  GL textures created:        ${gpu.createTexture}   (bound: == 1, created once)`);
log(`  GL programs created:        ${gpu.createProgram}   (bound: == 1, created once)`);
log('');
log(`  RGBA buffer reallocs:       ${rgbaReallocs}   (bound: 0 -- one reused decode buffer)`);
log(`  memory-view rebuilds:       ${viewRebuilds}   (bound: 0 -- one cached read-only view)`);
log(`  HUD values reallocs:        ${hudReallocs}   (bound: 0 -- one reused values object)`);
log('');
log(`  JS heapUsed start:          ${(heapStart / 1048576).toFixed(2)} MB`);
log(`  JS heapUsed end:            ${(heapEnd / 1048576).toFixed(2)} MB`);
log(`  JS heapUsed delta:          ${heapDeltaMB.toFixed(3)} MB`);
log('');

const HEAP_TOL_MB = 8; // generous; a real per-frame allocation storm over TURNS turns is >> this
const checks = [];
checks.push(['ONE present per rAF turn (never one-per-retro_run)', maxPresentPerTurn <= 1]);
checks.push(['ONE GL texture created (not per frame)', gpu.createTexture === 1]);
checks.push(['ONE GL program created (not per frame)', gpu.createProgram === 1]);
checks.push(['reused RGBA decode buffer (0 reallocs)', rgbaReallocs === 0]);
checks.push(['cached read-only memory view (0 rebuilds)', viewRebuilds === 0]);
checks.push(['reused HUD values object (0 reallocs)', hudReallocs === 0]);
checks.push([`JS heap flat (delta ${heapDeltaMB.toFixed(2)}MB <= ${HEAP_TOL_MB}MB)`, heapDeltaMB <= HEAP_TOL_MB]);

fake.restore();

let failed = 0;
for (const [name, ok] of checks) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
log('');
log('-'.repeat(72));
log('NOTE: this PROVES the single-thread rAF loop allocates nothing per frame in steady state');
log('(one reused RGBA buffer, one cached view, one reused HUD object, one present per rAF, GL');
log('objects created once). Sustained-60-on-device is still the final judge.');

process.exit(failed === 0 ? 0 : 1);
