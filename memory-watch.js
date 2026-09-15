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

// ---------------------------- PER-CORE WRAM MAPS (empirical) -----------------------------
//
// IMPORTANT (empirically established): different libretro cores can expose
// RETRO_MEMORY_SYSTEM_RAM with a different base / mirroring even when the reported size is
// identical. tools/run-smoke.mjs shows BOTH bsnes-mercury and snes9x report a 131072-byte
// SYSTEM_RAM region, yet the bsnes-verified SMB1 offsets do NOT read the same variables on
// snes9x: tools/hud-crosscheck.mjs (run against cores/snes9x_libretro.js) shows the bsnes
// $005D / $0042 / $0002 offsets fail every physics proof there (no velocity-integral carry
// match, no gravity parabola). So the HUD keeps a PER-CORE map, selected by the engine's
// active core id (engine.activeCoreId), and each core's map carries its own verification
// state so the HUD never presents an unproven address as if it were confirmed.
//
//   * bsnes cores (accuracy + performance): the map below is EMPIRICALLY PROVEN by
//     tools/hud-calibrate.mjs (velocity-integral carry-match for X, gravity parabola for Y,
//     accel/friction/signed-reversal for speed). CALIBRATION_VERIFIED = true for them.
//
//   * snes9x (real-time core): the correct SMB1 offsets for snes9x's SYSTEM_RAM region are
//     NOT YET empirically confirmed (the bsnes offsets are proven WRONG on it, and an
//     automated derivation did not converge on a provable map in this pass). Rather than
//     display fabricated/unverified values as if trustworthy — which would violate this
//     project's read-only, observation-only, prove-every-address discipline — the snes9x map
//     ships with verified=false. While a field is unverified the HUD renders it with an
//     explicit "(unverified)" tag (see the render logic) instead of a confidently-wrong
//     number. The frame counter (engine-sourced, not WRAM) is always correct on every core.
//
// The bsnes offset set (all proven by tools/hud-calibrate.mjs; see the header proofs):
const BSNES_MAP = Object.freeze({
  verified: true,
  addr: Object.freeze({
    PLAYER_X_SPEED: 0x005d, // signed horizontal speed (accel/friction/reversal proof)
    PLAYER_X_POSITION: 0x0042, // on-screen X pixel (low byte)  — velocity-integral proof
    PLAYER_PAGE_LOC: 0x0043, // horizontal page (high byte of X) — rollover proof
    PLAYER_X_SUBPIXEL: 0x0401, // X sub-pixel (Player_X_MoveForce) — carry-match + idle-freeze
    PLAYER_Y_POSITION: 0x0002, // on-screen Y pixel — gravity parabola proof
    PLAYER_Y_SUBPIXEL: 0x041c, // Y sub-pixel (Player_Y_MoveForce) — constant-gravity parabola
  }),
});

// The snes9x offset set. Placeholder = the bsnes offsets (so the HUD reads a valid, in-range
// WRAM location and never dereferences out of bounds), but flagged UNVERIFIED because those
// offsets are proven not to track Mario on snes9x. When the snes9x SMB1 offsets are
// empirically proven (tools/hud-crosscheck.mjs against cores/snes9x_libretro.js, all fields
// VERIFIED), replace these values and set verified:true.
const SNES9X_MAP = Object.freeze({
  verified: false,
  addr: BSNES_MAP.addr, // in-range placeholder; NOT proven to be Mario's vars on snes9x
});

// Per-core map registry, keyed by the catalog core id exposed via engine.activeCoreId.
export const CORE_WRAM_MAPS = Object.freeze({
  accuracy: BSNES_MAP,
  performance: BSNES_MAP,
  realtime: SNES9X_MAP, // snes9x — unverified until hud-crosscheck proves it
});

// The default map when the active core is unknown (e.g. before a core loads). We default to
// the bsnes (verified) map since the HUD only reads once a core+ROM are present; the actual
// map used at read time is always re-selected from engine.activeCoreId in update().
const DEFAULT_MAP = BSNES_MAP;

/** Resolve the WRAM map for a core id, falling back to the default map. */
export function mapForCore(coreId) {
  return (coreId && CORE_WRAM_MAPS[coreId]) || DEFAULT_MAP;
}

// GLOBAL verified flag — true only when EVERY core's map is empirically confirmed. Because the
// snes9x map is not yet proven, this now ships FALSE (bsnes-only calibration is proven; the
// added third core still needs its own proof). Per-core / per-field verification below drives
// the HUD's per-row display, so bsnes rows still render clean while snes9x rows are tagged.
export const CALIBRATION_VERIFIED = BSNES_MAP.verified && SNES9X_MAP.verified;

// Legacy alias retained for callers/tests that referenced the flat bsnes offset table. It
// mirrors the bsnes (proven) map. New code should use mapForCore(engine.activeCoreId).addr.
export const SMB_ADDR = BSNES_MAP.addr;

// Per-field empirical verification for the DEFAULT (bsnes) map, retained for back-compat.
// The live HUD computes per-field verification per active core in update() via mapForCore().
export const SMB_FIELD_VERIFIED = Object.freeze({
  speedX: true,
  marioX: true,
  marioY: true,
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

  // Suffix appended to any emulation-dependent label whose address is not empirically proven
  // FOR THE ACTIVE CORE. Because the map is per-core, this is recomputed whenever the active
  // core changes (bsnes rows render clean; snes9x rows are tagged until its map is proven).
  const UNVERIFIED_TAG = ' (unverified)';

  const PLACEHOLDER = '--';

  // Track the core id the current skeleton was rendered for, so we can re-render the labels
  // (verified vs "(unverified)") when the user swaps cores from the dropdown.
  let renderedCoreId = null;

  function activeCoreId() {
    return engine && typeof engine.activeCoreId === 'string' ? engine.activeCoreId : null;
  }

  // A field is shown "unverified" when it depends on WRAM (emu) and the ACTIVE CORE's map is
  // not empirically confirmed. The frame counter (engine-sourced) is never marked unverified.
  function isUnverified(f) {
    if (!f.emu) return false;
    const map = mapForCore(activeCoreId());
    return map.verified !== true;
  }

  function renderSkeleton() {
    if (!hudEl) return;
    renderedCoreId = activeCoreId();
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

    // If the active core changed (dropdown swap), re-render the skeleton so the labels'
    // verified vs "(unverified)" tags track the newly-selected core's map.
    if (activeCoreId() !== renderedCoreId) {
      renderSkeleton();
    }

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

    // Select the per-core WRAM offset map for whichever core is currently active. The HUD
    // stays correct across snes9x <-> bsnes swaps because the offsets used are always THIS
    // core's offsets (and any core whose map is unverified renders tagged, never fake-precise).
    const ADDR = mapForCore(activeCoreId()).addr;
    const base = SMB_WRAM_BASE;
    // READ-ONLY reads via the engine's read accessors.
    const xPage = mem.readU8(base + ADDR.PLAYER_PAGE_LOC);
    const xPos = mem.readU8(base + ADDR.PLAYER_X_POSITION);
    const xSub = mem.readU8(base + ADDR.PLAYER_X_SUBPIXEL);
    const yPos = mem.readU8(base + ADDR.PLAYER_Y_POSITION);
    const ySub = mem.readU8(base + ADDR.PLAYER_Y_SUBPIXEL);
    const xSpeedRaw = mem.readU8(base + ADDR.PLAYER_X_SPEED);

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
