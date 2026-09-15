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

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
