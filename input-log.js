// input-log.js
//
// The TAS input log: a pure, DOM-free data structure that stores per-frame controller
// input as a libretro joypad bitmask, one entry per frame index.
//
// This module is deliberately free of DOM and engine references so it can be unit-tested
// directly in Node (see tools/inputlog-truncate.test.mjs). The piano roll (piano-roll.js)
// renders and mutates an InputLog; the engine's per-frame input provider reads from it.
//
// Bitmask layout matches the libretro RETRO_DEVICE_ID_JOYPAD_* bit positions exactly, so
// tas-engine.js's retro_set_input_state can read a frame's mask directly:
//   B=0, Y=1, SELECT=2, START=3, UP=4, DOWN=5, LEFT=6, RIGHT=7, A=8, X=9, L=10, R=11.
//
// HARD RULE reminder: nothing here touches emulator memory. It only stores controller
// button intent per frame. No cheats, no pokes, no level-select.

'use strict';

// RETRO_DEVICE_ID_JOYPAD_* bit positions. Kept in sync with tas-engine.js JOYPAD.
export const JOYPAD_BITS = Object.freeze({
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

// Column order shown in the piano roll (left to right).
export const COLUMN_ORDER = Object.freeze([
  'A',
  'B',
  'X',
  'Y',
  'L',
  'R',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'START',
  'SELECT',
]);

/**
 * A frame-indexed log of joypad bitmasks.
 *
 * The internal array `masks` holds one Number per frame; index === frame number.
 * Frames that have never been touched are 0 (no buttons held).
 */
export class InputLog {
  constructor() {
    /** @type {number[]} one bitmask per frame index. */
    this.masks = [];
  }

  /** Total number of frames currently represented in the log. */
  get length() {
    return this.masks.length;
  }

  /** Ensure the log has at least `frame + 1` entries, filling gaps with 0. */
  ensureFrame(frame) {
    if (frame < 0) return;
    while (this.masks.length <= frame) this.masks.push(0);
  }

  /** Get the raw bitmask for a frame (0 if the frame is out of range). */
  getMask(frame) {
    if (frame < 0 || frame >= this.masks.length) return 0;
    return this.masks[frame] | 0;
  }

  /** True if `button` (a JOYPAD_BITS key) is set on `frame`. */
  isSet(frame, button) {
    const bit = JOYPAD_BITS[button];
    if (bit === undefined) return false;
    return (this.getMask(frame) & (1 << bit)) !== 0;
  }

  /** Set/clear `button` on `frame`. Extends the log as needed. Returns the new state. */
  set(frame, button, on) {
    const bit = JOYPAD_BITS[button];
    if (bit === undefined || frame < 0) return false;
    this.ensureFrame(frame);
    if (on) this.masks[frame] |= 1 << bit;
    else this.masks[frame] &= ~(1 << bit);
    return !!on;
  }

  /** Toggle `button` on `frame`. Returns the new boolean state. */
  toggle(frame, button) {
    const next = !this.isSet(frame, button);
    this.set(frame, button, next);
    return next;
  }

  /**
   * Truncate the log so that no input survives after `frame` (standard TAS re-recording).
   * Inputs for frames 0..frame inclusive are kept; everything after `frame` is discarded.
   * A negative frame clears the whole log.
   */
  truncateAfter(frame) {
    const keep = Math.max(0, Math.floor(frame) + 1);
    if (keep < this.masks.length) this.masks.length = keep;
  }

  /** Return a plain-array copy of the masks (for save-state snapshots). */
  snapshot() {
    return this.masks.slice();
  }

  /** Replace the log contents from a snapshot array (used when restoring a state node). */
  restore(snapshot) {
    this.masks = Array.isArray(snapshot) ? snapshot.slice() : [];
  }

  /** Clear the entire log. */
  clear() {
    this.masks = [];
  }
}
