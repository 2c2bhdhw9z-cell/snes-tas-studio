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
// EVERY address below was MEASURED, not guessed, against the real committed ROM + accuracy
// core via the reproducible headless harness tools/hud-calibrate.mjs. That harness boots the
// core, drives input through the All-Stars menus into SMB1 gameplay, then MATHEMATICALLY
// proves each byte by watching how it responds to input (its raw proof output is the evidence
// of record — re-run `node tools/hud-calibrate.mjs`, which exits non-zero unless all pass).
//
// ALL FIELDS EMPIRICALLY VERIFIED (CALIBRATION_VERIFIED = true):
//
//   0x005D  Player_X_Speed — SIGNED horizontal speed. Proof: under RIGHT it ACCELERATES 0 ->
//           +walk/run (~+24); on release it FRICTION-DECELERATES toward 0; under LEFT it goes
//           NEGATIVE (two's complement) and accelerates left. That accel / friction / signed-
//           reversal signature is unique to a physical velocity. (The NES classic $0057 is
//           dead in All-Stars; the real byte is $005D.)
//
//   0x0042  Player X PIXEL (on-screen X, low byte)     ]  little-endian 16-bit on-screen X.
//   0x0043  Player X PAGE  (on-screen X, high byte)    ]  Proof (VELOCITY INTEGRAL): during a
//   0x0401  Player X SUB-PIXEL (MoveForce accumulator) ]  sustained run the sub-pixel $0401
//           accumulates speed*16 (1/256 px) each frame; every 256 overflow carries exactly one
//           pixel into $0042, and when $0042 rolls 255->0 the page $0043 increments. Over the
//           measured run the PREDICTED number of sub-pixel carries EQUALS the measured net
//           movement of $0042 (to within a couple of frames), $0042 rolls 255->0 into $0043,
//           and at speed 0 the sub-pixel FREEZES. This delta-match rejects camera/animation/
//           timer counters, which do not track the integral of $005D through accel + steady.
//
//   0x0002  Player Y PIXEL (on-screen Y)               ]  Proof (GRAVITY): holding A makes
//   0x041C  Player Y SUB-PIXEL (MoveForce accumulator) ]  Mario jump; the 16-bit vertical
//           position ($0002 pixel << 8 | $041C sub) traces a SMOOTH PARABOLA whose per-frame
//           velocity shrinks by a CONSTANT gravity (~32 sub-units/frame^2), crosses zero at the
//           apex, then grows again on the way down, returning Mario to the exact ground pixel.
//           A camera/animation counter cannot produce a constant-acceleration parabola that
//           closes back to its start.
//
// px.sub display: the pixel value is the whole-pixel position ($0043*256+$0042 for X, $0002
// for Y); the sub-pixel byte is shown as the fractional 1/256 part after the dot.
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
// confirmed. It now ships TRUE: H-Speed, X pixel/page/sub-pixel, and Y pixel/sub-pixel are ALL
// proven by tools/hud-calibrate.mjs (velocity-integral carry-match for X + gravity parabola
// for Y; that harness exits non-zero unless every field verifies). Per-field verification is
// still tracked in SMB_FIELD_VERIFIED for the HUD's per-row display logic.
export const CALIBRATION_VERIFIED = true;

// Per-field empirical verification. All emulation-dependent fields are proven:
//   speedX: $005D via accel / friction / signed reversal
//   marioX: $0042 pixel + $0043 page + $0401 sub-pixel via velocity-integral carry match
//   marioY: $0002 pixel + $041C sub-pixel via the constant-gravity jump parabola
// Read-only display metadata only.
export const SMB_FIELD_VERIFIED = Object.freeze({
  speedX: true,
  marioX: true,
  marioY: true,
});

// WRAM addresses — all EMPIRICALLY MEASURED for SMB1 within Super Mario All-Stars (USA) by
// tools/hud-calibrate.mjs (see the header for the proof of each). Observation-only constants.
export const SMB_ADDR = Object.freeze({
  PLAYER_X_SPEED: 0x005d, // signed horizontal speed (accel/friction/reversal proof)
  PLAYER_X_POSITION: 0x0042, // on-screen X pixel (low byte)  — velocity-integral proof
  PLAYER_PAGE_LOC: 0x0043, // horizontal page (high byte of X) — rollover proof
  PLAYER_X_SUBPIXEL: 0x0401, // X sub-pixel (Player_X_MoveForce) — carry-match + idle-freeze
  PLAYER_Y_POSITION: 0x0002, // on-screen Y pixel — gravity parabola proof
  PLAYER_Y_SUBPIXEL: 0x041c, // Y sub-pixel (Player_Y_MoveForce) — constant-gravity parabola
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
  // Each emulation-dependent row carries its own verification state (SMB_FIELD_VERIFIED). All
  // rows are currently VERIFIED, so every label renders clean (no tag). The tagging logic is
  // retained as a defensive guard: if a future field were added without an empirically proven
  // address, it would automatically render an explicit "(unverified)" tag rather than be
  // silently trusted for routing.
  const FIELDS = [
    { key: 'frame', label: 'Frame' }, // from the engine's own counter, always trustworthy
    { key: 'marioX', label: 'Mario X (px.sub)', emu: true },
    { key: 'marioY', label: 'Mario Y (px.sub)', emu: true },
    { key: 'speedX', label: 'H-Speed', emu: true },
  ];

  // Suffix appended to any emulation-dependent label whose address is not empirically proven.
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
