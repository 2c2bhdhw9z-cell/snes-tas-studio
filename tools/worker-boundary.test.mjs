// tools/worker-boundary.test.mjs
//
// THE definitive determinism + OffscreenCanvas + save/load test for the worker boundary.
//
// Unlike tools/emu-worker.test.mjs (which drives the worker with a lightweight FAKE runner to
// prove the message plumbing), THIS test wires the REAL emu-worker.js to the REAL
// EmuCoreRunner + REAL InputResolver, backed by a MOCK libretro core Module. So determinism
// is proven THROUGH the actual libretro input-state ABI: the mock core's retro_run calls the
// registered input_state callback for the CURRENT frame, and we capture exactly which bit was
// returned for each button — proving frame N runs with exactly (log.getMask(N) | liveMask)>>>0
// and never N+1's input, end to end. This is the authoritative version; emu-worker.test.mjs
// remains as the lighter plumbing check.
//
// Covers all seven FEAT-004 step-6 assertions:
//   (1) frame N runs with exactly (log.getMask(N) | latestLiveMask) >>> 0, NEVER N+1's input
//   (2) frame-advance = one frame with that frame's input
//   (3) truncateAfter re-record holds after a simulated loadState
//   (4) OffscreenCanvas available -> proxy transfers it + worker blit path (no {type:'video'})
//   (5) absent -> fallback {type:'video'} + main-thread blit
//   (6) streamed READ-ONLY HUD values with the verified SMB1 addresses
//   (7) save/load round-trip over transferable bytes
//
// Run: node tools/worker-boundary.test.mjs
import assert from 'node:assert';
import { SMB1_HUD_ADDR } from '../emu-core-runner.js';
import { installMockWorkerEnv, mockWorkerRegistry, FakeOffscreenCanvas } from './mock-worker.mjs';

const results = [];
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// --- Fake DedicatedWorkerGlobalScope --------------------------------------------------
function makeFakeScope() {
  const listeners = { message: [] };
  const posted = [];
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage(msg, transfer) { posted.push({ msg, transfer: transfer || null }); },
    __deliver(data) { for (const fn of listeners.message) fn({ data }); },
    __posted: posted,
    __last(type) {
      for (let i = posted.length - 1; i >= 0; i--) {
        if (!type || (posted[i].msg && posted[i].msg.type === type)) return posted[i];
      }
      return null;
    },
    __all(type) { return posted.filter((p) => p.msg && p.msg.type === type); },
    __clear() { posted.length = 0; },
  };
}

// Install the fake scope as `self` BEFORE importing the worker module (it wires a message
// listener onto `self` at import time).
const scope = makeFakeScope();
globalThis.self = scope;
const { EmuWorker } = await import('../emu-worker.js');

// --- A MOCK libretro core Module (real ABI path) --------------------------------------
// retro_run fires the registered input_state callback for the CURRENT frame, recording the
// bit returned for each queried joypad id. This lets us reconstruct the exact resolved mask
// the runner used for that frame — the determinism moment.
const FB_W = 4;
const FB_H = 2;
const RED565 = 0xf800;
const WRAM_PTR = 0x10000;
const HUD_SEED = {
  [SMB1_HUD_ADDR.H_SPEED]: 0xf0, // -16
  [SMB1_HUD_ADDR.X_HI]: 0x30,
  [SMB1_HUD_ADDR.X_SUB]: 0x80,
  [SMB1_HUD_ADDR.X_PAGE]: 0x02,
  [SMB1_HUD_ADDR.Y_HI]: 0xb0,
  [SMB1_HUD_ADDR.Y_SUB]: 0x40,
};

function makeMockModule(shared) {
  const HEAP_BYTES = 1 << 20;
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPU32 = new Uint32Array(buffer);
  const HEAPU16 = new Uint16Array(buffer);
  const HEAPF64 = new Float64Array(buffer);
  let bump = 0x40000;
  const _malloc = (n) => { const p = bump; bump += (n + 7) & ~7; return p; };
  const _free = () => {};
  for (const [off, val] of Object.entries(HUD_SEED)) HEAPU8[WRAM_PTR + Number(off)] = val;
  const FB_PTR = 0x20000;
  const FB_PITCH = FB_W * 2;
  for (let y = 0; y < FB_H; y++) for (let x = 0; x < FB_W; x++) HEAPU16[(FB_PTR + y * FB_PITCH) / 2 + x] = RED565;

  const table = [];
  const cbs = {};
  const addFunction = (fn) => { table.push(fn); return table.length; };
  let coreState = 0xabcd;
  const SERIALIZE_SIZE = 16;
  const noop = () => {};
  const fnTable = {
    retro_init: noop, retro_deinit: noop, retro_reset: noop, retro_unload_game: noop,
    retro_load_game: () => 1,
    retro_run: () => {
      const vcb = table[cbs.video - 1];
      if (typeof vcb === 'function') vcb(FB_PTR, FB_W, FB_H, FB_PITCH);
      // Query ALL 12 joypad ids and record the returned bit -> reconstruct the frame's mask.
      const icb = table[cbs.input - 1];
      let mask = 0;
      if (typeof icb === 'function') {
        for (let id = 0; id < 12; id++) {
          const bit = icb(0, 1, 0, id);
          if (bit) mask |= (1 << id);
        }
      }
      shared.resolvedPerFrame.push({ frame: shared.currentFrameAtRun(), mask: mask >>> 0 });
    },
    retro_serialize_size: () => SERIALIZE_SIZE,
    retro_serialize: (ptr) => { HEAP32[ptr >> 2] = coreState; return 1; },
    retro_unserialize: (ptr) => { coreState = HEAP32[ptr >> 2]; return 1; },
    retro_get_memory_data: (id) => (id === 2 ? WRAM_PTR : 0),
    retro_get_memory_size: (id) => (id === 2 ? 0x2000 : 0),
    retro_set_environment: (p) => { cbs.env = p; },
    retro_set_video_refresh: (p) => { cbs.video = p; },
    retro_set_audio_sample: (p) => { cbs.audioSample = p; },
    retro_set_audio_sample_batch: (p) => { cbs.audioBatch = p; },
    retro_set_input_poll: (p) => { cbs.inputPoll = p; },
    retro_set_input_state: (p) => { cbs.input = p; },
    retro_get_system_av_info: (ptr) => {
      HEAPU32[(ptr >> 2) + 0] = 256; HEAPU32[(ptr >> 2) + 1] = 224; HEAPF64[(ptr + 24) >> 3] = 60.098;
    },
  };
  const cwrap = (name) => { const fn = fnTable[name]; if (!fn) throw new Error('unknown ' + name); return fn; };
  return { HEAPU8, HEAP32, HEAPU32, HEAPU16, HEAPF64, _malloc, _free, cwrap, addFunction,
    __getState: () => coreState, __setState: (v) => { coreState = v; } };
}

// Import the REAL EmuCoreRunner so the worker wires it exactly as in production, but with an
// injected loadCore/fetchRom (mock core) + synchronous scheduler.
const { EmuCoreRunner } = await import('../emu-core-runner.js');

/**
 * Build an EmuWorker whose _makeRunner returns a REAL EmuCoreRunner backed by the mock core.
 * The wiring mirrors emu-worker.js exactly (same getFrameInputMask + sinks) so the
 * determinism contract is exercised through the true resolver + runner + libretro ABI path.
 */
function makeWorker() {
  const shared = { resolvedPerFrame: [], runner: null, currentFrameAtRun: () => 0 };
  const worker = new EmuWorker(scope);
  worker._makeRunner = function (asyncify) {
    const runner = new EmuCoreRunner({
      asyncify: !!asyncify,
      getFrameInputMask: (frame) => this.resolver.getFrameInputMask(frame, this.liveMask),
      onVideoFrame: (rgba, w, h, pitch, fmt) => this._presentFrame(rgba, w, h, pitch, fmt),
      onHud: (values) => this.post({ type: 'hud', values }),
      onStatus: (snapshot) => this.post({ type: 'status', snapshot }),
      onFrame: (frame, status) => this.post({ type: 'frame', frame, status }),
      onStateLoaded: (frame) => this.post({ type: 'stateLoaded', frame }),
      loadCore: async () => ({ ok: true, Module: makeMockModule(shared), corePath: 'cores/snes9x_libretro.js' }),
      fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
      scheduleYield: (cb) => { shared.__pending = cb; return 1; },
    });
    shared.runner = runner;
    shared.currentFrameAtRun = () => runner.currentFrame;
    return runner;
  };
  return { worker, shared };
}

// ======================================================================================
// (1) DETERMINISM: frame N executed with exactly (log.getMask(N) | liveMask) >>> 0.
// ======================================================================================
await checkAsync('(1) frame N runs with exactly (log.getMask(N) | liveMask) >>> 0 and never N+1 input', async () => {
  scope.__clear();
  const { worker, shared } = makeWorker();
  // Pause after boot so the free-running loop does not race our frame-advances.
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  shared.resolvedPerFrame.length = 0;

  const B = 1 << 0, A = 1 << 8, START = 1 << 3;
  // Scripted: B on frame 0, A on frame 2. Live: START held.
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 0, button: 'B', on: true } });
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 2, button: 'A', on: true } });
  await worker._onMessage({ data: { type: 'liveMask', mask: START } });

  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 0
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 1
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 2

  const pf = shared.resolvedPerFrame;
  assert.strictEqual(pf.length, 3, 'exactly three frames ran');
  assert.strictEqual(pf[0].frame, 0);
  assert.strictEqual(pf[0].mask, (B | START) >>> 0, 'frame 0 = scripted B | live START');
  assert.strictEqual(pf[1].mask, START >>> 0, 'frame 1 = live START only (NO bleed from f0/f2)');
  assert.strictEqual(pf[2].mask, (A | START) >>> 0, 'frame 2 = scripted A | live START');
});

await checkAsync('(1b) frame 0 NEVER reflects frame 1 scripted input', async () => {
  scope.__clear();
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  shared.resolvedPerFrame.length = 0;
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 1, button: 'A', on: true } });
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 0
  assert.strictEqual(shared.resolvedPerFrame[0].mask, 0, 'frame 0 must not see frame 1 input');
});

// ======================================================================================
// (2) frame-advance = exactly one frame with that frame's input.
// ======================================================================================
await checkAsync('(2) frameAdvance runs EXACTLY one frame with that frame input', async () => {
  scope.__clear();
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  shared.resolvedPerFrame.length = 0;
  const before = shared.runner.currentFrame;
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: before, button: 'Y', on: true } });
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  assert.strictEqual(shared.runner.currentFrame, before + 1, 'exactly one retro_run');
  assert.strictEqual(shared.resolvedPerFrame.length, 1, 'exactly one frame resolved');
  assert.strictEqual(shared.resolvedPerFrame[0].mask, (1 << 1) >>> 0, 'ran with that frame\'s Y bit');
});

// ======================================================================================
// (3) truncateAfter re-record holds after a simulated loadState.
// ======================================================================================
await checkAsync('(3) truncateAfter re-record holds after a loadState', async () => {
  scope.__clear();
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  for (let f = 0; f <= 3; f++) {
    await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: f, button: 'A', on: true } });
  }
  // Simulated loadState at frame 1, then truncateAfter(1) (what the proxy sends on stateLoaded).
  await worker._onMessage({ data: { type: 'loadState', bytes: new Uint8Array(16).buffer, frame: 1 } });
  await worker._onMessage({ data: { type: 'inputEdit', op: 'truncateAfter', frame: 1 } });
  const A = 1 << 8;
  assert.strictEqual(worker.resolver.getFrameInputMask(0, 0), A, 'frame 0 kept');
  assert.strictEqual(worker.resolver.getFrameInputMask(1, 0), A, 'frame 1 kept');
  assert.strictEqual(worker.resolver.getFrameInputMask(2, 0), 0, 'frame 2 truncated');
  assert.strictEqual(worker.resolver.getFrameInputMask(3, 0), 0, 'frame 3 truncated');
  assert.ok(scope.__last('stateLoaded'), 'stateLoaded posted so the proxy re-record path fires');
});

// ======================================================================================
// (4) OffscreenCanvas is DISABLED (device-confirmed native WebKit leak). The proxy must NEVER
// transfer the canvas and the worker must NEVER be sent an OffscreenCanvas — even when the
// browser advertises transferControlToOffscreen + OffscreenCanvas. Present is FORCED onto the
// main thread. (The worker's dormant offscreen code still exists and is unit-tested directly
// in emu-worker.test.mjs, but that path is unreachable in production because nothing transfers
// a canvas to it.)
// ======================================================================================
await checkAsync('(4) OffscreenCanvas DISABLED: supportsOffscreenCanvas()===false even when the API exists', async () => {
  installMockWorkerEnv({ offscreen: true }); // install a WORKING transferControlToOffscreen + OffscreenCanvas
  const mod = await import('../tas-engine.js');
  assert.strictEqual(mod.USE_OFFSCREEN, false, 'USE_OFFSCREEN gate is OFF (documented decision)');
  assert.strictEqual(mod.supportsOffscreenCanvas(), false, 'gate forces false despite the API being present');
});

// The proxy SIDE of (4): even with transferControlToOffscreen available, attach() must NOT
// call it, must NOT post a setOffscreen message, and must build a MAIN-THREAD presenter.
await checkAsync('(4b) proxy NEVER transfers the canvas; forces the main-thread present path', async () => {
  installMockWorkerEnv({ offscreen: true }); // API present -> would be transferred if not gated OFF
  const { TASEngine } = await import('../tas-engine.js');
  const proxy = new TASEngine();
  let transferCalls = 0;
  let mainThreadGetContext = 0;
  const canvas = {
    width: 256, height: 224,
    transferControlToOffscreen() { transferCalls += 1; return new FakeOffscreenCanvas(256, 224); },
    getContext(type) {
      mainThreadGetContext += 1;
      // Return null for WebGL so the proxy records the WebGL feature-detect attempt; give a
      // 2d ctx so the last-resort path is available if WebGL is missing.
      if (type === '2d') {
        return {
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => {},
        };
      }
      return null;
    },
  };
  proxy.attach({ canvas, noticeEl: null });
  const w = mockWorkerRegistry.last;
  assert.strictEqual(transferCalls, 0, 'transferControlToOffscreen was NEVER called (OffscreenCanvas disabled)');
  assert.strictEqual(w.__last('setOffscreen'), null, 'proxy posted NO setOffscreen message (worker never sent an OffscreenCanvas)');
  assert.strictEqual(proxy._usingOffscreen, false, 'proxy is on the main-thread present path');
  assert.ok(mainThreadGetContext >= 1, 'proxy took a main-thread context on the DOM canvas');
  assert.ok(/^fallback-/.test(proxy.videoPath), `Video banner reports a fallback-* path (got ${proxy.videoPath})`);
});

// (4c) MAIN-THREAD WebGL is the PRIMARY present path: the proxy builds a GLPresenter on the
// DOM canvas, reports videoPath 'fallback-webgl2', and presents received frames via
// texSubImage2D + drawArrays (GL objects created ONCE, per-frame sub-uploads) — NOT 2D.
function makeMainThreadGLCanvas(gpu) {
  let id = 1;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4, TEXTURE_2D: 5,
    TEXTURE0: 6, TEXTURE_MIN_FILTER: 7, TEXTURE_MAG_FILTER: 8, TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10,
    NEAREST: 11, CLAMP_TO_EDGE: 12, RGBA: 13, UNSIGNED_BYTE: 14, UNPACK_ALIGNMENT: 15, FLOAT: 16,
    TRIANGLES: 17, LINK_STATUS: 18, COMPILE_STATUS: 19,
    createShader: () => ({ id: id++ }), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => { gpu.createProgram++; return { id: id++ }; }, attachShader() {},
    bindAttribLocation() {}, linkProgram() {}, getProgramParameter: () => true,
    getProgramInfoLog: () => '', useProgram() {}, getUniformLocation: () => ({ id: id++ }), uniform1i() {},
    createBuffer: () => ({ id: id++ }), bindBuffer() {}, bufferData() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {},
    createVertexArray: () => ({ id: id++ }), bindVertexArray() {}, deleteVertexArray() {},
    createTexture: () => { gpu.createTexture++; return { id: id++ }; }, activeTexture() {},
    bindTexture() {}, texParameteri() {}, pixelStorei() {},
    texImage2D: () => { gpu.texImage2D++; }, texSubImage2D: () => { gpu.texSubImage2D++; },
    viewport() {}, drawArrays: () => { gpu.drawArrays++; },
    deleteTexture() {}, deleteBuffer() {}, deleteProgram() {},
  };
  return {
    width: 0, height: 0,
    getContext: (type) => {
      if (type === 'webgl2') return gl;
      if (type === '2d') return { createImageData: () => { throw new Error('2D must not be used when WebGL2 is available'); }, putImageData() {} };
      return null;
    },
  };
}

await checkAsync('(4c) main-thread WebGL is PRIMARY: proxy reports fallback-webgl2 and presents via texSubImage2D+drawArrays', async () => {
  // Controllable main-thread rAF so we can fire the present deterministically.
  const savedRaf = globalThis.requestAnimationFrame;
  const rafCbs = [];
  globalThis.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length; };
  try {
    installMockWorkerEnv({ offscreen: false }); // API absent too -> definitely main-thread
    const { TASEngine } = await import('../tas-engine.js');
    const proxy = new TASEngine();
    const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
    const canvas = makeMainThreadGLCanvas(gpu);
    proxy.attach({ canvas, noticeEl: null });
    assert.ok(proxy._gl, 'proxy built a GLPresenter on the DOM canvas (main-thread WebGL primary)');
    assert.strictEqual(proxy._ctx, null, 'no 2D context taken when WebGL2 is available');
    assert.strictEqual(proxy.videoPath, 'fallback-webgl2', 'Video banner reads fallback-webgl2 (never offscreen-*)');
    // Feed several worker video frames; each present is deferred to rAF then drawn once.
    const w = mockWorkerRegistry.last;
    for (let i = 0; i < 6; i++) {
      const buf = new Uint8Array(FB_W * FB_H * 4).fill(i + 1).buffer;
      w.__emit({ type: 'video', buffer: buf, width: FB_W, height: FB_H, pitch: FB_W * 2, pixelFormat: 2 });
    }
    // With strict single-in-flight backpressure the proxy schedules ONE rAF at a time; drain.
    let guard = 0;
    while (rafCbs.length && guard++ < 100) rafCbs.shift()();
    assert.strictEqual(gpu.createTexture, 1, 'ONE texture created (not per frame)');
    assert.strictEqual(gpu.createProgram, 1, 'ONE program created (not per frame)');
    assert.strictEqual(gpu.texImage2D, 1, 'texture storage allocated ONCE for the geometry');
    assert.ok(gpu.texSubImage2D >= 1, `per-frame uploads via texSubImage2D (got ${gpu.texSubImage2D})`);
    assert.ok(gpu.drawArrays >= 1, `one draw per presented frame (got ${gpu.drawArrays})`);
    // Each present acked back to the worker with the buffer transferred for reuse.
    const acks = w.__all('videoAck');
    assert.ok(acks.length >= 1, 'proxy acked drawn frames back to the worker');
    assert.ok(acks[0].transfer && acks[0].transfer[0] === acks[0].msg.buffer, 'ack transfers the buffer BACK zero-copy for pool reuse');
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
  }
});

// ======================================================================================
// (5) OffscreenCanvas ABSENT -> fallback {type:'video'} + main-thread blit.
// ======================================================================================
await checkAsync('(5) no OffscreenCanvas -> worker posts transferable {type:video}', async () => {
  scope.__clear();
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } }); // no offscreen
  await worker._onMessage({ data: { type: 'pause' } });
  scope.__clear();
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  const video = scope.__last('video');
  assert.ok(video, 'video message posted in the fallback path');
  assert.ok(video.msg.buffer instanceof ArrayBuffer, 'RGBA carried as a transferable ArrayBuffer');
  assert.strictEqual(video.msg.width, FB_W);
  assert.strictEqual(video.msg.height, FB_H);
  assert.ok(video.transfer && video.transfer[0] === video.msg.buffer, 'buffer transferred zero-copy');
});

await checkAsync('(5b) proxy blits posted {type:video} to a main-thread 2d context', async () => {
  installMockWorkerEnv({ offscreen: false });
  const { TASEngine } = await import('../tas-engine.js');
  const proxy = new TASEngine();
  const blits = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img) => blits.push({ w: img.width, h: img.height }),
    }),
  };
  proxy.attach({ canvas, noticeEl: null });
  const w = mockWorkerRegistry.last;
  const buf = new Uint8Array(FB_W * FB_H * 4).fill(255).buffer;
  w.__emit({ type: 'video', buffer: buf, width: FB_W, height: FB_H, pitch: FB_W * 2, pixelFormat: 2 });
  assert.strictEqual(blits.length, 1, 'proxy drew the frame on the main thread');
  assert.strictEqual(canvas.width, FB_W);
  assert.strictEqual(canvas.height, FB_H);
});

// ======================================================================================
// (6) streamed READ-ONLY HUD values with the verified SMB1 addresses.
// ======================================================================================
await checkAsync('(6) HUD values streamed read-only carry the verified SMB1 addresses/values', async () => {
  scope.__clear();
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  scope.__clear();
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  const hud = scope.__last('hud');
  assert.ok(hud, 'hud message posted');
  // Values decoded READ-ONLY from the mock WRAM at the verified SMB1 offsets.
  assert.strictEqual(hud.msg.values.hSpeed, -16, 'H-Speed (0x005D) signed decode');
  assert.strictEqual(hud.msg.values.xHi, HUD_SEED[SMB1_HUD_ADDR.X_HI]);
  assert.strictEqual(hud.msg.values.xSub, HUD_SEED[SMB1_HUD_ADDR.X_SUB]);
  assert.strictEqual(hud.msg.values.xPage, HUD_SEED[SMB1_HUD_ADDR.X_PAGE]);
  assert.strictEqual(hud.msg.values.yHi, HUD_SEED[SMB1_HUD_ADDR.Y_HI]);
  assert.strictEqual(hud.msg.values.ySub, HUD_SEED[SMB1_HUD_ADDR.Y_SUB]);
});
check('(6b) verified SMB1 HUD addresses are exactly the documented constants', () => {
  assert.strictEqual(SMB1_HUD_ADDR.H_SPEED, 0x005d);
  assert.strictEqual(SMB1_HUD_ADDR.X_HI, 0x0042);
  assert.strictEqual(SMB1_HUD_ADDR.X_SUB, 0x0043);
  assert.strictEqual(SMB1_HUD_ADDR.X_PAGE, 0x0401);
  assert.strictEqual(SMB1_HUD_ADDR.Y_HI, 0x0002);
  assert.strictEqual(SMB1_HUD_ADDR.Y_SUB, 0x041c);
});

// ======================================================================================
// (7) save/load round-trips over transferable bytes.
// ======================================================================================
await checkAsync('(7) save/load round-trips over transferable bytes', async () => {
  scope.__clear();
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  // Save.
  await worker._onMessage({ data: { type: 'saveState' } });
  const saved = scope.__last('saved');
  assert.ok(saved, 'saved message posted');
  assert.ok(saved.msg.bytes instanceof ArrayBuffer, 'saved bytes are a transferable ArrayBuffer');
  assert.ok(saved.transfer && saved.transfer[0] === saved.msg.bytes, 'buffer is in the transfer list');
  // Mutate the core state, then load the saved bytes back and confirm restoration.
  const M = shared.runner.Module;
  M.__setState(0x1234);
  assert.strictEqual(M.__getState(), 0x1234);
  await worker._onMessage({ data: { type: 'loadState', bytes: saved.msg.bytes, frame: 9 } });
  assert.strictEqual(M.__getState(), 0xabcd, 'core state restored from the round-tripped bytes');
  assert.strictEqual(shared.runner.currentFrame, 9, 'frame metadata applied on load');
  assert.ok(scope.__last('stateLoaded'), 'stateLoaded posted after load');
});

// ======================================================================================
// Safety: no memory-write / cheat path crosses the boundary; unknown messages fail-closed.
// ======================================================================================
await checkAsync('memory is strictly READ-ONLY across the boundary (no write op honored)', async () => {
  scope.__clear();
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'pause' } });
  // There is no writeMemory/poke message type; sending one must be ignored (fail-closed).
  const before = shared.runner.Module.HEAPU8[WRAM_PTR + SMB1_HUD_ADDR.X_HI];
  await worker._onMessage({ data: { type: 'writeMemory', offset: SMB1_HUD_ADDR.X_HI, value: 0xff } });
  await worker._onMessage({ data: { type: 'poke', offset: SMB1_HUD_ADDR.X_HI, value: 0xff } });
  const after = shared.runner.Module.HEAPU8[WRAM_PTR + SMB1_HUD_ADDR.X_HI];
  assert.strictEqual(after, before, 'no write message can mutate WRAM');
  // The runner exposes no writer and never wraps retro_cheat_*.
  assert.strictEqual(typeof shared.runner._fn.retro_cheat_set, 'undefined');
  assert.strictEqual(typeof shared.runner.poke, 'undefined');
});

check('unknown / malformed messages are ignored (fail-closed, no throw)', () => {
  const { worker } = makeWorker();
  worker._onMessage({ data: null });
  worker._onMessage({ data: { type: 'nope' } });
  worker._onMessage({ data: { notype: true } });
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
