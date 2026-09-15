// tools/hud-crosscheck.mjs
//
// CROSS-CORE HUD map verification. The main tools/hud-calibrate.mjs proves the SMB1 /
// All-Stars WRAM offsets against the bsnes accuracy core. This harness proves the SAME
// offsets read correct Mario physics on ANY core passed via CORE=..., so we can state
// empirically whether the single shared memory map is core-agnostic (works on snes9x too)
// or whether a per-core map is required.
//
// WHY A SEPARATE HARNESS: hud-calibrate.mjs uses fixed frame counts tuned to the bsnes
// menu/boot timing; snes9x boots and paces its menus slightly differently, so those fixed
// windows bleed one phase into the next (e.g. Mario is still at run speed when the "start
// from rest" phase begins). This harness instead SETTLES Mario to a proven rest state
// (speed byte == 0 and X pixel stationary) before each measurement, and drives phases off
// the observed state rather than fixed counts, so it is core-timing-independent.
//
// It only READS WRAM. Driving input and serialize/unserialize touch only this emulator's
// OWN state, never game memory. Re-execs under --liftoff-only (V8 JIT guard, matches the
// other harnesses) and bounds every retro_run with a wall-clock timeout.
//
// Run:  CORE=cores/snes9x_libretro.js node tools/hud-crosscheck.mjs
// Exit 0 iff every offset verifies on the given core.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.execArgv.some((a) => a.includes('liftoff-only')) && process.env.__XC_REEXEC !== '1') {
  const res = spawnSync(process.execPath, ['--liftoff-only', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, __XC_REEXEC: '1' } });
  process.exit(res.status == null ? 1 : res.status);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CORE_REL = process.env.CORE || 'cores/snes9x_libretro.js';
const CORE_JS = isAbsolute(CORE_REL) ? CORE_REL : join(ROOT, CORE_REL);
const CORE_WASM = CORE_JS.replace(/\.js$/, '.wasm');
const ROM_PATH = join(ROOT, 'assets', 'Super Mario All-Stars (USA).sfc');
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 30000);
const log = (s = '') => console.log(s);

const RETRO_MEMORY_SYSTEM_RAM = 2;
const RETRO_DEVICE_JOYPAD = 1;
const JOY = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };

// The SMB1-in-All-Stars WRAM map proven by hud-calibrate.mjs on bsnes. We re-prove the
// SAME addresses here on the given core.
const A_SPEED = 0x005d;
const A_XPX = 0x0042;
const A_XPAGE = 0x0043;
const A_XSUB = 0x0401;
const A_YPX = 0x0002;
const A_YSUB = 0x041c;

const ENV = { GET_OVERSCAN: 2, GET_CAN_DUPE: 3, GET_SYSTEM_DIRECTORY: 9, SET_PIXEL_FORMAT: 10, GET_VARIABLE: 15, GET_VARIABLE_UPDATE: 17, GET_LANGUAGE: 39, GET_CORE_OPTIONS_VERSION: 52, GET_SAVE_DIRECTORY: 31, GET_CORE_ASSETS_DIRECTORY: 30, GET_LOG_INTERFACE: 27 };

log(`core: ${CORE_REL}`);
log(`ROM:  ${ROM_PATH}`);

const mod = await import(pathToFileURL(CORE_JS).href);
const factory = mod && (mod.default || mod);
const wasmBytes = readFileSync(CORE_WASM);
const romBytes = new Uint8Array(readFileSync(ROM_PATH));

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
function rd(a) { return Module.HEAPU8[wramPtr + a]; }
function fullX() { return rd(A_XPAGE) * 256 + rd(A_XPX); }
function sgn8(v) { return v >= 0x80 ? v - 0x100 : v; }
async function tap(id, hold, rest) { setBtn(id, true); await step(hold); setBtn(id, false); await step(rest); }

// ---- PHASE 1: drive All-Stars menus into input-responsive SMB1 gameplay -----------------
log('');
log('=== PHASE 1: reach SMB1 gameplay ===');
await step(240);
const seq = [JOY.START, JOY.A, JOY.START, JOY.A, JOY.DOWN, JOY.A, JOY.START, JOY.A];
async function respondsToRight() {
  clearPad();
  // settle first, then probe: does holding RIGHT move the on-screen X and raise speed?
  const x0 = fullX();
  setBtn(JOY.RIGHT, true);
  let moved = 0, spedUp = 0;
  for (let i = 0; i < 40; i++) { await step(1); if (fullX() !== x0) moved++; if (sgn8(rd(A_SPEED)) > 2) spedUp++; }
  setBtn(JOY.RIGHT, false);
  return moved >= 20 && spedUp >= 20;
}
let reacted = false;
for (let i = 0; i < 120 && !reacted; i++) { await tap(seq[i % seq.length], 6, 16); if (i % 2 === 1) { if (await respondsToRight()) reacted = true; } }
log(`gameplay + input response: ${reacted ? 'YES' : 'NO'} at frame ${frameNo}`);

// Settle Mario to a proven REST state: no input until the speed byte is 0 AND the on-screen
// X pixel stops changing for several consecutive frames. This is the key fix over the fixed-
// count calibration: we measure from a KNOWN rest, so a core's different menu timing cannot
// bleed leftover momentum into the next phase.
async function settleToRest(maxFrames = 400) {
  clearPad();
  let stableX = 0, lastX = fullX();
  for (let i = 0; i < maxFrames; i++) {
    await step(1);
    const x = fullX();
    if (x === lastX && sgn8(rd(A_SPEED)) === 0) stableX++; else stableX = 0;
    lastX = x;
    if (stableX >= 8) return true;
  }
  return false;
}

const pass = {};

// ---- PHASE 2: H-SPEED $005D — accelerate FROM REST, friction, signed reversal -----------
log('');
log('=== PHASE 2: H-SPEED $005D (accel from rest / friction / reversal) ===');
await settleToRest();
const restSpeed = sgn8(rd(A_SPEED));
setBtn(JOY.RIGHT, true);
const rightSpd = [];
for (let i = 0; i < 24; i++) { await step(1); rightSpd.push(sgn8(rd(A_SPEED))); }
setBtn(JOY.RIGHT, false);
const idleSpd = [];
for (let i = 0; i < 30; i++) { await step(1); idleSpd.push(sgn8(rd(A_SPEED))); }
await settleToRest();
setBtn(JOY.LEFT, true);
const leftSpd = [];
for (let i = 0; i < 24; i++) { await step(1); leftSpd.push(sgn8(rd(A_SPEED))); }
setBtn(JOY.LEFT, false);
clearPad();
log(`  rest speed             : $005D = ${restSpeed}`);
log(`  hold RIGHT (accelerate): $005D = ${rightSpd.join(', ')}`);
log(`  release  (friction->0) : $005D = ${idleSpd.join(', ')}`);
log(`  hold LEFT (reverse -)  : $005D = ${leftSpd.join(', ')}`);
const accelerates = restSpeed === 0 && Math.max(...rightSpd) >= 8 && rightSpd[rightSpd.length - 1] > 0;
const frictions = idleSpd[idleSpd.length - 1] >= -1 && idleSpd[idleSpd.length - 1] < Math.max(...rightSpd);
const reverses = Math.min(...leftSpd) < -2;
pass.speed = accelerates && frictions && reverses;
log(`  accelerates=${accelerates} friction=${frictions} reverses=${reverses}  => H-SPEED $005D: ${pass.speed ? 'VERIFIED' : 'FAILED'}`);

// ---- PHASE 3: X pixel/page/sub-pixel — velocity integral over a steady run --------------
log('');
log('=== PHASE 3: X PIXEL $0042 / PAGE $0043 / SUB $0401 (velocity integral) ===');
await settleToRest();
setBtn(JOY.RIGHT, true); setBtn(JOY.B, true);
await step(30); // reach steady run speed
const N = 220;
const spd = [], xsub = [], xpx = [], xpage = [];
xsub.push(rd(A_XSUB)); xpx.push(rd(A_XPX)); xpage.push(rd(A_XPAGE));
for (let i = 0; i < N; i++) {
  spd.push(sgn8(rd(A_SPEED)));
  await step(1);
  xsub.push(rd(A_XSUB)); xpx.push(rd(A_XPX)); xpage.push(rd(A_XPAGE));
}
setBtn(JOY.RIGHT, false); setBtn(JOY.B, false);
let predCarries = 0, subMatches = 0, subTotal = 0, pxWraps = 0, measuredPixMove = 0;
let acc = xsub[0];
for (let i = 1; i <= N; i++) {
  const combPrev = xpx[i - 1] * 256 + xsub[i - 1];
  const combNow = xpx[i] * 256 + xsub[i];
  const pinned = spd[i - 1] >= 6 && combNow === combPrev;
  if (spd[i - 1] <= 0 || pinned) { acc = xsub[i]; continue; }
  acc += spd[i - 1] * 16;
  let carry = 0; while (acc >= 256) { acc -= 256; carry++; }
  const predSub = acc & 0xff;
  subTotal++;
  if (Math.abs(predSub - xsub[i]) <= 3 || Math.abs(predSub - xsub[i]) >= 253) subMatches++;
  predCarries += carry;
  let dpx = xpx[i] - xpx[i - 1]; if (dpx < -128) { dpx += 256; pxWraps++; }
  measuredPixMove += dpx;
}
const pageInc = xpage[N] - xpage[0];
log(`  steady speed sample: ${spd.slice(0, 8).join(',')} ... (max ${Math.max(...spd)})`);
log(`  sub-pixel $0401 matches integral: ${subMatches}/${subTotal} clean frames`);
log(`  predicted carries = ${predCarries}; measured $0042 movement = ${measuredPixMove}; wraps=${pxWraps}; page +${pageInc}`);
// idle-freeze: at rest the sub-pixel stops accumulating.
await settleToRest();
const subA = rd(A_XSUB); const spdA = sgn8(rd(A_SPEED));
await step(30);
const subB = rd(A_XSUB);
const idleFreezes = subA === subB && spdA === 0;
log(`  IDLE: speed=${spdA}; $0401 ${subA} -> ${subB} over 30 idle frames (frozen: ${idleFreezes})`);
pass.xSub = subTotal > 40 && subMatches >= subTotal * 0.9 && Math.abs(predCarries - measuredPixMove) <= 6 && idleFreezes;
pass.xPx = measuredPixMove > 80;
pass.xPage = pxWraps >= 1 && pageInc >= 1;
log(`  => X SUB $0401: ${pass.xSub ? 'VERIFIED' : 'FAILED'};  X PIXEL $0042: ${pass.xPx ? 'VERIFIED' : 'FAILED'};  X PAGE $0043: ${pass.xPage ? 'VERIFIED' : 'FAILED'}`);

// ---- PHASE 4: Y pixel/sub — gravity parabola (jump) -------------------------------------
log('');
log('=== PHASE 4: Y PIXEL $0002 / SUB $041C (gravity parabola) ===');
await settleToRest();
const groundStart = rd(A_YPX);
const YF = 70;
const yc = []; const ypxArr = [];
yc.push(rd(A_YPX) * 256 + rd(A_YSUB)); ypxArr.push(rd(A_YPX));
setBtn(JOY.A, true);
for (let i = 0; i < YF; i++) { if (i === 30) setBtn(JOY.A, false); await step(1); yc.push(rd(A_YPX) * 256 + rd(A_YSUB)); ypxArr.push(rd(A_YPX)); }
setBtn(JOY.A, false);
const isTearFrame = (i) => ypxArr[i] === 0 && (i === 0 || ypxArr[i - 1] > 40) && (i >= YF || ypxArr[i + 1] > 40);
let apexIdx = 0, minY = 999; for (let i = 0; i <= YF; i++) { if (!isTearFrame(i) && ypxArr[i] > 50 && ypxArr[i] < minY) { minY = ypxArr[i]; apexIdx = i; } }
const riseVel = [];
for (let i = 1; i <= apexIdx; i++) { if (isTearFrame(i) || isTearFrame(i - 1)) continue; const d = yc[i] - yc[i - 1]; if (Math.abs(d) > 4000) continue; riseVel.push(d); }
const allVel = [];
for (let i = 1; i <= YF; i++) { if (isTearFrame(i) || isTearFrame(i - 1)) continue; const d = yc[i] - yc[i - 1]; if (Math.abs(d) > 4000) continue; allVel.push(d); }
const cleanRise = riseVel.filter((v) => v < -30 && v > -2000);
const accs = []; for (let i = 1; i < cleanRise.length; i++) accs.push(cleanRise[i] - cleanRise[i - 1]);
const accsSorted = [...accs].sort((a, b) => a - b);
const medianAcc = accsSorted.length ? accsSorted[Math.floor(accsSorted.length / 2)] : 0;
const withinTol = accs.filter((a) => Math.abs(a - medianAcc) <= 24).length;
const risesThenFalls = allVel.length && Math.min(...allVel) < -20 && Math.max(...allVel) > 20;
const peakY = minY;
const endY = ypxArr[YF] === 0 ? ypxArr[YF - 1] : ypxArr[YF];
const returnsDown = endY > peakY + 20;
log(`  Y pixel $0002: ground=${groundStart}, apex=${peakY} (frame ${apexIdx}), end=${endY}`);
log(`  clean RISE velocity: ${cleanRise.slice(0, 14).join(', ')} ...`);
log(`  gravity (median 2nd-diff) = ${medianAcc}; frames obeying it: ${withinTol}/${accs.length}`);
log(`  rises then falls: ${risesThenFalls}; returns toward ground: ${returnsDown}`);
const gravityConsistent = medianAcc >= 16 && cleanRise.length >= 6 && accs.length > 0 && withinTol >= accs.length * 0.75;
pass.yPx = risesThenFalls && returnsDown && peakY < groundStart;
pass.ySub = gravityConsistent && risesThenFalls && returnsDown;
log(`  => Y PIXEL $0002: ${pass.yPx ? 'VERIFIED' : 'FAILED'};  Y SUB $041C: ${pass.ySub ? 'VERIFIED' : 'FAILED'}`);

// ---- SUMMARY ----------------------------------------------------------------------------
const allPass = pass.speed && pass.xPx && pass.xPage && pass.xSub && pass.yPx && pass.ySub;
log('');
log('='.repeat(70));
log(`CROSS-CORE HUD MAP RESULT for ${CORE_REL}`);
log('='.repeat(70));
log(`H-SPEED     : $005D  ${pass.speed ? 'VERIFIED' : 'FAILED'}`);
log(`X pixel     : $0042  ${pass.xPx ? 'VERIFIED' : 'FAILED'}`);
log(`X page      : $0043  ${pass.xPage ? 'VERIFIED' : 'FAILED'}`);
log(`X sub-pixel : $0401  ${pass.xSub ? 'VERIFIED' : 'FAILED'}`);
log(`Y pixel     : $0002  ${pass.yPx ? 'VERIFIED' : 'FAILED'}`);
log(`Y sub-pixel : $041C  ${pass.ySub ? 'VERIFIED' : 'FAILED'}`);
log('');
log(`total frames advanced: ${frameNo}`);
log('READ-ONLY: this harness only READS WRAM; input drives motion and serialize/unserialize');
log("affects only this emulator's OWN state, never game memory.");
process.exit(allPass ? 0 : 2);
