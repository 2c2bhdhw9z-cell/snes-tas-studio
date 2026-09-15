// tools/single-thread-harness.mjs
//
// Shared test scaffolding for the SNES TAS Studio SINGLE-THREAD engine harnesses (engine-smoke,
// engine-determinism, studio-dom, mobile-smoke). It replaces the retired tools/mock-worker.mjs.
//
// THE GREAT REVERSAL (FEAT-002): the emulator no longer runs in a Web Worker. tas-engine.js is
// now a DIRECT single-thread engine that OWNS one EmuCoreRunner + one InputResolver + one
// GLPresenter and drives them from ONE requestAnimationFrame loop on the main thread. There is
// no Worker, no postMessage, no OffscreenCanvas anywhere. So the harnesses no longer install a
// mock Worker; instead they install:
//
//   (1) a CONTROLLABLE fake requestAnimationFrame / cancelAnimationFrame that QUEUES the
//       engine's per-turn callbacks and a MONOTONIC fake performance.now(), so a Node/jsdom
//       test can advance the engine's rAF loop deterministically. The engine reads
//       window.requestAnimationFrame / globalThis.requestAnimationFrame and the runner reads
//       performance.now() (via _now()), so driving those two is enough to pace the real loop.
//       flushRaf()/stepRaf(n) fire queued turns; each turn advances the fake clock by one
//       display-refresh interval FIRST so the runner's target-time accumulator releases frames.
//
//   (2) a MOCK libretro core factory (a fake Emscripten Module implementing cwrap/addFunction/
//       HEAP*/_malloc/_free/retro_*) so a REAL EmuCoreRunner boots against injected loadCore/
//       fetchRom with NO real WASM. Mirrors the mock-core pattern proven in
//       emu-core-runner.test.mjs / (the old) worker-boundary.test.mjs. retro_run fires the
//       registered video + input callbacks so determinism is exercised through the true ABI.
//
//   (3) a MOCK WebGL canvas so attach() can build a REAL GLPresenter (createGLPresenter) and
//       the engine's present path (texSubImage2D + drawArrays) can be counted per rAF.
//
// The engine constructs its runner internally in init() -> runner.boot(). To inject the mock
// core WITHOUT real WASM, a test overrides engine._makeRunner to return a REAL EmuCoreRunner
// wired to the same in-process sinks the engine uses, but with injected loadCore/fetchRom (the
// mock core) and the engine's own rAF scheduleYield. installEngineMockRunner() does exactly
// that, so the real single-thread rAF present-coalescing + the real runner accumulator + the
// real resolver determinism are all exercised (nothing under test is mocked away).

'use strict';

import { EmuCoreRunner, SMB1_HUD_ADDR } from '../emu-core-runner.js';

// One display-refresh interval (~60Hz). Each fake rAF turn advances the clock by this so the
// runner's target-time accumulator releases ~one emulated frame per turn at 1x.
export const REFRESH_MS = 1000 / 60;

// A small SNES-like framebuffer the mock core "renders" each frame (RGB565 red).
const FB_W = 4;
const FB_H = 2;
const RED565 = 0xf800;
const WRAM_PTR = 0x10000;

// Verified SMB1 HUD seed bytes, keyed by the WRAM offset each byte lives at. Distinct values
// per offset so a transpose bug (page vs sub-pixel) is caught by the determinism test.
export const HUD_SEED = {
  [SMB1_HUD_ADDR.H_SPEED]: 0xf0, // -16 as S8
  [SMB1_HUD_ADDR.X_HI]: 0x30,
  [SMB1_HUD_ADDR.X_SUB]: 0x80,
  [SMB1_HUD_ADDR.X_PAGE]: 0x02,
  [SMB1_HUD_ADDR.Y_HI]: 0xb0,
  [SMB1_HUD_ADDR.Y_SUB]: 0x40,
};

export { SMB1_HUD_ADDR, FB_W, FB_H };

// ------------------------------------------------------------------ fake rAF + clock

/**
 * Install a CONTROLLABLE requestAnimationFrame/cancelAnimationFrame + a monotonic
 * performance.now onto globalThis (and window if present). Returns a controller:
 *   flushRaf()  -> fire ALL queued turns once (each advances the clock one refresh), returns count
 *   stepRaf(n)  -> fire up to n queued turns (re-arming turns are drained up to n), returns count
 *   pending()   -> number of queued turns right now
 *   advance(ms) -> advance the fake clock without firing a turn (models a stall)
 *   now()       -> current fake clock value
 *   restore()   -> put back the saved globals
 *
 * The engine's _scheduleYield calls requestAnimationFrame(wrapper); wrapper runs the runner
 * tick then presents once. The runner's synchronous tick RE-ARMS the next turn (another
 * requestAnimationFrame) BEFORE running frames, so after a turn fires there is again exactly
 * one queued turn while the loop runs. flushRaf drains only the turns queued at call time;
 * stepRaf(n) keeps firing re-armed turns up to n so a test can run n refreshes.
 */
export function installFakeRaf(startClock = 100000) {
  const saved = {
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    perf: globalThis.performance,
    winRaf: typeof window !== 'undefined' ? window.requestAnimationFrame : undefined,
    winCaf: typeof window !== 'undefined' ? window.cancelAnimationFrame : undefined,
    hasWindow: typeof window !== 'undefined',
  };

  let clock = startClock;
  let nextId = 1;
  const queue = new Map(); // id -> callback

  const raf = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  const caf = (id) => {
    queue.delete(id);
  };

  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = caf;
  globalThis.performance = { now: () => clock };
  if (saved.hasWindow) {
    window.requestAnimationFrame = raf;
    window.cancelAnimationFrame = caf;
  }

  function fireOne() {
    // Drain the OLDEST queued turn; advance the clock one refresh FIRST so the accumulator is
    // due one frame. Insertion order of the Map preserves scheduling order.
    const [id, cb] = queue.entries().next().value;
    queue.delete(id);
    clock += REFRESH_MS;
    cb();
  }

  return {
    now: () => clock,
    pending: () => queue.size,
    advance: (ms) => {
      clock += ms;
    },
    flushRaf() {
      const n = queue.size;
      for (let i = 0; i < n; i++) {
        if (!queue.size) break;
        fireOne();
      }
      return n;
    },
    stepRaf(n) {
      let fired = 0;
      let guard = 0;
      while (fired < n && queue.size && guard++ < n * 8 + 16) {
        fireOne();
        fired += 1;
      }
      return fired;
    },
    restore() {
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
      globalThis.performance = saved.perf;
      if (saved.hasWindow) {
        window.requestAnimationFrame = saved.winRaf;
        window.cancelAnimationFrame = saved.winCaf;
      }
    },
  };
}

// ------------------------------------------------------------------ mock libretro core

/**
 * Build a MOCK Emscripten Module implementing the exact subset of the libretro ABI the
 * EmuCoreRunner wraps (cwrap, addFunction, HEAP typed arrays, _malloc, _free, retro_*). The
 * retro_run stub fires the
 * registered video-refresh callback (so onVideoFrame decodes an RGBA frame) and queries ALL 12
 * joypad ids through the registered input_state callback, recording the resolved mask into
 * `shared.resolvedPerFrame` so a test can prove frame N ran with exactly (log|live)>>>0.
 *
 * When `opts.asyncify` is true the retro_run stub returns a REAL Promise that resolves on a
 * microtask (modelling an Asyncify/libco suspension), so the runner's _tickAsync await path AND
 * the engine's `r.then(present)` deferred-present branch are genuinely exercised (not merely the
 * Promise.resolve() wrap the runner applies around a synchronous retro_run). `shared.inFlight`
 * tracks concurrent suspensions so a test can prove at most one is ever outstanding (libco).
 *
 * @param {{resolvedPerFrame:Array, currentFrameAtRun:()=>number, inFlight?:number, maxInFlight?:number}} shared
 * @param {{asyncify?:boolean}} [opts]
 */
export function makeMockModule(shared, opts = {}) {
  const asyncify = !!opts.asyncify;
  if (typeof shared.inFlight !== 'number') shared.inFlight = 0;
  if (typeof shared.maxInFlight !== 'number') shared.maxInFlight = 0;
  const HEAP_BYTES = 1 << 20;
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPU32 = new Uint32Array(buffer);
  const HEAPU16 = new Uint16Array(buffer);
  const HEAPF64 = new Float64Array(buffer);
  let bump = 0x40000;
  const _malloc = (n) => {
    const p = bump;
    bump += (n + 7) & ~7;
    return p;
  };
  const _free = () => {};
  for (const [off, val] of Object.entries(HUD_SEED)) HEAPU8[WRAM_PTR + Number(off)] = val;
  const FB_PTR = 0x20000;
  const FB_PITCH = FB_W * 2;
  for (let y = 0; y < FB_H; y++) {
    for (let x = 0; x < FB_W; x++) HEAPU16[(FB_PTR + y * FB_PITCH) / 2 + x] = RED565;
  }

  const table = [];
  const cbs = {};
  const addFunction = (fn) => {
    table.push(fn);
    return table.length;
  };
  let coreState = 0xabcd;
  const SERIALIZE_SIZE = 16;
  const noop = () => {};
  const fnTable = {
    retro_init: noop,
    retro_deinit: noop,
    retro_reset: noop,
    retro_unload_game: noop,
    retro_load_game: () => 1,
    retro_run: () => {
      const runBody = () => {
        const vcb = table[cbs.video - 1];
        if (typeof vcb === 'function') vcb(FB_PTR, FB_W, FB_H, FB_PITCH);
        const icb = table[cbs.input - 1];
        let mask = 0;
        if (typeof icb === 'function') {
          for (let id = 0; id < 12; id++) {
            const bit = icb(0, 1, 0, id);
            if (bit) mask |= 1 << id;
          }
        }
        shared.resolvedPerFrame.push({ frame: shared.currentFrameAtRun(), mask: mask >>> 0 });
      };
      if (!asyncify) {
        runBody();
        return undefined;
      }
      // ASYNCIFY: model a libco suspension. Fire the frame's video + input callbacks
      // synchronously (the frame's work happens at retro_run entry, exactly as a real core
      // does) then return a Promise that resolves on a microtask so the runner AWAITS it and
      // the engine DEFERS the present to the r.then branch. inFlight proves suspensions never
      // overlap: it is > 1 only if a second retro_run began before the first resolved.
      runBody();
      shared.inFlight += 1;
      if (shared.inFlight > shared.maxInFlight) shared.maxInFlight = shared.inFlight;
      return Promise.resolve().then(() => {
        shared.inFlight -= 1;
      });
    },
    retro_serialize_size: () => SERIALIZE_SIZE,
    retro_serialize: (ptr) => {
      HEAP32[ptr >> 2] = coreState;
      return 1;
    },
    retro_unserialize: (ptr) => {
      coreState = HEAP32[ptr >> 2];
      return 1;
    },
    retro_get_memory_data: (id) => (id === 2 ? WRAM_PTR : 0),
    retro_get_memory_size: (id) => (id === 2 ? 0x2000 : 0),
    retro_set_environment: (p) => {
      cbs.env = p;
    },
    retro_set_video_refresh: (p) => {
      cbs.video = p;
    },
    retro_set_audio_sample: (p) => {
      cbs.audioSample = p;
    },
    retro_set_audio_sample_batch: (p) => {
      cbs.audioBatch = p;
    },
    retro_set_input_poll: (p) => {
      cbs.inputPoll = p;
    },
    retro_set_input_state: (p) => {
      cbs.input = p;
    },
    retro_get_system_av_info: (ptr) => {
      HEAPU32[(ptr >> 2) + 0] = 256;
      HEAPU32[(ptr >> 2) + 1] = 224;
      HEAPF64[(ptr + 24) >> 3] = 60.098;
    },
  };
  const cwrap = (name) => {
    const fn = fnTable[name];
    if (!fn) throw new Error('unknown ' + name);
    return fn;
  };
  return {
    HEAPU8,
    HEAP32,
    HEAPU32,
    HEAPU16,
    HEAPF64,
    _malloc,
    _free,
    cwrap,
    addFunction,
    WRAM_PTR,
    __getState: () => coreState,
    __setState: (v) => {
      coreState = v;
    },
  };
}

/**
 * Override an engine instance's _makeRunner so init() boots a REAL EmuCoreRunner backed by the
 * mock core (no real WASM). The wiring mirrors the engine's own _makeRunner EXACTLY (same
 * getFrameInputMask resolving (log|live)>>>0, same onVideoFrame stash, same status/frame/state
 * sinks, same rAF scheduleYield), so the real single-thread pacing + present coalescing + the
 * real resolver determinism are all exercised. Returns `shared` for per-frame mask assertions.
 *
 * The engine passes asyncify=true to _makeRunner when it boots an ASYNCIFY core (bsnes
 * accuracy/performance), so pointing this at an accuracy/performance corePath makes the mock
 * retro_run return a real Promise and drives the engine's deferred-present (r.then) branch and
 * the runner's _tickAsync await path through the real rAF loop; shared.maxInFlight then proves
 * at most one suspension is outstanding.
 *
 * @param {import('../tas-engine.js').TASEngine} engine
 * @param {string} corePath the corePath the mock loadCore reports (default snes9x)
 */
export function installEngineMockRunner(engine, corePath = 'cores/snes9x_libretro.js') {
  const shared = {
    resolvedPerFrame: [],
    runner: null,
    currentFrameAtRun: () => 0,
    module: null,
    inFlight: 0,
    maxInFlight: 0,
  };
  engine._makeRunner = function (asyncify) {
    // Model a genuine Asyncify suspension when the engine boots an ASYNCIFY core (bsnes), so
    // the mock retro_run returns a real Promise and the engine's deferred-present branch runs.
    const mod = makeMockModule(shared, { asyncify: !!asyncify });
    shared.module = mod;
    const runner = new EmuCoreRunner({
      asyncify: !!asyncify,
      getFrameInputMask: (frame) => this._resolver.getFrameInputMask(frame, this._liveMask),
      onVideoFrame: (rgba, width, height) => {
        this._pendingFrame = { rgba, width, height };
      },
      onHud: () => {},
      onStatus: (snap) => this._applyStatusSnapshot(snap),
      onFrame: (frame, status) => {
        if (typeof frame === 'number') this.currentFrame = frame;
        if (typeof status === 'string') {
          this.status = status;
          this.paused = status !== 'running';
        }
        this._emitFrame();
      },
      onStateLoaded: (frame) => {
        if (typeof frame === 'number') this.currentFrame = frame;
        this._emitStateLoaded(this.currentFrame);
        this._emitFrame();
      },
      loadCore: async () => ({ ok: true, Module: mod, corePath }),
      fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
      scheduleYield: this._scheduleYield,
    });
    shared.runner = runner;
    shared.currentFrameAtRun = () => runner.currentFrame;
    return runner;
  };
  return shared;
}

// ------------------------------------------------------------------ mock WebGL canvas

/**
 * A canvas-like object exposing a MOCK WebGL2 context so attach() builds a REAL GLPresenter and
 * the engine's present path can be counted. gpu tallies createTexture/createProgram/texImage2D/
 * texSubImage2D/drawArrays so a test can assert GL objects are created ONCE and each present is
 * exactly one texSubImage2D + drawArrays. Pass { webgl:false } to force the 2D/none path.
 *
 * @param {{gpu?:object, webgl?:boolean}} [opts]
 */
export function makeGLCanvas(opts = {}) {
  const gpu = opts.gpu || { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
  const webgl = opts.webgl !== false;
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
  const canvas = {
    width: 0,
    height: 0,
    __gpu: gpu,
    getContext: (type) => {
      if (webgl && type === 'webgl2') return gl;
      if (type === '2d') {
        return {
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {},
        };
      }
      return null;
    },
  };
  return canvas;
}

/** A 2D-only canvas (no WebGL) so the engine takes the last-resort main-2d present path. */
export function make2DCanvas() {
  const blits = [];
  const canvas = {
    width: 0,
    height: 0,
    __blits: blits,
    getContext: (type) => {
      if (type !== '2d') return null;
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => blits.push({ w: img.width, h: img.height }),
      };
    },
  };
  return canvas;
}
