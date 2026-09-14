// tools/runloop.test.mjs
//
// Focused test for the TAS engine run loop (review fixes #1 and #2):
//   - The loop schedules the next frame in exactly ONE place, so only ONE rAF id is ever
//     outstanding (no orphaned/uncancelable chain, no ~2x emulation).
//   - pause() cancels that single tracked id and the loop actually stops.
//   - play() re-arms the loop with a fresh single id.
//   - frameAdvance() runs EXACTLY one frame while paused and does not start the loop.
//
// Uses a controllable fake requestAnimationFrame/cancelAnimationFrame so we can inspect
// exactly how many callbacks are outstanding at any moment. Run: node tools/runloop.test.mjs
import assert from 'node:assert';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// ---- Controllable fake rAF -------------------------------------------------------------
// pending maps id -> callback. flush() runs currently-pending callbacks once (a single
// "animation frame"), draining them first so re-arms scheduled during the flush queue for
// the NEXT flush (mirrors real rAF semantics).
let nextId = 1;
const pending = new Map();
let cancelCount = 0;

globalThis.requestAnimationFrame = (cb) => {
  const id = nextId++;
  pending.set(id, cb);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  if (pending.delete(id)) cancelCount++;
};

let clock = 0;
function flush() {
  const batch = [...pending.entries()];
  for (const [id] of batch) pending.delete(id);
  clock += 17; // ~one 60fps frame of wall-clock time
  for (const [, cb] of batch) cb(clock);
}

// Minimal DOM/fetch stubs so the ES module imports cleanly.
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ className: '', textContent: '' }),
  getElementById: () => null,
  head: { appendChild: () => {} },
};
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

const mod = await import('../tas-engine.js');
const { TASEngine } = mod;

// Build an engine in a 'ready' state with a counting retro_run, WITHOUT a real core.
function makeReadyEngine() {
  const engine = new TASEngine();
  engine.status = 'ready';
  engine.paused = true;
  let runs = 0;
  engine._fn.retro_run = () => { runs += 1; };
  engine._runCountRef = () => runs;
  return engine;
}

// --- play() schedules exactly one rAF id ---
check('play() schedules exactly one outstanding rAF', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.play();
  assert.strictEqual(pending.size, 1, `expected 1 pending, got ${pending.size}`);
});

// --- after several flushes there is still only ONE outstanding id (no double schedule) ---
check('only one rAF id outstanding across many frames (no double-schedule)', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.play();
  for (let i = 0; i < 10; i++) {
    flush();
    assert.strictEqual(pending.size, 1, `frame ${i}: expected 1 pending, got ${pending.size}`);
  }
});

// --- exactly one retro_run per animation frame at 1x (not ~2x) ---
check('runs ~one frame per animation frame at 1x speed (not 2x)', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.setSpeed(1);
  engine.play();
  // Prime timestamps.
  flush();
  const before = engine._runCountRef();
  for (let i = 0; i < 10; i++) flush();
  const after = engine._runCountRef();
  const perFrame = (after - before) / 10;
  // A double-scheduled loop would advance ~2x. Assert we're close to 1 per frame.
  assert.ok(perFrame >= 0.6 && perFrame <= 1.4, `frames/animation-frame = ${perFrame}`);
});

// --- pause() cancels the single tracked id and stops the loop ---
check('pause() cancels the tracked rAF id and stops the loop', () => {
  pending.clear();
  cancelCount = 0;
  const engine = makeReadyEngine();
  engine.play();
  assert.strictEqual(pending.size, 1);
  engine.pause();
  assert.strictEqual(engine._rafId, null, 'rafId should be cleared on pause');
  assert.strictEqual(pending.size, 0, 'no rAF should remain pending after pause');
  assert.strictEqual(cancelCount, 1, 'exactly one cancelAnimationFrame call');
  // Flushing does nothing (loop is truly stopped) and advances no frames.
  const before = engine._runCountRef();
  flush();
  assert.strictEqual(engine._runCountRef(), before, 'no frames advance while paused/stopped');
  assert.strictEqual(pending.size, 0, 'loop stays stopped after pause');
});

// --- play() after pause re-arms exactly one id ---
check('play() re-arms exactly one rAF id after pause', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.play();
  engine.pause();
  assert.strictEqual(pending.size, 0);
  engine.play();
  assert.strictEqual(pending.size, 1, 'play() should re-arm exactly one rAF');
  // And still only one across subsequent frames.
  flush();
  assert.strictEqual(pending.size, 1);
});

// --- frameAdvance() runs EXACTLY one frame while paused and does not start the loop ---
check('frameAdvance() runs exactly one frame and does not start the loop', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.pause();
  const before = engine._runCountRef();
  engine.frameAdvance();
  assert.strictEqual(engine._runCountRef() - before, 1, 'exactly one retro_run');
  assert.strictEqual(engine.currentFrame, 1, 'frame counter advanced by one');
  assert.strictEqual(pending.size, 0, 'frameAdvance must not schedule a loop');
});

// --- frameAdvance() while running still advances exactly one frame and stops the loop ---
check('frameAdvance() while playing pauses and advances exactly one frame', () => {
  pending.clear();
  const engine = makeReadyEngine();
  engine.play();
  const before = engine._runCountRef();
  engine.frameAdvance();
  assert.strictEqual(engine.paused, true, 'frameAdvance pauses');
  assert.strictEqual(engine._runCountRef() - before, 1, 'exactly one retro_run');
  assert.strictEqual(pending.size, 0, 'loop stopped after frameAdvance');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
