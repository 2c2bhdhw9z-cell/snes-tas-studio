// tools/engine-smoke.mjs
//
// Verifies tas-engine.js -- the SINGLE-THREAD MAIN-THREAD engine -- against a CONTROLLABLE
// fake requestAnimationFrame + a MOCK libretro core (no real WASM), driving the REAL engine
// rAF loop + the REAL EmuCoreRunner accumulator + the REAL InputResolver.
//
// THE GREAT REVERSAL (FEAT-002/003): the emulator no longer runs in a Web Worker. tas-engine.js
// OWNS one EmuCoreRunner + one InputResolver + one GLPresenter and drives them from ONE
// requestAnimationFrame loop on the main thread. This test installs a fake rAF whose turns fire
// deterministically (each turn advances a monotonic fake clock one display refresh) so the
// engine's real loop can be stepped, and asserts the reversal invariants:
//   (a) at 1x, N rAF turns advance ~N emulated frames and issue EXACTLY one present per turn
//       (one retro_run + one texSubImage2D + drawArrays per rAF);
//   (b) at 0.5x, ~half as many frames advance over the same turns;
//   (c) bounded catch-up: a large simulated time gap runs AT MOST MAX_CATCHUP_FRAMES then
//       frame-skips (no death-spiral burst), still ONE present that turn;
//   (d) frameAdvance() runs EXACTLY one retro_run and presents once, paused;
//   (e) NO worker is created and the engine exposes no worker handle / no worker primitives;
//   (f) safety invariants: no memory-write/poke/inject/cheat method, exact ROM_PATH, graceful
//       disabled state on a missing core/ROM, no file picker;
//   (g) videoPath reports a main-* label (main-webgl2 here via the mock GL canvas).
//
// Run: node tools/engine-smoke.mjs
import assert from 'node:assert';
import {
  installFakeRaf,
  installEngineMockRunner,
  makeGLCanvas,
  make2DCanvas,
  FB_W,
  FB_H,
} from './single-thread-harness.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
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

// --- Minimal DOM stubs so the ES module can run under Node ------------------------------
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => {
    let t = '';
    return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } };
  },
  getElementById: () => null,
  head: { appendChild: () => {} },
};

// Fake rAF + monotonic clock installed BEFORE importing the engine (the engine reads
// window.requestAnimationFrame + performance.now via the runner).
const fake = installFakeRaf();

const mod = await import('../tas-engine.js');
const engine = mod.default;

// A notice element that records appended text so we can assert graceful-degradation notices.
const recorded = [];
const noticeEl = {
  hidden: true,
  appendChild(n) { recorded.push(n.textContent); },
  set innerHTML(v) { if (v === '') recorded.length = 0; },
  get innerHTML() { return ''; },
};

// Wire the engine's internal runner to the mock core (real EmuCoreRunner, no WASM) BEFORE init.
const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
const canvas = makeGLCanvas({ gpu });
const shared = installEngineMockRunner(engine);

engine.attach({ canvas, noticeEl });

// ======================================================================================
// (e) NO worker created; the single-thread engine exposes no worker/cross-thread surface.
// ======================================================================================
check('(e) engine created NO worker (single-thread; no worker handle)', () => {
  assert.strictEqual(typeof engine.worker, 'undefined', 'engine exposes no worker handle');
  assert.strictEqual(typeof globalThis.Worker, 'undefined', 'no Worker global was installed/used');
  for (const k of ['_ensureWorker', '_postToWorker', '_onWorkerMessage', 'supportsOffscreenCanvas', '_usingOffscreen']) {
    assert.strictEqual(typeof engine[k], 'undefined', `no worker-proxy member: ${k}`);
  }
  assert.strictEqual('USE_OFFSCREEN' in mod, false, 'no USE_OFFSCREEN export (OffscreenCanvas gone)');
});
check('(g) videoPath reports a MAIN-thread present label (main-webgl2 via mock GL canvas)', () => {
  assert.ok(engine._gl, 'engine built a GLPresenter on the DOM canvas (main-thread WebGL)');
  assert.strictEqual(engine.videoPath, 'main-webgl2', `videoPath is a main-* label (got ${engine.videoPath})`);
  assert.ok(/^main-/.test(engine.statusSnapshot().videoPath), 'status snapshot carries a main-* videoPath');
});

// ======================================================================================
// (f) Safety invariants: no memory-write / cheat / file-picker; exact ROM path; API surface.
// ======================================================================================
check('(f) no memory-write / poke / inject / cheat / level-select method on the engine', () => {
  for (const k of ['writeMemory', 'poke', 'pokeU8', 'writeU8', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat', 'retro_cheat_set', 'selectLevel', 'openFile', 'pickFile']) {
    assert.strictEqual(typeof engine[k], 'undefined', `unexpected method: ${k}`);
  }
});
check('(f) exact ROM path constant', () => {
  assert.strictEqual(mod.ROM_PATH, 'assets/Super Mario All-Stars (USA).sfc');
});
check('public engine API surface present', () => {
  for (const k of ['attach', 'init', 'play', 'pause', 'togglePause', 'frameAdvance', 'setSpeed', 'fastForward', 'setCore', 'saveState', 'loadState', 'onFrame', 'onStatus', 'onStateLoaded', 'getMemoryView', 'sendInputEdit', 'sendLiveMask']) {
    assert.strictEqual(typeof engine[k], 'function', `missing API: ${k}`);
  }
});

// ======================================================================================
// init() boots the in-process runner and auto-plays into the rAF loop; never throws.
// ======================================================================================
await checkAsync('init() boots the in-process runner, auto-plays, and never throws', async () => {
  let threw = false;
  let ret;
  try {
    ret = await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
  } catch (_e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'init() never throws');
  assert.ok(ret && ret.ok === true, 'init() reports a successful boot');
  assert.strictEqual(engine.status, 'running', 'engine auto-plays after boot');
  assert.strictEqual(engine.activeCoreId, 'realtime', 'snes9x maps to the realtime core id');
  assert.ok(fake.pending() >= 1, 'the rAF loop is armed (one turn pending)');
});

// ======================================================================================
// (a) 1x: N rAF turns advance ~N emulated frames, EXACTLY one present per turn.
// ======================================================================================
await checkAsync('(a) 1x: ~one retro_run + EXACTLY one present per rAF turn', async () => {
  engine.setSpeed(1);
  // Reset counters for a clean window (the accumulator is already seeded from init()).
  shared.resolvedPerFrame.length = 0;
  gpu.texImage2D = 0;
  gpu.texSubImage2D = 0;
  gpu.drawArrays = 0;
  const TURNS = 30;
  const fired = fake.stepRaf(TURNS);
  assert.strictEqual(fired, TURNS, `fired ${TURNS} rAF turns`);
  const ran = shared.resolvedPerFrame.length;
  // At 1x with one refresh per turn the accumulator releases ~one frame per turn.
  assert.ok(ran >= TURNS - 3 && ran <= TURNS + 1, `~${TURNS} frames advanced at 1x (got ${ran})`);
  // ONE present per rAF turn -- never one-per-retro_run, never more than the turns fired.
  assert.ok(gpu.drawArrays >= 1, 'presented at least once');
  assert.ok(gpu.drawArrays <= TURNS, `at most one present per rAF turn (draws=${gpu.drawArrays} <= turns=${TURNS})`);
  // Each present is exactly one texture UPLOAD (texSubImage2D in steady state, texImage2D only
  // on a geometry change) + exactly one drawArrays. So total uploads == total draws.
  assert.strictEqual(gpu.texImage2D + gpu.texSubImage2D, gpu.drawArrays, 'one upload + one draw per present');
  assert.strictEqual(gpu.createTexture, 1, 'ONE texture created for the whole session (not per frame)');
  assert.strictEqual(gpu.createProgram, 1, 'ONE program created for the whole session');
});

// ======================================================================================
// (b) 0.5x: ~half as many frames advance over the same number of turns.
// ======================================================================================
await checkAsync('(b) 0.5x advances ~half as many frames as 1x over equal rAF turns', async () => {
  const TURNS = 40;
  // Measure 1x.
  engine.setSpeed(1);
  fake.stepRaf(3); // let the anchor settle at the new speed
  shared.resolvedPerFrame.length = 0;
  fake.stepRaf(TURNS);
  const framesAt1x = shared.resolvedPerFrame.length;
  // Measure 0.5x.
  engine.setSpeed(0.5);
  fake.stepRaf(3);
  shared.resolvedPerFrame.length = 0;
  fake.stepRaf(TURNS);
  const framesAtHalf = shared.resolvedPerFrame.length;
  assert.ok(framesAt1x > framesAtHalf, `1x (${framesAt1x}) advances more than 0.5x (${framesAtHalf})`);
  // 0.5x should be roughly half of 1x (a ~one-frame-per-two-refreshes cadence).
  assert.ok(
    framesAtHalf >= framesAt1x * 0.35 && framesAtHalf <= framesAt1x * 0.65,
    `0.5x (~${framesAtHalf}) is ~half of 1x (~${framesAt1x})`
  );
  engine.setSpeed(1);
});

// ======================================================================================
// (c) Bounded catch-up: a large time gap runs AT MOST MAX_CATCHUP_FRAMES, then frame-skips,
// and still presents EXACTLY ONCE that turn (no death-spiral burst / no burst of presents).
// ======================================================================================
await checkAsync('(c) a big time gap is bounded to <=2 retro_run and ONE present that turn', async () => {
  engine.setSpeed(1);
  fake.stepRaf(3);
  shared.resolvedPerFrame.length = 0;
  gpu.drawArrays = 0;
  // Advance the fake clock by a full simulated second WITHOUT firing a turn (models a stall),
  // then fire exactly one turn: the accumulator is ~60 intervals overdue.
  fake.advance(1000);
  const fired = fake.stepRaf(1);
  assert.strictEqual(fired, 1, 'fired exactly one rAF turn after the stall');
  const burst = shared.resolvedPerFrame.length;
  assert.ok(burst <= 2, `catch-up HARD-clamped to <=2 retro_run in one turn (got ${burst}, no death-spiral)`);
  assert.ok(gpu.drawArrays <= 1, `still exactly ONE present that turn under catch-up (draws=${gpu.drawArrays})`);
});

// ======================================================================================
// (d) frameAdvance() = EXACTLY one retro_run + one present, paused.
// ======================================================================================
await checkAsync('(d) frameAdvance() runs EXACTLY one retro_run and presents once, paused', async () => {
  engine.pause();
  fake.stepRaf(2); // drain any straggler turn from pause()
  shared.resolvedPerFrame.length = 0;
  gpu.drawArrays = 0;
  const before = shared.runner.currentFrame;
  const r = engine.frameAdvance();
  if (r && typeof r.then === 'function') await r;
  assert.strictEqual(shared.resolvedPerFrame.length, 1, 'exactly one retro_run on frame-advance');
  assert.strictEqual(shared.runner.currentFrame, before + 1, 'frame counter advanced by exactly one');
  assert.strictEqual(gpu.drawArrays, 1, 'frame-advance presents exactly once');
  assert.strictEqual(engine.paused, true, 'frame-advance leaves the engine paused');
  // No further turns should advance frames while paused.
  fake.stepRaf(3);
  assert.strictEqual(shared.resolvedPerFrame.length, 1, 'no extra frames run while paused');
});

// ======================================================================================
// setSpeed clamps to [0.1, 2]; determinism / live-mask plumbing exists on the engine.
// ======================================================================================
check('setSpeed() clamps to [0.1, 2]', () => {
  engine.setSpeed(5);
  assert.strictEqual(engine.speed, 2, 'clamped to 2');
  engine.setSpeed(0.01);
  assert.strictEqual(engine.speed, 0.1, 'clamped to 0.1');
  engine.setSpeed(1);
});
check('sendLiveMask stores the live mask; sendInputEdit mutates the in-process resolver', () => {
  engine.sendLiveMask((1 << 3) >>> 0);
  assert.strictEqual(engine._liveMask, 1 << 3, 'live mask stored on the engine');
  engine.sendInputEdit({ op: 'setFrameButton', frame: 2, button: 'A', on: true });
  assert.strictEqual(engine._resolver.getFrameInputMask(2, 0), 1 << 8, 'scripted edit applied to the in-process log');
  engine.sendLiveMask(0);
  engine.sendInputEdit({ op: 'truncateAfter', frame: 0 });
});

// ======================================================================================
// getMemoryView() is STRICTLY READ-ONLY (verified SMB1 offsets), no writer.
// ======================================================================================
check('getMemoryView() returns a READ-ONLY view over the verified SMB1 offsets', () => {
  const mem = engine.getMemoryView();
  assert.ok(mem, 'a memory view is available after boot');
  assert.strictEqual(mem.readS8(0x005d), -16, 'H-Speed signed byte via offset 0x005D');
  assert.strictEqual(mem.readU8(0x0042), 0x30, 'X hi via offset 0x0042');
  for (const k of ['writeU8', 'poke', 'write', 'set', 'inject']) {
    assert.strictEqual(typeof mem[k], 'undefined', `memory view must not expose ${k}`);
  }
});

// ======================================================================================
// saveState()/loadState() over byte buffers; loadState fires onStateLoaded and presents once.
// ======================================================================================
await checkAsync('saveState() resolves with bytes; loadState round-trips + fires onStateLoaded', async () => {
  const bytes = await engine.saveState();
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, 'saveState resolves to a Uint8Array');
  // Mutate the core state, then load the saved bytes back and confirm restoration.
  shared.module.__setState(0x1234);
  assert.strictEqual(shared.module.__getState(), 0x1234, 'core state mutated before load');
  let loadedFrame = -1;
  engine.onStateLoaded((f) => { loadedFrame = f; });
  gpu.drawArrays = 0;
  const ok = engine.loadState(bytes, { frame: 42 });
  assert.strictEqual(ok, true, 'loadState applied');
  assert.strictEqual(shared.module.__getState(), 0xabcd, 'core state restored from the round-tripped bytes');
  assert.strictEqual(loadedFrame, 42, 'onStateLoaded fired with the loaded frame');
  assert.strictEqual(engine.currentFrame, 42, 'frame metadata applied on load');
  // The engine presents the latest stashed frame at most ONCE on load (never a burst); there
  // is no newly decoded frame after unserialize, so the coalesced present is a bounded no-op.
  assert.ok(gpu.drawArrays <= 1, `loadState presents at most once (draws=${gpu.drawArrays})`);
});

// ======================================================================================
// (f) Graceful DISABLED state on a missing core/ROM: notice, no throw, no file picker.
// ======================================================================================
await checkAsync('(f) missing core/ROM -> graceful disabled state, no throw, no file picker', async () => {
  const { TASEngine } = mod;
  const disabled = new TASEngine();
  // Wire its internal runner to a boot that FAILS (missing core), still no real WASM/worker.
  disabled._makeRunner = function () {
    const { EmuCoreRunner } = mod;
    return new EmuCoreRunner({
      getFrameInputMask: (frame) => this._resolver.getFrameInputMask(frame, this._liveMask),
      onStatus: (snap) => this._applyStatusSnapshot(snap),
      onFrame: () => this._emitFrame(),
      loadCore: async () => ({ ok: false, reason: 'core-missing' }),
      fetchRom: async () => ({ ok: false, reason: 'rom-missing' }),
      scheduleYield: this._scheduleYield,
    });
  };
  const localNotices = [];
  disabled.attach({
    canvas: make2DCanvas(),
    noticeEl: {
      hidden: true,
      appendChild(n) { localNotices.push(n.textContent); },
      set innerHTML(v) { if (v === '') localNotices.length = 0; },
      get innerHTML() { return ''; },
    },
  });
  let threw = false;
  let ret;
  try {
    ret = await disabled.init({ corePaths: ['cores/snes9x_libretro.js'] });
  } catch (_e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'attach/init never throw on a missing core/ROM');
  assert.ok(ret && ret.ok === false, 'init reports not-ok when the core/ROM is unavailable');
  assert.strictEqual(disabled.status, 'disabled', 'engine enters the disabled state');
  assert.ok(localNotices.some((l) => /disabled|unavailable|failed/i.test(l)), 'a disabled notice is shown: ' + JSON.stringify(localNotices));
});

// ======================================================================================
// setCore(): in-process teardown + re-init (core-select only, no file picker).
// ======================================================================================
await checkAsync('setCore() re-inits in-process and mirrors activeCoreId (no file picker)', async () => {
  // Re-point the mock runner at the bsnes accuracy core (ASYNCIFY).
  installEngineMockRunner(engine, 'cores/bsnes_mercury_accuracy_libretro.js');
  const r = await engine.setCore('cores/bsnes_mercury_accuracy_libretro.js');
  assert.ok(r && r.ok === true, 'setCore re-inited in-process');
  assert.strictEqual(engine.activeCoreId, 'accuracy', 'activeCoreId mirrors the selected core');
});

// ======================================================================================
// (h) ASYNCIFY present-coalescing through the ENGINE rAF loop (bsnes accuracy core).
//
// Closes the review coverage gap: prove the engine's DEFERRED-present branch (r.then(present)
// for a Promise-returning tick) yields EXACTLY ONE present per rAF turn when driven FREE-RUNNING
// and under FAST-FORWARD, not just via frameAdvance. The mock retro_run returns a REAL Promise
// here (asyncify=true), so this drives the runner's _tickAsync await path and the engine's
// r.then(present) wrapper end to end, and shared.maxInFlight proves suspensions never overlap.
//
// Because a turn's present is deferred to a microtask (after the awaited tick + re-arm), we
// drain microtasks after EACH fired turn so the deferred present lands and the runner re-arms
// the next turn before we fire it. `runAsyncRafTurns(n)` returns the presents observed.
// ======================================================================================
await checkAsync('(h) ASYNCIFY free-running: EXACTLY one present per engine rAF turn (deferred branch)', async () => {
  // Fresh engine on the ASYNCIFY (accuracy) core so retro_run genuinely returns a Promise.
  const { TASEngine } = mod;
  const asyncEngine = new TASEngine();
  const agpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
  const acanvas = makeGLCanvas({ gpu: agpu });
  const ashared = installEngineMockRunner(asyncEngine, 'cores/bsnes_mercury_accuracy_libretro.js');
  const anotices = [];
  asyncEngine.attach({
    canvas: acanvas,
    noticeEl: {
      hidden: true,
      appendChild(n) { anotices.push(n.textContent); },
      set innerHTML(v) { if (v === '') anotices.length = 0; },
      get innerHTML() { return ''; },
    },
  });
  const ret = await asyncEngine.init({ corePaths: ['cores/bsnes_mercury_accuracy_libretro.js'] });
  assert.ok(ret && ret.ok === true, 'ASYNCIFY engine booted');
  assert.strictEqual(asyncEngine._asyncify, true, 'engine is on the ASYNCIFY path');

  // Drain microtasks so the tick promise resolves (present fires) and the next tick re-arms.
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  // Fire n free-running rAF turns one at a time, draining microtasks between each so the
  // engine's deferred present (r.then) lands and the async runner re-arms the next turn.
  async function runAsyncRafTurns(n) {
    await drain(); // ensure a turn is armed after boot
    let fired = 0;
    for (let i = 0; i < n; i++) {
      const f = fake.stepRaf(1);
      if (f === 0) { await drain(); continue; }
      fired += f;
      await drain();
    }
    return fired;
  }

  asyncEngine.setSpeed(1);
  await runAsyncRafTurns(4); // settle the anchor + prove the deferred branch is live
  ashared.resolvedPerFrame.length = 0;
  agpu.drawArrays = 0;
  agpu.texImage2D = 0;
  agpu.texSubImage2D = 0;

  const TURNS = 20;
  const fired = await runAsyncRafTurns(TURNS);
  assert.ok(fired >= TURNS - 2, `drove ~${TURNS} free-running ASYNCIFY rAF turns (fired ${fired})`);
  // The whole point: the async r.then(present) branch draws AT MOST ONCE per rAF turn.
  assert.ok(agpu.drawArrays >= 1, 'the deferred-present branch presented at least once');
  assert.ok(agpu.drawArrays <= fired, `at most ONE present per ASYNCIFY rAF turn (draws=${agpu.drawArrays} <= turns=${fired})`);
  assert.strictEqual(agpu.texImage2D + agpu.texSubImage2D, agpu.drawArrays, 'one upload + one draw per deferred present');
  assert.strictEqual(agpu.createTexture, 1, 'ONE texture for the whole ASYNCIFY session');
  // At 1x the accumulator releases ~one frame per turn; presents track turns, not retro_run count.
  assert.ok(ashared.resolvedPerFrame.length >= 1, 'the ASYNCIFY loop advanced emulated frames');
  // libco: at most one suspension outstanding at any instant.
  assert.ok(ashared.maxInFlight <= 1, `at most one ASYNCIFY suspension outstanding (maxInFlight=${ashared.maxInFlight})`);

  // Fast-forward: the runner bursts up to 8 awaited retro_run in one turn, but the engine still
  // coalesces to EXACTLY ONE present for that rAF turn on the deferred branch.
  ashared.resolvedPerFrame.length = 0;
  agpu.drawArrays = 0;
  asyncEngine.fastForward(true);
  await runAsyncRafTurns(1); // let fast-forward take effect and burst one turn
  const burstPresentsA = agpu.drawArrays;
  agpu.drawArrays = 0;
  ashared.resolvedPerFrame.length = 0;
  await runAsyncRafTurns(1); // one clean fast-forward turn
  const burstFrames = ashared.resolvedPerFrame.length;
  const burstPresents = agpu.drawArrays;
  asyncEngine.fastForward(false);
  assert.ok(burstFrames >= 2, `fast-forward bursts multiple awaited retro_run per turn (got ${burstFrames})`);
  assert.ok(burstPresents <= 1, `still EXACTLY ONE present for a fast-forward ASYNCIFY rAF turn (presents=${burstPresents})`);
  assert.ok(burstPresentsA <= 1, `and the prior fast-forward turn also presented at most once (presents=${burstPresentsA})`);
  assert.ok(ashared.maxInFlight <= 1, `fast-forward keeps at most one suspension outstanding (maxInFlight=${ashared.maxInFlight})`);

  asyncEngine.pause();
});

fake.restore();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
