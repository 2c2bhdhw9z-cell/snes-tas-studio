// fps-meter.js
//
// A tiny, DOM-free ROLLING-WINDOW FPS meter for the SNES TAS Studio.
//
// WHY THIS EXISTS (the user's request): the user asked for a live, easy-to-read FPS readout on
// the UI so device performance can be monitored directly (no manual "frame 11 -> 601 in 18s"
// timestamp math). The honest source of truth is the ACTUAL advanced frames the user sees: the
// emulator worker posts one 'frame' message per emulated frame, and the main thread counts
// those messages over a rolling window. FPS = (number of frames in the last `windowMs` ms).
//
// This is a READ-ONLY performance display. It observes frame timestamps and computes a rate;
// it has NO emulation capability — it cannot advance, pause, poke memory, or change input.
//
// Semantics:
//   - tick(now): record one advanced frame at time `now` (ms, e.g. performance.now()).
//   - fps(now): frames whose timestamp is within (now - windowMs, now]; older stamps are
//     dropped. Reads 0 cleanly when idle/paused (no frames arriving) — no divide-by-zero,
//     because it is a COUNT over a fixed window, not count/elapsed.
//
// A rolling 1-second window means fps() is literally "frames in the last second", which is the
// most intuitive readout and needs no division.

'use strict';

export class FpsMeter {
  /**
   * @param {number} [windowMs] rolling window size in milliseconds (default 1000 = 1 second).
   */
  constructor(windowMs = 1000) {
    this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 1000;
    // Ring of frame timestamps (ms). Kept pruned to the window on every read/tick.
    this._stamps = [];
  }

  /** Record one advanced frame at time `now` (ms). */
  tick(now) {
    const t = Number.isFinite(now) ? now : 0;
    this._stamps.push(t);
    this._prune(t);
  }

  /** Drop timestamps older than the rolling window relative to `ref`. */
  _prune(ref) {
    const cutoff = ref - this.windowMs;
    const s = this._stamps;
    // Timestamps are pushed in non-decreasing order, so shift the stale prefix.
    let i = 0;
    while (i < s.length && s[i] <= cutoff) i += 1;
    if (i > 0) s.splice(0, i);
  }

  /**
   * Frames-per-second over the rolling window as of `now`. For a 1000 ms window this is simply
   * the count of frames in the last second. Reads 0 when no frames are within the window
   * (idle/paused) — never divides, so never NaN/Infinity.
   * @param {number} now current time (ms)
   * @returns {number} whole-frame count within (now - windowMs, now]
   */
  fps(now) {
    const ref = Number.isFinite(now) ? now : 0;
    this._prune(ref);
    return this._stamps.length;
  }

  /** Forget all recorded frames (e.g. on core swap / reset). */
  reset() {
    this._stamps.length = 0;
  }
}

export default FpsMeter;
