// tools/fps-meter.test.mjs
//
// Unit test for the rolling-window FPS meter (../fps-meter.js) that powers the live on-screen
// FPS readout. The user asked for an honest, easy-to-read FPS number sourced from the ACTUAL
// advanced frames they see: the worker posts one 'frame' message per emulated frame and the
// main thread counts those over a rolling 1-second window. FPS = frames in the last second.
//
// These tests prove the math the UI depends on:
//   - counting timestamped frame events over a 1s window yields the right number,
//   - stamps older than the window are dropped (rolling, not cumulative),
//   - reads 0 cleanly when idle/paused (no divide-by-zero, no NaN/Infinity),
//   - a steady 60 fps stream reads ~60; a 30 fps stream reads ~30.
// Run: node fps-meter.test.mjs

import assert from 'node:assert';
import { FpsMeter } from '../fps-meter.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

check('default window is 1000ms (1 second)', () => {
  const m = new FpsMeter();
  assert.strictEqual(m.windowMs, 1000);
});

check('reads 0 when idle (no frames) — no divide-by-zero', () => {
  const m = new FpsMeter(1000);
  const n = m.fps(5000);
  assert.strictEqual(n, 0);
  assert.ok(Number.isFinite(n), 'fps is a finite number, never NaN/Infinity');
});

check('counts exactly the frames within the rolling 1s window', () => {
  const m = new FpsMeter(1000);
  // 60 frames evenly spaced over one second ending at t=1000 (t = 1000/60 * i, i=1..60).
  const step = 1000 / 60;
  for (let i = 1; i <= 60; i++) m.tick(i * step);
  // As of t=1000, all 60 stamps are within (0, 1000].
  assert.strictEqual(m.fps(1000), 60, 'a steady 60fps stream reads 60');
});

check('a steady 30fps stream reads ~30', () => {
  const m = new FpsMeter(1000);
  const step = 1000 / 30;
  for (let i = 1; i <= 30; i++) m.tick(i * step);
  assert.strictEqual(m.fps(1000), 30, '30 evenly-spaced frames in the last second read 30');
});

check('rolling window DROPS stamps older than windowMs (not cumulative)', () => {
  const m = new FpsMeter(1000);
  // 100 frames over TWO seconds (t = 20*i ms, i=1..100). As of t=2000 only the last second
  // of frames should be counted, NOT all 100.
  for (let i = 1; i <= 100; i++) m.tick(20 * i);
  const n = m.fps(2000);
  // Stamps in (1000, 2000] are i where 20*i > 1000 -> i in 51..100 = 50 frames.
  assert.strictEqual(n, 50, `only the last second counts (got ${n}, expected 50)`);
});

check('window boundary is exclusive at the old edge (stamp exactly windowMs old is dropped)', () => {
  const m = new FpsMeter(1000);
  m.tick(1000); // exactly windowMs before the read at 2000
  m.tick(1500);
  m.tick(2000);
  // cutoff = 2000 - 1000 = 1000; stamps <= 1000 are dropped, so 1000 is dropped, 1500 & 2000 kept.
  assert.strictEqual(m.fps(2000), 2);
});

check('decays toward 0 after frames stop arriving (paused emulator)', () => {
  const m = new FpsMeter(1000);
  for (let i = 1; i <= 60; i++) m.tick(i * (1000 / 60));
  assert.strictEqual(m.fps(1000), 60, 'full window right after playing');
  // Half a second later with no new frames: only the frames from (500,1000] remain (~30).
  const half = m.fps(1500);
  assert.ok(half >= 28 && half <= 32, `half-window later reads ~30 (got ${half})`);
  // A full window+ later with no frames: reads 0.
  assert.strictEqual(m.fps(2100), 0, 'reads 0 once the window empties (paused)');
});

check('custom window size is honored', () => {
  const m = new FpsMeter(500); // half-second window
  for (let i = 1; i <= 60; i++) m.tick(i * (1000 / 60));
  // As of t=1000, only stamps in (500, 1000] count -> ~30 frames.
  const n = m.fps(1000);
  assert.ok(n >= 29 && n <= 31, `500ms window of a 60fps stream reads ~30 (got ${n})`);
});

check('reset() forgets all frames (e.g. on core swap)', () => {
  const m = new FpsMeter(1000);
  for (let i = 1; i <= 60; i++) m.tick(i * (1000 / 60));
  m.reset();
  assert.strictEqual(m.fps(1000), 0, 'no frames counted after reset');
});

check('non-finite inputs are tolerated (defensive, never throws/NaN)', () => {
  const m = new FpsMeter(1000);
  assert.doesNotThrow(() => m.tick(undefined));
  assert.doesNotThrow(() => m.tick(NaN));
  const n = m.fps(NaN);
  assert.ok(Number.isFinite(n), 'fps stays finite even with a bad clock');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
