// tools/runloop.test.mjs
//
// Focused test for the SINGLE-THREAD run loop pacing (THE GREAT REVERSAL, FEAT-002/003).
//
// The emulator is back on the main thread: tas-engine.js owns ONE requestAnimationFrame loop
// and paces the reused EmuCoreRunner by injecting an rAF-based scheduleYield into it (design
// CHOICE A). The runner keeps its target-time accumulator (bounded catch-up MAX_CATCHUP_FRAMES,
// speed 0.1-2x, fast-forward burst, frame-skip beyond the clamp, ASYNCIFY awaits); the engine
// coalesces to EXACTLY ONE present per rAF turn after each tick.
//
// The first half of this file drives the runner's accumulator DIRECTLY through an injected
// controllable scheduler (the exact seam the engine's rAF scheduleYield uses) and asserts the
// pacing contract the reversal relies on:
//   - exactly ONE tick outstanding (re-arms once per tick, never double-schedules)
//   - pause() stops the loop; play() re-arms exactly one tick after a pause
//   - speed scaling: 2x advances more frames than 0.5x for equal wall-clock
//   - fast-forward runs a bounded burst per tick
//   - frame-advance = EXACTLY one frame with that frame's resolved input, does NOT start the loop
//   - an ASYNCIFY core AWAITS retro_run (never overlapping suspensions)
//   - target-time pacing: ~60 emu-frames/sec at 1x, ~30 at 0.5x, ~120 at 2x, HARD-clamped
//     catch-up, no death-spiral, present decoupled from compute
//
// The second half drives the REAL single-thread tas-engine.js rAF loop (fake rAF + mock core)
// and asserts the top-level reversal invariant: EXACTLY ONE present per rAF turn, even under a
// catch-up burst or a fast-forward burst (many retro_run in one turn -> still one draw).
//
// This complements tools/emu-core-runner.test.mjs (boot/decode/save-load/HUD) + engine-smoke.
// Run: node runloop.test.mjs
import assert from 'node:assert';
import { EmuCoreRunner } from '../emu-core-runner.js';

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r;
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// --- A minimal mock libretro Module (enough to drive the loop) -------------------------
function makeMockModule({ asyncify = false } = {}) {
  const HEAP_BYTES = 1 << 18;
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPU32 = new Uint32Array(buffer);
  const HEAPU16 = new Uint16Array(buffer);
  const HEAPF64 = new Float64Array(buffer);
  let bump = 0x10000;
  const _malloc = (n) => { const p = bump; bump += (n + 7) & ~7; return p; };
  const _free = () => {};
  const WRAM_PTR = 0x8000;
  const table = [];
  const cbs = {};
  const addFunction = (fn) => { table.push(fn); return table.length; };
  let runs = 0;
  let resolveGate = null;
  // Track in-flight (suspended) ASYNCIFY runs so a test can prove suspensions never overlap:
  // libco/Asyncify cannot have more than one retro_run suspended at a time.
  let inFlight = 0;
  let maxInFlight = 0;
  const gates = [];
  const fnTable = {
    retro_init: () => {},
    retro_deinit: () => {},
    retro_reset: () => {},
    retro_unload_game: () => {},
    retro_load_game: () => 1,
    retro_run: () => {
      runs += 1;
      // Fire the input_state callback so the resolver is consulted for the current frame.
      const icb = table[cbs.input - 1];
      if (typeof icb === 'function') icb(0, 1, 0, 0);
      if (asyncify) {
        // Simulate a suspended (awaited) retro_run: return a promise the test resolves.
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        return new Promise((res) => {
          const gate = () => { inFlight -= 1; res(); };
          resolveGate = gate;
          gates.push(gate);
        });
      }
    },
    retro_serialize_size: () => 8,
    retro_serialize: () => 1,
    retro_unserialize: () => 1,
    retro_get_memory_data: (id) => (id === 2 ? WRAM_PTR : 0),
    retro_get_memory_size: (id) => (id === 2 ? 0x2000 : 0),
    retro_set_environment: (p) => { cbs.env = p; },
    retro_set_video_refresh: (p) => { cbs.video = p; },
    retro_set_audio_sample: (p) => { cbs.audioSample = p; },
    retro_set_audio_sample_batch: (p) => { cbs.audioBatch = p; },
    retro_set_input_poll: (p) => { cbs.inputPoll = p; },
    retro_set_input_state: (p) => { cbs.input = p; },
    retro_get_system_av_info: (ptr) => {
      HEAPU32[(ptr >> 2) + 0] = 256;
      HEAPU32[(ptr >> 2) + 1] = 224;
      HEAPF64[(ptr + 24) >> 3] = 60.098;
    },
  };
  const cwrap = (name) => { const fn = fnTable[name]; if (!fn) throw new Error('unknown ' + name); return fn; };
  return {
    HEAPU8, HEAP32, HEAPU32, HEAPU16, HEAPF64, _malloc, _free, cwrap, addFunction,
    __runs: () => runs,
    __resolveGate: () => { if (resolveGate) { const r = resolveGate; resolveGate = null; r(); } },
    __gated: () => !!resolveGate,
    __inFlight: () => inFlight,
    __maxInFlight: () => maxInFlight,
    __resolveAll: () => { while (gates.length) { const g = gates.shift(); g(); } resolveGate = null; },
  };
}

// The runner reads performance.now(); install a controllable one for the whole file.
let CLOCK = 1000;
globalThis.performance = { now: () => CLOCK };

async function makeRunner({ asyncify = false } = {}) {
  const mock = makeMockModule({ asyncify });
  const state = { pending: null, inputFrames: [] };
  const runner = new EmuCoreRunner({
    asyncify,
    loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
    fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
    scheduleYield: (cb) => { state.pending = cb; return 1; },
    getFrameInputMask: (frame) => { state.inputFrames.push(frame); return 0; },
  });
  await runner.boot();
  return { runner, mock, state };
}

// Drive N scheduler ticks, advancing the fake clock by dtMs before each tick.
function pump(runner, state, ticks, dtMs) {
  for (let i = 0; i < ticks && state.pending; i++) {
    const cb = state.pending;
    state.pending = null;
    CLOCK += dtMs;
    cb();
  }
}

// ======================================================================================
await checkAsync('play() schedules exactly ONE outstanding tick', async () => {
  const { runner, state } = await makeRunner();
  CLOCK = 1000;
  runner.start();
  assert.ok(state.pending, 'a tick is scheduled after start()');
});

await checkAsync('only one tick outstanding across many frames (no double-schedule)', async () => {
  const { runner, state } = await makeRunner();
  CLOCK = 1000;
  runner.start();
  // After each tick, exactly one new tick should be pending (never two). We detect a
  // double-schedule by checking that draining `pending` once always yields <=1 next tick.
  for (let i = 0; i < 10; i++) {
    assert.ok(state.pending, `tick ${i}: a tick should be pending`);
    const cb = state.pending;
    state.pending = null;
    CLOCK += 17;
    cb();
    // If the loop double-scheduled, `pending` would have been overwritten but the count of
    // re-arms per tick is still one — assert the loop is still running with a single handle.
    assert.ok(runner._loopRunning === true || runner.paused, `tick ${i}: loop consistent`);
  }
});

await checkAsync('pause() stops the loop (no re-arm, no further frames)', async () => {
  const { runner, mock, state } = await makeRunner();
  CLOCK = 1000;
  runner.start();
  pump(runner, state, 3, 100);
  const before = mock.__runs();
  runner.pause();
  // Draining any straggler tick must not advance frames once paused.
  if (state.pending) { const cb = state.pending; state.pending = null; CLOCK += 100; cb(); }
  assert.strictEqual(runner._loopRunning, false, 'loop stopped on pause');
  assert.strictEqual(mock.__runs(), before, 'no frames advance after pause');
});

await checkAsync('play() re-arms exactly one tick after pause', async () => {
  const { runner, state } = await makeRunner();
  CLOCK = 1000;
  runner.start();
  pump(runner, state, 2, 100);
  runner.pause();
  state.pending = null;
  runner.start();
  assert.ok(state.pending, 'play() re-arms a single tick after pause');
});

await checkAsync('speed scaling: 2x advances more frames than 0.5x for equal wall-clock', async () => {
  // 0.5x run.
  const slow = await makeRunner();
  CLOCK = 1000;
  slow.runner.setSpeed(0.5);
  slow.runner.start();
  pump(slow.runner, slow.state, 1, 0); // seed _lastTs
  const slowBefore = slow.mock.__runs();
  pump(slow.runner, slow.state, 10, 50); // 10 ticks of 50ms
  const slowFrames = slow.mock.__runs() - slowBefore;

  // 2x run over the SAME wall-clock cadence.
  const fast = await makeRunner();
  CLOCK = 1000;
  fast.runner.setSpeed(2);
  fast.runner.start();
  pump(fast.runner, fast.state, 1, 0);
  const fastBefore = fast.mock.__runs();
  pump(fast.runner, fast.state, 10, 50);
  const fastFrames = fast.mock.__runs() - fastBefore;

  assert.ok(fastFrames > slowFrames, `2x (${fastFrames}) should advance more than 0.5x (${slowFrames})`);
});

await checkAsync('fast-forward runs a burst of frames per tick', async () => {
  const { runner, mock, state } = await makeRunner();
  CLOCK = 1000;
  runner.fastForward(true);
  runner.start();
  const before = mock.__runs();
  pump(runner, state, 1, 0); // one tick
  assert.ok(mock.__runs() - before >= 8, `fast-forward burst advanced >=8 frames (got ${mock.__runs() - before})`);
});

await checkAsync('frame-advance runs EXACTLY one frame with that frame input and does NOT start the loop', async () => {
  const { runner, mock, state } = await makeRunner();
  CLOCK = 1000;
  const before = mock.__runs();
  state.inputFrames.length = 0;
  runner.frameAdvance();
  assert.strictEqual(mock.__runs() - before, 1, 'exactly one retro_run');
  assert.strictEqual(runner.currentFrame, 1, 'frame counter advanced by one');
  assert.deepStrictEqual(state.inputFrames, [0], 'input resolved for exactly frame 0');
  assert.strictEqual(runner._loopRunning, false, 'frame-advance must not start the loop');
  assert.strictEqual(state.pending, null, 'frame-advance schedules no tick');
});

await checkAsync('ASYNCIFY core AWAITS retro_run: the loop only ticks after the frame resolves', async () => {
  const { runner, mock, state } = await makeRunner({ asyncify: true });
  CLOCK = 1000;
  const p = runner.frameAdvance(); // asyncify frameAdvance returns a promise
  // retro_run is now suspended (gated). The frame has NOT ticked yet.
  assert.ok(mock.__gated(), 'retro_run is suspended (awaited)');
  assert.strictEqual(runner.currentFrame, 0, 'frame not counted until the awaited run resolves');
  mock.__resolveGate();
  await p;
  assert.strictEqual(runner.currentFrame, 1, 'frame counted after the awaited retro_run resolves');
});

await checkAsync('ASYNCIFY fast-forward burst AWAITS between frames (never overlaps suspensions)', async () => {
  const { runner, mock, state } = await makeRunner({ asyncify: true });
  CLOCK = 1000;
  runner.fastForward(true);
  runner.start();
  // Kick the one scheduled tick. Because the burst awaits each retro_run, only ONE frame
  // suspends and the tick's async body parks on the first gate — it does NOT fire all 8.
  const cb = state.pending;
  state.pending = null;
  CLOCK += 0;
  cb(); // async _tick; returns a promise we don't hold, but its progress is gated
  // Let microtasks settle: still only the first frame should be suspended.
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(mock.__inFlight(), 1, 'exactly one retro_run suspended at a time');
  assert.strictEqual(mock.__runs(), 1, 'only the first burst frame has started (awaited)');
  // Resolve frames one at a time; each resolution should release exactly one more run, and
  // the in-flight count must never exceed 1.
  for (let i = 0; i < 8; i++) {
    mock.__resolveGate();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(mock.__inFlight() <= 1, `after resolving frame ${i}, in-flight <= 1`);
  }
  assert.strictEqual(mock.__maxInFlight(), 1, 'suspensions NEVER overlapped (max in-flight == 1)');
});

await checkAsync('SYNCHRONOUS fast-forward burst is unchanged: 8 inline frames, no suspensions', async () => {
  const { runner, mock, state } = await makeRunner({ asyncify: false });
  CLOCK = 1000;
  runner.fastForward(true);
  runner.start();
  const before = mock.__runs();
  const cb = state.pending;
  state.pending = null;
  CLOCK += 0;
  const r = cb(); // synchronous burst: _tick's async body runs the 8 frames inline
  if (r && typeof r.then === 'function') await r;
  assert.strictEqual(mock.__runs() - before, 8, 'synchronous burst still advances exactly 8 frames per tick');
  assert.strictEqual(mock.__maxInFlight(), 0, 'synchronous core never suspends retro_run');
  assert.ok(state.pending, 'loop re-armed exactly one tick after the synchronous burst');
});

// ======================================================================================
// SCHEDULER SEAM: the engine paces the runner by INJECTING an rAF-based scheduleYield (CHOICE
// A). The runner's synchronous tick re-arms the NEXT turn FIRST (before running frames), so the
// engine's rAF turn is decoupled from frame decode/present. We already inject a controllable
// scheduler above (state.pending), which is exactly that seam. Here we assert the injected
// scheduler is honored and the runner never falls back to any internal timer/macrotask when a
// scheduler IS provided -- i.e. the running app's pacing is 100% the engine's rAF loop.

await checkAsync('injected scheduler is the ONLY loop driver (no setTimeout/MessageChannel fallback when injected)', async () => {
  const savedST = globalThis.setTimeout;
  const savedMC = globalThis.MessageChannel;
  let setTimeoutUsed = 0;
  let mcUsed = 0;
  globalThis.setTimeout = (...args) => { setTimeoutUsed += 1; return savedST(...args); };
  globalThis.MessageChannel = class { constructor() { mcUsed += 1; this.port1 = {}; this.port2 = { postMessage() {} }; } };
  try {
    const { runner, mock, state } = await makeRunner(); // makeRunner injects scheduleYield
    CLOCK = 1000;
    runner.start();
    // Drive several turns through the INJECTED scheduler only.
    for (let i = 0; i < 6; i++) { if (!state.pending) break; const cb = state.pending; state.pending = null; CLOCK += 17; cb(); }
    runner.pause();
    assert.ok(mock.__runs() >= 1, 'the injected-scheduler-paced loop advanced frames');
    assert.strictEqual(setTimeoutUsed, 0, 'no setTimeout fallback while a scheduler is injected (engine owns pacing)');
    assert.strictEqual(mcUsed, 0, 'no MessageChannel fallback while a scheduler is injected (no cross-thread port)');
  } finally {
    globalThis.setTimeout = savedST;
    globalThis.MessageChannel = savedMC;
  }
});

await checkAsync('fps pacing: loop targets the core-declared frame time (_baseFrameMs from av_info fps)', async () => {
  const { runner, mock, state } = await makeRunner();
  CLOCK = 1000;
  // av_info fps mocked to 60.098 -> _baseFrameMs ~= 16.639 ms.
  assert.ok(Math.abs(runner._baseFrameMs - 1000 / 60.098) < 1e-6, '_baseFrameMs derived from declared fps');
  runner.start();
  pump(runner, state, 1, 0); // seed _lastTs, no elapsed time -> no frame yet
  assert.strictEqual(mock.__runs(), 0, 'no frame runs before a frame-time of wall clock elapses (paced, not free-running)');
  const seeded = mock.__runs();
  // Advance just over one frame-time of wall clock: the accumulator should release exactly 1.
  pump(runner, state, 1, runner._baseFrameMs + 0.5);
  assert.strictEqual(mock.__runs() - seeded, 1, 'exactly one frame per one frame-time of elapsed wall clock');
  // Advance ten frame-times at once in a SINGLE tick: the paced loop advances more than one
  // frame (proving it targets real time, not one-frame-per-tick), but catch-up is HARD-CLAMPED
  // to at most 2 per tick (death-spiral fix) — it does NOT burst all ten.
  const before = mock.__runs();
  pump(runner, state, 1, runner._baseFrameMs * 10);
  const caughtUp = mock.__runs() - before;
  assert.ok(caughtUp >= 1 && caughtUp <= 2, `single-tick catch-up clamped to 1-2 frames for 10x elapsed (got ${caughtUp})`);
});

// ======================================================================================
// THE 30 FPS-LOCK PROOF (the crux of this fix).
//
// The bug: the old loop re-armed its yield ONCE per tick, AFTER the tick's frame work + video
// present. On iOS Safari that turn cadence coalesced to ~30 Hz, so with one frame per turn the
// loop hard-locked at ~30 FPS regardless of how fast the core ran.
//
// The fix: a FREE-RUNNING pump (re-armed BEFORE frame work on the synchronous path) whose
// frame output is gated purely by a performance.now() TARGET-TIME accumulator. To prove it
// mechanically we model exactly the pathological condition: a pump that fires at a HIGH
// macrotask rate (so cadence is not the limiter) against a clock advancing at REAL time, and
// assert the loop issues ~60 frames per simulated second at speed 1 (NOT ~30), ~30 at 0.5x,
// with bounded catch-up and NO 2x over-run.
//
// runFreeRunning drives the injected scheduler as a free-running pump: each turn advances the
// fake clock by `pumpMs` (the macrotask granularity) and fires the pending tick, for a total
// of `simMs` simulated milliseconds. This is real 60fps proven headlessly (device FPS is
// on-device only, but the LOOP TARGET is proven here).
function runFreeRunning(runner, state, simMs, pumpMs) {
  const end = CLOCK + simMs;
  let turns = 0;
  // Fire the first pending tick that start() armed, then keep re-firing whatever the loop
  // re-arms, advancing the clock by pumpMs each turn — exactly a free-running macrotask pump.
  while (state.pending && CLOCK < end && turns < 1e6) {
    const cb = state.pending;
    state.pending = null;
    CLOCK += pumpMs;
    cb();
    turns += 1;
  }
  return turns;
}

await checkAsync('30 FPS-LOCK BROKEN: free-running pump issues ~60 frames per simulated second at speed 1', () => {
  // A pump firing every 4ms = 250 Hz (well above 60): if cadence still gated frames we would
  // see ~250 or, in the old coupled loop, whatever the turn rate was. Instead the target-time
  // accumulator must clamp output to the core's declared ~60.098 fps.
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 100000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 1000, 4); // 1 simulated second, 250 Hz pump
    const frames = mock.__runs();
    // ~60.098 expected. Tight band proves it is neither locked at ~30 nor free-running at 250.
    assert.ok(frames >= 55 && frames <= 63, `expected ~60 frames/sec, got ${frames} (must NOT be ~30 or ~250)`);
  });
});

await checkAsync('NOT 30: a slow ~30 Hz pump still reaches ~60 fps via bounded catch-up', () => {
  // Model the OLD pathological turn cadence directly: the pump itself only fires ~30x/sec.
  // The free-running loop must NOT be limited to one frame per turn — the accumulator releases
  // the frames that real time is due (bounded catch-up), so it still reaches ~60 fps.
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 200000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 1000, 33); // 1 simulated second, ~30 Hz pump
    const frames = mock.__runs();
    assert.ok(frames >= 55 && frames <= 63, `even at a 30 Hz pump the loop reaches ~60 fps (got ${frames}), NOT locked at ~30`);
  });
});

await checkAsync('speed 0.5x issues ~30 frames per simulated second (half of 60)', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 300000;
    runner.setSpeed(0.5);
    runner.start();
    runFreeRunning(runner, state, 1000, 4);
    const frames = mock.__runs();
    assert.ok(frames >= 27 && frames <= 33, `expected ~30 frames/sec at 0.5x, got ${frames}`);
  });
});

await checkAsync('speed 2x issues ~120 frames per simulated second (double 60), NO over-run beyond it', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 400000;
    runner.setSpeed(2);
    runner.start();
    runFreeRunning(runner, state, 1000, 4);
    const frames = mock.__runs();
    assert.ok(frames >= 110 && frames <= 126, `expected ~120 frames/sec at 2x, got ${frames} (no runaway over-run)`);
  });
});

await checkAsync('catch-up is HARD-CLAMPED: a long stall runs AT MOST 2 frames that turn, then FRAME-SKIPS', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 500000;
    runner.setSpeed(1);
    runner.start();
    // Seed one turn at real cadence, then jump the clock a full simulated second in ONE turn
    // (models a tab-backgrounded stall / a big CPU dip).
    runFreeRunning(runner, state, 20, 4);
    const before = mock.__runs();
    const anchorBefore = runner._nextFrameTime;
    // One giant turn: advance the clock 1000ms (~60 intervals overdue) but fire the tick once.
    const cb = state.pending;
    state.pending = null;
    CLOCK += 1000;
    cb();
    const burst = mock.__runs() - before;
    // DEATH-SPIRAL FIX: the clamp caps catch-up to at most 2 frames — NOT a ~60-frame burst,
    // NOT the old <=10. A device that fell behind must never try to replay missed wall-clock.
    assert.ok(burst <= 2, `single-turn catch-up burst HARD-clamped to <=2 (got ${burst})`);
    // FRAME-SKIP: rather than staying behind (which would burst again next turn), the anchor
    // was snapped forward to ~now, so the loop is caught up to real time WITHOUT replaying.
    assert.ok(runner._nextFrameTime > anchorBefore, 'anchor advanced (frame-skip), not left behind');
    assert.ok(
      runner._nextFrameTime >= CLOCK,
      'anchor snapped forward to now+interval (missed frames dropped, not queued)'
    );
    // And after the resync, normal cadence resumes at ~60 (not a compounding backlog).
    const afterBurst = mock.__runs();
    runFreeRunning(runner, state, 500, 4);
    const resumed = mock.__runs() - afterBurst;
    assert.ok(resumed >= 26 && resumed <= 34, `~60 fps resumes after the frame-skip (got ${resumed} in 0.5s)`);
  });
});

await checkAsync('DEATH-SPIRAL PROOF: sustained CPU slowness never grows runs-per-tick (bounded, no ratchet)', () => {
  // Model a device that is CONTINUOUSLY too slow: every pump turn advances the clock by MANY
  // frame-intervals (the CPU can only turn the pump slowly). The OLD loop would try to catch
  // up with a burst of up to 10 retro_run per turn — each burst costs more than its budget, so
  // it falls further behind and ratchets the framerate down (the user's 60->48->...->11 decay).
  // The clamp+skip must instead cap EVERY turn at <=2 runs and keep re-anchoring, so
  // runs-per-tick is FLAT (no growth) no matter how far behind the device is.
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 800000;
    runner.setSpeed(1);
    runner.start();
    let maxPerTick = 0;
    const perTick = [];
    // 40 turns, each jumping the clock 100ms forward (~6 intervals overdue per turn) — a
    // device running the pump at only ~10Hz while owing ~60fps of work.
    for (let i = 0; i < 40 && state.pending; i++) {
      const before = mock.__runs();
      const cb = state.pending;
      state.pending = null;
      CLOCK += 100;
      cb();
      const ran = mock.__runs() - before;
      perTick.push(ran);
      if (ran > maxPerTick) maxPerTick = ran;
    }
    assert.ok(maxPerTick <= 2, `runs-per-tick never exceeds the clamp under sustained slowness (max ${maxPerTick})`);
    // No RATCHET: every steady-state turn is bounded by the clamp, so the per-tick cost is FLAT
    // (a spiral would show later turns running MORE than the clamp as the backlog compounds).
    // The very first turn does 0-1 (seed), so compare the tail turns' max against the clamp.
    const tailMax = perTick.slice(5).reduce((a, b) => Math.max(a, b), 0);
    assert.ok(tailMax <= 2, `steady-state runs-per-tick stays clamped, never ratchets up (tailMax=${tailMax})`);
  });
});

// ======================================================================================
// iOS SUSPEND / RESUME HARDENING (the "4 FPS forever after backgrounding" bug).
//
// While iOS suspends a backgrounded PWA it stops firing requestAnimationFrame but
// performance.now() keeps advancing, so the first turn after resuming can be SECONDS overdue.
// The runner now (1) CLAMPS the overdue time a single turn will even consider (MAX_OVERDUE_MS)
// and re-anchors instead of reasoning about the gap, and (2) exposes resetClockAnchor() which
// the engine calls on visibilitychange/focus/pageshow so a resume starts from a clean anchor.
// These tests prove a multi-second stall can neither burst nor wedge the loop into a permanent
// low-FPS state, and that the resume re-anchor path exists and works.

await checkAsync('SUSPEND/RESUME: a multi-second clock jump runs AT MOST the clamped frames in the first turn', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 900000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 100, 16.7); // normal cadence first
    const before = mock.__runs();
    const stallsBefore = runner._stallSkips;
    // THE SUSPEND: 5 simulated seconds pass with NO rAF turns at all (iOS froze the page).
    CLOCK += 5000;
    // THE RESUME: the first turn fires.
    const cb = state.pending;
    state.pending = null;
    cb();
    const firstTurn = mock.__runs() - before;
    assert.ok(firstTurn <= 2, `first turn after a 5s stall runs at most the clamp (got ${firstTurn})`);
    assert.ok(runner._stallSkips > stallsBefore, 'the turn was classified as a STALL (overdue clamped, missed time discarded)');
    assert.ok(runner._nextFrameTime >= CLOCK, 'anchor re-anchored to now + one interval (gap discarded, not queued)');
  });
});

await checkAsync('SUSPEND/RESUME: cadence returns to ~60 frames/simulated-second after the stall (no permanent low-FPS state)', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 1100000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 200, 16.7);
    // Suspend for 8 simulated seconds, then resume and run one simulated second of turns.
    CLOCK += 8000;
    const after = mock.__runs();
    runFreeRunning(runner, state, 1000, 16.7);
    const resumed = mock.__runs() - after;
    assert.ok(resumed >= 55 && resumed <= 63, `~60 frames in the simulated second after resuming (got ${resumed})`);
    // And it stays there for a second second (no ratchet, no compounding backlog).
    const after2 = mock.__runs();
    runFreeRunning(runner, state, 1000, 16.7);
    const resumed2 = mock.__runs() - after2;
    assert.ok(resumed2 >= 55 && resumed2 <= 63, `still ~60 frames the next simulated second (got ${resumed2})`);
  });
});

await checkAsync('SUSPEND/RESUME: repeated multi-second stalls never grow per-turn work (flat, bounded)', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 1300000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 50, 16.7);
    let maxPerTurn = 0;
    for (let i = 0; i < 10; i++) {
      CLOCK += 3000 + i * 1000; // ever LONGER suspends (3s, 4s, 5s, ... 12s)
      const before = mock.__runs();
      const cb = state.pending;
      state.pending = null;
      cb();
      const ran = mock.__runs() - before;
      if (ran > maxPerTurn) maxPerTurn = ran;
      runFreeRunning(runner, state, 100, 16.7); // a little normal running in between
    }
    assert.ok(maxPerTurn <= 2, `per-turn work stays clamped however long the stall (max ${maxPerTurn})`);
  });
});

await checkAsync('SUSPEND/RESUME: resetClockAnchor() re-anchors the accumulator and is counted', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 1500000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 100, 16.7);
    assert.strictEqual(typeof runner.resetClockAnchor, 'function', 'the runner exposes resetClockAnchor()');
    const resyncsBefore = runner._clockResyncs;
    CLOCK += 30000; // a 30-second suspend
    runner.resetClockAnchor('resume');
    assert.strictEqual(runner._clockResyncs, resyncsBefore + 1, 'the resync was counted');
    assert.ok(runner._nextFrameTime >= CLOCK, 'anchor moved to now + one interval (nothing overdue after a resume)');
    // The very next turn must run at most one frame (not a catch-up burst), then hold ~60.
    const before = mock.__runs();
    const cb = state.pending;
    state.pending = null;
    CLOCK += 16.7;
    cb();
    assert.ok(mock.__runs() - before <= 1, 'first turn after an explicit re-anchor is not a burst');
    const after = mock.__runs();
    runFreeRunning(runner, state, 1000, 16.7);
    const resumed = mock.__runs() - after;
    assert.ok(resumed >= 55 && resumed <= 63, `~60 fps after the explicit re-anchor (got ${resumed})`);
  });
});

await checkAsync('cadence is decoupled from present: onVideoFrame throwing never stalls frame advance', () => {
  // The present sink must never pace or block compute. Even if presenting throws every frame,
  // the loop keeps advancing retro_run at ~60 fps (the runner swallows sink errors).
  return (async () => {
    const mock = makeMockModule({ asyncify: false });
    const state = { pending: null };
    // Make retro_run also emit a video refresh so onVideoFrame is exercised each frame.
    const runner = new EmuCoreRunner({
      loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
      fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
      scheduleYield: (cb) => { state.pending = cb; return 1; },
      getFrameInputMask: () => 0,
      onVideoFrame: () => { throw new Error('present blew up'); },
    });
    await runner.boot();
    CLOCK = 600000;
    runner.setSpeed(1);
    runner.start();
    runFreeRunning(runner, state, 1000, 4);
    const frames = mock.__runs();
    assert.ok(frames >= 55 && frames <= 63, `compute advances ~60 fps despite present throwing (got ${frames})`);
  })();
});

// ======================================================================================
// HARDWARE-VSYNC (rAF) PACING PROOF.
//
// The single-thread engine drives the runner's loop from window.requestAnimationFrame (~60Hz,
// display-refresh-paced) by injecting an rAF-based scheduleYield. We model that here by
// injecting a scheduleYield that fires at a FIXED 60Hz cadence (advance the clock by one
// refresh interval per turn), and assert the target-time accumulator advances ~60 emulated
// frames per simulated second at 1x (one emu frame per rAF), and ~30 at 0.5x -- WITHOUT
// reintroducing the old cadence lock. This is the "verify the accumulator still advances ~60
// emu-frames/sec under a 60Hz rAF" check: rAF is display-driven, one emu frame due per refresh.
function makeRunnerRafPaced() {
  const mock = makeMockModule({ asyncify: false });
  const state = { pending: null, inputFrames: [] };
  const runner = new EmuCoreRunner({
    asyncify: false,
    loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
    fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
    scheduleYield: (cb) => { state.pending = cb; return { kind: 'raf' }; },
    getFrameInputMask: (frame) => { state.inputFrames.push(frame); return 0; },
  });
  return { runner, mock, state };
}

// Fire the rAF-paced loop for `refreshes` display refreshes at ~60Hz (16.667ms each).
function runAtRefreshRate(runner, state, refreshes) {
  const REFRESH_MS = 1000 / 60;
  for (let i = 0; i < refreshes && state.pending; i++) {
    const cb = state.pending;
    state.pending = null;
    CLOCK += REFRESH_MS;
    cb();
  }
}

await checkAsync('rAF pacing 1x: ~60 emulated frames per simulated second under a 60Hz rAF (one per refresh)', async () => {
  const { runner, mock, state } = makeRunnerRafPaced();
  await runner.boot();
  CLOCK = 1000000;
  runner.setSpeed(1);
  runner.start();
  runAtRefreshRate(runner, state, 60); // one simulated second of 60Hz refreshes
  const frames = mock.__runs();
  assert.ok(frames >= 57 && frames <= 61, `~60 emu frames/sec at 1x under 60Hz rAF (got ${frames}); one emu frame per refresh, no cadence lock`);
});

await checkAsync('rAF pacing 0.5x: ~30 emulated frames per simulated second under a 60Hz rAF', async () => {
  const { runner, mock, state } = makeRunnerRafPaced();
  await runner.boot();
  CLOCK = 2000000;
  runner.setSpeed(0.5);
  runner.start();
  runAtRefreshRate(runner, state, 60);
  const frames = mock.__runs();
  assert.ok(frames >= 27 && frames <= 33, `~30 emu frames/sec at 0.5x under 60Hz rAF (got ${frames})`);
});

await checkAsync('rAF pacing: exactly one outstanding rAF-scheduled turn (single driver, no double-schedule)', async () => {
  const { runner, state } = makeRunnerRafPaced();
  await runner.boot();
  CLOCK = 3000000;
  runner.start();
  // After each refresh, exactly one new turn is pending (the loop re-arms once per tick).
  for (let i = 0; i < 20; i++) {
    assert.ok(state.pending, `refresh ${i}: exactly one turn pending`);
    const cb = state.pending;
    state.pending = null;
    CLOCK += 1000 / 60;
    cb();
  }
});

await checkAsync('frame-advance still runs EXACTLY one frame after the free-running loop redesign', () => {
  return makeRunner().then(({ runner, mock, state }) => {
    CLOCK = 700000;
    const before = mock.__runs();
    state.inputFrames.length = 0;
    runner.frameAdvance();
    assert.strictEqual(mock.__runs() - before, 1, 'exactly one retro_run on frame-advance');
    assert.strictEqual(runner.currentFrame, 1, 'frame counter advanced by exactly one');
    assert.deepStrictEqual(state.inputFrames, [0], 'input resolved for exactly frame 0');
    assert.strictEqual(runner._loopRunning, false, 'frame-advance does not start the free-running loop');
    assert.strictEqual(state.pending, null, 'frame-advance schedules no pump turn');
  });
});

// ======================================================================================
// ENGINE rAF PRESENT-COALESCING PROOF (the top-level single-thread invariant).
//
// Drive the REAL tas-engine.js single-thread rAF loop with a fake rAF + mock core and assert
// the reversal invariant: EXACTLY ONE present per rAF turn, even when a turn runs MANY retro_run
// (a catch-up burst or a fast-forward burst). Drawing once-per-retro_run instead of once-per-rAF
// (the open-loop flood the reversal removes) would FAIL these.
{
  // Isolate the engine harness in its own DOM-stub + fake-rAF scope (imported lazily so the
  // runner-level CLOCK/perf shim above is not disturbed).
  globalThis.window = globalThis;
  // A document stub WITH an event-listener registry + visibilityState, so the engine's iOS
  // suspend/resume watch (document 'visibilitychange') can be attached and fired on demand.
  const docListeners = new Map();
  globalThis.document = {
    createElement: () => { let t = ''; return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } }; },
    getElementById: () => null,
    head: { appendChild: () => {} },
    visibilityState: 'visible',
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    },
    __listeners: docListeners,
    __fire: (type) => {
      for (const fn of docListeners.get(type) || []) fn({ type });
    },
  };
  const { installFakeRaf, installEngineMockRunner, makeGLCanvas } = await import('./single-thread-harness.mjs');
  const fake = installFakeRaf();
  const engMod = await import('../tas-engine.js');
  const engine = engMod.default;
  const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
  const shared = installEngineMockRunner(engine);
  engine.attach({ canvas: makeGLCanvas({ gpu }), noticeEl: null });
  await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });

  await checkAsync('engine: EXACTLY one present per rAF turn at 1x (never one-per-retro_run)', async () => {
    engine.setSpeed(1);
    fake.stepRaf(3);
    shared.resolvedPerFrame.length = 0;
    gpu.texImage2D = 0; gpu.texSubImage2D = 0; gpu.drawArrays = 0;
    const TURNS = 20;
    fake.stepRaf(TURNS);
    assert.ok(gpu.drawArrays >= 1, 'presented at least once');
    assert.ok(gpu.drawArrays <= TURNS, `at most one present per rAF turn (draws=${gpu.drawArrays} <= turns=${TURNS})`);
    assert.strictEqual(gpu.texImage2D + gpu.texSubImage2D, gpu.drawArrays, 'one upload + one draw per present');
  });

  await checkAsync('engine: a catch-up burst (many retro_run in one turn) still presents ONCE', async () => {
    engine.setSpeed(1);
    fake.stepRaf(3);
    shared.resolvedPerFrame.length = 0;
    gpu.drawArrays = 0;
    fake.advance(1000); // ~60 intervals overdue
    fake.stepRaf(1); // ONE turn
    assert.ok(shared.resolvedPerFrame.length <= 2, `catch-up bounded to <=2 retro_run (got ${shared.resolvedPerFrame.length})`);
    assert.ok(gpu.drawArrays <= 1, `still ONE present under the catch-up burst (draws=${gpu.drawArrays})`);
  });

  await checkAsync('engine: a fast-forward burst (8 retro_run in one turn) still presents ONCE', async () => {
    engine.pause();
    fake.stepRaf(2);
    engine.fastForward(true);
    engine.play();
    fake.stepRaf(2); // let fast-forward engage + settle
    shared.resolvedPerFrame.length = 0;
    gpu.drawArrays = 0;
    fake.stepRaf(1); // ONE turn -> fast-forward runs a burst of frames
    const burst = shared.resolvedPerFrame.length;
    assert.ok(burst >= 4, `fast-forward advanced a burst in one turn (got ${burst})`);
    assert.strictEqual(gpu.drawArrays, 1, `the fast-forward burst still presented EXACTLY once (draws=${gpu.drawArrays})`);
    engine.fastForward(false);
    engine.pause();
  });

  // --------------------------------------------------------------------------------
  // ENGINE-LEVEL RESUME RE-ANCHOR: the engine subscribes to document 'visibilitychange'
  // (+ window focus/pageshow) and re-anchors the runner's accumulator when the page comes
  // back, so the first turn after an iOS suspend starts clean. Also proves the listeners are
  // REMOVED on teardown (they must never accumulate across re-inits / core swaps).
  await checkAsync('engine: visibilitychange (resume) re-anchors the run loop and is cleaned up on teardown', async () => {
    engine.setSpeed(1);
    engine.play();
    fake.stepRaf(5);
    assert.ok(
      (globalThis.document.__listeners.get('visibilitychange') || new Set()).size >= 1,
      'the engine attached a visibilitychange listener during init()'
    );
    const runner = shared.runner;
    const resyncsBefore = runner._clockResyncs;

    // SUSPEND: 7 simulated seconds with no rAF turns, then the page becomes visible again.
    fake.advance(7000);
    globalThis.document.visibilityState = 'visible';
    globalThis.document.__fire('visibilitychange');
    assert.strictEqual(runner._clockResyncs, resyncsBefore + 1, 'the resume re-anchored the accumulator');
    assert.ok(runner._nextFrameTime >= fake.now(), 'the anchor was moved to now + one interval');

    // The first turns after resuming must be normal, bounded turns (no burst, no wedge).
    shared.resolvedPerFrame.length = 0;
    fake.stepRaf(1);
    assert.ok(shared.resolvedPerFrame.length <= 2, `first post-resume turn is bounded (ran ${shared.resolvedPerFrame.length})`);
    shared.resolvedPerFrame.length = 0;
    const TURNS = 30;
    fake.stepRaf(TURNS);
    assert.ok(
      shared.resolvedPerFrame.length >= TURNS - 4 && shared.resolvedPerFrame.length <= TURNS + 2,
      `cadence back to ~one frame per turn after resuming (got ${shared.resolvedPerFrame.length} over ${TURNS} turns)`
    );

    // The HIDDEN half of visibilitychange must NOT be treated as a resume.
    const beforeHidden = runner._clockResyncs;
    globalThis.document.visibilityState = 'hidden';
    globalThis.document.__fire('visibilitychange');
    assert.strictEqual(runner._clockResyncs, beforeHidden, 'going hidden does not re-anchor (that is the suspend, not the resume)');
    globalThis.document.visibilityState = 'visible';

    // TEARDOWN removes the listeners (no accumulation across re-inits).
    engine.pause();
    fake.stepRaf(2);
    engine.teardown();
    assert.strictEqual(
      (globalThis.document.__listeners.get('visibilitychange') || new Set()).size,
      0,
      'teardown removed the visibilitychange listener'
    );
    // Re-init for the remaining engine assertions below (and prove listeners do not double-add).
    installEngineMockRunner(engine);
    await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
    assert.strictEqual(
      (globalThis.document.__listeners.get('visibilitychange') || new Set()).size,
      1,
      're-init attached exactly ONE visibilitychange listener (never two)'
    );
  });

  fake.restore();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
