// tas-engine.js
//
// The THIN MAIN-THREAD PROXY for the SNES TAS Studio emulator.
//
// WHY THIS IS A PROXY (the user's bug): a synchronous WASM libretro core on the main thread
// starves iOS Safari's UI — touch/DOM events are swallowed and the emulator crawls. So the
// ENTIRE emulator (WASM instantiation, libretro cwrap ABI, retro_run, save/load, READ-ONLY
// WRAM reads, framebuffer decode) now runs in a dedicated MODULE Web Worker (emu-worker.js,
// hosting emu-core-runner.js). This file no longer does ANY synchronous WASM work: it owns
// only the worker handle + the canvas presentation, and forwards commands / mirrors state
// over postMessage. There are NO retro_* cwrap/addFunction/retro_run calls here anymore.
//
// PUBLIC API PRESERVED (so app.js / piano-roll.js / memory-watch.js keep working): the
// default export `engine`, window.TASEngine, and the TASEngine class name are unchanged, and
// the same method shape is kept:
//   attach({canvas,noticeEl}) init() play() pause() togglePause() frameAdvance()
//   setSpeed(mult) fastForward(on) setCore(path) saveState() loadState(bytes,{frame})
//   onFrame(cb) onStatus(cb) onStateLoaded(cb) getMemoryView() (streamed HUD view)
//   plus synced fields: currentFrame status coreStatus romStatus engineStatus activeCoreId.
//
// VIDEO (OffscreenCanvas): attach() FEATURE-DETECTS transferControlToOffscreen + an
// OffscreenCanvas 2d context. If supported, it transfers control of #screen to the worker
// (postMessage as a transferable) so the WORKER blits directly — the main thread never takes
// a 2d context on that canvas (a transferred canvas cannot getContext('2d') on the main
// thread). If NOT supported, the proxy keeps the 2d context and blits {type:'video'} frames
// the worker posts. BOTH paths are implemented here.
//
// INPUT DETERMINISM: the authoritative scripted InputLog lives in the WORKER. The UI sends
// {type:'inputEdit'} edits and streams {type:'liveMask'} each animation frame; the worker
// resolves (log.getMask(frame) | liveMask) >>> 0 at the instant it runs each frame. This
// proxy exposes helpers (sendInputEdit / sendLiveMask) that piano-roll.js drives.
//
// GRACEFUL DEGRADATION: a missing worker/core/ROM renders a notice + disabled state and never
// throws, never opens a file picker. HARD RULES: memory is READ-ONLY (HUD values only cross
// the boundary — no write path); no cheat/level-select; retro_cheat_* is never wrapped.

'use strict';

import { CORE_CATALOG, coreById } from './core/core-loader.js';
// Re-export the extracted runner + verified HUD address map so consumers can reach them from
// one place (the runner itself now executes inside the worker, not on the main thread).
export { EmuCoreRunner, SMB1_HUD_ADDR } from './emu-core-runner.js';

// The exact ROM path the app auto-boots. No file picker anywhere. (The worker performs the
// actual fetch; kept exported here for back-compat with any consumer/tests.)
export const ROM_PATH = 'assets/Super Mario All-Stars (USA).sfc';

// libretro device id for the standard joypad; button bit layout (RETRO_DEVICE_ID_JOYPAD_*).
export const JOYPAD = Object.freeze({
  B: 0,
  Y: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
});

/**
 * Feature-detect OffscreenCanvas support: both transferControlToOffscreen on the canvas
 * prototype AND an OffscreenCanvas that can hand out a 2d context. Returns false in any
 * environment (older Safari, jsdom) where either is missing, so the proxy falls back to
 * main-thread blitting of posted {type:'video'} frames.
 */
export function supportsOffscreenCanvas() {
  try {
    if (typeof HTMLCanvasElement === 'undefined') return false;
    if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') return false;
    if (typeof OffscreenCanvas === 'undefined') return false;
    // Probe a real 2d context (some engines expose the class without 2d support).
    const probe = new OffscreenCanvas(1, 1);
    const ctx = typeof probe.getContext === 'function' ? probe.getContext('2d') : null;
    return !!ctx;
  } catch (_err) {
    return false;
  }
}

/**
 * The main-thread TAS engine PROXY. A single instance is created and exposed as
 * window.TASEngine. It creates the emulator worker, forwards commands, and mirrors the
 * worker's status/frame/hud state so the banner + piano-roll + HUD read it without blocking.
 */
class TASEngine {
  constructor() {
    // Mirrored core/engine state (kept in sync from worker 'status' / 'frame' messages so the
    // banner, piano-roll current-frame, and HUD read these synchronously without blocking).
    this.status = 'idle'; // idle | loading | ready | running | disabled | error
    this.coreStatus = 'Idle';
    this.romStatus = 'Idle';
    this.romBytes = 0;
    this.engineStatus = 'Init';
    this.currentFrame = 0;
    this.paused = true;
    this.speed = 1.0;
    this._activeCoreId = null;

    // The latest HUD values streamed from the worker (read READ-ONLY there). memory-watch.js
    // renders from these via getMemoryView() — no synchronous WRAM read on the main thread.
    this._hudValues = null;

    // Worker handle + readiness.
    this.worker = null;
    this._workerReady = false;
    this._usingOffscreen = false;

    // Canvas presentation (fallback path only — when OffscreenCanvas is unavailable).
    this.canvas = null;
    this._ctx = null;
    this._imageData = null;
    this._fbWidth = 0;
    this._fbHeight = 0;

    // Notice banner element (set via attach()).
    this._noticeEl = null;

    // Subscriber registries fed by worker messages.
    this._onFrameCbs = [];
    this._onStateLoadedCbs = [];
    this._onStatusCbs = [];

    // Pending save-state resolvers (saveState() returns a Promise resolved by 'saved').
    this._saveWaiters = [];

    this._onWorkerMessage = this._onWorkerMessage.bind(this);
  }

  // ------------------------------------------------------------------ attach / notices

  /**
   * Wire the engine to DOM elements and create the worker. Safe to call before init().
   *
   * ORDERING (critical): the OffscreenCanvas transfer must happen HERE, before anything on
   * the main thread ever calls getContext('2d') on #screen. Once control is transferred, the
   * main thread can no longer get a 2d context on that canvas. So attach() decides the video
   * path FIRST: if OffscreenCanvas is supported, transfer control to the worker and take NO
   * main-thread context; otherwise keep the 2d context here for the fallback blit path.
   *
   * @param {{canvas?:HTMLCanvasElement, noticeEl?:HTMLElement}} els
   */
  attach(els = {}) {
    if (els.noticeEl) this._noticeEl = els.noticeEl;
    if (els.canvas) this.canvas = els.canvas;

    this._ensureWorker();

    if (els.canvas) {
      if (this.worker && supportsOffscreenCanvas()) {
        // Direct-blit path: transfer control of the canvas to the worker. Do NOT take a 2d
        // context on the main thread first — that would make transferControlToOffscreen throw.
        try {
          const offscreen = els.canvas.transferControlToOffscreen();
          this._usingOffscreen = true;
          this._postToWorker({ type: 'setOffscreen', canvas: offscreen }, [offscreen]);
        } catch (err) {
          // Transfer failed (e.g. a context was somehow already taken): fall back to main-thread blit.
          console.warn('[TASEngine] OffscreenCanvas transfer failed; using main-thread blit:', err);
          this._usingOffscreen = false;
          this._takeMainThreadContext(els.canvas);
        }
      } else {
        // Fallback path: keep the 2d context on the main thread and blit posted frames.
        this._usingOffscreen = false;
        this._takeMainThreadContext(els.canvas);
      }
    }
    return this;
  }

  _takeMainThreadContext(canvas) {
    try {
      this._ctx = canvas.getContext('2d', { alpha: false });
    } catch (err) {
      this._ctx = null;
      console.warn('[TASEngine] 2d context unavailable:', err);
    }
  }

  /** Render a non-blocking notice. Appends a line; never throws. */
  showNotice(message, level = 'warn') {
    try {
      if (this._noticeEl && typeof document !== 'undefined') {
        const line = document.createElement('div');
        line.className = `notice notice--${level}`;
        line.textContent = message;
        this._noticeEl.appendChild(line);
        this._noticeEl.hidden = false;
      }
      const logf = level === 'error' ? console.error : console.warn;
      logf('[TASEngine]', message);
    } catch (_err) {
      console.warn('[TASEngine]', message);
    }
  }

  clearNotices() {
    if (this._noticeEl) {
      this._noticeEl.innerHTML = '';
      this._noticeEl.hidden = true;
    }
  }

  // ------------------------------------------------------------------ worker plumbing

  /**
   * Create the emulator MODULE worker (once). On any failure (no Worker support, blocked
   * module worker) the proxy degrades to a disabled state with a notice — never throws.
   */
  _ensureWorker() {
    if (this.worker) return this.worker;
    try {
      if (typeof Worker !== 'function') {
        this._disable('Web Workers are unavailable in this browser.');
        return null;
      }
      this.worker = new Worker(new URL('./emu-worker.js', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', this._onWorkerMessage);
      this.worker.addEventListener('error', (ev) => {
        const msg = ev && ev.message ? ev.message : 'worker error';
        this.showNotice(`Emulator worker error: ${msg}`, 'error');
        this._setStatus({ engineStatus: 'Stopped' });
      });
      this.worker.addEventListener('messageerror', () => {
        this.showNotice('Emulator worker message error (deserialize failed).', 'error');
      });
    } catch (err) {
      this.worker = null;
      this._disable(`Failed to start emulator worker: ${err && err.message ? err.message : err}`);
      return null;
    }
    return this.worker;
  }

  _disable(message) {
    this.status = 'disabled';
    this.showNotice(message, 'error');
    this._setStatus({ coreStatus: 'Failed', engineStatus: 'Stopped' });
    this._emitFrame();
  }

  _postToWorker(msg, transfer) {
    const w = this._ensureWorker();
    if (!w) return;
    try {
      if (transfer && transfer.length) w.postMessage(msg, transfer);
      else w.postMessage(msg);
    } catch (err) {
      console.warn('[TASEngine] postMessage failed:', err);
    }
  }

  /** Handle a message from the worker: mirror state + fan out to subscribers. */
  _onWorkerMessage(ev) {
    const msg = ev && ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'status':
        this._applyStatusSnapshot(msg.snapshot);
        break;
      case 'frame':
        if (typeof msg.frame === 'number') this.currentFrame = msg.frame;
        if (typeof msg.status === 'string') {
          this.status = msg.status;
          this.paused = msg.status !== 'running';
        }
        this._emitFrame();
        break;
      case 'hud':
        this._hudValues = msg.values || null;
        break;
      case 'video':
        this._blitVideoMessage(msg);
        break;
      case 'saved':
        this._resolveSave(msg.bytes ? new Uint8Array(msg.bytes) : null);
        break;
      case 'stateLoaded':
        if (typeof msg.frame === 'number') this.currentFrame = msg.frame;
        this._emitStateLoaded(this.currentFrame);
        this._emitFrame();
        break;
      case 'ready':
        this._workerReady = true;
        if (msg.ok) this.clearNotices();
        break;
      case 'error':
        this.showNotice(msg.message || 'emulator worker error', 'error');
        break;
      default:
        break;
    }
  }

  _applyStatusSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if ('status' in snap) {
      this.status = snap.status;
      if (snap.status === 'running') this.paused = false;
      else if (snap.status === 'ready' || snap.status === 'disabled' || snap.status === 'error') {
        this.paused = true;
      }
    }
    if ('coreStatus' in snap) this.coreStatus = snap.coreStatus;
    if ('romStatus' in snap) this.romStatus = snap.romStatus;
    if ('romBytes' in snap) this.romBytes = snap.romBytes;
    if ('engineStatus' in snap) this.engineStatus = snap.engineStatus;
    if (typeof snap.frame === 'number') this.currentFrame = snap.frame;
    this._notifyStatus();
  }

  // ------------------------------------------------------------------ video (fallback blit)

  _blitVideoMessage(msg) {
    if (!this._ctx || this._usingOffscreen) return;
    const { buffer, width, height } = msg;
    if (!buffer || !width || !height) return;
    try {
      if (this._fbWidth !== width || this._fbHeight !== height || !this._imageData) {
        this._fbWidth = width;
        this._fbHeight = height;
        if (this.canvas) {
          this.canvas.width = width;
          this.canvas.height = height;
        }
        this._imageData = this._ctx.createImageData(width, height);
      }
      this._imageData.data.set(new Uint8Array(buffer));
      this._ctx.putImageData(this._imageData, 0, 0);
    } catch (err) {
      console.warn('[TASEngine] video blit failed:', err);
    }
  }

  // ------------------------------------------------------------------ status surface

  /**
   * Subscribe to diagnostic status updates for the on-screen debug banner. Fires immediately
   * with the current snapshot so late subscribers render at once. READ-ONLY status channel.
   */
  onStatus(cb) {
    if (typeof cb === 'function') {
      this._onStatusCbs.push(cb);
      try {
        cb(this.statusSnapshot());
      } catch (err) {
        console.warn('[TASEngine] onStatus callback error', err);
      }
    }
    return this;
  }

  statusSnapshot() {
    return {
      status: this.status,
      coreStatus: this.coreStatus,
      romStatus: this.romStatus,
      romBytes: this.romBytes,
      engineStatus: this.engineStatus,
      frame: this.currentFrame,
    };
  }

  /** Update mirrored status fields locally (used for proxy-side disabled/error states). */
  _setStatus(patch) {
    if (patch && typeof patch === 'object') {
      if ('coreStatus' in patch) this.coreStatus = patch.coreStatus;
      if ('romStatus' in patch) this.romStatus = patch.romStatus;
      if ('romBytes' in patch) this.romBytes = patch.romBytes;
      if ('engineStatus' in patch) this.engineStatus = patch.engineStatus;
    }
    this._notifyStatus();
  }

  _notifyStatus() {
    const snap = this.statusSnapshot();
    for (const cb of this._onStatusCbs) {
      try {
        cb(snap);
      } catch (err) {
        console.warn('[TASEngine] onStatus callback error', err);
      }
    }
  }

  // ------------------------------------------------------------------ init / boot

  /**
   * Initialize: tell the worker to load the core + ROM and auto-boot. Never throws; on a
   * missing worker/core/ROM the worker posts an 'error' and this proxy shows a notice and
   * stays in a disabled state (never a file picker).
   * @param {{corePaths?:string[]}} [opts]
   */
  async init(opts = {}) {
    const w = this._ensureWorker();
    if (!w) return { ok: false };
    this.status = 'loading';
    this.clearNotices();
    this._setStatus({ coreStatus: 'Loading', romStatus: 'Idle', romBytes: 0, engineStatus: 'Init' });

    const corePath = Array.isArray(opts.corePaths) && opts.corePaths.length ? opts.corePaths[0] : undefined;
    this._activeCoreId = this._idForPath(corePath);
    this._postToWorker({ type: 'init', corePath, asyncify: this._asyncifyForPath(corePath) });
    // Boot is asynchronous in the worker; state arrives via status/ready messages.
    return { ok: true };
  }

  _idForPath(corePath) {
    if (!corePath) return 'realtime';
    const entry = CORE_CATALOG.find((c) => c.path === corePath);
    return entry ? entry.id : null;
  }

  /** bsnes cores are ASYNCIFY (retro_run awaits); snes9x is synchronous. */
  _asyncifyForPath(corePath) {
    const id = this._idForPath(corePath);
    return id === 'accuracy' || id === 'performance';
  }

  // ------------------------------------------------------------------ core switching

  /**
   * Switch to a different emulator core at runtime. Messages the worker to tear the current
   * core down and load the selected one. Never throws; graceful on failure. CORE selection
   * only — never a ROM/level picker, grants no cheat/memory-write capability.
   * @param {string} corePath
   */
  async setCore(corePath) {
    if (typeof corePath !== 'string' || !corePath) return { ok: false };
    this._activeCoreId = this._idForPath(corePath);
    this._setStatus({ coreStatus: 'Loading' });
    this._postToWorker({ type: 'setCore', corePath, asyncify: this._asyncifyForPath(corePath) });
    return { ok: true };
  }

  // ------------------------------------------------------------------ run controls

  play() {
    this.paused = false;
    this._postToWorker({ type: 'play' });
  }

  pause() {
    this.paused = true;
    this._postToWorker({ type: 'pause' });
  }

  togglePause() {
    if (this.paused) this.play();
    else this.pause();
  }

  /** Set playback speed multiplier, clamped to [0.1, 2]. */
  setSpeed(mult) {
    const m = Number(mult);
    if (!Number.isFinite(m)) return;
    this.speed = Math.min(2, Math.max(0.1, m));
    this._postToWorker({ type: 'setSpeed', mult: this.speed });
  }

  /** Hold fast-forward (worker runs a burst of frames per tick). */
  fastForward(on = true) {
    this._postToWorker({ type: 'fastForward', on: !!on });
  }

  /** Advance EXACTLY one video frame (frame stepping) — the worker runs one retro_run. */
  frameAdvance() {
    this.paused = true;
    this._postToWorker({ type: 'frameAdvance' });
  }

  // ------------------------------------------------------------------ input (to worker)

  /**
   * Forward a scripted-input edit to the worker's authoritative InputLog. op is one of
   * 'setFrameButton' | 'truncateAfter' | 'restoreSnapshot' (see input-resolver.js INPUT_OP).
   * This is the ONLY mutation of scripted input that crosses the boundary — controller input
   * only, never a memory write.
   */
  sendInputEdit(edit) {
    if (!edit || typeof edit.op !== 'string') return;
    this._postToWorker({ type: 'inputEdit', ...edit });
  }

  /** Stream the latest live controller/touch mask; the worker OR-s it into the next frame. */
  sendLiveMask(mask) {
    const m = Number.isFinite(mask) ? mask >>> 0 : 0;
    this._postToWorker({ type: 'liveMask', mask: m });
  }

  // ------------------------------------------------------------------ save states

  /**
   * Ask the worker to serialize state. Returns a Promise that resolves with a Uint8Array (or
   * null). Callers that ignore the Promise still work — the value simply isn't awaited.
   * @returns {Promise<Uint8Array|null>}
   */
  saveState() {
    const w = this._ensureWorker();
    if (!w) return Promise.resolve(null);
    return new Promise((resolve) => {
      this._saveWaiters.push(resolve);
      this._postToWorker({ type: 'saveState' });
    });
  }

  _resolveSave(bytesOrNull) {
    const waiter = this._saveWaiters.shift();
    if (waiter) {
      try {
        waiter(bytesOrNull);
      } catch (_err) {
        /* ignore */
      }
    }
  }

  /**
   * Restore emulator state in the worker. Fires onStateLoaded (via the worker's 'stateLoaded'
   * message) so the UI truncates future inputs (TAS re-recording).
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{frame?:number}} [meta]
   * @returns {boolean} whether a load command was dispatched
   */
  loadState(bytes, meta = {}) {
    if (!bytes) return false;
    const w = this._ensureWorker();
    if (!w) return false;
    let buffer;
    if (bytes instanceof ArrayBuffer) buffer = bytes.slice(0);
    else if (bytes && bytes.buffer) buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    else return false;
    if (!buffer || !buffer.byteLength) return false;
    this._postToWorker({ type: 'loadState', bytes: buffer, frame: meta.frame }, [buffer]);
    return true;
  }

  /** Register a callback fired after a state load, for re-record input truncation. */
  onStateLoaded(cb) {
    if (typeof cb === 'function') this._onStateLoadedCbs.push(cb);
    return this;
  }

  _emitStateLoaded(frame) {
    for (const cb of this._onStateLoadedCbs) {
      try {
        cb(frame);
      } catch (err) {
        console.warn('[TASEngine] onStateLoaded callback error', err);
      }
    }
  }

  // ------------------------------------------------------------------ memory (READ-ONLY)

  /**
   * A STRICTLY READ-ONLY view over the streamed HUD values for memory-watch.js. The worker
   * reads the verified SMB1 WRAM addresses READ-ONLY each frame and streams a small values
   * object ({ hSpeed, xHi, xSub, xPage, yHi, ySub, x, y }) via 'hud' messages. This proxy
   * surfaces those values through read accessors keyed by WRAM OFFSET so memory-watch.js's
   * existing readU8(addr) calls keep working — there is NO write path across the boundary and
   * NO way to poke/inject memory anywhere.
   *
   * @returns {{readU8:(offset:number)=>number, readS8:(offset:number)=>number, values:object}|null}
   */
  getMemoryView() {
    const v = this._hudValues;
    if (!v) return null;
    // Map verified SMB1 WRAM offsets -> the streamed values (read-only).
    const byOffset = {
      0x005d: v.hSpeed & 0xff, // H-Speed (stored signed; expose raw byte, memory-watch re-signs)
      0x0042: v.xHi, // byte read AT 0x0042 (X pixel/high)
      0x0043: v.xSub, // v.xSub holds the byte the worker read AT 0x0043 (X page, per memory-watch)
      0x0401: v.xPage, // v.xPage holds the byte the worker read AT 0x0401 (X sub-pixel, per memory-watch)
      0x0002: v.yHi,
      0x041c: v.ySub,
    };
    return Object.freeze({
      values: v,
      readU8(offset) {
        return offset in byOffset ? byOffset[offset] & 0xff : 0;
      },
      readS8(offset) {
        const u = offset in byOffset ? byOffset[offset] & 0xff : 0;
        return u >= 0x80 ? u - 0x100 : u;
      },
      // Kept for API parity; the streamed HUD does not carry arbitrary 16-bit reads.
      readU16(offset, littleEndian = true) {
        const lo = this.readU8(offset);
        const hi = this.readU8(offset + 1);
        return littleEndian ? lo | (hi << 8) : hi | (lo << 8);
      },
      readS16(offset, littleEndian = true) {
        const u = this.readU16(offset, littleEndian);
        return u >= 0x8000 ? u - 0x10000 : u;
      },
    });
  }

  /** The catalog id of the active core ('realtime' | 'accuracy' | 'performance'), or null. */
  get activeCoreId() {
    return this._activeCoreId;
  }

  // ------------------------------------------------------------------ frame callbacks

  /** Register a per-frame callback (invoked after each advanced frame). */
  onFrame(cb) {
    if (typeof cb === 'function') this._onFrameCbs.push(cb);
    return this;
  }

  _emitFrame() {
    for (const cb of this._onFrameCbs) {
      try {
        cb(this.currentFrame, this.status);
      } catch (err) {
        console.warn('[TASEngine] onFrame callback error', err);
      }
    }
  }
}

// Create and expose a singleton for the index.html bootstrap, memory-watch.js, and the UI.
const engine = new TASEngine();
if (typeof window !== 'undefined') {
  window.TASEngine = engine;
}

export default engine;
export { TASEngine };
