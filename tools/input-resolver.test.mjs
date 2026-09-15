// tools/input-resolver.test.mjs
//
// Unit-tests input-resolver.js — the DETERMINISM contract of the TAS studio, tested with NO
// worker and NO browser. Proves that for any frame N the resolved joypad mask is EXACTLY
// (log.getMask(N) | liveMask) >>> 0, that the live mask applies to the current frame ONLY,
// that truncateAfter re-record behavior holds, and that restoreSnapshot restores exactly.
//
// Run: node tools/input-resolver.test.mjs

import assert from 'node:assert';
import { InputResolver, resolveMask, INPUT_OP } from '../input-resolver.js';
import { InputLog, JOYPAD_BITS } from '../input-log.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

const bit = (b) => 1 << JOYPAD_BITS[b];

// --- Seed a scripted log across several frames via the op protocol --------------------
const r = new InputResolver();
r.setFrameButton(0, 'A', true);
r.setFrameButton(1, 'B', true);
r.setFrameButton(2, 'RIGHT', true);
r.setFrameButton(2, 'A', true);
r.setFrameButton(5, 'START', true);

check('getFrameInputMask(N) returns exactly the scripted mask for N', () => {
  assert.strictEqual(r.getFrameInputMask(0), bit('A'));
  assert.strictEqual(r.getFrameInputMask(1), bit('B'));
  assert.strictEqual(r.getFrameInputMask(2), (bit('RIGHT') | bit('A')) >>> 0);
  assert.strictEqual(r.getFrameInputMask(5), bit('START'));
});

check('untouched frames resolve to 0', () => {
  assert.strictEqual(r.getFrameInputMask(3), 0);
  assert.strictEqual(r.getFrameInputMask(4), 0);
  assert.strictEqual(r.getFrameInputMask(999), 0);
});

check('a live mask OR-s in for the current frame ONLY (exact contract)', () => {
  const live = bit('X');
  // Frame 1 scripted B, plus live X this frame -> B|X.
  assert.strictEqual(r.getFrameInputMask(1, live), (bit('B') | bit('X')) >>> 0);
  // Frame 3 scripted nothing, live X -> X.
  assert.strictEqual(r.getFrameInputMask(3, live), bit('X'));
  // Without the live mask, the SAME frames revert (live never persisted across frames).
  assert.strictEqual(r.getFrameInputMask(1), bit('B'));
  assert.strictEqual(r.getFrameInputMask(3), 0);
});

check('frame N never reflects frame N+1 scripted input', () => {
  // Frame 1 must NOT contain frame 2's RIGHT/A; frame 4 must NOT contain frame 5's START.
  assert.strictEqual((r.getFrameInputMask(1) & bit('RIGHT')) >>> 0, 0);
  assert.strictEqual((r.getFrameInputMask(1) & bit('A')) >>> 0, 0);
  assert.strictEqual((r.getFrameInputMask(4) & bit('START')) >>> 0, 0);
});

check('resolveMask free function matches the class contract', () => {
  const log = new InputLog();
  log.set(7, 'L', true);
  assert.strictEqual(resolveMask(log, 7, bit('R')), (bit('L') | bit('R')) >>> 0);
  assert.strictEqual(resolveMask(log, 7), bit('L'));
  assert.strictEqual(resolveMask(log, 8), 0);
});

check('resolved mask is an unsigned 32-bit value', () => {
  const log = new InputLog();
  // A high live bit must not produce a negative Number.
  const v = resolveMask(log, 0, 0x80000000);
  assert.ok(v >= 0, `expected unsigned, got ${v}`);
  assert.strictEqual(v, 0x80000000);
});

// --- truncateAfter (re-record) --------------------------------------------------------
check('truncateAfter(frame) discards scripted input AFTER frame (re-record)', () => {
  const t = new InputResolver();
  t.setFrameButton(0, 'A', true);
  t.setFrameButton(3, 'B', true);
  t.setFrameButton(6, 'X', true);
  // Rewind so nothing survives after frame 3.
  t.truncateAfter(3);
  assert.strictEqual(t.getFrameInputMask(0), bit('A'));
  assert.strictEqual(t.getFrameInputMask(3), bit('B'));
  assert.strictEqual(t.getFrameInputMask(6), 0, 'frame after truncation must be cleared');
  assert.strictEqual(t.log.length, 4, 'log keeps frames 0..3 inclusive');
});

check('applyEdit(TRUNCATE_AFTER) op form matches the convenience wrapper', () => {
  const t = new InputResolver();
  t.setFrameButton(2, 'A', true);
  t.setFrameButton(4, 'B', true);
  assert.strictEqual(t.applyEdit({ op: INPUT_OP.TRUNCATE_AFTER, frame: 2 }), true);
  assert.strictEqual(t.getFrameInputMask(4), 0);
});

// --- restoreSnapshot ------------------------------------------------------------------
check('restoreSnapshot restores the scripted log EXACTLY', () => {
  const s = new InputResolver();
  s.setFrameButton(0, 'A', true);
  s.setFrameButton(2, 'RIGHT', true);
  const snap = s.snapshot();
  // Mutate away from the snapshot, then restore.
  s.setFrameButton(0, 'A', false);
  s.setFrameButton(9, 'START', true);
  assert.strictEqual(s.getFrameInputMask(0), 0);
  assert.strictEqual(s.getFrameInputMask(9), bit('START'));
  s.restoreSnapshot(snap);
  assert.strictEqual(s.getFrameInputMask(0), bit('A'));
  assert.strictEqual(s.getFrameInputMask(2), bit('RIGHT'));
  assert.strictEqual(s.getFrameInputMask(9), 0, 'restore drops frames not in the snapshot');
});

// --- op protocol fail-closed ----------------------------------------------------------
check('applyEdit fail-closed on unknown / malformed ops', () => {
  const u = new InputResolver();
  assert.strictEqual(u.applyEdit(null), false);
  assert.strictEqual(u.applyEdit({}), false);
  assert.strictEqual(u.applyEdit({ op: 'writeMemory', frame: 0 }), false);
  assert.strictEqual(u.applyEdit({ op: INPUT_OP.SET_FRAME_BUTTON, frame: 'x' }), false);
  assert.strictEqual(u.applyEdit({ op: INPUT_OP.RESTORE_SNAPSHOT, masks: 'nope' }), false);
});

check('no memory-write / cheat / level-select surface on the resolver', () => {
  const g = new InputResolver();
  for (const k of ['writeMemory', 'poke', 'pokeU8', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat', 'selectLevel']) {
    assert.strictEqual(typeof g[k], 'undefined', `unexpected method: ${k}`);
  }
});

let failed = 0;
for (const res of results) {
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${res.name}${res.ok ? '' : '  -> ' + res.err}`);
  if (!res.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
