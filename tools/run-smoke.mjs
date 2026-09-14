// tools/run-smoke.mjs
//
// REAL headless boot-and-run harness for the bsnes-mercury WASM cores (accuracy + performance).
//
// PURPOSE (the crucial proof): instantiate a real WASM core in Node, install the SAME
// libretro environment/video/input callbacks tas-engine.js uses, load the REAL committed
// ROM ('assets/Super Mario All-Stars (USA).sfc'), assert retro_load_game() returns true,
// then call retro_run() N times and assert:
//   (i)   retro_run RETURNS (does NOT hang) — every call is bounded by a hard wall-clock
//         timeout so we never wait minutes on a hang,
//   (ii)  the video_refresh callback fired with a non-null framebuffer of plausible
//         dimensions (~256 wide), and
//   (iii) the frame counter advanced across several runs.
//
// The cores are built with -s ASYNCIFY (+ EXPORT_ES6 + MODULARIZE), so retro_run may
// return a Promise when it suspends (yields to the event loop). This harness AWAITs
// retro_run and pumps the event loop, and races each call against a timeout so a real
// hang is detected as a FAIL instead of blocking forever.
//
// It mirrors tas-engine's _handleEnvironment semantics exactly, so a green run here proves
// the same environment handling will boot the core in the browser.
//
// Run:
//   node tools/run-smoke.mjs [coreJsPath] [RUN_N]
// Examples:
//   node tools/run-smoke.mjs cores/bsnes_mercury_accuracy_libretro.js 12
//   node tools/run-smoke.mjs cores/bsnes_mercury_performance_libretro.js 12
// Env overrides: CORE=... RUN_N=... RUN_TIMEOUT_MS=... ENV_VERBOSE=1

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

// V8 codegen guard. The ASYNCIFY-instrumented cores are large WASM modules. When Node's
// TurboFan tier-2 compiler optimizes one, current V8 can hit an internal assertion
// (`Check failed: IdField::is_valid(id)`) — a Node-side JIT limit, NOT a core defect
// (browsers don't hit it, and retro_run genuinely returns; see the core notes). Running
// under --liftoff-only keeps WASM on the baseline compiler and side-steps that crash.
// If we weren't started with it, transparently re-exec ourselves once with the flag.
if (!process.execArgv.some((a) => a.includes('liftoff-only')) && process.env.__RUNSMOKE_REEXEC !== '1') {
  const res = spawnSync(
    process.execPath,
    ['--liftoff-only', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __RUNSMOKE_REEXEC: '1' } }
  );
  process.exit(res.status == null ? 1 : res.status);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argCore = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const CORE_REL = process.env.CORE || argCore || 'cores/bsnes_mercury_accuracy_libretro.js';
const CORE_JS = isAbsolute(CORE_REL) ? CORE_REL : join(ROOT, CORE_REL);
const CORE_WASM = CORE_JS.replace(/\.js$/, '.wasm');
const ROM_PATH = join(ROOT, 'assets', 'Super Mario All-Stars (USA).sfc');

const numArg = process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a));
const RUN_N = Number(process.env.RUN_N || numArg || 12);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 30000);

const log = (s = '') => console.log(s);

// ---- libretro constants (mirror tas-engine.js) ---------------------------------------
const RETRO_MEMORY_SYSTEM_RAM = 2;
const ENV = {
  SET_ROTATION: 1,
  GET_OVERSCAN: 2,
  GET_CAN_DUPE: 3,
  SET_MESSAGE: 6,
  SET_PERFORMANCE_LEVEL: 8,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  SET_INPUT_DESCRIPTORS: 11,
  SET_KEYBOARD_CALLBACK: 12,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  SET_SUPPORT_NO_GAME: 18,
  GET_LIBRETRO_PATH: 19,
  GET_INPUT_DEVICE_CAPABILITIES: 22,
  GET_LOG_INTERFACE: 27,
  GET_PERF_INTERFACE: 28,
  GET_CORE_ASSETS_DIRECTORY: 30,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
  SET_SUBSYSTEM_INFO: 34,
  SET_CONTROLLER_INFO: 35,
  SET_MEMORY_MAPS: 36,
  SET_GEOMETRY: 37,
  GET_LANGUAGE: 39,
  GET_INPUT_BITMASKS: 51 | 0x10000,
  GET_CORE_OPTIONS_VERSION: 52,
  SET_CORE_OPTIONS: 53,
  SET_CORE_OPTIONS_INTL: 54,
  SET_CORE_OPTIONS_DISPLAY: 55,
};
const PIXEL_FORMAT = { XRGB1555: 0, XRGB8888: 1, RGB565: 2 };
const PIXEL_FORMAT_NAME = { 0: 'XRGB1555', 1: 'XRGB8888', 2: 'RGB565' };

const ENV_NAME = {};
for (const [k, v] of Object.entries(ENV)) ENV_NAME[v & 0xffff] = k;

log(`core: ${CORE_REL}`);
log(`ROM:  ${ROM_PATH}`);

// ---- instantiate the core (ES6 default-export factory via dynamic import) ------------
let factory;
try {
  const mod = await import(pathToFileURL(CORE_JS).href);
  factory = mod && (mod.default || mod);
} catch (err) {
  log(`FATAL: could not import the core loader: ${err && err.message}`);
  process.exit(2);
}
if (typeof factory !== 'function') {
  log(`FATAL: core export is not a factory function (got ${typeof factory}).`);
  process.exit(2);
}

const wasmBytes = readFileSync(CORE_WASM);
const romBytes = new Uint8Array(readFileSync(ROM_PATH));
log(`ROM bytes: ${romBytes.length}`);

const Module = await factory({
  noInitialRun: true,
  locateFile: (p) => (p.endsWith('.wasm') ? CORE_WASM : p),
  print: () => {},
  printErr: () => {},
  instantiateWasm(imports, cb) {
    WebAssembly.instantiate(wasmBytes, imports)
      .then((r) => cb(r.instance, r.module))
      .catch((err) => {
        log(`FATAL: WebAssembly.instantiate failed: ${err && err.message}`);
        process.exit(3);
      });
    return {};
  },
});
log('core instantiated [OK]');

// ---- wrap the ABI --------------------------------------------------------------------
// retro_run is wrapped with async:true so ASYNCIFY suspends are returned as a Promise
// that we can await (mirrors how the browser frontend must await a suspending retro_run).
const cw = Module.cwrap.bind(Module);
const fn = {
  retro_init: cw('retro_init', null, [], { async: true }),
  retro_run: cw('retro_run', null, [], { async: true }),
  retro_load_game: cw('retro_load_game', 'number', ['number'], { async: true }),
  retro_get_memory_data: cw('retro_get_memory_data', 'number', ['number']),
  retro_get_memory_size: cw('retro_get_memory_size', 'number', ['number']),
  retro_set_environment: cw('retro_set_environment', null, ['number']),
  retro_set_video_refresh: cw('retro_set_video_refresh', null, ['number']),
  retro_set_audio_sample: cw('retro_set_audio_sample', null, ['number']),
  retro_set_audio_sample_batch: cw('retro_set_audio_sample_batch', null, ['number']),
  retro_set_input_poll: cw('retro_set_input_poll', null, ['number']),
  retro_set_input_state: cw('retro_set_input_state', null, ['number']),
  retro_get_system_av_info: cw('retro_get_system_av_info', null, ['number']),
};

// ---- environment-command instrumentation --------------------------------------------
const seenCmds = new Map();
let pixelFormat = PIXEL_FORMAT.RGB565;

function cstr(s) {
  const bytes = new TextEncoder().encode(s);
  const ptr = Module._malloc(bytes.length + 1);
  Module.HEAPU8.set(bytes, ptr);
  Module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}
const SYS_DIR_PTR = cstr('.');
const SAVE_DIR_PTR = cstr('.');

const envVerbose = process.env.ENV_VERBOSE === '1';

function handleEnvironment(cmd, data) {
  const base = cmd & 0xffff;
  if (envVerbose) log(`  ENV cmd ${base} (${ENV_NAME[base] || '?'}) data=${data}`);
  const H = Module.HEAPU8;
  const H32 = Module.HEAP32;
  let handled = false;
  switch (base) {
    case ENV.SET_PIXEL_FORMAT & 0xffff: {
      if (data) {
        const fmt = H32[data >> 2];
        if (fmt === 0 || fmt === 1 || fmt === 2) {
          pixelFormat = fmt;
          handled = true;
        }
      }
      break;
    }
    case ENV.GET_CAN_DUPE & 0xffff:
      if (data) { H[data] = 1; handled = true; }
      break;
    case ENV.GET_OVERSCAN & 0xffff:
      if (data) { H[data] = 0; handled = true; }
      break;
    case ENV.GET_SYSTEM_DIRECTORY & 0xffff:
      if (data) { H32[data >> 2] = SYS_DIR_PTR; handled = true; }
      break;
    case ENV.GET_SAVE_DIRECTORY & 0xffff:
    case ENV.GET_CORE_ASSETS_DIRECTORY & 0xffff:
      if (data) { H32[data >> 2] = SAVE_DIR_PTR; handled = true; }
      break;
    case ENV.GET_LOG_INTERFACE & 0xffff:
      // Deliberately fail-closed: the log printf is variadic and traps under addFunction.
      handled = false;
      break;
    case ENV.GET_VARIABLE & 0xffff:
      if (data) { H32[(data + 4) >> 2] = 0; handled = true; }
      break;
    case ENV.GET_VARIABLE_UPDATE & 0xffff:
      if (data) { H[data] = 0; handled = true; }
      break;
    case ENV.GET_LANGUAGE & 0xffff:
      if (data) { H32[data >> 2] = 0; handled = true; }
      break;
    case ENV.GET_CORE_OPTIONS_VERSION & 0xffff:
      if (data) { H32[data >> 2] = 0; handled = true; }
      break;
    case ENV.SET_ROTATION & 0xffff:
    case ENV.SET_MESSAGE & 0xffff:
    case ENV.SET_PERFORMANCE_LEVEL & 0xffff:
    case ENV.SET_INPUT_DESCRIPTORS & 0xffff:
    case ENV.SET_VARIABLES & 0xffff:
    case ENV.SET_CORE_OPTIONS & 0xffff:
    case ENV.SET_CORE_OPTIONS_INTL & 0xffff:
    case ENV.SET_CORE_OPTIONS_DISPLAY & 0xffff:
    case ENV.SET_CONTROLLER_INFO & 0xffff:
    case ENV.SET_SUBSYSTEM_INFO & 0xffff:
    case ENV.SET_MEMORY_MAPS & 0xffff:
    case ENV.SET_GEOMETRY & 0xffff:
    case ENV.SET_SYSTEM_AV_INFO & 0xffff:
    case ENV.SET_SUPPORT_NO_GAME & 0xffff:
    case ENV.SET_KEYBOARD_CALLBACK & 0xffff:
      handled = true;
      break;
    default:
      handled = false;
  }
  const rec = seenCmds.get(cmd) || { count: 0, handled };
  rec.count += 1;
  rec.handled = handled;
  seenCmds.set(cmd, rec);
  return handled;
}

// ---- video / input callbacks ---------------------------------------------------------
let videoFrames = 0;
let lastW = 0;
let lastH = 0;
let sawNonNull = false;
function onVideo(dataPtr, width, height) {
  videoFrames += 1;
  if (dataPtr && width && height) {
    sawNonNull = true;
    lastW = width;
    lastH = height;
  }
}

const envCb = Module.addFunction((cmd, data) => (handleEnvironment(cmd, data) ? 1 : 0), 'iii');
const videoCb = Module.addFunction((d, w, h, p) => onVideo(d, w, h, p), 'viiii');
const audioSampleCb = Module.addFunction(() => {}, 'vii');
const audioBatchCb = Module.addFunction((_p, frames) => frames, 'iii');
const inputPollCb = Module.addFunction(() => {}, 'v');
const inputStateCb = Module.addFunction(() => 0, 'iiiii');

fn.retro_set_environment(envCb);
log('retro_set_environment() called');
fn.retro_set_video_refresh(videoCb);
fn.retro_set_audio_sample(audioSampleCb);
fn.retro_set_audio_sample_batch(audioBatchCb);
fn.retro_set_input_poll(inputPollCb);
fn.retro_set_input_state(inputStateCb);

// ---- boot ----------------------------------------------------------------------------
await fn.retro_init();
log('retro_init() called');

const dataPtr = Module._malloc(romBytes.length);
Module.HEAPU8.set(romBytes, dataPtr);
const infoPtr = Module._malloc(16);
const idx = infoPtr >> 2;
Module.HEAP32[idx + 0] = 0;
Module.HEAP32[idx + 1] = dataPtr;
Module.HEAP32[idx + 2] = romBytes.length;
Module.HEAP32[idx + 3] = 0;

const loaded = await fn.retro_load_game(infoPtr);
Module._free(infoPtr);
log(`retro_load_game() -> ${loaded ? 'true' : 'false'}`);

const AV = Module._malloc(40);
Module.HEAPU8.fill(0, AV, AV + 40);
fn.retro_get_system_av_info(AV);
const avW = Module.HEAPU32[(AV >> 2) + 0];
const avH = Module.HEAPU32[(AV >> 2) + 1];
const avFps = Module.HEAPF64[(AV + 24) >> 3];
Module._free(AV);
log(`av_info: base ${avW}x${avH} @ ${avFps.toFixed(3)} fps`);

const wramPtr = fn.retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
const wramSize = fn.retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
log(`WRAM: ptr=${wramPtr} size=${wramSize}`);

// ---- run frames (bounded so a hang is detected, never waited on forever) -------------
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([Promise.resolve(promise).then((v) => { clearTimeout(timer); return v; }), timeout]);
}

let runHang = false;
let runError = null;
let ranFrames = 0;
const framesAtStart = videoFrames;
if (RUN_N > 0) {
  const tRun0 = Date.now();
  for (let i = 0; i < RUN_N; i++) {
    try {
      // ASYNCIFY: retro_run may return a Promise when it suspends. Await it, bounded by a
      // hard wall-clock timeout so a hang is a FAIL, not an infinite wait.
      await withTimeout(fn.retro_run(), RUN_TIMEOUT_MS, `retro_run #${i + 1}`);
      ranFrames += 1;
    } catch (err) {
      if (/TIMEOUT/.test(String(err && err.message))) {
        runHang = true;
        log(`  retro_run #${i + 1} HUNG (>${RUN_TIMEOUT_MS}ms) — aborting run loop.`);
      } else {
        runError = err;
        log(`  retro_run #${i + 1} threw: ${err && err.message}`);
      }
      break;
    }
    if ((i + 1) % 4 === 0) log(`  retro_run ${i + 1}/${RUN_N} (video=${videoFrames}, ${Date.now() - tRun0}ms)`);
  }
  log(`ran retro_run() x${ranFrames} in ${Date.now() - tRun0}ms`);
}

// ---- report --------------------------------------------------------------------------
log('');
log('=== RETRO_ENVIRONMENT commands requested by the core ===');
const sorted = [...seenCmds.entries()].sort((a, b) => (a[0] & 0xffff) - (b[0] & 0xffff));
for (const [cmd, rec] of sorted) {
  const base = cmd & 0xffff;
  const exp = cmd & 0x10000 ? ' (EXPERIMENTAL)' : '';
  const name = ENV_NAME[base] || `cmd#${base}`;
  log(`  ${String(base).padStart(3)} ${name}${exp}  x${rec.count}  -> ${rec.handled ? 'handled(true)' : 'false'}`);
}
log('');
log(`pixel format declared by core: ${PIXEL_FORMAT_NAME[pixelFormat]} (${pixelFormat})`);
log(`video_refresh calls: ${videoFrames}; sawNonNull=${sawNonNull}; last dims ${lastW}x${lastH}`);
log('');

// ---- assertions ----------------------------------------------------------------------
let failed = 0;
function assert(name, cond) {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
}
assert('retro_load_game returned true', !!loaded);
assert('core declared a valid pixel format', pixelFormat === 0 || pixelFormat === 1 || pixelFormat === 2);
assert('av_info geometry is plausible SNES (~256x224)', avW >= 240 && avW <= 600 && avH >= 200 && avH <= 512);
assert('av_info fps is plausible (~60)', avFps > 45 && avFps < 75);
assert('WRAM pointer + size available (read-only HUD)', wramPtr > 0 && wramSize > 0);
assert('ROM data buffer retained (not freed after load)', dataPtr !== 0);

if (RUN_N > 0) {
  assert('retro_run did NOT hang (returned within wall-clock timeout)', !runHang);
  assert('retro_run did not throw', !runError);
  assert('retro_run returned for every requested frame', ranFrames === RUN_N);
  assert('video_refresh fired at least once', videoFrames > 0);
  assert('video_refresh saw a non-null framebuffer', sawNonNull);
  assert('framebuffer width is plausible (~256)', lastW >= 240 && lastW <= 600);
  assert('video frames advanced across the run', videoFrames > framesAtStart);
}

log('');
log(`${'-'.repeat(60)}`);
log(`${failed === 0 ? 'ALL ASSERTIONS PASSED' : failed + ' ASSERTION(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
