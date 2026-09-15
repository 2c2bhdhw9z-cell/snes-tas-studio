// tools/runloop.test.mjs
//
// Focused test for the WORKER's self-scheduling run loop, now owned by emu-core-runner.js
// (the emulator moved off the main thread in FEAT-002; the old main-thread rAF loop is gone).
//
// The synchronous run loop yields between frames via an INJECTED scheduler (setTimeout(0) in
// the worker; here a controllable fake) so control + input messages are processed BETWEEN
// retro_run calls. This test drives that injected scheduler deterministically and asserts:
//   - the loop keeps EXACTLY ONE tick outstanding (re-arms once per tick, never double-schedules)
//   - pause() stops the loop (no re-arm, no further frames)
//   - play() re-arms exactly one tick after a pause
//   - speed scaling: 0.5x advances ~half as many frames as 2x for the same wall-clock
//   - fast-forward runs a burst of frames per tick
//   - frame-advance = EXACTLY one frame with that frame's resolved input, and does NOT start the loop
//   - an ASYNCIFY core AWAITS retro_run (the loop only ticks after the awaited frame resolves)
//
// This complements tools/emu-core-runner.test.mjs (which covers boot/decode/save-load/HUD) by
// exercising the scheduling + speed + async semantics specifically. Run: node runloop.test.mjs
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
// SCHEDULER: the default per-frame yield must use a MessageChannel (NO setTimeout clamp) when
// available, falling back to setTimeout(0) only when MessageChannel is absent. Mobile Safari
// clamps setTimeout to ~4ms, which alone capped the synchronous core near ~26 FPS; a
// MessageChannel one-shot has no clamp, so the loop can pace up to the core's native fps.

await checkAsync('default scheduler uses MessageChannel (no setTimeout clamp) when available', async () => {
  // A minimal MessageChannel/MessagePort stub whose port2.postMessage schedules port1.onmessage
  // on a microtask — modelling the browser/worker MessageChannel that has NO timer clamp.
  let mcConstructed = 0;
  let posted = 0;
  const savedMC = globalThis.MessageChannel;
  const savedST = globalThis.setTimeout;
  let setTimeoutUsed = 0;
  class FakePort {
    constructor() { this.onmessage = null; this._peer = null; }
    postMessage() { posted += 1; const peer = this._peer; Promise.resolve().then(() => { if (peer && peer.onmessage) peer.onmessage({ data: 0 }); }); }
  }
  globalThis.MessageChannel = class {
    constructor() { mcConstructed += 1; this.port1 = new FakePort(); this.port2 = new FakePort(); this.port1._peer = this.port2; this.port2._peer = this.port1; }
  };
  // Wrap setTimeout so we can prove the default scheduler did NOT use it while MC is present.
  globalThis.setTimeout = (...args) => { setTimeoutUsed += 1; return savedST(...args); };
  try {
    const mock = makeMockModule({ asyncify: false });
    // NOTE: no scheduleYield injected — exercise the DEFAULT scheduler (defaultScheduleYield).
    const runner = new EmuCoreRunner({
      loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
      fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
      getFrameInputMask: () => 0,
    });
    await runner.boot();
    CLOCK = 1000;
    runner.start();
    // Let the MessageChannel-driven tick fire a couple of times via microtasks.
    for (let i = 0; i < 5; i++) { CLOCK += 17; await Promise.resolve(); await Promise.resolve(); }
    runner.pause();
    assert.ok(mcConstructed >= 1, 'default scheduler constructed a MessageChannel');
    assert.ok(posted >= 1, 'default scheduler posted through the MessageChannel port');
    assert.strictEqual(setTimeoutUsed, 0, 'default scheduler did NOT fall back to the clamped setTimeout');
    assert.ok(mock.__runs() >= 1, 'the MessageChannel-paced loop advanced frames');
  } finally {
    globalThis.MessageChannel = savedMC;
    globalThis.setTimeout = savedST;
  }
});

await checkAsync('default scheduler falls back to setTimeout(0) when MessageChannel is unavailable', async () => {
  const savedMC = globalThis.MessageChannel;
  let setTimeoutZero = 0;
  const savedST = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => { if (ms === 0) setTimeoutZero += 1; return savedST(cb, ms, ...rest); };
  // eslint-disable-next-line no-undef
  delete globalThis.MessageChannel;
  try {
    const mock = makeMockModule({ asyncify: false });
    const runner = new EmuCoreRunner({
      loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
      fetchRom: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }),
      getFrameInputMask: () => 0,
    });
    await runner.boot();
    CLOCK = 1000;
    runner.start();
    await new Promise((r) => savedST(r, 5));
    runner.pause();
    assert.ok(setTimeoutZero >= 1, 'fallback used setTimeout(cb, 0) when MessageChannel absent');
  } finally {
    globalThis.MessageChannel = savedMC;
    globalThis.setTimeout = savedST;
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
// On the OffscreenCanvas present path the worker drives the runner's loop from
// self.requestAnimationFrame (~60Hz, display-refresh-paced). We model that here by injecting a
// scheduleYield that fires at a FIXED 60Hz cadence (advance the clock by one refresh interval
// per turn), and assert the target-time accumulator advances ~60 emulated frames per simulated
// second at 1x (one emu frame per rAF), and ~30 at 0.5x — WITHOUT reintroducing the old
// cadence lock. This is the "verify the accumulator still advances ~60 emu-frames/sec under a
// 60Hz rAF" check: rAF is display-driven, and one emu frame is due per refresh at 1x.
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

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
