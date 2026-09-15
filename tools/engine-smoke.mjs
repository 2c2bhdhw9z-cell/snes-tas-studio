// tools/engine-smoke.mjs
//
// Verifies tas-engine.js — the THIN MAIN-THREAD PROXY — against a MOCK Worker.
//
// FEAT-004 rewrite: the emulator no longer runs on the main thread. tas-engine.js is a
// proxy that (a) creates a MODULE Web Worker, (b) forwards commands as postMessage, and
// (c) mirrors state from worker->main messages. This test installs a mock Worker (recording
// every postMessage + letting us push worker messages back) + a fake OffscreenCanvas, then
// asserts the proxy sends the correct protocol messages and mirrors currentFrame/status/
// banner fields from simulated worker messages.
//
// It ALSO preserves the original safety assertions: no memory-write/poke/inject/cheat method
// on the proxy, the exact ROM_PATH constant, a graceful disabled state, and no file picker.
//
// Run: node tools/engine-smoke.mjs
import assert from 'node:assert';
import { installMockWorkerEnv, removeOffscreenSupport, mockWorkerRegistry } from './mock-worker.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// --- Minimal DOM stubs so the ES module can run under Node -----------------------------
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => {
    let t = '';
    return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } };
  },
  getElementById: () => null,
  head: { appendChild: () => {} },
};
// Controllable rAF: the fallback present path now defers the draw+ack to a main-thread
// requestAnimationFrame (hardware-vsync backpressure). Capture pending callbacks so tests can
// fire a "display refresh" deterministically via flushRaf().
const __rafCbs = [];
globalThis.requestAnimationFrame = (cb) => { __rafCbs.push(cb); return __rafCbs.length; };
globalThis.cancelAnimationFrame = () => {};
function flushRaf() { const cbs = __rafCbs.splice(0); for (const cb of cbs) cb(); return cbs.length; }

// Install the mock Worker (no OffscreenCanvas support by default -> fallback video path).
installMockWorkerEnv({ offscreen: false });
removeOffscreenSupport();

// import.meta.url resolution inside the proxy needs new URL('./emu-worker.js', import.meta.url);
// Node resolves that fine (the module is on disk). The MockWorker never evaluates the URL.
const mod = await import('../tas-engine.js');
const engine = mod.default;

// A notice element that records appended text so we can assert graceful-degradation notices.
const recorded = [];
const noticeEl = {
  hidden: true,
  appendChild(n) { recorded.push(n.textContent); },
  set innerHTML(v) { if (v === '') recorded.length = 0; },
  get innerHTML() { return ''; },
};
// A fake canvas WITHOUT transferControlToOffscreen -> proxy keeps a main-thread present path.
// It has NO WebGL (getContext('webgl2'/'webgl') -> null), so the proxy's WebGL-first present
// path feature-detects to null and falls back to the 2D putImageData blit — exactly like an
// older Safari without WebGL. (Modern iOS gets 'fallback-webgl2'; this harness proves the 2D
// last-resort still draws + backpressures.)
const blits = [];
const fakeCanvas = {
  width: 0,
  height: 0,
  getContext: (type) => {
    if (type !== '2d') return null; // no WebGL here -> 2D fallback present path
    return {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img) => blits.push({ w: img.width, h: img.height }),
    };
  },
};

engine.attach({ canvas: fakeCanvas, noticeEl });
const worker = mockWorkerRegistry.last;

// ======================================================================================
// PROXY IS A THIN CLIENT: no synchronous WASM, creates a module worker.
// ======================================================================================
check('attach() created a module Worker', () => {
  assert.ok(worker, 'a worker was created by attach()');
  assert.strictEqual(worker.opts.type, 'module', 'worker created with {type:"module"}');
});
check('no memory-write / poke / inject / cheat method on the proxy', () => {
  for (const k of ['writeMemory', 'poke', 'pokeU8', 'writeU8', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat', 'retro_cheat_set', 'selectLevel']) {
    assert.strictEqual(typeof engine[k], 'undefined', `unexpected method: ${k}`);
  }
});
check('proxy has no retro_* ABI / run-loop surface', () => {
  for (const k of ['retro_run', 'retro_serialize', 'cwrap', 'addFunction', '_readInput', '_onVideoRefresh']) {
    assert.strictEqual(typeof engine[k], 'undefined', `proxy must not expose ${k}`);
  }
});
check('exact ROM path constant', () => {
  assert.strictEqual(mod.ROM_PATH, 'assets/Super Mario All-Stars (USA).sfc');
});
check('public proxy API surface present', () => {
  for (const k of ['attach', 'init', 'play', 'pause', 'togglePause', 'frameAdvance', 'setSpeed', 'fastForward', 'setCore', 'saveState', 'loadState', 'onFrame', 'onStatus', 'onStateLoaded', 'getMemoryView', 'sendInputEdit', 'sendLiveMask']) {
    assert.strictEqual(typeof engine[k], 'function', `missing API: ${k}`);
  }
});

// ======================================================================================
// init() sends an 'init' message to the worker; no throw; boot is async in the worker.
// ======================================================================================
await checkAsync('init() posts an init message and does not throw', async () => {
  worker.__clear();
  let threw = false;
  let ret;
  try {
    ret = await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
  } catch (_e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'init() never throws');
  assert.ok(ret && ret.ok === true, 'init() reports a dispatched command');
  const init = worker.__last('init');
  assert.ok(init, 'init message posted to the worker');
  assert.strictEqual(init.msg.corePath, 'cores/snes9x_libretro.js');
  assert.strictEqual(init.msg.asyncify, false, 'snes9x is a synchronous (non-asyncify) core');
});

// ======================================================================================
// Run controls forward the correct messages.
// ======================================================================================
check('play() posts {type:"play"}', () => {
  worker.__clear();
  engine.play();
  assert.ok(worker.__last('play'), 'play message posted');
  assert.strictEqual(engine.paused, false, 'proxy mirrors unpaused optimistically');
});
check('pause() posts {type:"pause"}', () => {
  worker.__clear();
  engine.pause();
  assert.ok(worker.__last('pause'), 'pause message posted');
  assert.strictEqual(engine.paused, true);
});
check('frameAdvance() posts exactly one {type:"frameAdvance"}', () => {
  worker.__clear();
  engine.frameAdvance();
  assert.strictEqual(worker.__all('frameAdvance').length, 1, 'exactly one frameAdvance');
});
check('setSpeed() clamps to [0.1,2] and posts the clamped value', () => {
  worker.__clear();
  engine.setSpeed(5);
  const s = worker.__last('setSpeed');
  assert.ok(s, 'setSpeed posted');
  assert.strictEqual(s.msg.mult, 2, 'clamped to 2');
  engine.setSpeed(0.01);
  assert.strictEqual(worker.__last('setSpeed').msg.mult, 0.1, 'clamped to 0.1');
});
check('fastForward(true) posts {type:"fastForward", on:true}', () => {
  worker.__clear();
  engine.fastForward(true);
  const ff = worker.__last('fastForward');
  assert.ok(ff && ff.msg.on === true);
});

// ======================================================================================
// setCore() posts a setCore message (graceful; core-select only, no file picker).
// ======================================================================================
await checkAsync('setCore() posts a setCore message with asyncify flag per core', async () => {
  worker.__clear();
  const r = await engine.setCore('cores/bsnes_mercury_accuracy_libretro.js');
  assert.ok(r && r.ok === true, 'setCore dispatched');
  const sc = worker.__last('setCore');
  assert.ok(sc, 'setCore message posted');
  assert.strictEqual(sc.msg.corePath, 'cores/bsnes_mercury_accuracy_libretro.js');
  assert.strictEqual(sc.msg.asyncify, true, 'bsnes accuracy is an ASYNCIFY core');
  assert.strictEqual(engine.activeCoreId, 'accuracy', 'activeCoreId mirrors the selected core');
  // Restore the default core for later assertions.
  await engine.setCore('cores/snes9x_libretro.js');
});

// ======================================================================================
// State MIRRORING: currentFrame/status/banner fields update from worker messages.
// ======================================================================================
check('frame message updates currentFrame + fires onFrame subscribers', () => {
  let seen = -1;
  engine.onFrame((f) => { seen = f; });
  worker.__emit({ type: 'frame', frame: 123, status: 'running' });
  assert.strictEqual(engine.currentFrame, 123, 'currentFrame mirrored');
  assert.strictEqual(seen, 123, 'onFrame subscriber fired with the frame');
  assert.strictEqual(engine.status, 'running');
  assert.strictEqual(engine.paused, false);
});
check('status snapshot message mirrors banner fields (Core/ROM/Engine/Frame)', () => {
  let snap = null;
  engine.onStatus((s) => { snap = s; });
  worker.__emit({
    type: 'status',
    snapshot: { status: 'ready', coreStatus: 'Instantiated', romStatus: 'Loaded 2097152 bytes', romBytes: 2097152, engineStatus: 'GameLoaded', frame: 5 },
  });
  assert.strictEqual(engine.coreStatus, 'Instantiated');
  assert.strictEqual(engine.romStatus, 'Loaded 2097152 bytes');
  assert.strictEqual(engine.engineStatus, 'GameLoaded');
  assert.strictEqual(engine.currentFrame, 5);
  assert.ok(snap && snap.coreStatus === 'Instantiated' && snap.engineStatus === 'GameLoaded',
    'onStatus fired with the mirrored snapshot');
});
check('hud message populates the read-only memory view (verified SMB1 offsets)', () => {
  worker.__emit({ type: 'hud', values: { hSpeed: -16, xHi: 0x30, xSub: 0x80, xPage: 0x02, yHi: 0xb0, ySub: 0x40 } });
  const mem = engine.getMemoryView();
  assert.ok(mem, 'memory view surfaces once HUD values stream in');
  // Read via verified WRAM offsets (SMB1): H-Speed 0x005D, X hi 0x0042.
  assert.strictEqual(mem.readS8(0x005d), -16, 'H-Speed signed byte via offset 0x005D');
  assert.strictEqual(mem.readU8(0x0042), 0x30, 'X hi via offset 0x0042');
  // Strictly READ-ONLY: no writer on the view.
  for (const k of ['writeU8', 'poke', 'write', 'set', 'inject']) {
    assert.strictEqual(typeof mem[k], 'undefined', `memory view must not expose ${k}`);
  }
});
// END-TO-END HUD OFFSET MAP: the worker reads WRAM addresses and streams them under field
// NAMES tied to the ADDRESS each byte came from (SMB1_HUD_ADDR): xHi=byte@0x0042,
// xSub=byte@0x0043 (the X PAGE per memory-watch.js), xPage=byte@0x0401 (the X SUB-PIXEL).
// memory-watch.js then reads readU8(0x0043)=page and readU8(0x0401)=sub-pixel. The proxy
// map must route each streamed byte back to the offset it was READ AT, so a readU8(addr)
// returns exactly the WRAM byte at addr. We deliberately use DISTINCT bytes at 0x0043 and
// 0x0401 so this FAILS if the two offsets are transposed (the v1 bug).
check('read-only view maps ALL FOUR X offsets + Y/H-Speed to the correct WRAM bytes end-to-end', () => {
  // Distinct sentinel bytes per verified address (page 0x0043 != sub-pixel 0x0401).
  const byteAt = { 0x005d: 0xf0, 0x0042: 0x30, 0x0043: 0x11, 0x0401: 0x22, 0x0002: 0xb0, 0x041c: 0x40 };
  // Worker streams field NAMES keyed to the address each byte was read at (see SMB1_HUD_ADDR).
  worker.__emit({
    type: 'hud',
    values: {
      hSpeed: -16,           // 0xF0 as S8
      xHi: byteAt[0x0042],   // byte@0x0042
      xSub: byteAt[0x0043],  // field 'xSub' carries byte@0x0043 (the X PAGE)
      xPage: byteAt[0x0401], // field 'xPage' carries byte@0x0401 (the X SUB-PIXEL)
      yHi: byteAt[0x0002],   // byte@0x0002
      ySub: byteAt[0x041c],  // byte@0x041c
    },
  });
  const mem = engine.getMemoryView();
  assert.ok(mem, 'memory view present');
  // Each offset must return the byte the worker read AT that offset (memory-watch semantics).
  assert.strictEqual(mem.readU8(0x0042), byteAt[0x0042], 'X pixel byte at 0x0042');
  assert.strictEqual(mem.readU8(0x0043), byteAt[0x0043], 'X PAGE byte at 0x0043 (not the sub-pixel)');
  assert.strictEqual(mem.readU8(0x0401), byteAt[0x0401], 'X SUB-PIXEL byte at 0x0401 (not the page)');
  assert.notStrictEqual(mem.readU8(0x0043), mem.readU8(0x0401), 'page and sub-pixel are NOT transposed');
  assert.strictEqual(mem.readS8(0x005d), -16, 'H-Speed at 0x005D');
  assert.strictEqual(mem.readU8(0x0002), byteAt[0x0002], 'Y hi at 0x0002');
  assert.strictEqual(mem.readU8(0x041c), byteAt[0x041c], 'Y sub-pixel at 0x041c');
});

// ======================================================================================
// Video FALLBACK blit: no OffscreenCanvas -> proxy blits {type:'video'} frames itself.
// ======================================================================================
check('proxy blits {type:"video"} frames on the fallback path — DEFERRED to a main-thread rAF (vsync backpressure)', () => {
  blits.length = 0;
  const w = 4, h = 2;
  const buf = new Uint8Array(w * h * 4).fill(255).buffer;
  worker.__emit({ type: 'video', buffer: buf, width: w, height: h, pitch: w * 2, pixelFormat: 2 });
  // The present is now bound to the display refresh: NOTHING is drawn until the rAF fires.
  assert.strictEqual(blits.length, 0, 'present is deferred to requestAnimationFrame (not drawn synchronously)');
  const drew = flushRaf(); // one simulated display refresh
  assert.ok(drew >= 1, 'a rAF was scheduled for the present');
  assert.strictEqual(blits.length, 1, 'proxy drew the posted frame to the main-thread 2d context on the rAF');
  assert.strictEqual(fakeCanvas.width, w);
  assert.strictEqual(fakeCanvas.height, h);
});

check('proxy ACKs the drawn video buffer back to the worker FROM INSIDE the rAF (in-flight <= 1)', () => {
  worker.__clear();
  const w = 4, h = 2;
  const buf = new Uint8Array(w * h * 4).fill(128).buffer;
  worker.__emit({ type: 'video', buffer: buf, width: w, height: h, pitch: w * 2, pixelFormat: 2 });
  // Gate: no ack until the rAF fires, so the worker holds the next frame (in-flight bounded to 1).
  assert.strictEqual(worker.__last('videoAck'), null, 'no ack before the rAF fires (worker gate stays set)');
  flushRaf();
  const ack = worker.__last('videoAck');
  assert.ok(ack, 'a videoAck was posted after drawing on the rAF');
  assert.ok(ack.transfer && ack.transfer[0] === ack.msg.buffer, 'the buffer is transferred BACK for reuse');
});

check('fallback video path reports videoPath in the status snapshot (banner diagnostic)', () => {
  // This harness canvas has no WebGL, so the proxy took the 2D last-resort present path and
  // reported it. On modern iOS this would be 'fallback-webgl2'.
  const snap = engine.statusSnapshot();
  assert.ok('videoPath' in snap, 'status snapshot carries the active video path');
  assert.strictEqual(snap.videoPath, 'fallback-2d', 'no-WebGL fake canvas -> 2D last-resort path reported');
});

// ======================================================================================
// saveState()/loadState() over the message protocol.
// ======================================================================================
await checkAsync('saveState() resolves with bytes from the worker "saved" message', async () => {
  worker.__clear();
  const p = engine.saveState();
  assert.ok(worker.__last('saveState'), 'saveState command posted');
  // Simulate the worker replying with serialized bytes.
  worker.__emit({ type: 'saved', bytes: new Uint8Array([1, 2, 3, 4]).buffer });
  const bytes = await p;
  assert.ok(bytes instanceof Uint8Array && bytes.length === 4, 'saveState resolved with the bytes');
});
check('loadState() posts a transferable loadState and fires onStateLoaded on stateLoaded', () => {
  worker.__clear();
  let loadedFrame = -1;
  engine.onStateLoaded((f) => { loadedFrame = f; });
  const ok = engine.loadState(new Uint8Array([9, 9, 9, 9]), { frame: 7 });
  assert.strictEqual(ok, true, 'loadState dispatched');
  const ls = worker.__last('loadState');
  assert.ok(ls, 'loadState message posted');
  assert.ok(ls.msg.bytes instanceof ArrayBuffer, 'bytes sent as a transferable ArrayBuffer');
  assert.ok(ls.transfer && ls.transfer[0] === ls.msg.bytes, 'buffer is in the transfer list');
  // Worker acks with stateLoaded -> proxy fires onStateLoaded so re-record truncation runs.
  worker.__emit({ type: 'stateLoaded', frame: 7 });
  assert.strictEqual(loadedFrame, 7, 'onStateLoaded fired with the loaded frame');
});

// ======================================================================================
// Input edits + live mask cross the boundary (controller input only).
// ======================================================================================
check('sendInputEdit() forwards a scripted edit as {type:"inputEdit"}', () => {
  worker.__clear();
  engine.sendInputEdit({ op: 'setFrameButton', frame: 3, button: 'A', on: true });
  const e = worker.__last('inputEdit');
  assert.ok(e, 'inputEdit posted');
  assert.strictEqual(e.msg.op, 'setFrameButton');
  assert.strictEqual(e.msg.frame, 3);
  assert.strictEqual(e.msg.button, 'A');
  assert.strictEqual(e.msg.on, true);
});
check('sendLiveMask() forwards the latest live mask as {type:"liveMask"}', () => {
  worker.__clear();
  engine.sendLiveMask((1 << 3) >>> 0);
  const m = worker.__last('liveMask');
  assert.ok(m, 'liveMask posted');
  assert.strictEqual(m.msg.mask, 1 << 3);
});

// ======================================================================================
// Worker error -> proxy shows a notice (never throws) and NO file picker anywhere.
// ======================================================================================
check('worker "error" message surfaces a notice (no throw)', () => {
  recorded.length = 0;
  worker.__emit({ type: 'error', message: 'core boot failed: rom-missing' });
  assert.ok(recorded.some((l) => /core boot failed/.test(l)), 'error notice rendered: ' + JSON.stringify(recorded));
});

// ======================================================================================
// GRACEFUL DISABLED STATE when Web Workers are unavailable (e.g. an old/locked-down engine).
// A fresh proxy instance with Worker removed must degrade, not throw, not open a file picker.
// ======================================================================================
await checkAsync('no Worker support -> graceful disabled state, no throw, no file picker', async () => {
  const savedWorker = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const { TASEngine } = mod;
    const disabled = new TASEngine();
    const localNotices = [];
    let threw = false;
    let ret;
    try {
      disabled.attach({
        canvas: fakeCanvas,
        noticeEl: {
          hidden: true,
          appendChild(n) { localNotices.push(n.textContent); },
          set innerHTML(v) { if (v === '') localNotices.length = 0; },
          get innerHTML() { return ''; },
        },
      });
      ret = await disabled.init();
    } catch (_e) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'attach/init never throw without Worker support');
    assert.ok(ret && ret.ok === false, 'init reports not-ok when disabled');
    assert.strictEqual(disabled.status, 'disabled', 'proxy enters the disabled state');
    assert.ok(localNotices.some((l) => /Web Workers are unavailable/.test(l)), 'disabled notice shown: ' + JSON.stringify(localNotices));
  } finally {
    globalThis.Worker = savedWorker;
  }
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
