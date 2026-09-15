// tools/engine-determinism.test.mjs
//
// THE definitive determinism + save/load + core-switch test for the SINGLE-THREAD engine.
//
// THE GREAT REVERSAL (FEAT-002/003): the emulator moved back onto the main thread. This test
// wires the REAL tas-engine.js TASEngine to its REAL EmuCoreRunner + REAL InputResolver, backed
// by a MOCK libretro core Module (no real WASM). Determinism is proven THROUGH the actual
// libretro input-state ABI: the mock core's retro_run calls the registered input_state callback
// for the CURRENT frame and we capture exactly which bit was returned for each button -- proving
// frame N runs with exactly (log.getMask(N) | liveMask) >>> 0 and never N+1's input, end to end
// on the single main thread (no worker, no postMessage, no cross-thread bridge).
//
// Covers (the single-thread equivalents of the old worker-boundary assertions):
//   (1) frame N runs with exactly (log.getMask(N) | latestLiveMask) >>> 0, NEVER N+1's input
//   (2) frame-advance = exactly one frame with that frame's input
//   (3) sendInputEdit mutates the in-process authoritative log; sendLiveMask is OR-ed in next
//   (4) truncateAfter re-record holds after a loadState (onStateLoaded fires the re-record hook)
//   (5) save/load round-trips over byte buffers
//   (6) streamed READ-ONLY HUD carries the verified SMB1 addresses; no memory-write path
//   (7) core-switch (setCore) tears the runner down and re-inits in-process
//
// Run: node tools/engine-determinism.test.mjs
import assert from 'node:assert';
import { SMB1_HUD_ADDR } from '../emu-core-runner.js';
import {
  installFakeRaf,
  installEngineMockRunner,
  makeGLCanvas,
  HUD_SEED,
} from './single-thread-harness.mjs';

const results = [];
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// Minimal DOM stubs so the ES module runs under Node.
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => {
    let t = '';
    return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } };
  },
  getElementById: () => null,
  head: { appendChild: () => {} },
};

const fake = installFakeRaf();
const mod = await import('../tas-engine.js');
const { TASEngine } = mod;

/**
 * A fresh single-thread engine wired to a mock core, PAUSED after boot so our frame-advances
 * are the only thing that runs frames (deterministic; no free-running loop racing us).
 */
async function makeEngine(corePath = 'cores/snes9x_libretro.js') {
  const engine = new TASEngine();
  const shared = installEngineMockRunner(engine, corePath);
  engine.attach({ canvas: makeGLCanvas(), noticeEl: null });
  await engine.init({ corePaths: [corePath] });
  engine.pause();
  fake.stepRaf(2); // drain any straggler turn from pause()
  shared.resolvedPerFrame.length = 0;
  return { engine, shared };
}

// A frame-advance that fully resolves (awaits an ASYNCIFY frame).
async function step(engine) {
  const r = engine.frameAdvance();
  if (r && typeof r.then === 'function') await r;
}

// ======================================================================================
// (1) DETERMINISM: frame N executed with exactly (log.getMask(N) | liveMask) >>> 0.
// ======================================================================================
await checkAsync('(1) frame N runs with exactly (log.getMask(N) | liveMask) >>> 0 and never N+1 input', async () => {
  const { engine, shared } = await makeEngine();
  const B = 1 << 0, A = 1 << 8, START = 1 << 3;
  // Scripted: B on frame 0, A on frame 2. Live: START held.
  engine.sendInputEdit({ op: 'setFrameButton', frame: 0, button: 'B', on: true });
  engine.sendInputEdit({ op: 'setFrameButton', frame: 2, button: 'A', on: true });
  engine.sendLiveMask(START);

  await step(engine); // frame 0
  await step(engine); // frame 1
  await step(engine); // frame 2

  const pf = shared.resolvedPerFrame;
  assert.strictEqual(pf.length, 3, 'exactly three frames ran');
  assert.strictEqual(pf[0].frame, 0);
  assert.strictEqual(pf[0].mask, (B | START) >>> 0, 'frame 0 = scripted B | live START');
  assert.strictEqual(pf[1].mask, START >>> 0, 'frame 1 = live START only (NO bleed from f0/f2)');
  assert.strictEqual(pf[2].mask, (A | START) >>> 0, 'frame 2 = scripted A | live START');
});

await checkAsync('(1b) frame 0 NEVER reflects frame 1 scripted input', async () => {
  const { engine, shared } = await makeEngine();
  engine.sendInputEdit({ op: 'setFrameButton', frame: 1, button: 'A', on: true });
  await step(engine); // frame 0
  assert.strictEqual(shared.resolvedPerFrame[0].mask, 0, 'frame 0 must not see frame 1 input');
});

// ======================================================================================
// (2) frame-advance = exactly one frame with that frame's input.
// ======================================================================================
await checkAsync('(2) frameAdvance runs EXACTLY one frame with that frame input', async () => {
  const { engine, shared } = await makeEngine();
  const before = shared.runner.currentFrame;
  engine.sendInputEdit({ op: 'setFrameButton', frame: before, button: 'Y', on: true });
  await step(engine);
  assert.strictEqual(shared.runner.currentFrame, before + 1, 'exactly one retro_run');
  assert.strictEqual(shared.resolvedPerFrame.length, 1, 'exactly one frame resolved');
  assert.strictEqual(shared.resolvedPerFrame[0].mask, (1 << 1) >>> 0, "ran with that frame's Y bit");
});

// ======================================================================================
// (3) sendLiveMask is OR-ed into the NEXT frame; changing it changes only later frames.
// ======================================================================================
await checkAsync('(3) sendLiveMask OR-es into the next frame only (latest wins per frame)', async () => {
  const { engine, shared } = await makeEngine();
  const L = 1 << 10; // L shoulder
  const R = 1 << 11; // R shoulder
  engine.sendLiveMask(L);
  await step(engine); // frame 0 sees L
  engine.sendLiveMask(R);
  await step(engine); // frame 1 sees R (NOT L)
  engine.sendLiveMask(0);
  await step(engine); // frame 2 sees nothing
  assert.strictEqual(shared.resolvedPerFrame[0].mask, L >>> 0, 'frame 0 = live L');
  assert.strictEqual(shared.resolvedPerFrame[1].mask, R >>> 0, 'frame 1 = live R (latest live mask)');
  assert.strictEqual(shared.resolvedPerFrame[2].mask, 0, 'frame 2 = no live input');
});

// ======================================================================================
// (4) truncateAfter re-record holds after a loadState; onStateLoaded fires the hook.
// ======================================================================================
await checkAsync('(4) loadState fires onStateLoaded and truncateAfter re-record holds', async () => {
  const { engine } = await makeEngine();
  let loadedFrame = -1;
  engine.onStateLoaded((f) => {
    loadedFrame = f;
    // The UI truncates future scripted inputs after the loaded frame (re-record).
    engine.sendInputEdit({ op: 'truncateAfter', frame: f });
  });
  for (let f = 0; f <= 3; f++) {
    engine.sendInputEdit({ op: 'setFrameButton', frame: f, button: 'A', on: true });
  }
  const saved = await engine.saveState();
  assert.ok(saved instanceof Uint8Array, 'saveState produced bytes');
  const ok = engine.loadState(saved, { frame: 1 });
  assert.strictEqual(ok, true, 'loadState applied');
  assert.strictEqual(loadedFrame, 1, 'onStateLoaded fired with the loaded frame so re-record runs');
  const A = 1 << 8;
  assert.strictEqual(engine._resolver.getFrameInputMask(0, 0), A, 'frame 0 kept');
  assert.strictEqual(engine._resolver.getFrameInputMask(1, 0), A, 'frame 1 kept');
  assert.strictEqual(engine._resolver.getFrameInputMask(2, 0), 0, 'frame 2 truncated after load');
  assert.strictEqual(engine._resolver.getFrameInputMask(3, 0), 0, 'frame 3 truncated after load');
});

// ======================================================================================
// (5) save/load round-trips over byte buffers.
// ======================================================================================
await checkAsync('(5) save/load round-trips over byte buffers', async () => {
  const { engine, shared } = await makeEngine();
  const saved = await engine.saveState();
  assert.ok(saved instanceof Uint8Array && saved.length > 0, 'saveState returns a Uint8Array');
  // Mutate the core state, then restore from the saved bytes.
  shared.module.__setState(0x1234);
  assert.strictEqual(shared.module.__getState(), 0x1234);
  const ok = engine.loadState(saved, { frame: 9 });
  assert.strictEqual(ok, true, 'loadState applied');
  assert.strictEqual(shared.module.__getState(), 0xabcd, 'core state restored from the round-tripped bytes');
  assert.strictEqual(engine.currentFrame, 9, 'frame metadata applied on load');
});

// ======================================================================================
// (6) HUD carries the verified SMB1 addresses READ-ONLY; NO memory-write path exists.
// ======================================================================================
await checkAsync('(6) getMemoryView carries the verified SMB1 addresses READ-ONLY', async () => {
  const { engine } = await makeEngine();
  const mem = engine.getMemoryView();
  assert.ok(mem, 'a memory view is available');
  assert.strictEqual(mem.readS8(SMB1_HUD_ADDR.H_SPEED), -16, 'H-Speed (0x005D) signed decode');
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.X_HI), HUD_SEED[SMB1_HUD_ADDR.X_HI]);
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.X_SUB), HUD_SEED[SMB1_HUD_ADDR.X_SUB]);
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.X_PAGE), HUD_SEED[SMB1_HUD_ADDR.X_PAGE]);
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.Y_HI), HUD_SEED[SMB1_HUD_ADDR.Y_HI]);
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.Y_SUB), HUD_SEED[SMB1_HUD_ADDR.Y_SUB]);
  // Strictly READ-ONLY: no writer on the view.
  for (const k of ['writeU8', 'poke', 'write', 'set', 'inject']) {
    assert.strictEqual(typeof mem[k], 'undefined', `memory view must not expose ${k}`);
  }
});
check('(6b) verified SMB1 HUD addresses are exactly the documented constants', () => {
  assert.strictEqual(SMB1_HUD_ADDR.H_SPEED, 0x005d);
  assert.strictEqual(SMB1_HUD_ADDR.X_HI, 0x0042);
  assert.strictEqual(SMB1_HUD_ADDR.X_SUB, 0x0043);
  assert.strictEqual(SMB1_HUD_ADDR.X_PAGE, 0x0401);
  assert.strictEqual(SMB1_HUD_ADDR.Y_HI, 0x0002);
  assert.strictEqual(SMB1_HUD_ADDR.Y_SUB, 0x041c);
});
await checkAsync('(6c) memory is strictly READ-ONLY: no write/poke/cheat path on engine or runner', async () => {
  const { engine, shared } = await makeEngine();
  // The engine exposes no memory-write surface.
  for (const k of ['writeMemory', 'poke', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat']) {
    assert.strictEqual(typeof engine[k], 'undefined', `engine must not expose ${k}`);
  }
  // The runner exposes no writer and never wraps retro_cheat_*.
  assert.strictEqual(typeof shared.runner._fn.retro_cheat_set, 'undefined', 'retro_cheat_set never wrapped');
  assert.strictEqual(typeof shared.runner.poke, 'undefined', 'runner exposes no poke');
});

// ======================================================================================
// (7) core-switch: setCore tears the runner down and re-inits in-process (no file picker).
// ======================================================================================
await checkAsync('(7) setCore tears down + re-inits the runner in-process, mirrors activeCoreId', async () => {
  const { engine } = await makeEngine();
  assert.strictEqual(engine.activeCoreId, 'realtime', 'starts on snes9x (realtime)');
  // Re-point the mock runner factory at the accuracy core, then switch.
  installEngineMockRunner(engine, 'cores/bsnes_mercury_accuracy_libretro.js');
  const r = await engine.setCore('cores/bsnes_mercury_accuracy_libretro.js');
  assert.ok(r && r.ok === true, 'setCore re-inited in-process (no throw, no file picker)');
  assert.strictEqual(engine.activeCoreId, 'accuracy', 'activeCoreId mirrors the swapped core');
  // Determinism survives the swap: a scripted+live frame still resolves (log|live)>>>0.
  engine.pause();
  fake.stepRaf(2);
  const sharedAfter = engine._makeRunner ? null : null; // runner re-created by setCore/init
  // Reach the live runner via the engine and prove one frame resolves correctly.
  engine.sendInputEdit({ op: 'setFrameButton', frame: engine.runner.currentFrame, button: 'X', on: true });
  const targetFrame = engine.runner.currentFrame;
  const captured = [];
  // Wrap the resolver so we capture the exact mask requested for the frame about to run.
  const realResolve = engine._resolver.getFrameInputMask.bind(engine._resolver);
  engine._resolver.getFrameInputMask = (frame, live) => {
    const m = realResolve(frame, live);
    captured.push({ frame, mask: m });
    return m;
  };
  await step(engine);
  engine._resolver.getFrameInputMask = realResolve;
  const forTarget = captured.find((c) => c.frame === targetFrame);
  assert.ok(forTarget, 'the swapped runner resolved input for the advanced frame');
  assert.strictEqual(forTarget.mask, (1 << 9) >>> 0, "post-swap frame ran with that frame's X bit (determinism held)");
  void sharedAfter;
});

fake.restore();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
