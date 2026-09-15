// emu-worker.js
//
// The dedicated MODULE Web Worker that hosts the SNES emulator entirely OFF the main thread.
//
// WHY THIS EXISTS (the user's actual bug): a synchronous WASM libretro core running in the
// page's main thread on iOS Safari starves the UI — touch/DOM events are swallowed and the
// emulator crawls (~15 FPS). Moving WASM instantiation + retro_run into a worker lets the
// main thread do ONLY DOM + rendering, so touch is never blocked. This file is the worker
// side of that split; tas-engine.js is the thin main-thread proxy that talks to it.
//
// It runs an EmuCoreRunner (emu-core-runner.js — the DOM-free libretro glue) and owns the
// AUTHORITATIVE scripted InputLog through an InputResolver (input-resolver.js). All three
// shipping cores are built with `-s ENVIRONMENT=web,worker,node`, so a dynamic import() of a
// core INSIDE this module worker works (core/core-loader.js is used unchanged).
//
// ============================ MESSAGE PROTOCOL ============================
// IN  (main -> worker):
//   { type:'init', corePath?, offscreen?:OffscreenCanvas, asyncify? }
//   { type:'setOffscreen', canvas:OffscreenCanvas }        // transferable
//   { type:'play' } | { type:'pause' } | { type:'frameAdvance' }
//   { type:'setSpeed', mult } | { type:'fastForward', on }
//   { type:'setCore', corePath, asyncify? }
//   { type:'inputEdit', op:'setFrameButton'|'truncateAfter'|'restoreSnapshot', ... }
//   { type:'liveMask', mask }                              // streamed each frame
//   { type:'saveState' }
//   { type:'loadState', bytes:ArrayBuffer, frame }         // bytes transferable
// OUT (worker -> main):
//   { type:'status', snapshot } | { type:'frame', frame, status } | { type:'hud', values }
//   { type:'video', buffer:ArrayBuffer, width, height, pitch, pixelFormat }  // fallback only
//   { type:'saved', bytes:ArrayBuffer }                    // transferable
//   { type:'stateLoaded', frame } | { type:'error', message } | { type:'ready', ok, ... }
//
// ==================== DETERMINISM GUARANTEE (sacrosanct) ====================
// The worker MUST NOT run frame N without frame N's input. Scripted input lives HERE in the
// InputResolver's authoritative InputLog (mutated only by 'inputEdit' messages). The live
// controller/touch mask is snapshotted on the main thread and streamed via 'liveMask'; the
// worker holds the MOST-RECENT live mask and OR-s it in at the exact moment retro_run pulls
// input for the frame it is about to run. The runner calls getFrameInputMask(frame) from
// INSIDE retro_run (via retro_set_input_state), and that resolver returns exactly:
//
//     (log.getMask(frame) | latestLiveMask) >>> 0
//
// so frame N is always run with exactly frame N's resolved input. A 'frameAdvance' message
// triggers EXACTLY one retro_run with that frame's resolved input (EmuCoreRunner.frameAdvance).
//
// ==================== OFFSCREENCANVAS TRANSFER ORDERING ====================
// When the main thread transfers an OffscreenCanvas (feature-detected there), the worker
// gets its 2d context HERE and blits decoded RGBA directly — no 'video' message crosses the
// boundary. If NO OffscreenCanvas was transferred, the worker posts a 'video' message with a
// transferable ArrayBuffer of decoded RGBA + dims/format and the main thread blits. Both
// paths use emu-core-runner.js's decoder (RGBA out); only the presentation differs.
//
// HARD RULES preserved: memory is STRICTLY READ-ONLY (HUD values only; no write path crosses
// the boundary); no cheat/level-select; retro_cheat_* is never wrapped; no file picker.

'use strict';

import { EmuCoreRunner } from './emu-core-runner.js';
import { InputResolver } from './input-resolver.js';
import { DEFAULT_CORE_PATHS } from './core/core-loader.js';

// The worker's global scope. In a module worker `self` is the DedicatedWorkerGlobalScope.
const workerScope = self;

/**
 * The worker-side controller: owns one EmuCoreRunner + one InputResolver, resolves per-frame
 * input deterministically, and marshals messages to/from the main-thread proxy.
 */
class EmuWorker {
  constructor(scope) {
    this.scope = scope;

    // Authoritative scripted input log lives HERE (determinism contract owner).
    this.resolver = new InputResolver();

    // Most-recent live controller/touch mask streamed from the main thread. It is OR-ed into
    // whatever frame retro_run is about to run — never persisted per-frame, so it cannot leak
    // from one frame to the next except as the "current live state" the TAS contract wants.
    this.liveMask = 0;

    // OffscreenCanvas + its 2d context (direct-blit path). Null when the main thread blits.
    this.offscreen = null;
    this.offCtx = null;
    this._offImageData = null;
    this._offW = 0;
    this._offH = 0;

    this.runner = null;
    this._corePath = null;
    this._asyncify = false;

    this._onMessage = this._onMessage.bind(this);
    scope.addEventListener('message', this._onMessage);
  }

  post(msg, transfer) {
    try {
      if (transfer && transfer.length) this.scope.postMessage(msg, transfer);
      else this.scope.postMessage(msg);
    } catch (err) {
      // A failed postMessage must never crash the worker.
      try {
        this.scope.postMessage({ type: 'error', message: `postMessage failed: ${String(err)}` });
      } catch (_e) {
        /* give up quietly */
      }
    }
  }

  // ------------------------------------------------------------------ runner factory

  /**
   * Build a fresh EmuCoreRunner wired to this worker's sinks + the deterministic input
   * source. The input source is called from INSIDE retro_run for the frame about to run, so
   * it resolves (scripted mask for that frame | latest live mask) — the determinism contract.
   */
  _makeRunner(asyncify) {
    return new EmuCoreRunner({
      asyncify: !!asyncify,
      // DETERMINISM: resolve the exact mask for the frame retro_run is currently executing.
      getFrameInputMask: (frame) => this.resolver.getFrameInputMask(frame, this.liveMask),
      onVideoFrame: (rgba, width, height, pitch, pixelFormat) =>
        this._presentFrame(rgba, width, height, pitch, pixelFormat),
      onHud: (values) => this.post({ type: 'hud', values }),
      onStatus: (snapshot) => this.post({ type: 'status', snapshot }),
      onFrame: (frame, status) => this.post({ type: 'frame', frame, status }),
      onStateLoaded: (frame) => this.post({ type: 'stateLoaded', frame }),
    });
  }

  // ------------------------------------------------------------------ video presentation

  /**
   * Present a decoded RGBA frame. Direct path: blit onto the transferred OffscreenCanvas's
   * 2d context in the worker. Fallback path: post the RGBA buffer to the main thread as a
   * transferable ArrayBuffer so it blits. Both receive the SAME decoded RGBA from the runner.
   */
  _presentFrame(rgba, width, height, pitch, pixelFormat) {
    if (this.offCtx) {
      this._blitOffscreen(rgba, width, height);
      return;
    }
    // Fallback: copy into a standalone ArrayBuffer and transfer it (zero-copy handoff). We
    // copy because `rgba` is the runner's reused framebuffer — transferring it would detach
    // the runner's buffer. A fresh copy keeps the runner's next-frame decode intact.
    const copy = new Uint8Array(width * height * 4);
    copy.set(rgba.subarray(0, copy.length));
    this.post(
      { type: 'video', buffer: copy.buffer, width, height, pitch, pixelFormat },
      [copy.buffer]
    );
  }

  _blitOffscreen(rgba, width, height) {
    try {
      if (this.offscreen && (this.offscreen.width !== width || this.offscreen.height !== height)) {
        this.offscreen.width = width;
        this.offscreen.height = height;
        this._offImageData = null;
      }
      if (!this._offImageData || this._offW !== width || this._offH !== height) {
        // ImageData is available in workers; prefer the ctx factory when present.
        if (typeof this.offCtx.createImageData === 'function') {
          this._offImageData = this.offCtx.createImageData(width, height);
        } else if (typeof ImageData !== 'undefined') {
          this._offImageData = new ImageData(width, height);
        } else {
          return;
        }
        this._offW = width;
        this._offH = height;
      }
      this._offImageData.data.set(rgba.subarray(0, width * height * 4));
      this.offCtx.putImageData(this._offImageData, 0, 0);
    } catch (err) {
      this.post({ type: 'error', message: `offscreen blit failed: ${String(err)}` });
    }
  }

  /** Adopt a transferred OffscreenCanvas and take its 2d context in the worker. */
  _adoptOffscreen(canvas) {
    if (!canvas) return;
    this.offscreen = canvas;
    this._offImageData = null;
    this._offW = 0;
    this._offH = 0;
    try {
      this.offCtx =
        typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: false }) : null;
    } catch (err) {
      this.offCtx = null;
      this.post({ type: 'error', message: `OffscreenCanvas 2d unavailable: ${String(err)}` });
    }
  }

  // ------------------------------------------------------------------ boot / core swap

  async _boot(corePath, asyncify) {
    this._corePath = corePath || null;
    this._asyncify = !!asyncify;
    this.runner = this._makeRunner(this._asyncify);
    const corePaths = corePath ? [corePath] : DEFAULT_CORE_PATHS;
    let result;
    try {
      result = await this.runner.boot({ corePaths });
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (result && result.ok) {
      // Auto-play on boot, matching the main-thread engine's old init() behavior.
      this.runner.start();
    } else {
      this.post({
        type: 'error',
        message:
          result && result.error
            ? `core boot failed: ${result.error}`
            : 'core or ROM unavailable (worker disabled)',
      });
    }
    this.post({ type: 'ready', ok: !!(result && result.ok), coreOk: result && result.coreOk, romOk: result && result.romOk });
    return result;
  }

  async _setCore(corePath, asyncify) {
    const wasRunning = this.runner && this.runner.status === 'running' && !this.runner.paused;
    if (this.runner) {
      try {
        this.runner.teardown();
      } catch (_err) {
        /* best-effort */
      }
    }
    const result = await this._boot(corePath, asyncify);
    // _boot auto-plays; if the user had paused before the swap, honor that.
    if (result && result.ok && !wasRunning && this.runner) {
      this.runner.pause();
    }
    return result;
  }

  // ------------------------------------------------------------------ message handling

  async _onMessage(ev) {
    const msg = ev && ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'init': {
          if (msg.offscreen) this._adoptOffscreen(msg.offscreen);
          await this._boot(msg.corePath, msg.asyncify);
          break;
        }
        case 'setOffscreen': {
          this._adoptOffscreen(msg.canvas);
          break;
        }
        case 'play':
          if (this.runner) this.runner.start();
          break;
        case 'pause':
          if (this.runner) this.runner.pause();
          break;
        case 'frameAdvance':
          // EXACTLY one retro_run with exactly that frame's resolved input.
          if (this.runner) await Promise.resolve(this.runner.frameAdvance());
          break;
        case 'setSpeed':
          if (this.runner) this.runner.setSpeed(msg.mult);
          break;
        case 'fastForward':
          if (this.runner) this.runner.fastForward(!!msg.on);
          break;
        case 'setCore':
          await this._setCore(msg.corePath, msg.asyncify);
          break;
        case 'inputEdit':
          // Mutate the AUTHORITATIVE scripted log (setFrameButton/truncateAfter/restoreSnapshot).
          this.resolver.applyEdit(msg);
          break;
        case 'liveMask':
          // Hold the latest live mask; it is OR-ed into the frame retro_run runs next.
          this.liveMask = Number.isFinite(msg.mask) ? msg.mask >>> 0 : 0;
          break;
        case 'saveState': {
          const bytes = this.runner ? this.runner.saveState() : null;
          if (bytes && bytes.byteLength) {
            // Transfer the underlying buffer (zero-copy). saveState() already returns a
            // standalone Uint8Array, so detaching its buffer is safe.
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            this.post({ type: 'saved', bytes: buf }, [buf]);
          } else {
            this.post({ type: 'saved', bytes: null });
          }
          break;
        }
        case 'loadState': {
          if (this.runner && msg.bytes) {
            const view = msg.bytes instanceof ArrayBuffer ? new Uint8Array(msg.bytes) : new Uint8Array(msg.bytes.buffer || msg.bytes);
            this.runner.loadState(view, { frame: msg.frame });
          }
          break;
        }
        default:
          // Unknown message: ignore (fail-closed, never throw).
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err && err.message ? err.message : err) });
    }
  }
}

// Instantiate the worker controller as soon as the module loads so it is ready to receive
// messages (the main-thread proxy posts 'init' immediately after constructing the worker).
// Guarded so `node --check` / a non-worker import never explodes.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  // eslint-disable-next-line no-new
  new EmuWorker(workerScope);
}

export { EmuWorker };
