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
// ------------------- SMB1 (Super Mario All-Stars, USA) WRAM map — EMPIRICAL ----------------
// These addresses were MEASURED, not guessed, against the real committed ROM + accuracy core
// via the reproducible headless harness tools/hud-calibrate.mjs. That harness boots the core,
// drives input into SMB1 gameplay, and watches which SNES WRAM bytes track Mario's motion.
//
// VERIFIED (ships with CALIBRATION_VERIFIED semantics per-field):
//   0x005D  Player_X_Speed — Mario's SIGNED horizontal speed. Proof (reproducible): holding
//           RIGHT makes it ACCELERATE from 0 up to walk speed (~+21); releasing makes it
//           FRICTION-DECELERATE back toward 0; holding LEFT makes it go NEGATIVE (two's
//           complement, e.g. -2, -3, ... -8) and accelerate leftward. That accel / friction /
//           signed-reversal signature is unique to a physical velocity, so 0x005D is the X
//           speed. (Note: the NES classic $0057 is dead in All-Stars; the real byte is $005D.)
//
// NOT VERIFIED (deliberately NOT shipped with fabricated addresses):
//   Mario's X/Y PIXEL and SUB-PIXEL position. In the gameplay state reachable by headless
//   menu navigation, Mario builds speed but does not translate freely (pinned against level
//   geometry at spawn), so the position/sub-pixel bytes never showed the monotonic-increment
//   + 0..255 rollover signature required to confirm them. The classic NES offsets ($0086 X,
//   $006D page, $0400 X-subpixel, $00CE Y, $0416 Y-subpixel) — raw AND rebased into the upper
//   WRAM bank (+0x10000) — stay frozen; the only bytes that move under RIGHT are camera /
//   animation / double-buffer artifacts that fail the idle-hold + reversal checks. Per the
//   project rule "do not guess the sub-pixels", these rows keep the honest "(unverified)"
//   label and show the raw candidate read only as a best-effort observation.
//
// Until the ROM + core are present, getMemoryView() returns null and the HUD shows
// placeholders, so no address is ever dereferenced in the untested state.
// ------------------------------------------------------------------------------------------

'use strict';

// Offset applied to every address to reach the All-Stars WRAM copy. Measurement shows the
// live SMB1 variables the HUD uses are in the low WRAM page (0 base); kept configurable (a
// read-only display concern, never a write path) so the map can be re-based if needed.
export const SMB_WRAM_BASE = 0x0000;

// GLOBAL verified flag = true only when EVERY emulation-dependent field is empirically
// confirmed. It ships FALSE because X/Y position + sub-pixel could not be verified headlessly
// (see header). Per-field verification is tracked in SMB_FIELD_VERIFIED below so the VERIFIED
// field (H-Speed) can drop its "(unverified)" tag while the unconfirmed rows keep theirs.
export const CALIBRATION_VERIFIED = false;

// Per-field empirical verification. H-Speed ($005D) is proven (accel/friction/reversal);
// position + sub-pixel are not (never observed translating). Read-only display metadata.
export const SMB_FIELD_VERIFIED = Object.freeze({
  speedX: true, // 0x005D proven via accel/friction/signed-reversal
  marioX: false, // X pixel+subpixel: not empirically confirmable headlessly (not guessed)
  marioY: false, // Y pixel+subpixel: not empirically confirmable headlessly (not guessed)
});

// WRAM addresses. VERIFIED ones are the measured All-Stars SMB1 bytes; the position bytes
// are the classic NES offsets retained ONLY as an honest best-effort (labeled unverified).
export const SMB_ADDR = Object.freeze({
  // VERIFIED (tools/hud-calibrate.mjs): Mario's signed horizontal speed.
  PLAYER_X_SPEED: 0x005d,
  // UNVERIFIED best-effort (classic NES SMB1 offsets; observed frozen in All-Stars). These
  // are shown with an explicit "(unverified)" tag and must not be trusted for TAS routing.
  PLAYER_X_POSITION: 0x0086, // on-screen X pixel (low byte) — UNVERIFIED
  PLAYER_PAGE_LOC: 0x006d, // horizontal page (high byte of X) — UNVERIFIED
  PLAYER_X_SUBPIXEL: 0x0400, // X sub-pixel (Player_X_MoveForce) — UNVERIFIED
  PLAYER_Y_POSITION: 0x00ce, // on-screen Y pixel — UNVERIFIED
  PLAYER_Y_SUBPIXEL: 0x0416, // Y sub-pixel (Player_Y_MoveForce) — UNVERIFIED
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
  // Each emulation-dependent row carries its own verification state (SMB_FIELD_VERIFIED). A
  // verified row (H-Speed) shows a clean label; an unverified row (Mario X/Y position + sub-
  // pixel) keeps an explicit "(unverified)" tag so its value is never trusted for routing.
  const FIELDS = [
    { key: 'frame', label: 'Frame' }, // from the engine's own counter, always trustworthy
    { key: 'marioX', label: 'Mario X (px.sub)', emu: true },
    { key: 'marioY', label: 'Mario Y (px.sub)', emu: true },
    { key: 'speedX', label: 'H-Speed', emu: true },
  ];

  // Suffix appended to emulation-dependent labels whose address is not yet verified.
  const UNVERIFIED_TAG = ' (unverified)';

  const PLACEHOLDER = '--';

  // A field is shown "unverified" when it depends on WRAM (emu) and its address has NOT been
  // empirically confirmed (per-field flag). The frame counter is never marked unverified.
  function isUnverified(f) {
    return !!f.emu && SMB_FIELD_VERIFIED[f.key] !== true;
  }

  function renderSkeleton() {
    if (!hudEl) return;
    hudEl.innerHTML = '';
    for (const f of FIELDS) {
      const row = document.createElement('div');
      row.className = 'hud__row';
      const label = document.createElement('span');
      label.className = 'hud__label';
      const unverified = isUnverified(f);
      label.textContent = unverified ? f.label + UNVERIFIED_TAG : f.label;
      if (unverified) label.classList.add('hud__label--unverified');
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
