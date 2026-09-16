// tas-engine.js
//
// The SINGLE-THREAD MAIN-THREAD engine for the SNES TAS Studio emulator.
//
// THE GREAT REVERSAL (why this is no longer a worker proxy): the emulator used to run in a
// dedicated Web Worker to keep the main thread free for touch/DOM. That was a misdiagnosis.
// The main thread only ever choked because of three now-fixed bugs: a setTimeout(0) clamp
// that half-vsync-locked the loop, ~300 DOM nodes/sec banner+HUD churn, and a per-frame HUD
// object allocation storm. Those are ALL fixed (cached DOM nodes mutated in place, one reused
// HUD values object, a bounded target-time accumulator). snes9x executes retro_run in ~1.2ms,
// which fits comfortably inside a 16.6ms frame budget without blocking touch. The Web Worker
// added cross-thread message-passing latency, transferable pooling, and iOS WebKit bridging
// that were themselves incompatible with iOS Safari's GC at 60Hz (the decay persisted even on
// the worker-computes + main-thread-WebGL fallback path). So the emulator moves BACK onto the
// main thread and runs in ONE tight requestAnimationFrame loop. There is no cross-thread
// machinery of any kind (no background thread, no cross-thread messaging, no cross-thread
// canvas transfer) anywhere in this file or the running app.
//
// rAF LOOP DESIGN - CHOICE A (the engine owns the rAF loop):
//   The engine owns exactly ONE requestAnimationFrame loop. It drives the reused EmuCoreRunner
//   by injecting an rAF-based scheduleYield into the runner, so the runner's existing
//   target-time accumulator loop (bounded catch-up MAX_CATCHUP_FRAMES, speed 0.1-2x,
//   fast-forward burst, frame-skip beyond the clamp) is paced by rAF instead of a macrotask
//   channel. rAF gives native vsync pacing + implicit GL backpressure.
//
//   Each rAF tick runs, IN ORDER:
//     (a) INPUTS: resolved inside retro_run via the injected getFrameInputMask, which returns
//         (log.getMask(frame) | liveMask) >>> 0 - the determinism contract.
//     (b) RUN: the runner's accumulator advances emulation up to real time (1-2 retro_run at
//         1x = ~60/sec, ~30/sec at 0.5x; frame-skip beyond the clamp; NO death-spiral burst).
//         Each retro_run fires onVideoFrame DURING the run; the engine's onVideoFrame sink
//         only STASHES the latest decoded frame (coalesce to latest - it never draws here).
//     (c) HUD: the runner's onHud fires per advanced frame and updates the cached HUD values;
//         memory-watch.js reads the runner's cached READ-ONLY view via getMemoryView().
//     (d) PRESENT: AFTER the tick completes, the engine presents the SINGLE latest stashed
//         frame ONCE via GLPresenter.present (texSubImage2D + drawArrays), or a 2D
//         putImageData context as the last resort. Exactly ONE present per rAF even under a
//         catch-up or fast-forward burst.
//
//   ASYNCIFY (bsnes accuracy/performance): retro_run may return a Promise (libco/Asyncify can
//   have at most one suspension outstanding). The runner's _tickAsync awaits each retro_run;
//   the engine's rAF wrapper AWAITS the runner's tick before presenting the stashed frame and
//   before scheduling the next rAF, so only one suspension is ever outstanding and exactly one
//   present happens per rAF. snes9x (synchronous) presents immediately after the tick.
//
// PUBLIC API PRESERVED (so app.js / piano-roll.js / memory-watch.js keep working unchanged):
// the default export `engine`, window.TASEngine, and the TASEngine class name are unchanged,
// and the same method shape is kept:
//   attach({canvas,noticeEl}) init({corePaths}) play() pause() togglePause() frameAdvance()
//   setSpeed(mult) fastForward(on) setCore(path) saveState() loadState(bytes,{frame})
//   onFrame(cb) onStatus(cb) onStateLoaded(cb) getMemoryView() sendLiveMask(mask)
//   sendInputEdit(edit) statusSnapshot() (includes videoPath)
//   plus the blindfold diagnostic: setBlindfold(on) isBlindfold() and a `blindfold` property
//   plus teardown() (stops the resume listeners + the in-process runner; used by init/setCore)
//   plus synced fields: currentFrame paused status coreStatus romStatus romBytes engineStatus
//   speed activeCoreId. Exported ROM_PATH + JOYPAD + re-exported EmuCoreRunner + SMB1_HUD_ADDR.
//
// VIDEO (MAIN-THREAD present): attach() builds a GLPresenter directly on the DOM canvas via
// createGLPresenter(canvas, 'main') - ONE texture/program/quad, per-frame texSubImage2D +
// drawArrays (no per-frame putImageData). A 2D putImageData context is kept ONLY as a last
// resort when WebGL is unavailable (e.g. jsdom). The active present path is surfaced in the
// status snapshot (videoPath): 'main-webgl2' | 'main-webgl1' | 'main-2d'. On-device steady-FPS
// is the final judge of the reversal.
//
// INPUT DETERMINISM: the authoritative scripted InputLog lives IN-PROCESS in an InputResolver.
// piano-roll.js sends scripted edits via sendInputEdit() and streams the live controller/touch
// mask via sendLiveMask(); the runner resolves (log.getMask(frame) | liveMask) >>> 0 at the
// instant retro_run pulls input for the frame it is about to run.
//
// BLINDFOLD MODE (the "blindfold test" diagnostic, DEFAULT OFF):
// The FPS decay has survived the removal of the JS heap, the WASM heap, transferable memory,
// OffscreenCanvas and the ENTIRE Web Worker bridge. Two suspects remain: (1) the snes9x WASM
// core leaking/fragmenting per retro_run, or (2) iOS Safari leaking natively inside
// gl.texSubImage2D / main-thread WebGL presentation. Blindfold mode isolates them by running
// EVERYTHING as normal - the rAF loop, input resolution, retro_run at the same cadence with the
// same accumulator + bounded catch-up, the framebuffer DECODE into the reused RGBA buffer, HUD
// reads, onFrame emission and the FPS meter - while performing NO GPU/canvas work at all: the
// SINGLE choke point _present() early-returns before any texSubImage2D / drawArrays /
// putImageData call. Interpretation on device: FPS still decays to ~8 => the WASM core is the
// leak (swap cores next); FPS holds at 60 => Apple's WebGL/present path is the leak (find a
// non-WebGL present path).
//
// DELIBERATE CHOICE: presenter SETUP is left completely UNCHANGED (attach() still creates the
// GL context, texture, program and quad exactly as today, and videoPath still reports the real
// context label). Only the PER-FRAME upload+draw is skipped, so the ONE variable between the
// two runs is the per-frame GPU work - not context creation, not decode, not pacing.
// Blindfold is OFF on a fresh load unless it is explicitly requested, and can be driven three
// ways: the URL (?blindfold=1, alias ?noPresent=1), the on-screen "Blindfold (no present)"
// checkbox in #frame-controls, or window.TASEngine.setBlindfold(true|false) / isBlindfold().
// The active mode is surfaced in the status snapshot (videoPath gains a
// ' (BLINDFOLD: no present)' suffix, plus explicit `blindfold` / `present` fields) so the
// on-screen debug banner makes it unmistakable which mode produced a given FPS number.
//
// GRACEFUL DEGRADATION: a missing core/ROM renders a notice + disabled state and never throws,
// never opens a file picker. HARD RULES: memory is STRICTLY READ-ONLY (read accessors only, no
// write/poke/inject anywhere); no cheat/level-select; retro_cheat_* is never wrapped; the ROM
// auto-boots from the fixed ROM_PATH (no file picker).

'use strict';

import { CORE_CATALOG } from './core/core-loader.js';
import { createGLPresenter } from './gl-presenter.js';
import { EmuCoreRunner } from './emu-core-runner.js';
import { InputResolver } from './input-resolver.js';
// Re-export the runner + verified HUD address map so consumers can reach them from one place.
export { EmuCoreRunner, SMB1_HUD_ADDR } from './emu-core-runner.js';

// The exact ROM path the app auto-boots. No file picker anywhere. (The runner performs the
// actual fetch from this path; kept exported here for back-compat with any consumer/tests.)
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
 * Parse the BLINDFOLD (no-present) diagnostic flag out of a URL query string. Pure + exported
 * so it can be unit-tested without a browser.
 *
 * Accepted (case-insensitive keys): `blindfold` and its alias `noPresent`/`nopresent`.
 *   ?blindfold=1 | =true | =on | =yes | bare ?blindfold  -> true
 *   ?blindfold=0 | =false | =off | =no | absent          -> false (the DEFAULT)
 * A bare key with no '=' counts as ON so a phone-typed `?blindfold` works.
 *
 * @param {string} search a location.search style string (with or without the leading '?')
 * @returns {boolean} whether blindfold mode was requested at boot
 */
export function parseBlindfoldParam(search) {
  if (typeof search !== 'string' || !search) return false;
  const q = search.charAt(0) === '?' ? search.slice(1) : search;
  if (!q) return false;
  let on = false;
  for (const part of q.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key;
    try {
      key = decodeURIComponent(rawKey).trim().toLowerCase();
    } catch (_err) {
      key = rawKey.trim().toLowerCase();
    }
    if (key !== 'blindfold' && key !== 'nopresent' && key !== 'no-present') continue;
    if (eq === -1) {
      on = true; // bare ?blindfold
      continue;
    }
    let val;
    try {
      val = decodeURIComponent(part.slice(eq + 1)).trim().toLowerCase();
    } catch (_err) {
      val = part.slice(eq + 1).trim().toLowerCase();
    }
    // An explicit falsy value turns it OFF (so ?blindfold=0 behaves as today).
    on = !(val === '0' || val === 'false' || val === 'off' || val === 'no');
  }
  return on;
}

/** Read the boot-time blindfold flag from the current location, if any. Never throws. */
function readBlindfoldFromLocation() {
  try {
    const loc =
      (typeof window !== 'undefined' && window.location) ||
      (typeof globalThis !== 'undefined' && globalThis.location) ||
      null;
    if (!loc || typeof loc.search !== 'string') return false;
    return parseBlindfoldParam(loc.search);
  } catch (_err) {
    return false;
  }
}

/**
 * The main-thread, single-threaded TAS engine. A single instance is created and exposed as
 * window.TASEngine. It OWNS one EmuCoreRunner + one InputResolver + one GLPresenter and drives
 * them from ONE requestAnimationFrame loop on the main thread. No background thread, no
 * cross-thread messaging.
 */
class TASEngine {
  constructor() {
    // Mirrored core/engine state (kept in sync from the runner's sinks so the banner,
    // piano-roll current-frame, and HUD read these synchronously).
    this.status = 'idle'; // idle | loading | ready | running | disabled | error
    this.coreStatus = 'Idle';
    this.romStatus = 'Idle';
    this.romBytes = 0;
    this.engineStatus = 'Init';
    this.currentFrame = 0;
    this.paused = true;
    this.speed = 1.0;
    this._activeCoreId = null;

    // The authoritative scripted InputLog now lives IN-PROCESS in this resolver. The live
    // controller/touch mask is held here and OR-ed into the frame retro_run runs next.
    this._resolver = new InputResolver();
    this._liveMask = 0;

    // The in-process libretro core runner (built lazily so attach() can precede init()).
    this.runner = null;
    this._asyncify = false;

    // Canvas presentation (MAIN THREAD). PRIMARY: a WebGL presenter (gl-presenter.js) uploading
    // the decoded RGBA into ONE texture via texSubImage2D + drawArrays. LAST RESORT: a 2D
    // putImageData context, used only if WebGL is unavailable on the DOM canvas (e.g. jsdom).
    this.canvas = null;
    this._gl = null; // GLPresenter | null (primary present path)
    this._ctx = null; // 2d context | null (last-resort present path)
    this._imageData = null;
    this._fbWidth = 0;
    this._fbHeight = 0;

    // The single latest decoded frame stashed by the onVideoFrame sink, presented ONCE per
    // rAF tick (coalesce to latest). The runner reuses ONE RGBA buffer across frames, so
    // stashing the reference is safe: by the time we present after the tick it holds the last
    // decoded frame. { rgba, width, height } | null.
    this._pendingFrame = null;

    // The active video present path string, surfaced in the status snapshot for the debug
    // banner: 'main-webgl2' | 'main-webgl1' | 'main-2d' | 'none'. This always reports the REAL
    // present path the presenter set up, even while blindfold mode suppresses the per-frame
    // upload+draw (setup is deliberately unchanged - see the BLINDFOLD note in the header).
    this.videoPath = 'none';

    // BLINDFOLD (no-present) DIAGNOSTIC MODE. DEFAULT OFF: a fresh load behaves exactly as
    // before. When ON, _present() early-returns before ANY GL/2D call, so no texSubImage2D, no
    // drawArrays and no putImageData happens - while the rAF loop, input resolution, retro_run
    // cadence, framebuffer DECODE, HUD reads, onFrame emission and the FPS meter all run
    // completely unchanged. Requested at boot via ?blindfold=1 (alias ?noPresent=1), toggled
    // live from the on-screen checkbox, or set programmatically via setBlindfold().
    this._blindfold = readBlindfoldFromLocation();

    // rAF loop state (the engine owns exactly ONE requestAnimationFrame loop).
    this._rafHandle = 0;
    this._loopActive = false;
    // Bound scheduler injected into the runner so its accumulator loop is rAF-paced and the
    // engine presents exactly one frame per rAF after each tick.
    this._scheduleYield = this._scheduleYield.bind(this);

    // ---------------- ZERO-CHURN rAF SCHEDULING (see _scheduleYield) ----------------
    // The scheduling path used to allocate FIVE objects per animation frame: a fresh
    // `requestAnimationFrame.bind(scope)`, a fresh arrow passed to rAF, a fresh
    // `{kind:'raf', id, scope}` handle, and (on the ASYNCIFY path) two more arrows for
    // `r.then(onOk, onErr)`. At 60Hz that is ~300 avoidable allocations/sec feeding the GC for
    // the entire session. Everything below is created ONCE and REUSED every turn, so the steady
    // state allocates nothing per turn while the loop semantics are unchanged.
    this._rafFn = null; // cached BOUND requestAnimationFrame
    this._rafRawFn = null; // the scope's rAF identity the cache was built from
    this._rafScopeRef = null; // the scope the cache was bound to
    this._pendingTickCb = null; // the runner tick for the ONE outstanding turn
    this._rafTurn = () => this._runTurn(); // ONE reused rAF/timeout callback
    this._presentNow = () => this._presentPending(); // ONE reused promise continuation
    this._rafHandleObj = { kind: 'raf', id: 0, scope: null }; // ONE reused cancellable handle
    this._timeoutHandleObj = { kind: 'timeout', id: 0 };
    this._microtaskHandleObj = { kind: 'microtask' };
    // Allocation counters for the scheduling path, incremented ONLY where something new is
    // actually created. A steady-state loop must never grow these (tools/engine-smoke.mjs
    // asserts it): rafBinds is 1 per scope, and the callbacks/handles are 1 for the session.
    this._schedAlloc = { rafBinds: 0, turnCbs: 1, presentCbs: 1, handles: 3 };

    // Resume (iOS suspend/resume) listener bookkeeping - see _startResumeWatch(). Bound ONCE.
    this._onResume = this._onResume.bind(this);
    this._resumeWatch = null;
    this._resumeEvents = 0;

    // Notice banner element (set via attach()).
    this._noticeEl = null;

    // Subscriber registries fed by the runner's sinks.
    this._onFrameCbs = [];
    this._onStateLoadedCbs = [];
    this._onStatusCbs = [];
  }

  // ------------------------------------------------------------------ runner factory

  /**
   * Build a fresh EmuCoreRunner wired to this engine's IN-PROCESS sinks + the deterministic
   * input source. The input source is called from INSIDE retro_run for the frame about to run,
   * so it resolves (scripted mask for that frame | latest live mask) - the determinism
   * contract. The runner's loop is paced by the engine's rAF scheduleYield (CHOICE A).
   */
  _makeRunner(asyncify) {
    return new EmuCoreRunner({
      asyncify: !!asyncify,
      // DETERMINISM: resolve the exact mask for the frame retro_run is currently executing.
      getFrameInputMask: (frame) => this._resolver.getFrameInputMask(frame, this._liveMask),
      // VIDEO: stash the LATEST decoded frame; the per-rAF present draws it exactly once. Do
      // NOT draw here (that would be one draw per retro_run - the open-loop flood).
      onVideoFrame: (rgba, width, height) => {
        this._pendingFrame = { rgba, width, height };
      },
      // HUD: the runner mutates one reused values object; memory-watch.js reads the runner's
      // cached READ-ONLY view via getMemoryView(). Nothing to mirror here (read-on-demand).
      onHud: () => {},
      // STATUS: mirror the runner's diagnostic snapshot + notify subscribers.
      onStatus: (snap) => this._applyStatusSnapshot(snap),
      // FRAME: mirror currentFrame/paused + fan out to onFrame subscribers.
      onFrame: (frame, status) => {
        if (typeof frame === 'number') this.currentFrame = frame;
        if (typeof status === 'string') {
          this.status = status;
          this.paused = status !== 'running';
        }
        this._emitFrame();
      },
      // STATE LOADED: fan out to onStateLoaded subscribers (re-record truncation hook).
      onStateLoaded: (frame) => {
        if (typeof frame === 'number') this.currentFrame = frame;
        this._emitStateLoaded(this.currentFrame);
        this._emitFrame();
      },
      // LOOP DRIVER (CHOICE A): pace the runner's accumulator loop with the engine's single
      // requestAnimationFrame loop; present exactly one stashed frame after each tick.
      scheduleYield: this._scheduleYield,
    });
  }

  // ------------------------------------------------------------------ rAF loop (CHOICE A)

  /**
   * Schedule ONE run-loop turn on the next display refresh. This is the single loop-driver
   * seam and the heart of the reversal:
   *   - When requestAnimationFrame is available, schedule the runner's tick on the NEXT vsync.
   *     After the tick runs (awaiting it for an ASYNCIFY core so at most one retro_run
   *     suspension is ever outstanding), present the SINGLE latest stashed frame ONCE. rAF
   *     gives native vsync pacing + implicit GL backpressure - the browser will not fire the
   *     next rAF until the previous frame's GL commands are consumed, so the command queue can
   *     never flood and we never draw more than once per refresh.
   *   - When rAF is unavailable (Node/headless/tests) fall back to a microtask/timeout so the
   *     loop still advances; tests inject their own scheduler anyway.
   * Returns a tagged handle the runner's _cancelYield can cancel.
   *
   * ZERO STEADY-STATE ALLOCATION: the bound rAF, the turn callback (_rafTurn), the present
   * continuation (_presentNow) and the cancellable handle object are all created ONCE in the
   * constructor and REUSED on every turn (the handle's id/scope are mutated in place, which is
   * safe because exactly ONE turn is ever outstanding). Semantics are unchanged: one turn
   * outstanding, the tick awaited on the ASYNCIFY path, exactly one present per turn after the
   * tick, and the returned handle still cancels the pending turn.
   */
  _scheduleYield(cb) {
    // The ONE outstanding turn's tick. Read+cleared by _runTurn BEFORE it invokes the tick, so
    // the tick's own re-arm (the synchronous path re-arms first) sets the next turn's cb.
    this._pendingTickCb = cb;
    const raf = this._raf();
    if (raf) {
      const id = raf(this._rafTurn);
      this._rafHandle = id;
      const h = this._rafHandleObj;
      h.id = id;
      h.scope = this._rafScopeRef;
      return h;
    }
    // Headless fallback: no display to pace against. Advance on a microtask/timeout and present
    // synchronously after the tick so a Node harness still sees one present per turn.
    if (typeof setTimeout === 'function') {
      const h = this._timeoutHandleObj;
      h.id = setTimeout(this._rafTurn, 0);
      return h;
    }
    Promise.resolve().then(this._rafTurn);
    return this._microtaskHandleObj;
  }

  /**
   * ONE loop turn (the reused rAF callback body):
   *   (a) inputs are resolved inside retro_run; (b) the runner advances emulation via its
   *   target-time accumulator (bounded catch-up); (c) HUD updates per advanced frame; the
   *   onVideoFrame sink stashes only the latest decoded frame this turn; then
   *   (d) present the single latest stashed frame ONCE, AFTER the tick. For an ASYNCIFY core the
   *   tick is async (it awaits each retro_run); present AFTER it resolves so exactly one present
   *   happens per turn and suspensions never overlap. Synchronous cores present immediately.
   */
  _runTurn() {
    this._rafHandle = 0;
    const cb = this._pendingTickCb;
    this._pendingTickCb = null;
    if (typeof cb !== 'function') return;
    const r = cb();
    if (r && typeof r.then === 'function') r.then(this._presentNow, this._presentNow);
    else this._presentPending();
  }

  /**
   * The requestAnimationFrame function bound to its scope, or null when unavailable. The bound
   * function is CACHED and only rebuilt when the scope (or its requestAnimationFrame identity)
   * actually changes - so the running app binds exactly once for the whole session instead of
   * allocating a fresh bound function on every animation frame. (Test harnesses that swap
   * window.requestAnimationFrame are still honored: the identity check catches the swap.)
   */
  _raf() {
    const scope = this._rafScope();
    const raw = scope && typeof scope.requestAnimationFrame === 'function' ? scope.requestAnimationFrame : null;
    if (!raw) {
      this._rafFn = null;
      this._rafRawFn = null;
      this._rafScopeRef = null;
      return null;
    }
    if (raw !== this._rafRawFn || scope !== this._rafScopeRef) {
      this._rafFn = raw.bind(scope);
      this._rafRawFn = raw;
      this._rafScopeRef = scope;
      this._schedAlloc.rafBinds += 1;
    }
    return this._rafFn;
  }

  _rafScope() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined') return globalThis;
    return null;
  }

  /**
   * Present the single latest stashed frame ONCE (coalesced present). Called once per display
   * refresh AFTER the emulation tick - so even a catch-up burst or a fast-forward burst (many
   * retro_run this turn) yields EXACTLY ONE texSubImage2D + drawArrays. No-op when nothing new
   * was decoded this turn (keeps the queue empty rather than redrawing).
   */
  _presentPending() {
    const p = this._pendingFrame;
    if (!p) return;
    this._pendingFrame = null;
    this._present(p.rgba, p.width, p.height);
  }

  /**
   * Present one decoded RGBA frame on the MAIN THREAD. PRIMARY: upload into the single WebGL
   * texture and draw (texSubImage2D + drawArrays - the iOS-native-leak fix). LAST RESORT: 2D
   * putImageData (only when WebGL was unavailable on this canvas).
   *
   * BLINDFOLD GATE: this is the SINGLE choke point for ALL GPU/canvas work, so gating here is
   * enough to skip the ENTIRE upload+draw while leaving every other stage of the frame intact.
   * The caller (_presentPending) has already consumed + cleared the stashed frame, so nothing
   * accumulates while blindfolded. Note what is deliberately NOT skipped: the GL context /
   * texture / program / quad are still created in attach() exactly as normal, so the only
   * variable between a blindfolded run and a normal run is the per-frame upload+draw.
   */
  _present(rgba, width, height) {
    // BLINDFOLD: skip ONLY the per-frame upload+draw. Return BEFORE touching any GL or 2D API.
    if (this._blindfold) return;
    if (!rgba || !width || !height) return;
    if (this._gl) {
      try {
        this._gl.present(rgba, width, height);
      } catch (err) {
        console.warn('[TASEngine] GL present failed:', err);
      }
      return;
    }
    if (this._ctx) {
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
        this._imageData.data.set(rgba.subarray(0, width * height * 4));
        this._ctx.putImageData(this._imageData, 0, 0);
      } catch (err) {
        console.warn('[TASEngine] 2D present failed:', err);
      }
    }
  }

  // ------------------------------------------------------- iOS suspend / resume hardening

  /**
   * Watch for the page RESUMING and re-anchor the run loop's target-time accumulator.
   *
   * THE BUG THIS FIXES (user report): backgrounding the installed PWA and coming back dropped
   * the app to ~4 FPS "permanently, never recovering". While iOS suspends a backgrounded PWA it
   * stops firing requestAnimationFrame but performance.now() keeps advancing, so the first turn
   * after resuming is arbitrarily overdue. The runner now CLAMPS the overdue time it will even
   * consider (MAX_OVERDUE_MS) and frame-skips instead of replaying the gap, so it can no longer
   * wedge; on top of that we re-anchor EXPLICITLY the moment the page comes back, so the very
   * first turn after resuming starts from a clean anchor rather than from a stale one.
   *
   * Listens on document 'visibilitychange' (the reliable iOS signal) plus window 'focus' and
   * 'pageshow' (which also fire when returning from the page cache / app switcher). Idempotent,
   * fully defensive (a headless/stubbed document without addEventListener is simply skipped),
   * and removed again by _stopResumeWatch() on teardown/re-init so listeners never accumulate.
   */
  _startResumeWatch() {
    if (this._resumeWatch) return;
    const doc = typeof document !== 'undefined' ? document : null;
    const win = this._rafScope();
    const bound = [];
    try {
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', this._onResume);
        bound.push({ target: doc, type: 'visibilitychange' });
      }
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('focus', this._onResume);
        bound.push({ target: win, type: 'focus' });
        win.addEventListener('pageshow', this._onResume);
        bound.push({ target: win, type: 'pageshow' });
      }
    } catch (_err) {
      /* a hostile/stubbed environment must never break boot */
    }
    this._resumeWatch = bound.length ? bound : null;
    return this._resumeWatch;
  }

  /** Remove the resume listeners (teardown / re-init). Idempotent; never throws. */
  _stopResumeWatch() {
    const bound = this._resumeWatch;
    this._resumeWatch = null;
    if (!bound) return;
    for (const b of bound) {
      try {
        if (b.target && typeof b.target.removeEventListener === 'function') {
          b.target.removeEventListener(b.type, this._onResume);
        }
      } catch (_err) {
        /* best-effort */
      }
    }
  }

  /**
   * The page came back (or may have). Re-anchor the runner's accumulator so the first turn after
   * a suspend/resume gap starts clean instead of trying to reason about a multi-second jump.
   * Ignores the HIDDEN half of visibilitychange (that is the suspend, not the resume).
   */
  _onResume() {
    try {
      const doc = typeof document !== 'undefined' ? document : null;
      if (doc && typeof doc.visibilityState === 'string' && doc.visibilityState === 'hidden') return;
      this._resumeEvents += 1;
      if (this.runner && typeof this.runner.resetClockAnchor === 'function') {
        this.runner.resetClockAnchor('resume');
      }
      // A resume also invalidates any frame stashed before the gap.
      this._pendingFrame = null;
    } catch (_err) {
      /* never let a resume hook throw into an event handler */
    }
  }

  /**
   * Tear the engine down: stop the resume listeners and the in-process runner/loop. Used by
   * init() before a (re-)boot or a core swap so nothing (listeners, rAF turns, cores) leaks
   * across re-inits. Never throws.
   */
  teardown() {
    this._stopResumeWatch();
    if (this.runner) {
      try {
        this.runner.teardown();
      } catch (_err) {
        /* best-effort */
      }
      this.runner = null;
    }
    this._pendingTickCb = null;
    this._pendingFrame = null;
    return this;
  }

  // ------------------------------------------------------------------ attach / notices

  /**
   * Wire the engine to DOM elements. Safe to call before init(). Builds the MAIN-THREAD
   * presenter on the canvas: a WebGL presenter (primary) or a 2D putImageData context (last
   * resort). NO worker is created and the canvas is NEVER transferred anywhere - the emulator
   * runs on the main thread in this engine's own rAF loop.
   *
   * @param {{canvas?:HTMLCanvasElement, noticeEl?:HTMLElement}} els
   */
  attach(els = {}) {
    if (els.noticeEl) this._noticeEl = els.noticeEl;
    if (els.canvas) {
      this.canvas = els.canvas;
      this._takeMainThreadContext(els.canvas);
    }
    return this;
  }

  /**
   * Set up the main-thread presenter. PRIMARY: a WebGL presenter (one texture, per-frame
   * texSubImage2D - no putImageData leak) labelled main-webgl2/main-webgl1. LAST RESORT: a 2D
   * putImageData context (main-2d) if WebGL is unavailable. Records the active video path.
   */
  _takeMainThreadContext(canvas) {
    try {
      this._gl = createGLPresenter(canvas, 'main');
    } catch (_err) {
      this._gl = null;
    }
    if (this._gl) {
      this._setVideoPath(this._gl.label); // 'main-webgl2' | 'main-webgl1'
      return;
    }
    // WebGL unavailable: last-resort 2D putImageData.
    try {
      this._ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    } catch (err) {
      this._ctx = null;
      console.warn('[TASEngine] 2d context unavailable:', err);
    }
    this._setVideoPath(this._ctx ? 'main-2d' : 'none');
  }

  /** Record the active video path and notify status subscribers (for the debug banner). */
  _setVideoPath(path) {
    if (this.videoPath === path) return;
    this.videoPath = path;
    this._notifyStatus();
  }

  // --------------------------------------------------------- blindfold (no-present) mode

  /**
   * Turn the BLINDFOLD (no-present) diagnostic on/off AT RUNTIME - no reload required, safe to
   * call while the loop is running and while paused. When ON, the per-frame upload+draw is
   * skipped inside _present(); EVERYTHING else (rAF loop, input resolution, retro_run cadence
   * + accumulator + bounded catch-up, framebuffer decode into the reused RGBA buffer, HUD
   * reads, onFrame emission, the FPS meter) keeps running exactly as normal. The presenter and
   * its GL context are left untouched so flipping back ON resumes drawing immediately.
   * @param {boolean} on
   * @returns {boolean} the resulting blindfold state
   */
  setBlindfold(on) {
    const next = !!on;
    if (this._blindfold === next) return this._blindfold;
    this._blindfold = next;
    // Drop any frame stashed but not yet presented so a mode flip never draws a stale frame
    // and nothing accumulates across the transition.
    this._pendingFrame = null;
    // Make the new mode visible in the debug banner immediately (the user reads this off a
    // phone video, so the mode must never lag the FPS number it explains).
    this._notifyStatus();
    return this._blindfold;
  }

  /** Whether the BLINDFOLD (no-present) diagnostic is currently active. */
  isBlindfold() {
    return !!this._blindfold;
  }

  /** Convenience property mirror of isBlindfold()/setBlindfold() for console/DevTools use. */
  get blindfold() {
    return !!this._blindfold;
  }

  set blindfold(on) {
    this.setBlindfold(on);
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

  _disable(message) {
    this.status = 'disabled';
    this.showNotice(message, 'error');
    this._setStatus({ coreStatus: 'Failed', engineStatus: 'Stopped' });
    this._emitFrame();
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
    const blindfold = !!this._blindfold;
    return {
      status: this.status,
      coreStatus: this.coreStatus,
      romStatus: this.romStatus,
      romBytes: this.romBytes,
      engineStatus: this.engineStatus,
      frame: this.currentFrame,
      // The REAL present path, with an UNMISTAKABLE suffix while blindfolded so an FPS number
      // read off a phone video can never be attributed to the wrong mode.
      videoPath: blindfold ? `${this.videoPath} (BLINDFOLD: no present)` : this.videoPath,
      // The raw path (no suffix) for consumers that want the plain label.
      videoPathBase: this.videoPath,
      blindfold,
      // Explicit banner-ready present state: 'ON' normally, 'OFF (BLINDFOLD)' while skipping.
      present: blindfold ? 'OFF (BLINDFOLD)' : 'ON',
    };
  }

  /** Mirror the runner's status snapshot into this engine's fields + notify subscribers. */
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

  /** Update mirrored status fields locally (used for disabled/error states before boot). */
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
   * Initialize: build the in-process runner, load the core + ROM, and auto-boot into the rAF
   * loop. Never throws; on a missing core/ROM it shows a notice and stays disabled (never a
   * file picker). The runner's start() begins the engine-owned rAF loop via scheduleYield.
   * @param {{corePaths?:string[]}} [opts]
   */
  async init(opts = {}) {
    const corePath = Array.isArray(opts.corePaths) && opts.corePaths.length ? opts.corePaths[0] : undefined;
    this._activeCoreId = this._idForPath(corePath);
    this._asyncify = this._asyncifyForPath(corePath);

    this.status = 'loading';
    this.clearNotices();
    this._setStatus({ coreStatus: 'Loading', romStatus: 'Idle', romBytes: 0, engineStatus: 'Init' });

    // Tear down any prior runner + its resume listeners (idempotent init / re-init, core swap):
    // nothing may accumulate across re-inits.
    this.teardown();

    this.runner = this._makeRunner(this._asyncify);
    // Re-anchor the run loop whenever the page resumes from an iOS suspend (see the note on
    // _startResumeWatch). Attached AFTER the runner exists so the handler always has a target.
    this._startResumeWatch();
    let result;
    try {
      result = await this.runner.boot({ corePaths: corePath ? [corePath] : undefined });
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }

    if (result && result.ok) {
      this.clearNotices();
      // Auto-play on boot: start() begins the engine-owned rAF loop through scheduleYield.
      this.runner.start();
    } else {
      this._disable(
        result && result.error
          ? `Emulator failed to start: ${result.error}`
          : 'Core or ROM unavailable (emulator disabled).'
      );
    }
    return { ok: !!(result && result.ok) };
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
   * Switch to a different emulator core at runtime, in-process: tear the current runner down
   * and re-boot with the selected core, restoring the prior paused state. Never throws;
   * graceful on failure. CORE selection ONLY - never a ROM/level picker, grants no
   * cheat/memory-write capability. snes9x is the default; bsnes accuracy/performance selectable.
   * @param {string} corePath
   */
  async setCore(corePath) {
    if (typeof corePath !== 'string' || !corePath) return { ok: false };
    const wasRunning = !!(this.runner && this.runner.status === 'running' && !this.runner.paused);
    this._setStatus({ coreStatus: 'Loading' });
    const result = await this.init({ corePaths: [corePath] });
    // init() auto-plays; if the user had paused before the swap, honor that.
    if (result && result.ok && !wasRunning && this.runner) {
      this.runner.pause();
      this.paused = true;
    }
    return result;
  }

  // ------------------------------------------------------------------ run controls

  play() {
    if (!this.runner) return;
    this.paused = false;
    this.runner.start();
  }

  pause() {
    if (!this.runner) return;
    this.paused = true;
    this.runner.pause();
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
    if (this.runner) this.runner.setSpeed(this.speed);
  }

  /** Hold fast-forward (runner runs a bounded burst per tick; still ONE present per rAF). */
  fastForward(on = true) {
    if (this.runner) this.runner.fastForward(!!on);
  }

  /**
   * Advance EXACTLY one video frame (frame stepping): one retro_run, paused, then a single
   * one-shot present. For an ASYNCIFY core the runner's frameAdvance returns a Promise; await
   * it, then present exactly once.
   */
  frameAdvance() {
    if (!this.runner) return;
    this.paused = true;
    const r = this.runner.frameAdvance();
    if (r && typeof r.then === 'function') {
      return r.then(() => this._presentPending());
    }
    this._presentPending();
  }

  // ------------------------------------------------------------------ input (in-process)

  /**
   * Apply a scripted-input edit to the in-process authoritative InputLog. op is one of
   * 'setFrameButton' | 'truncateAfter' | 'restoreSnapshot' (see input-resolver.js INPUT_OP).
   * This is the ONLY mutation of scripted input - controller input only, never a memory write.
   */
  sendInputEdit(edit) {
    if (!edit || typeof edit.op !== 'string') return;
    this._resolver.applyEdit(edit);
  }

  /** Stream the latest live controller/touch mask; the runner OR-s it into the next frame. */
  sendLiveMask(mask) {
    this._liveMask = Number.isFinite(mask) ? mask >>> 0 : 0;
  }

  // ------------------------------------------------------------------ save states

  /**
   * Serialize the current emulator state. Returns a Promise resolving to a Uint8Array (or
   * null). Kept a Promise for API parity with the old worker proxy; callers may await it.
   * @returns {Promise<Uint8Array|null>}
   */
  saveState() {
    if (!this.runner) return Promise.resolve(null);
    let bytes = null;
    try {
      bytes = this.runner.saveState();
    } catch (err) {
      console.warn('[TASEngine] saveState failed:', err);
      bytes = null;
    }
    return Promise.resolve(bytes);
  }

  /**
   * Restore emulator state in-process. Fires onStateLoaded (via the runner's sink) so the UI
   * truncates future inputs (TAS re-recording), then presents the restored frame once.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{frame?:number}} [meta]
   * @returns {boolean} whether the load was applied
   */
  loadState(bytes, meta = {}) {
    if (!bytes || !this.runner) return false;
    let view;
    if (bytes instanceof Uint8Array) view = bytes;
    else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
    else if (bytes && bytes.buffer) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else return false;
    if (!view.length) return false;
    let ok = false;
    try {
      ok = this.runner.loadState(view, { frame: meta.frame });
    } catch (err) {
      console.warn('[TASEngine] loadState failed:', err);
      ok = false;
    }
    if (ok) this._presentPending();
    return ok;
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
   * Return the runner's CACHED, STRICTLY READ-ONLY WRAM view for memory-watch.js. It exposes
   * read accessors ONLY (readU8/readS8/readU16/readS16/snapshot) keyed by WRAM offset - there
   * is intentionally NO write/poke/inject path anywhere. Returns null before a core+ROM load.
   */
  getMemoryView() {
    return this.runner ? this.runner.getMemoryView() : null;
  }

  /** The catalog id of the active core ('realtime' | 'accuracy' | 'performance'), or null. */
  get activeCoreId() {
    if (this.runner && this.runner.activeCoreId) return this.runner.activeCoreId;
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
