// tools/mock-worker.mjs
//
// Shared test scaffolding for the SNES TAS Studio worker-proxy harnesses (studio-dom,
// mobile-smoke, engine-smoke, worker-boundary). It installs a MOCK Worker class + a fake
// OffscreenCanvas/transferControlToOffscreen so tas-engine.js (the thin main-thread PROXY)
// can be exercised in Node/jsdom with NO real browser, NO real WASM.
//
// The mock is deliberately FAITHFUL, not a stub of the logic under test: the proxy's real
// attach()/init()/play()/pause()/frameAdvance()/setCore()/saveState()/loadState()/
// sendInputEdit()/sendLiveMask() run unmodified; the mock only stands in for the browser's
// Worker + OffscreenCanvas primitives. It CAPTURES every postMessage (with transfer list)
// the proxy sends, and lets a test push worker->main messages back so the proxy's state
// mirror + subscriber fan-out are asserted against the exact protocol.
//
// Import this BEFORE importing tas-engine.js so `new Worker(new URL(...), {type:'module'})`
// resolves to the mock.

'use strict';

/**
 * A fake OffscreenCanvas returned by transferControlToOffscreen(). Records blits so a test
 * can assert the worker-side direct-blit path (not exercised in the main-thread proxy, but
 * kept faithful so a transferred canvas behaves like a real one).
 */
export class FakeOffscreenCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.__blits = [];
    this.__transferred = true;
  }
  getContext(type) {
    if (type !== '2d') return null;
    const self = this;
    return {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img) => self.__blits.push({ w: img.width, h: img.height }),
    };
  }
}

/**
 * The shared registry of live MockWorker instances. attach() creates exactly one worker, so
 * tests read `mockWorkerRegistry.last` to reach it after engine.attach(...).
 */
export const mockWorkerRegistry = {
  instances: [],
  get last() {
    return this.instances[this.instances.length - 1] || null;
  },
  reset() {
    this.instances.length = 0;
  },
};

/**
 * A minimal Worker stand-in. It records outgoing postMessage calls (+ transfer lists) and
 * dispatches inbound worker->main messages the test injects via __emit(). It supports the
 * EventTarget-style addEventListener('message'|'error'|'messageerror') the proxy uses.
 */
export class MockWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.posted = [];
    this._listeners = { message: [], error: [], messageerror: [] };
    mockWorkerRegistry.instances.push(this);
  }
  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer: transfer || null });
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    if (arr) {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  terminate() {
    this._terminated = true;
  }

  // --- test helpers ---------------------------------------------------------------------

  /** Push a worker->main message to the proxy (as if the worker posted it). */
  __emit(data) {
    for (const fn of this._listeners.message) fn({ data });
  }
  /** Fire an 'error' event at the proxy. */
  __error(message) {
    for (const fn of this._listeners.error) fn({ message });
  }
  /** The last posted message of a given type (or the last of any if type omitted). */
  __last(type) {
    for (let i = this.posted.length - 1; i >= 0; i--) {
      if (!type || (this.posted[i].msg && this.posted[i].msg.type === type)) return this.posted[i];
    }
    return null;
  }
  /** All posted messages of a given type. */
  __all(type) {
    return this.posted.filter((p) => p.msg && p.msg.type === type);
  }
  /** Clear the recorded outgoing messages. */
  __clear() {
    this.posted.length = 0;
  }
}

/**
 * Install the mock Worker + OffscreenCanvas primitives onto globalThis so the proxy's
 * feature-detect (supportsOffscreenCanvas) and worker creation resolve to the mock.
 *
 * @param {{ offscreen?: boolean }} [opts] offscreen:true installs a working
 *   HTMLCanvasElement.prototype.transferControlToOffscreen + OffscreenCanvas so the proxy
 *   takes the OffscreenCanvas transfer path; offscreen:false (default) leaves them absent so
 *   the proxy takes the main-thread {type:'video'} blit fallback.
 */
export function installMockWorkerEnv(opts = {}) {
  mockWorkerRegistry.reset();
  globalThis.Worker = MockWorker;

  if (!opts.offscreen) {
    // Ensure a prior offscreen install does not leak into a fallback-path test.
    removeOffscreenSupport();
  }

  if (opts.offscreen) {
    globalThis.OffscreenCanvas = FakeOffscreenCanvas;
    if (typeof globalThis.HTMLCanvasElement === 'undefined') {
      // jsdom provides HTMLCanvasElement; a pure-Node run needs a shim so the prototype
      // feature-detect has somewhere to hang transferControlToOffscreen.
      globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
    }
    globalThis.HTMLCanvasElement.prototype.transferControlToOffscreen = function transferControlToOffscreen() {
      const off = new FakeOffscreenCanvas(this.width || 256, this.height || 224);
      this.__transferredTo = off;
      return off;
    };
  }
}

/** Remove the OffscreenCanvas support so the proxy falls back to main-thread blitting. */
export function removeOffscreenSupport() {
  if (globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype) {
    delete globalThis.HTMLCanvasElement.prototype.transferControlToOffscreen;
  }
  delete globalThis.OffscreenCanvas;
}
