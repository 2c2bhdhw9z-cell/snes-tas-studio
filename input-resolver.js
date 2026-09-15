// input-resolver.js
//
// The deterministic input-resolution unit for the SNES TAS Studio.
//
// This module owns THE determinism contract of a Tool-Assisted Speedrun: for any frame N,
// the joypad bitmask handed to the emulator is EXACTLY
//
//     (log.getMask(N) | liveMask) >>> 0
//
// where `log` is the authoritative scripted InputLog (input-log.js) and `liveMask` is the
// LIVE controller/touch mask snapshotted for that specific frame. Frame N never reflects
// frame N+1's scripted input, and re-record truncation (truncateAfter) discards everything
// after a given frame so a state-load can rewind the timeline cleanly.
//
// It is deliberately pure and DOM-free / engine-free so it can be unit-tested in Node with
// NO browser (see tools/input-resolver.test.mjs). The engine owns an InputResolver instance
// IN-PROCESS on the main thread: the UI applies scripted edits (setFrameButton /
// truncateAfter / restoreSnapshot) and per-frame live masks in-process (no postMessage
// boundary), and the engine resolves the exact mask before it runs each frame.
//
// HARD RULE reminder: this module resolves CONTROLLER INPUT only. It has no memory-write,
// poke, cheat, or level-select surface of any kind.

'use strict';

import { InputLog } from './input-log.js';

/**
 * The op names the engine uses to mutate the scripted log in-process. These are the ONLY
 * mutations applied to the log, all of them controller-input edits.
 */
export const INPUT_OP = Object.freeze({
  SET_FRAME_BUTTON: 'setFrameButton', // { frame, button, on }
  TRUNCATE_AFTER: 'truncateAfter', // { frame }
  RESTORE_SNAPSHOT: 'restoreSnapshot', // { masks }
});

/**
 * Resolve the exact joypad bitmask for a frame from a scripted log plus a live mask.
 * Kept as a free function so both the resolver and any caller can share the ONE canonical
 * definition of the determinism contract.
 *
 * @param {InputLog} log authoritative scripted log
 * @param {number} frame frame index to resolve
 * @param {number} [liveMask=0] live controller/touch mask snapshotted for THIS frame
 * @returns {number} unsigned 32-bit joypad bitmask for `frame`
 */
export function resolveMask(log, frame, liveMask = 0) {
  const scripted = log && typeof log.getMask === 'function' ? log.getMask(frame) : 0;
  const live = Number.isFinite(liveMask) ? liveMask : 0;
  return (scripted | live) >>> 0;
}

/**
 * Deterministic input resolver wrapping an authoritative InputLog.
 *
 * The resolver holds the scripted log and applies scripted edits through a small, explicit
 * op protocol so the exact same code path is exercised in a unit test and in the engine
 * in-process. The live mask is supplied per-frame by the caller and is never persisted, so
 * it can never leak from one frame into another.
 */
export class InputResolver {
  /**
   * @param {{ log?: InputLog }} [opts] optionally inject an existing log (else a fresh one)
   */
  constructor(opts = {}) {
    /** @type {InputLog} the authoritative scripted log. */
    this.log = opts.log instanceof InputLog ? opts.log : new InputLog();
  }

  /**
   * Resolve frame N's mask: exactly the scripted mask for N OR-ed with the supplied live
   * mask for N. The live mask defaults to 0 (no live input) and is used for THIS frame only.
   * @param {number} frame
   * @param {number} [liveMask=0]
   * @returns {number} unsigned 32-bit joypad bitmask
   */
  getFrameInputMask(frame, liveMask = 0) {
    return resolveMask(this.log, frame, liveMask);
  }

  /**
   * Apply a scripted edit described by the in-process op protocol. Returns true if the op
   * was recognized and applied, false otherwise (fail-closed on unknown ops). This is the
   * single entry point the engine uses for scripted-log mutations.
   *
   * @param {{op:string, frame?:number, button?:string, on?:boolean, masks?:number[]}} msg
   * @returns {boolean}
   */
  applyEdit(msg) {
    if (!msg || typeof msg.op !== 'string') return false;
    switch (msg.op) {
      case INPUT_OP.SET_FRAME_BUTTON:
        if (typeof msg.frame !== 'number' || typeof msg.button !== 'string') return false;
        this.log.set(msg.frame, msg.button, !!msg.on);
        return true;
      case INPUT_OP.TRUNCATE_AFTER:
        if (typeof msg.frame !== 'number') return false;
        this.log.truncateAfter(msg.frame);
        return true;
      case INPUT_OP.RESTORE_SNAPSHOT:
        if (!Array.isArray(msg.masks)) return false;
        this.log.restore(msg.masks);
        return true;
      default:
        return false;
    }
  }

  // -- Convenience wrappers over the op protocol (used by the engine + its callers) --

  /** Set/clear a button on a frame. Convenience over applyEdit(SET_FRAME_BUTTON). */
  setFrameButton(frame, button, on) {
    return this.applyEdit({ op: INPUT_OP.SET_FRAME_BUTTON, frame, button, on });
  }

  /** Discard all scripted input after `frame` (re-record). Convenience over applyEdit. */
  truncateAfter(frame) {
    return this.applyEdit({ op: INPUT_OP.TRUNCATE_AFTER, frame });
  }

  /** Replace the scripted log from a snapshot array. Convenience over applyEdit. */
  restoreSnapshot(masks) {
    return this.applyEdit({ op: INPUT_OP.RESTORE_SNAPSHOT, masks });
  }

  /** A plain-array copy of the scripted masks (for save-state metadata / transfer). */
  snapshot() {
    return this.log.snapshot();
  }
}

export default InputResolver;
