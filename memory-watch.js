// memory-watch.js
//
// The Live HUD for the SNES TAS Studio. It renders routing values read STRICTLY
// READ-ONLY from SNES WRAM: Mario's X/Y position (including sub-pixel), horizontal speed,
// and a frame counter. It refreshes once per emulated frame.
//
// ============================ HARD RULE: READ-ONLY OBSERVATION ============================
// This module observes memory ONLY. It obtains a read-only view from the engine via
// TASEngine.getMemoryView(), which exposes read accessors only (readU8/readU16/readS16/
// snapshot) and has NO write API. This file:
//   * NEVER writes, pokes, or injects memory.
//   * Exposes NO write/poke/inject/cheat function of any kind.
//   * Provides NO level/stage selection.
// Routing is done by observation so the game runs 100% authentically.
// ==========================================================================================
//
// ------------------------------ SMB1 / Super Mario All-Stars RAM map ----------------------
// The values below are the well-documented Super Mario Bros. 1 RAM-map addresses (the same
// game logic Super Mario All-Stars re-implements for its "Super Mario Bros." mode). These
// are the classic Data Crystal / SMB disassembly offsets:
//
//   0x0086  Player_X_Position      — Mario's on-screen X pixel (low byte of position)
//   0x006D  Player_PageLoc         — Mario's horizontal "page" (high byte; X = page*256 + pos)
//   0x0400  Player_X_MoveForce     — Mario's X sub-pixel (fractional horizontal position)
//   0x00CE  Player_Y_Position      — Mario's on-screen Y pixel
//   0x0416  Player_Y_MoveForce     — Mario's Y sub-pixel (fractional vertical position)
//   0x0057  Player_X_Speed         — Mario's horizontal speed (signed; sub-pixels per frame)
//   0x0747  \
//   0x0748   } in-game timer digits (hundreds/tens/ones) — used as an in-game frame/timer
//   0x0749  /    reference alongside the engine's own frame counter.
//
// IMPORTANT ACCURACY NOTE: On the SNES, Super Mario All-Stars relocates the original NES
// zero-page/RAM variables into SNES WRAM at a game-specific base offset that depends on the
// exact ROM revision. The map above is expressed as SMB1 offsets; SMB_WRAM_BASE lets you
// shift them to the All-Stars WRAM location once verified against the real ROM. Until the
// ROM + core are dropped in, getMemoryView() returns null and the HUD shows placeholders,
// so no address is ever dereferenced in the untested state.
// ------------------------------------------------------------------------------------------

'use strict';

// ============================ HUD CALIBRATION (UNVERIFIED) =================================
// The address map below is PROVISIONAL. It uses the classic NES Super Mario Bros. 1 RAM-map
// offsets. Super Mario All-Stars re-implements SMB1 but relocates these variables into SNES
// WRAM at a ROM-revision-dependent base, which cannot be confirmed without the real ROM +
// core. Until someone verifies the mapping against the actual cartridge, the HUD values for
// Mario X/Y/speed should be treated as UNVERIFIED and may be wrong.
//
// Calibration lives in exactly ONE place:
//   * SMB_WRAM_BASE   — the single offset added to every address to reach the All-Stars copy.
//   * CALIBRATION_VERIFIED — flip to true only after the map is confirmed against the ROM;
//     while false, the HUD labels the position/speed rows as "(unverified)".
// This is a read-only display concern; there is NO memory-write path here of any kind.
// ==========================================================================================

// Offset applied to every SMB1 address to reach the All-Stars WRAM copy. 0 = raw SMB1 map.
// Kept configurable (not a write path) so the map can be calibrated against the real ROM
// without editing every constant.
export const SMB_WRAM_BASE = 0x0000;

// Whether the address map above has been verified against a real Super Mario All-Stars ROM.
// Ships false on purpose: the offsets are provisional SMB1 values (see header). When false,
// emulation-dependent HUD rows are labeled "(unverified)" so nobody trusts raw numbers.
export const CALIBRATION_VERIFIED = false;

// Documented SMB1 RAM-map addresses (see header). Read-only offsets into WRAM.
export const SMB_ADDR = Object.freeze({
  PLAYER_X_POSITION: 0x0086, // on-screen X pixel (low byte)
  PLAYER_PAGE_LOC: 0x006d, // horizontal page (high byte of X)
  PLAYER_X_SUBPIXEL: 0x0400, // X sub-pixel (Player_X_MoveForce)
  PLAYER_Y_POSITION: 0x00ce, // on-screen Y pixel
  PLAYER_Y_SUBPIXEL: 0x0416, // Y sub-pixel (Player_Y_MoveForce)
  PLAYER_X_SPEED: 0x0057, // horizontal speed (signed)
});

/**
 * Create the live HUD memory watcher.
 *
 * @param {object} engine the TAS engine (window.TASEngine / default export).
 * @param {HTMLElement|null} hudEl the #hud container to render into.
 * @returns {{ update: () => void, isActive: () => boolean }}
 */
export function createMemoryWatch(engine, hudEl) {
  // HUD field definitions. Each renders one labelled row; values fill in per frame.
  const FIELDS = [
    { key: 'frame', label: 'Frame' },
    // The position/speed rows depend on the provisional WRAM map. When the map is not yet
    // verified against a real ROM (CALIBRATION_VERIFIED === false) their labels carry an
    // explicit "(unverified)" tag so displayed values are never mistaken for confirmed.
    { key: 'marioX', label: 'Mario X (px.sub)', unverified: true },
    { key: 'marioY', label: 'Mario Y (px.sub)', unverified: true },
    { key: 'speedX', label: 'H-Speed', unverified: true },
  ];

  // Suffix appended to emulation-dependent labels while the address map is unverified.
  const UNVERIFIED_TAG = ' (unverified)';

  const PLACEHOLDER = '--';

  function renderSkeleton() {
    if (!hudEl) return;
    hudEl.innerHTML = '';
    for (const f of FIELDS) {
      const row = document.createElement('div');
      row.className = 'hud__row';
      const label = document.createElement('span');
      label.className = 'hud__label';
      label.textContent =
        f.unverified && !CALIBRATION_VERIFIED ? f.label + UNVERIFIED_TAG : f.label;
      if (f.unverified && !CALIBRATION_VERIFIED) label.classList.add('hud__label--unverified');
      const value = document.createElement('span');
      value.className = 'hud__value';
      value.dataset.key = f.key;
      value.textContent = PLACEHOLDER;
      row.appendChild(label);
      row.appendChild(value);
      hudEl.appendChild(row);
    }
  }

  function setValue(key, text) {
    if (!hudEl) return;
    const el = hudEl.querySelector(`[data-key="${key}"]`);
    if (el) el.textContent = text;
  }

  // Format a signed byte (SMB stores speed as a signed 8-bit value).
  function toSigned8(v) {
    return v >= 0x80 ? v - 0x100 : v;
  }

  /**
   * Per-frame refresh. When the memory view is unavailable (core/ROM absent) every field
   * gracefully shows a placeholder. All memory access here is read-only.
   */
  function update() {
    if (!hudEl) return;

    // The engine frame counter is always available and never a memory write.
    const frame = engine && typeof engine.currentFrame === 'number' ? engine.currentFrame : 0;
    setValue('frame', String(frame));

    const mem = engine && typeof engine.getMemoryView === 'function' ? engine.getMemoryView() : null;
    if (!mem) {
      // Core/ROM not present yet: keep placeholders for the emulation-dependent fields.
      setValue('marioX', PLACEHOLDER);
      setValue('marioY', PLACEHOLDER);
      setValue('speedX', PLACEHOLDER);
      return;
    }

    const base = SMB_WRAM_BASE;
    // READ-ONLY reads via the engine's read accessors.
    const xPage = mem.readU8(base + SMB_ADDR.PLAYER_PAGE_LOC);
    const xPos = mem.readU8(base + SMB_ADDR.PLAYER_X_POSITION);
    const xSub = mem.readU8(base + SMB_ADDR.PLAYER_X_SUBPIXEL);
    const yPos = mem.readU8(base + SMB_ADDR.PLAYER_Y_POSITION);
    const ySub = mem.readU8(base + SMB_ADDR.PLAYER_Y_SUBPIXEL);
    const xSpeedRaw = mem.readU8(base + SMB_ADDR.PLAYER_X_SPEED);

    // Full X = page * 256 + on-screen position; sub-pixel shown as a fraction (/256).
    const marioX = xPage * 256 + xPos;
    const speedX = toSigned8(xSpeedRaw);

    setValue('marioX', `${marioX}.${String(xSub).padStart(3, '0')}`);
    setValue('marioY', `${yPos}.${String(ySub).padStart(3, '0')}`);
    setValue('speedX', `${speedX}`);
  }

  function isActive() {
    return !!(engine && typeof engine.getMemoryView === 'function' && engine.getMemoryView());
  }

  renderSkeleton();

  return { update, isActive };
}

// Auto-wire when loaded as a module alongside the engine singleton.
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    try {
      const engine = window.TASEngine;
      const hudEl = document.getElementById('hud');
      if (engine && hudEl) {
        const watch = createMemoryWatch(engine, hudEl);
        window.__memoryWatch = watch;
        if (typeof engine.onFrame === 'function') {
          engine.onFrame(() => watch.update());
        }
        // Render initial values immediately (placeholders until core+ROM present).
        watch.update();
      }
    } catch (err) {
      console.warn('[memory-watch] init skipped:', err);
    }
  });
}
