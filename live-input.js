// live-input.js
//
// Live (real-time) controller input for the TAS Studio: the HTML5 Gamepad API for paired
// Bluetooth pads (Xbox / PlayStation / 8BitDo) plus the low-opacity on-screen touch
// controls. Both sources feed a single "live" joypad bitmask that is MERGED (OR-ed) into
// the current frame's input alongside the piano-roll input log.
//
// This module is deliberately DOM-light and engine-free so it can be unit-tested in Node:
//   - getMask()  -> the combined live bitmask (gamepad OR touch), in libretro joypad bits.
//   - poll()     -> read navigator.getGamepads() and refresh the gamepad portion of the mask.
//   - setTouch(button, on) / clearTouch() -> on-screen control state.
//   - bindTouchControls(container) -> attach pointer/touch handlers to #touch-controls.
//   - attachGamepadEvents(target)  -> listen for gamepadconnected/disconnected.
//
// Bitmask layout matches the libretro RETRO_DEVICE_ID_JOYPAD_* bit positions exactly, the
// same layout used by input-log.js and tas-engine.js:
//   B=0, Y=1, SELECT=2, START=3, UP=4, DOWN=5, LEFT=6, RIGHT=7, A=8, X=9, L=10, R=11.
//
// HARD RULE reminder: nothing here writes emulator memory, applies cheats, or selects
// levels. It only expresses controller-button intent, which the engine reads read-only.

'use strict';

import { JOYPAD_BITS } from './input-log.js';

// Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping) button indices
// mapped to SNES/libretro joypad buttons. This layout is what Xbox, PlayStation (DualShock/
// DualSense), and 8BitDo pads report in the "standard" mapping mode.
//
//   0: A (bottom face)  -> SNES B
//   1: B (right face)   -> SNES A
//   2: X (left face)    -> SNES Y
//   3: Y (top face)     -> SNES X
//   4: LB / L1          -> SNES L
//   5: RB / R1          -> SNES R
//   8: Back/Select/View -> SNES SELECT
//   9: Start/Menu       -> SNES START
//  12: D-Pad Up         -> SNES UP
//  13: D-Pad Down       -> SNES DOWN
//  14: D-Pad Left       -> SNES LEFT
//  15: D-Pad Right      -> SNES RIGHT
//
// The bottom/right face-button crossover (pad "A" -> SNES "B") matches the physical layout
// SNES speedrunners expect (jump on the bottom button).
export const GAMEPAD_STANDARD_MAP = Object.freeze({
  0: 'B',
  1: 'A',
  2: 'Y',
  3: 'X',
  4: 'L',
  5: 'R',
  8: 'SELECT',
  9: 'START',
  12: 'UP',
  13: 'DOWN',
  14: 'LEFT',
  15: 'RIGHT',
});

// Analog-stick threshold for treating a stick push as a d-pad direction.
const AXIS_THRESHOLD = 0.5;

function bit(button) {
  const b = JOYPAD_BITS[button];
  return b === undefined ? 0 : 1 << b;
}

export class LiveInput {
  constructor() {
    // The two live sources are tracked separately then OR-ed together in getMask() so a
    // released gamepad button never clears a held touch button and vice versa.
    this._gamepadMask = 0;
    this._touchMask = 0;

    // Bound handlers so they can be removed if ever needed.
    this._boundConnect = null;
    this._boundDisconnect = null;
    this._connectedPads = 0;
  }

  /** Combined live input bitmask (gamepad OR touch), in libretro joypad-bit layout. */
  getMask() {
    return (this._gamepadMask | this._touchMask) >>> 0;
  }

  /** True if any live source is currently asserting a button. */
  get active() {
    return this.getMask() !== 0;
  }

  // ----------------------------------------------------------------- gamepad

  /**
   * Poll all connected gamepads and rebuild the gamepad portion of the live mask. Call this
   * once per rAF tick (from the same tick as retro_run) to keep latency minimal.
   * Safe to call in Node / without a Gamepad API (no-op).
   */
  poll() {
    const pads = this._getGamepads();
    let mask = 0;
    if (pads) {
      for (const pad of pads) {
        if (!pad) continue;
        mask |= this._maskForPad(pad);
      }
    }
    this._gamepadMask = mask >>> 0;
    return this._gamepadMask;
  }

  _getGamepads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    try {
      return navigator.getGamepads();
    } catch (_err) {
      return null;
    }
  }

  /** Translate a single Gamepad snapshot into a libretro joypad bitmask. */
  _maskForPad(pad) {
    let mask = 0;
    const buttons = pad.buttons || [];
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const pressed = b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5);
      if (!pressed) continue;
      const snes = GAMEPAD_STANDARD_MAP[i];
      if (snes) mask |= bit(snes);
    }

    // Also honor the left analog stick as a d-pad so any pad remains usable even if its
    // hat is reported only via axes.
    const axes = pad.axes || [];
    if (axes.length >= 2) {
      const x = axes[0];
      const y = axes[1];
      if (typeof x === 'number') {
        if (x <= -AXIS_THRESHOLD) mask |= bit('LEFT');
        else if (x >= AXIS_THRESHOLD) mask |= bit('RIGHT');
      }
      if (typeof y === 'number') {
        if (y <= -AXIS_THRESHOLD) mask |= bit('UP');
        else if (y >= AXIS_THRESHOLD) mask |= bit('DOWN');
      }
    }
    return mask >>> 0;
  }

  /**
   * Attach gamepadconnected / gamepaddisconnected listeners. Purely informational (the
   * per-frame poll() reads live state regardless), but lets the UI/logs react to pairing.
   * @param {EventTarget} target usually window
   * @param {(count:number, ev:Event)=>void} [onChange]
   */
  attachGamepadEvents(target, onChange) {
    if (!target || typeof target.addEventListener !== 'function') return;
    this._boundConnect = (ev) => {
      this._connectedPads += 1;
      if (typeof onChange === 'function') onChange(this._connectedPads, ev);
    };
    this._boundDisconnect = (ev) => {
      this._connectedPads = Math.max(0, this._connectedPads - 1);
      // Clear the gamepad mask on disconnect so a stuck button cannot linger.
      this._gamepadMask = 0;
      if (typeof onChange === 'function') onChange(this._connectedPads, ev);
    };
    target.addEventListener('gamepadconnected', this._boundConnect);
    target.addEventListener('gamepaddisconnected', this._boundDisconnect);
  }

  // ----------------------------------------------------------------- touch controls

  /** Set/clear an on-screen (touch) button by SNES button name. */
  setTouch(button, on) {
    const m = bit(button);
    if (!m) return;
    if (on) this._touchMask |= m;
    else this._touchMask &= ~m;
    this._touchMask >>>= 0;
  }

  /** Release all on-screen buttons (e.g. on pointercancel / blur). */
  clearTouch() {
    this._touchMask = 0;
  }

  /**
   * Bind pointer/touch handlers to the on-screen control container. Each element with a
   * data-btn attribute (D-Pad + A/B/X/Y/L/R/Start/Select) sets its bit while pressed and
   * clears it on release. Uses pointer events with a touch-event fallback.
   * @param {Element} container the #touch-controls element
   */
  bindTouchControls(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const btns = container.querySelectorAll('[data-btn]');

    const press = (el) => {
      const name = el.getAttribute('data-btn');
      if (name) this.setTouch(name, true);
      el.classList.add('touch-btn--held');
    };
    const release = (el) => {
      const name = el.getAttribute('data-btn');
      if (name) this.setTouch(name, false);
      el.classList.remove('touch-btn--held');
    };

    const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;

    btns.forEach((el) => {
      if (supportsPointer) {
        // Pointer events cover mouse + touch + pen uniformly.
        el.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          try {
            if (typeof el.setPointerCapture === 'function') el.setPointerCapture(ev.pointerId);
          } catch (_err) {
            /* setPointerCapture may throw in some engines; ignore */
          }
          press(el);
        });
        el.addEventListener('pointerup', () => release(el));
        el.addEventListener('pointercancel', () => release(el));
        el.addEventListener('pointerleave', (ev) => {
          // Only release on leave if the button is not still captured/pressed.
          if (ev.buttons === 0) release(el);
        });
      } else {
        // Touch fallback. Not passive: we preventDefault to avoid synthetic mouse events
        // and scrolling/zoom on the control itself.
        el.addEventListener(
          'touchstart',
          (ev) => {
            ev.preventDefault();
            press(el);
          },
          { passive: false }
        );
        el.addEventListener('touchend', (ev) => {
          ev.preventDefault();
          release(el);
        });
        el.addEventListener('touchcancel', () => release(el));
        // Mouse fallback for desktop testing.
        el.addEventListener('mousedown', () => press(el));
        el.addEventListener('mouseup', () => release(el));
        el.addEventListener('mouseleave', () => release(el));
      }
    });

    // Safety: release everything if the window loses focus (prevents stuck buttons).
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('blur', () => this.clearTouch());
    }
  }
}
