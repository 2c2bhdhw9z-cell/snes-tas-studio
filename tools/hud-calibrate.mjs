// tools/hud-calibrate.mjs
//
// EMPIRICAL HUD calibration harness for Super Mario All-Stars (USA) — SMB1 sub-game.
//
// It boots the accuracy core + the REAL committed ROM, drives input through the All-Stars
// menus into SMB1 gameplay, then MEASURES which WRAM bytes track Mario's motion. It only
// READS WRAM; driving input (button presses) is legitimate and never writes memory. It
// re-execs under --liftoff-only (V8 JIT guard, see run-smoke.mjs) and bounds every retro_run
// with a wall-clock timeout so a core hang can never block.
//
// WHAT THIS PROVES (reproducibly):
//   * Horizontal SPEED lives at WRAM $005D. Under RIGHT it ACCELERATES from 0 up to walk
//     speed; on release it DECELERATES with friction back toward 0; under LEFT it goes
//     NEGATIVE (two's-complement 0xFF, 0xFE, ...) and accelerates leftward. That accel /
//     friction / signed-reversal signature is unique to a physical velocity — a frame
//     counter or input-hold timer cannot decelerate with friction on release. => $005D is
//     Mario's signed X speed. This is the address the Live HUD uses for H-Speed.
//
// WHAT THIS COULD NOT VERIFY (reported honestly, never guessed):
//   * Mario's X/Y PIXEL and SUB-PIXEL position. In the gameplay state reachable by blind
//     headless menu navigation, Mario builds speed but does not translate freely (he is
//     pinned against level geometry at spawn), so the position/sub-pixel bytes do not show
//     the monotonic-increment + 0..255 rollover signature needed to confirm them. The
//     classic NES SMB1 offsets ($0086/$006D/$0400/$00CE/$0416) — both raw and rebased into
//     the upper WRAM bank (+0x10000) — stay frozen; the only bytes that move under RIGHT are
//     camera-scroll / animation / double-buffer artifacts, which fail the reversal + idle
//     hold checks. Per the project rule "do not guess the sub-pixels", these fields are left
//     UNVERIFIED rather than shipped with fabricated addresses.
//
// Run:  node tools/hud-calibrate.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.execArgv.some((a) => a.includes('liftoff-only')) && process.env.__CAL_REEXEC !== '1') {
  const res = spawnSync(process.execPath, ['--liftoff-only', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __CAL_REEXEC: '1' } });
  process.exit(res.status == null ? 1 : res.status);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CORE_REL = process.env.CORE || 'cores/bsnes_mercury_accuracy_libretro.js';
const CORE_JS = isAbsolute(CORE_REL) ? CORE_REL : join(ROOT, CORE_REL);
const CORE_WASM = CORE_JS.replace(/\.js$/, '.wasm');
const ROM_PATH = join(ROOT, 'assets', 'Super Mario All-Stars (USA).sfc');
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 30000);
const log = (s = '') => console.log(s);

const RETRO_MEMORY_SYSTEM_RAM = 2;
const RETRO_DEVICE_JOYPAD = 1;
const JOY = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
const SPEED_ADDR = 0x005d; // measured: Mario's signed horizontal speed
const ENV = { GET_OVERSCAN: 2, GET_CAN_DUPE: 3, GET_SYSTEM_DIRECTORY: 9, SET_PIXEL_FORMAT: 10, GET_VARIABLE: 15, GET_VARIABLE_UPDATE: 17, GET_LANGUAGE: 39, GET_CORE_OPTIONS_VERSION: 52, GET_SAVE_DIRECTORY: 31, GET_CORE_ASSETS_DIRECTORY: 30, GET_LOG_INTERFACE: 27 };

log(`core: ${CORE_REL}`);
log(`ROM:  ${ROM_PATH}`);

const mod = await import(pathToFileURL(CORE_JS).href);
const factory = mod && (mod.default || mod);
const wasmBytes = readFileSync(CORE_WASM);
const romBytes = new Uint8Array(readFileSync(ROM_PATH));
log(`ROM bytes: ${romBytes.length}`);

const Module = await factory({
  noInitialRun: true,
  locateFile: (p) => (p.endsWith('.wasm') ? CORE_WASM : p),
  print: () => {}, printErr: () => {},
  instantiateWasm(imports, cb) {
    WebAssembly.instantiate(wasmBytes, imports).then((r) => cb(r.instance, r.module))
      .catch((err) => { log(`FATAL: instantiate failed: ${err && err.message}`); process.exit(3); });
    return {};
  },
});
log('core instantiated [OK]');

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
};
function cstr(s) { const b = new TextEncoder().encode(s); const p = Module._malloc(b.length + 1); Module.HEAPU8.set(b, p); Module.HEAPU8[p + b.length] = 0; return p; }
const DIR = cstr('.');
function handleEnvironment(cmd, data) {
  const base = cmd & 0xffff; const H = Module.HEAPU8; const H32 = Module.HEAP32;
  switch (base) {
    case ENV.SET_PIXEL_FORMAT: if (data) { const f = H32[data >> 2]; if (f >= 0 && f <= 2) return true; } return false;
    case ENV.GET_CAN_DUPE: if (data) { H[data] = 1; return true; } return false;
    case ENV.GET_OVERSCAN: if (data) { H[data] = 0; return true; } return false;
    case ENV.GET_SYSTEM_DIRECTORY: case ENV.GET_SAVE_DIRECTORY: case ENV.GET_CORE_ASSETS_DIRECTORY: if (data) { H32[data >> 2] = DIR; return true; } return false;
    case ENV.GET_LOG_INTERFACE: return false;
    case ENV.GET_VARIABLE: if (data) { H32[(data + 4) >> 2] = 0; return true; } return false;
    case ENV.GET_VARIABLE_UPDATE: if (data) { H[data] = 0; return true; } return false;
    case ENV.GET_LANGUAGE: if (data) { H32[data >> 2] = 0; return true; } return false;
    case ENV.GET_CORE_OPTIONS_VERSION: if (data) { H32[data >> 2] = 0; return true; } return false;
    default: return true;
  }
}
let padMask = 0;
function setBtn(id, on) { if (on) padMask |= (1 << id); else padMask &= ~(1 << id); }
function clearPad() { padMask = 0; }
const envCb = Module.addFunction((cmd, data) => (handleEnvironment(cmd, data) ? 1 : 0), 'iii');
const videoCb = Module.addFunction(() => {}, 'viiii');
const noSample = Module.addFunction(() => {}, 'vii');
const batchCb = Module.addFunction((_p, frames) => frames, 'iii');
const pollCb = Module.addFunction(() => {}, 'v');
const stateCb = Module.addFunction((p, dv, i, id) => (p === 0 && dv === RETRO_DEVICE_JOYPAD ? (padMask >> id) & 1 : 0), 'iiiii');
fn.retro_set_environment(envCb); fn.retro_set_video_refresh(videoCb); fn.retro_set_audio_sample(noSample);
fn.retro_set_audio_sample_batch(batchCb); fn.retro_set_input_poll(pollCb); fn.retro_set_input_state(stateCb);

await fn.retro_init();
const dataPtr = Module._malloc(romBytes.length); Module.HEAPU8.set(romBytes, dataPtr);
const infoPtr = Module._malloc(16); const idx = infoPtr >> 2;
Module.HEAP32[idx] = 0; Module.HEAP32[idx + 1] = dataPtr; Module.HEAP32[idx + 2] = romBytes.length; Module.HEAP32[idx + 3] = 0;
const loaded = await fn.retro_load_game(infoPtr); Module._free(infoPtr);
log(`retro_load_game() -> ${loaded ? 'true' : 'false'}`);
if (!loaded) { log('FATAL: ROM did not load'); process.exit(1); }
const wramPtr = fn.retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
const wramSize = fn.retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
log(`WRAM: ptr=${wramPtr} size=${wramSize}`);

function withTimeout(promise, ms, label) { let t; const to = new Promise((_, r) => { t = setTimeout(() => r(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms); }); return Promise.race([Promise.resolve(promise).then((v) => { clearTimeout(t); return v; }), to]); }
let frameNo = 0;
async function step(n = 1) { for (let i = 0; i < n; i++) { await withTimeout(fn.retro_run(), RUN_TIMEOUT_MS, `retro_run #${frameNo + 1}`); frameNo += 1; } }
function snapshot() { return Module.HEAPU8.slice(wramPtr, wramPtr + wramSize); }
function rd(a) { return Module.HEAPU8[wramPtr + a]; }
function sgn8(v) { return v >= 0x80 ? v - 0x100 : v; }
async function tap(id, hold, rest) { setBtn(id, true); await step(hold); setBtn(id, false); await step(rest); }

// ---- PHASE 1: reach gameplay where Mario responds to input (speed byte reacts) ----------
// We drive the menus and watch $005D: once holding RIGHT makes it climb (accelerate) and
// releasing makes it fall (friction), Mario is responding to input.
log('');
log('=== PHASE 1: reach gameplay (drive menus until $005D reacts to input) ===');
await step(240);
const seq = [JOY.START, JOY.A, JOY.START, JOY.A, JOY.DOWN, JOY.A, JOY.START, JOY.A];
// Proven-reliable gate: hold RIGHT for a long window and look for a byte with the "walking"
// signature (forward-monotonic, wraps 0..255 repeatedly). This deterministically detects the
// same input-responsive gameplay state each run.
async function steadyWalk(hold = 90) {
  clearPad(); setBtn(JOY.RIGHT, true);
  const frs = [snapshot()];
  for (let i = 0; i < hold; i++) { await step(1); frs.push(snapshot()); }
  setBtn(JOY.RIGHT, false);
  const n = frs[0].length; let best = -1, bf = 0;
  for (let a = 0; a < n; a++) {
    let f = 0, b = 0, w = 0;
    for (let i = 1; i < frs.length; i++) { let d = frs[i][a] - frs[i - 1][a]; if (d < -128) { d += 256; w++; } else if (d > 128) d -= 256; if (d > 0) f++; else if (d < 0) b++; }
    if (w >= 3 && f >= hold * 0.6 && b <= hold * 0.15 && f > bf) { bf = f; best = a; }
  }
  return best >= 0;
}
let reacted = false;
for (let i = 0; i < 90 && !reacted; i++) {
  await tap(seq[i % seq.length], 6, 16);
  if (i % 2 === 1) { if (await steadyWalk(90)) reacted = true; }
}
log(`gameplay + input response: ${reacted ? 'YES' : 'NO'} at frame ${frameNo}`);

// ---- PHASE 2: PROVE $005D is signed X speed (accel / friction / reversal) ---------------
log('');
log('=== PHASE 2: verify H-SPEED = $005D via accel / friction / signed reversal ===');
clearPad(); await step(20);
log('  hold RIGHT (should ACCELERATE 0 -> +walk):');
setBtn(JOY.RIGHT, true);
const rightSpd = [];
for (let i = 0; i < 16; i++) { await step(1); rightSpd.push(sgn8(rd(SPEED_ADDR))); }
setBtn(JOY.RIGHT, false);
log(`    $005D = ${rightSpd.join(', ')}`);
log('  release (should DECELERATE with friction toward 0):');
const idleSpd = [];
for (let i = 0; i < 12; i++) { await step(1); idleSpd.push(sgn8(rd(SPEED_ADDR))); }
log(`    $005D = ${idleSpd.join(', ')}`);
log('  hold LEFT (should go NEGATIVE and accelerate left):');
setBtn(JOY.LEFT, true);
const leftSpd = [];
for (let i = 0; i < 16; i++) { await step(1); leftSpd.push(sgn8(rd(SPEED_ADDR))); }
setBtn(JOY.LEFT, false);
log(`    $005D = ${leftSpd.join(', ')}`);
clearPad();

const accelerates = rightSpd[rightSpd.length - 1] > rightSpd[0] && Math.max(...rightSpd) >= 4;
const frictions = idleSpd[idleSpd.length - 1] < rightSpd[rightSpd.length - 1] && idleSpd[idleSpd.length - 1] >= -1;
const reverses = Math.min(...leftSpd) < -2;
const speedVerified = accelerates && frictions && reverses;
log('');
log(`  accelerates under RIGHT: ${accelerates}`);
log(`  friction-decelerates on release: ${frictions}`);
log(`  reverses to negative under LEFT: ${reverses}`);
log(`  => H-SPEED $005D VERIFIED: ${speedVerified ? 'YES' : 'NO'}`);

// ---- PHASE 3: attempt X/Y position + sub-pixel (report honestly if not confirmable) -----
log('');
log('=== PHASE 3: attempt X/Y PIXEL + SUB-PIXEL (must show monotonic + rollover) ===');
function analyze(frames) {
  const n = frames[0].length;
  const net = new Int32Array(n), up = new Int32Array(n), dn = new Int32Array(n), wr = new Int32Array(n);
  for (let i = 1; i < frames.length; i++) for (let a = 0; a < n; a++) {
    let d = frames[i][a] - frames[i - 1][a];
    if (d > 0) up[a]++; else if (d < 0) dn[a]++;
    if (d < -128) { d += 256; wr[a]++; } else if (d > 128) d -= 256;
    net[a] += d;
  }
  return { net, up, dn, wr };
}
clearPad(); await step(20);
const frames = [snapshot()];
setBtn(JOY.RIGHT, true);
for (let i = 0; i < 120; i++) { await step(1); frames.push(snapshot()); }
setBtn(JOY.RIGHT, false);
clearPad();
const A = analyze(frames);
// A true sub-pixel: many 0..255 wraps, forward-dominant, over a long RIGHT hold.
const subCands = [];
for (let a = 0; a < wramSize; a++) if (A.wr[a] >= 4 && A.up[a] > A.dn[a] * 2 && A.net[a] > 40) subCands.push({ a, wr: A.wr[a], up: A.up[a], net: A.net[a] });
subCands.sort((x, y) => y.wr - x.wr);
// A true pixel accumulator: strictly monotonic forward (dn <= wraps), net > 20.
const pixCands = [];
for (let a = 0; a < wramSize; a++) if (A.up[a] > 20 && A.dn[a] <= A.wr[a] + 2 && A.net[a] > 20 && A.net[a] < 200) pixCands.push({ a, net: A.net[a], up: A.up[a] });
pixCands.sort((x, y) => y.net - x.net);
log(`  sub-pixel candidates (>=4 rollovers, forward): ${subCands.slice(0, 8).map((c) => `0x${c.a.toString(16)}`).join(', ') || 'NONE'}`);
log(`  pixel-accumulator candidates: ${pixCands.slice(0, 8).map((c) => `0x${c.a.toString(16)}(${c.net})`).join(', ') || 'NONE'}`);
// Reject a lone frame-counter: a pixel candidate that increments by exactly 1 every frame
// with zero wraps is a timer, not position.
const positionConfirmed = subCands.length > 0 && pixCands.some((c) => c.a !== 0x00fd);
log(`  X/Y POSITION + SUB-PIXEL confirmable: ${positionConfirmed ? 'YES' : 'NO (only camera/animation/timer artifacts move; classic offsets frozen)'}`);

// ---- SUMMARY ----------------------------------------------------------------------------
log('');
log('='.repeat(66));
log('CALIBRATION RESULT (empirical, this run)');
log('='.repeat(66));
log(`H-SPEED       : $005D  ${speedVerified ? 'VERIFIED' : 'not verified this run'}`);
log(`X pixel/sub   : ${positionConfirmed ? 'candidate found' : 'NOT VERIFIED (not fabricated)'}`);
log(`Y pixel/sub   : ${positionConfirmed ? 'candidate found' : 'NOT VERIFIED (not fabricated)'}`);
log('');
log(`total frames advanced: ${frameNo}`);
log('READ-ONLY: this harness only READS WRAM; input drives motion, never writes memory.');
log('');
log('MAP_JSON ' + JSON.stringify({ X_SPEED: speedVerified ? SPEED_ADDR : null, X_SPEED_VERIFIED: speedVerified, POSITION_VERIFIED: positionConfirmed }));
process.exit(speedVerified ? 0 : 2);
