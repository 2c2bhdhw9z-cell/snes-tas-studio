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
//   { type:'videoAck', buffer:ArrayBuffer }                // fallback: drawn-frame buffer back (reuse)
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
//   { type:'videoPath', path }                             // active present path (banner diag)
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
// ==================== LOOP DRIVER: HARDWARE VSYNC (rAF) BACKPRESSURE ====================
// The emulator run/present loop is bound to the DISPLAY REFRESH so the GPU command queue can
// never flood (the iOS 60->12 decay). There is EXACTLY ONE loop driver active at a time
// (rAF XOR the MessageChannel/injected scheduler), selected by whether the worker presents
// onto a transferred OffscreenCanvas:
//
//   * OFFSCREEN present path (worker owns the canvas) + self.requestAnimationFrame available:
//     the runner's self-scheduling loop is driven by `self.requestAnimationFrame`. In a
//     dedicated worker that was transferred an OffscreenCanvas, rAF IS available and is
//     display-refresh-driven (~60Hz). It gives IMPLICIT WebGL backpressure: the browser will
//     not schedule the next rAF until the previous frame's GL commands are consumed/presented,
//     so the command queue cannot grow unbounded. Each rAF: (1) run the target-time
//     accumulator to advance emulation up to real time (bounded catch-up = MAX_CATCHUP_FRAMES,
//     so a slow device FRAME-SKIPS instead of bursting); (2) present EXACTLY ONE frame — the
//     LATEST decoded frame — via the GL presenter (never multiple draws per rAF, even under a
//     catch-up burst or fast-forward); (3) rAF again. Emulation stays paced to real time (60
//     at 1x, 30 at 0.5x); present is paced to vsync (one draw per refresh).
//
//   * FALLBACK present path (no OffscreenCanvas; MAIN thread presents) — see tas-engine.js:
//     the worker posts frames and gates the next post on a MAIN-THREAD requestAnimationFrame
//     ACK (the proxy presents inside its own rAF, then acks). in-flight is bounded to <= 1.
//
//   * HEADLESS / non-presenting (Node, tests): no rAF -> the MessageChannel one-shot yield
//     (defaultScheduleYield) drives the loop. Tests inject their own scheduler. rAF is
//     feature-detected; when absent the loop uses the injected/MessageChannel scheduler.
//
// IRONY/HISTORY: an earlier task deliberately decoupled the frame pump from any present ACK
// (a free-running MessageChannel yield) to break a ~30fps ACK-starvation cadence lock. That
// decoupling is what let the GPU command queue flood on iOS. rAF is the correct render-loop
// pacing primitive: it is DISPLAY-driven (not work-driven), so it reintroduces present
// backpressure WITHOUT the old work-coalesced cadence stall.
//
// ==================== OFFSCREENCANVAS TRANSFER ORDERING ====================
// When the main thread transfers an OffscreenCanvas (feature-detected there), the worker
// PRESENTS decoded RGBA directly onto it HERE — no 'video' message crosses the boundary. The
// present path is WebGL (gl-presenter.js: ONE texture/program/quad, per-frame texSubImage2D)
// whenever WebGL is available on the transferred canvas, falling back to a 2D putImageData
// context only if WebGL is unavailable. WebGL is the iOS-native-leak fix — repeated
// getContext('2d')/putImageData blits leak native memory on iOS even when JS pools perfectly.
// If NO OffscreenCanvas was transferred, the worker posts a 'video' message with a
// transferable ArrayBuffer of decoded RGBA + dims/format and the MAIN thread presents it
// (also via WebGL, falling back to 2D). Both paths use emu-core-runner.js's decoder (RGBA
// out); only the presentation surface differs. The ACTIVE path is reported via 'videoPath'.
//
// HARD RULES preserved: memory is STRICTLY READ-ONLY (HUD values only; no write path crosses
// the boundary); no cheat/level-select; retro_cheat_* is never wrapped; no file picker.

'use strict';

import { EmuCoreRunner } from './emu-core-runner.js';
import { InputResolver } from './input-resolver.js';
import { DEFAULT_CORE_PATHS } from './core/core-loader.js';
import { createGLPresenter } from './gl-presenter.js';

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

    // OffscreenCanvas presentation (direct-present path). Null when the main thread presents.
    //
    // PRIMARY: a WebGL presenter (gl-presenter.js) — ONE texture + ONE program + ONE quad,
    // created once, per-frame texSubImage2D upload + draw. This is the iOS-native-leak fix:
    // it never allocates a per-frame ImageData/2D-canvas blit, which is what iOS Safari leaks.
    // LAST RESORT: a 2D putImageData context, used only if WebGL is unavailable on the
    // transferred OffscreenCanvas in this environment.
    this.offscreen = null;
    this.offGL = null; // GLPresenter | null (primary offscreen present path)
    this.offCtx = null; // 2d context | null (fallback offscreen present path)
    this._offImageData = null;
    this._offW = 0;
    this._offH = 0;

    // ---- rAF loop driver (hardware-vsync present backpressure) ----
    // When the worker presents onto a transferred OffscreenCanvas AND self.requestAnimationFrame
    // is available, the runner's loop is driven by rAF (display-refresh-paced, implicit WebGL
    // backpressure) instead of the free-running MessageChannel pump. Exactly ONE driver is
    // active at a time (rAF XOR MessageChannel), decided by _usingRafDriver().
    this._rafAvailable = typeof this.scope.requestAnimationFrame === 'function';
    // When the rAF driver is active the runner must NOT present per emulated frame (that is the
    // open-loop GPU flood). Instead each rAF tick decodes emulation frames into the runner's
    // reused RGBA buffer, and we present EXACTLY the LATEST one ONCE after the tick. This holds
    // the latest decoded frame between the runner's onVideoFrame and the post-tick present.
    this._pendingPresent = null; // { rgba, width, height } | null (coalesced-to-latest frame)
    this._rafHandle = 0;

    // The ACTIVE video path, surfaced to the main thread (and on to the debug banner) so the
    // device can report which renderer actually engaged. One of:
    //   'offscreen-webgl2' | 'offscreen-webgl1' | 'offscreen-2d'  (worker presents)
    //   'fallback-webgl2'  | 'fallback-webgl1'  | 'fallback-2d'   (main thread presents)
    //   'none' (no canvas yet)
    // On the fallback path the WORKER only decodes+posts; the ACTUAL renderer lives on the
    // main thread, so the worker reports 'fallback-*' and the proxy refines it to the exact
    // renderer it created (webgl2/webgl1/2d) and shows that in the banner.
    this.videoPath = 'none';

    // ---- Fallback video path: BACKPRESSURE + BUFFER REUSE (steady-decay fix) ----
    // The fallback posts decoded RGBA to the main thread. Two mechanisms prevent the
    // monotonic FPS decay the user saw:
    //  (1) BACKPRESSURE: at most ONE undrawn frame is ever outstanding. While a posted frame
    //      is unacked the worker DROPS newer frames (present is best-effort — video may drop
    //      intermediate frames; emulation keeps running at 60 regardless). This decouples
    //      PRESENT from COMPUTE and means a slow drawer causes frame DROPS, never an unbounded
    //      postMessage queue that bloats memory and thrashes GC.
    //  (2) BUFFER REUSE: instead of a fresh ~229KB Uint8Array every frame, buffers are pooled
    //      and the main thread transfers the buffer BACK on ack so the worker reuses it. This
    //      eliminates the per-frame allocation / GC churn.
    this._videoInFlight = false; // a posted frame is awaiting a videoAck
    this._videoPool = []; // reusable ArrayBuffers ping-ponged with the main thread
    this._VIDEO_POOL_MAX = 3; // small cap; we never need more than a couple in flight

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
      // LOOP DRIVER: bind the run/present loop to the display refresh whenever the worker is
      // presenting onto a transferred OffscreenCanvas and rAF is available. Decided per-tick so
      // a later setOffscreen transfer switches drivers correctly. When the rAF driver is NOT
      // active (headless / fallback present) this returns undefined so the runner uses its own
      // defaultScheduleYield (MessageChannel one-shot) — exactly ONE driver is ever active.
      scheduleYield: (cb) => this._scheduleLoopTurn(cb),
    });
  }

  /** Is the worker driving the run loop from hardware vsync (rAF on the offscreen path)? */
  _usingRafDriver() {
    return this._rafAvailable && (this.offGL != null || this.offCtx != null);
  }

  /**
   * Schedule ONE run-loop turn (the runner's _tick). This is the single loop-driver seam:
   *   * rAF driver (offscreen present + rAF available): schedule the tick on the NEXT display
   *     refresh via self.requestAnimationFrame, then PRESENT exactly the latest decoded frame
   *     ONCE after the tick runs. This is the hardware-vsync backpressure — the browser will
   *     not fire the next rAF until the previous frame's GL commands are consumed, so the GPU
   *     command queue can never flood, and we never issue more than one draw per refresh.
   *   * otherwise (headless / fallback): defer to the runner's default MessageChannel/injected
   *     scheduler by delegating to defaultScheduleYield semantics — but since scheduleYield is
   *     injected, we replicate the default here (MessageChannel one-shot / setTimeout / micro).
   * Returns an opaque handle the runner cancels via its _cancelYield (objects/ids tolerated).
   */
  _scheduleLoopTurn(cb) {
    if (this._usingRafDriver()) {
      const raf = this.scope.requestAnimationFrame.bind(this.scope);
      const handle = raf(() => {
        this._rafHandle = 0;
        // Run the emulation tick (target-time accumulator; bounded catch-up; may run 0..N
        // retro_run, each decoding into the runner's reused RGBA buffer and calling
        // onVideoFrame -> _presentFrame, which under the rAF driver only STASHES the latest).
        // For an ASYNCIFY core the tick is async (awaits each retro_run); flush AFTER it
        // resolves so we still present exactly one frame per rAF. For the synchronous core the
        // tick returns undefined and we flush immediately. Either way: ONE present per refresh.
        const r = cb();
        if (r && typeof r.then === 'function') {
          r.then(() => this._flushPresent(), () => this._flushPresent());
        } else {
          this._flushPresent();
        }
      });
      this._rafHandle = handle;
      // Tag the handle so the runner's _cancelYield can cancel a pending rAF.
      return { kind: 'raf', id: handle, scope: this.scope };
    }
    // Non-presenting / headless: use the same MessageChannel-first yield the runner defaults to
    // (no rAF here). This keeps a single active driver: the MessageChannel one-shot.
    if (typeof MessageChannel === 'function') {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => {
        mc.port1.onmessage = null;
        cb();
      };
      mc.port2.postMessage(0);
      return { kind: 'messagechannel', channel: mc };
    }
    if (typeof setTimeout === 'function') {
      return { kind: 'timeout', id: setTimeout(cb, 0) };
    }
    Promise.resolve().then(cb);
    return { kind: 'microtask' };
  }

  /**
   * Present the single latest decoded frame stashed this rAF turn (coalesced present). Called
   * once per display refresh, AFTER the emulation tick — so even a catch-up burst or a
   * fast-forward burst (many retro_run this turn) yields EXACTLY ONE texSubImage2D+draw.
   * No-op when nothing new was decoded this turn (keeps the queue empty rather than redrawing).
   */
  _flushPresent() {
    const p = this._pendingPresent;
    if (!p) return;
    this._pendingPresent = null;
    this._drawOffscreen(p.rgba, p.width, p.height);
  }

  /** Draw one decoded RGBA frame directly onto the transferred OffscreenCanvas (GL or 2D). */
  _drawOffscreen(rgba, width, height) {
    if (this.offGL) {
      try {
        this.offGL.present(rgba, width, height);
      } catch (err) {
        this.post({ type: 'error', message: `offscreen GL present failed: ${String(err)}` });
      }
      return;
    }
    if (this.offCtx) this._blitOffscreen(rgba, width, height);
  }

  // ------------------------------------------------------------------ video presentation

  /**
   * Present a decoded RGBA frame. Direct path: blit onto the transferred OffscreenCanvas's
   * 2d context in the worker. Fallback path: post the RGBA buffer to the main thread as a
   * transferable ArrayBuffer so it blits. Both receive the SAME decoded RGBA from the runner.
   */
  _presentFrame(rgba, width, height, pitch, pixelFormat) {
    // OFFSCREEN present path (worker owns the canvas: WebGL primary, 2D last-resort).
    if (this.offGL || this.offCtx) {
      // rAF DRIVER + the loop is actively running: COALESCE. Do NOT draw here — stash the
      // LATEST decoded frame and let the per-rAF _flushPresent draw exactly ONE frame this
      // display refresh. This is what stops the open-loop GPU-command-queue flood: even if the
      // tick ran a catch-up/fast-forward burst of retro_run, only the last frame is drawn, once
      // per vsync, with implicit backpressure (the next rAF waits for the display).
      //
      // The runner reuses ONE RGBA buffer (_rgba) across frames, so stashing the reference is
      // safe: by the time _flushPresent runs after the tick, it holds the last decoded frame.
      if (this._usingRafDriver() && this.runner && this.runner._loopRunning) {
        this._pendingPresent = { rgba, width, height };
        return;
      }
      // Loop NOT running (frame-advance / paused one-shot) OR no rAF (headless offscreen):
      // present immediately as a single one-shot draw. Frame-advance is deliberately a separate
      // one-shot present, not the rAF loop.
      this._drawOffscreen(rgba, width, height);
      return;
    }
    // Fallback path. BACKPRESSURE: if the previous posted frame has not been drawn+acked yet,
    // DROP this frame (coalesce to the latest). Video is best-effort; the emulator keeps
    // running at full speed. This is what prevents the postMessage queue from growing unbounded
    // and dragging the framerate down over time.
    if (this._videoInFlight) return;

    const need = width * height * 4;
    // BUFFER REUSE: take a pooled buffer of the right size, else allocate once. We copy because
    // `rgba` is the runner's reused framebuffer — transferring it would detach the runner's
    // buffer. The main thread transfers this buffer BACK on ack, so it re-enters the pool and
    // there is NO per-frame allocation in steady state.
    let buffer = null;
    while (this._videoPool.length) {
      const b = this._videoPool.pop();
      if (b.byteLength === need) {
        buffer = b;
        break;
      }
      // Wrong size (geometry changed): drop it and keep looking / allocate fresh.
    }
    if (!buffer) buffer = new ArrayBuffer(need);

    new Uint8Array(buffer).set(rgba.subarray(0, need));
    this._videoInFlight = true;
    this.post(
      { type: 'video', buffer, width, height, pitch, pixelFormat },
      [buffer]
    );
  }

  /**
   * Main thread acks a drawn video frame, transferring the buffer BACK so the worker can
   * reuse it (buffer pool) and post the next frame. Clears the in-flight gate so the next
   * present is allowed. Never queues: while in-flight, presents are dropped.
   */
  _onVideoAck(buffer) {
    this._videoInFlight = false;
    if (buffer instanceof ArrayBuffer && this._videoPool.length < this._VIDEO_POOL_MAX) {
      this._videoPool.push(buffer);
    }
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

  /**
   * Adopt a transferred OffscreenCanvas and set up the WORKER-side presenter on it.
   *
   * PRIMARY: build a WebGL presenter (gl-presenter.js) — one texture/program/quad created
   * once, per-frame texSubImage2D uploads. This avoids the iOS-native leak of repeated
   * getContext('2d')/putImageData blits. FALLBACK (only if WebGL is unavailable on this
   * transferred OffscreenCanvas): take a 2D context and use putImageData as before.
   *
   * The resolved path is recorded in this.videoPath and reported to the main thread so the
   * debug banner shows which renderer is actually live on the device.
   */
  _adoptOffscreen(canvas) {
    if (!canvas) return;
    this.offscreen = canvas;
    this.offGL = null;
    this.offCtx = null;
    this._offImageData = null;
    this._offW = 0;
    this._offH = 0;

    // Try WebGL (WebGL2 preferred, WebGL1 fallback) FIRST.
    try {
      this.offGL = createGLPresenter(canvas, 'offscreen');
    } catch (_err) {
      this.offGL = null;
    }
    if (this.offGL) {
      this._setVideoPath(this.offGL.label); // 'offscreen-webgl2' | 'offscreen-webgl1'
      return;
    }

    // WebGL unavailable on this OffscreenCanvas: last-resort 2D putImageData.
    try {
      this.offCtx =
        typeof canvas.getContext === 'function'
          ? canvas.getContext('2d', { alpha: false, desynchronized: true })
          : null;
    } catch (err) {
      this.offCtx = null;
      this.post({ type: 'error', message: `OffscreenCanvas 2d unavailable: ${String(err)}` });
    }
    this._setVideoPath(this.offCtx ? 'offscreen-2d' : 'none');
  }

  /** Record the active video path and report it to the main thread (for the debug banner). */
  _setVideoPath(path) {
    this.videoPath = path;
    this.post({ type: 'videoPath', path });
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
          if (msg.offscreen) {
            this._adoptOffscreen(msg.offscreen);
          } else {
            // No OffscreenCanvas: the MAIN thread will present the posted frames. Report the
            // fallback path; the proxy refines it to the exact renderer it created.
            this._setVideoPath('fallback');
          }
          await this._boot(msg.corePath, msg.asyncify);
          break;
        }
        case 'setOffscreen': {
          this._adoptOffscreen(msg.canvas);
          break;
        }
        case 'videoAck':
          // Main thread finished drawing the last fallback frame and transferred its buffer
          // back for reuse. Release the backpressure gate + pool the buffer.
          this._onVideoAck(msg.buffer);
          break;
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
