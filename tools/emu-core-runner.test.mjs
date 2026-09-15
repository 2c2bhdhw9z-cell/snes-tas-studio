// tools/emu-core-runner.test.mjs
//
// Unit-tests emu-core-runner.js in Node with a MOCK libretro core Module — NO real browser,
// NO real WASM. The mock simulates a small Emscripten heap (HEAPU8/HEAP32/HEAPU32/HEAPU16/
// HEAPF64 over one ArrayBuffer, plus _malloc/_free), cwrap/addFunction, retro_load_game=true,
// a retro_run that fires the registered video callback with a known small framebuffer, a
// retro_serialize/unserialize round-trip over a byte buffer, and a WRAM region seeded with
// known SMB1 HUD bytes.
//
// Asserts: the run loop advances frames and calls onVideoFrame with a decoded RGBA buffer of
// the expected dimensions; onHud carries the verified SMB1 addresses/values read READ-ONLY;
// save->load round-trips; frame-advance runs exactly ONE frame; and the runner exposes NO
// memory-write / poke / cheat / level-select method.
//
// Run: node tools/emu-core-runner.test.mjs

import assert from 'node:assert';
import { EmuCoreRunner, SMB1_HUD_ADDR, ROM_PATH } from '../emu-core-runner.js';

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

// --- Framebuffer the mock core will emit each retro_run --------------------------------
const FB_W = 8;
const FB_H = 4;
const FB_PIXFMT_RGB565 = 2;
// A known RGB565 pixel we can decode-check: pure red (r5=31,g6=0,b5=0) => 0xF800.
const RED565 = 0xf800;

// --- WRAM seed: known SMB1 HUD bytes ---------------------------------------------------
const WRAM_SIZE = 0x2000; // 8 KiB SNES WRAM window is plenty for these offsets
const HUD_SEED = {
  [SMB1_HUD_ADDR.H_SPEED]: 0xf0, // -16 as a signed byte
  [SMB1_HUD_ADDR.X_HI]: 0x30,
  [SMB1_HUD_ADDR.X_SUB]: 0x80,
  [SMB1_HUD_ADDR.X_PAGE]: 0x02,
  [SMB1_HUD_ADDR.Y_HI]: 0xb0,
  [SMB1_HUD_ADDR.Y_SUB]: 0x40,
};

/**
 * Build a mock Emscripten Module with a linear heap + a tiny bump allocator, cwrap that maps
 * ABI names to closures, addFunction that stores callbacks and returns a table index, a WRAM
 * region seeded with HUD bytes, a framebuffer, and serialize/unserialize round-trip.
 */
function makeMockModule() {
  const HEAP_BYTES = 1 << 20; // 1 MiB mock heap
  const buffer = new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPU32 = new Uint32Array(buffer);
  const HEAPU16 = new Uint16Array(buffer);
  const HEAPF64 = new Float64Array(buffer);

  // Bump allocator starting well above the fixed regions we place below.
  let bump = 0x40000;
  const _malloc = (n) => {
    const p = bump;
    bump += (n + 7) & ~7; // 8-byte align
    if (bump > HEAP_BYTES) throw new Error('mock heap OOM');
    return p;
  };
  const _free = () => {};

  // Fixed WRAM region, seeded with the known SMB1 HUD bytes.
  const WRAM_PTR = 0x10000;
  for (const [off, val] of Object.entries(HUD_SEED)) HEAPU8[WRAM_PTR + Number(off)] = val;

  // Fixed framebuffer region filled with RED565 for every pixel (pitch = width*2).
  const FB_PTR = 0x20000;
  const FB_PITCH = FB_W * 2;
  for (let y = 0; y < FB_H; y++) {
    for (let x = 0; x < FB_W; x++) {
      HEAPU16[(FB_PTR + y * FB_PITCH) / 2 + x] = RED565;
    }
  }

  // Registered callbacks by "table index" returned from addFunction.
  const table = [];
  const cbs = {}; // env/video/audio/inputPoll/inputState pointers
  const addFunction = (fn) => {
    table.push(fn);
    return table.length; // non-zero index
  };

  // Simulated serialize buffer (opaque state). We store a monotonically-changing "state"
  // so a save->mutate->load round-trip is observable.
  let coreState = 0xabcd;
  const SERIALIZE_SIZE = 16;

  const noop = () => {};
  const fnTable = {
    retro_init: noop,
    retro_deinit: noop,
    retro_reset: noop,
    retro_unload_game: noop,
    retro_load_game: () => 1, // always succeeds
    retro_run: () => {
      // Fire the registered video callback with the known framebuffer.
      const vcb = table[cbs.video - 1];
      if (typeof vcb === 'function') vcb(FB_PTR, FB_W, FB_H, FB_PITCH);
      // Also exercise the input_state callback so input plumbing is driven.
      const icb = table[cbs.input - 1];
      if (typeof icb === 'function') icb(0, 1, 0, 0);
    },
    retro_serialize_size: () => SERIALIZE_SIZE,
    retro_serialize: (ptr /*, size */) => {
      // Write the current core state into the heap so saveState copies it out.
      HEAP32[ptr >> 2] = coreState;
      return 1;
    },
    retro_unserialize: (ptr /*, size */) => {
      coreState = HEAP32[ptr >> 2];
      return 1;
    },
    retro_get_memory_data: (id) => (id === 2 ? WRAM_PTR : 0),
    retro_get_memory_size: (id) => (id === 2 ? WRAM_SIZE : 0),
    retro_set_environment: (p) => { cbs.env = p; },
    retro_set_video_refresh: (p) => { cbs.video = p; },
    retro_set_audio_sample: (p) => { cbs.audioSample = p; },
    retro_set_audio_sample_batch: (p) => { cbs.audioBatch = p; },
    retro_set_input_poll: (p) => { cbs.inputPoll = p; },
    retro_set_input_state: (p) => { cbs.input = p; },
    retro_get_system_av_info: (ptr) => {
      // geometry.base_width@0, base_height@4; timing.fps (double)@24.
      HEAPU32[(ptr >> 2) + 0] = 256;
      HEAPU32[(ptr >> 2) + 1] = 224;
      HEAPF64[(ptr + 24) >> 3] = 60.098;
    },
  };

  const cwrap = (name) => {
    const fn = fnTable[name];
    if (!fn) throw new Error(`mock cwrap: unknown symbol ${name}`);
    return fn;
  };

  return {
    HEAPU8, HEAP32, HEAPU32, HEAPU16, HEAPF64,
    _malloc, _free, cwrap, addFunction,
    // test-only introspection
    __getState: () => coreState,
    __setState: (v) => { coreState = v; },
    __cbs: () => cbs,
    __call: (idx, ...args) => table[idx - 1](...args), // invoke an installed callback by index
  };
}

// A fake loadCore that returns our mock Module (bypasses the real dynamic import + WASM).
function makeDeps(overrides = {}) {
  const mock = makeMockModule();
  const captured = { frames: [], hud: [], statuses: [], frameTicks: [], stateLoaded: [] };
  const deps = {
    loadCore: async () => ({ ok: true, Module: mock, corePath: 'cores/snes9x_libretro.js' }),
    fetchRom: async () => ({ ok: true, bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]) }),
    // Synchronous inline scheduler so tests can drive the loop deterministically without timers.
    scheduleYield: (cb) => { deps.__pending = cb; return 1; },
    onVideoFrame: (rgba, w, h, pitch, fmt) => captured.frames.push({ rgba, w, h, pitch, fmt }),
    onHud: (v) => captured.hud.push(v),
    onStatus: (s) => captured.statuses.push(s),
    onFrame: (f, st) => captured.frameTicks.push({ f, st }),
    onStateLoaded: (f) => captured.stateLoaded.push(f),
    getFrameInputMask: () => 0,
    ...overrides,
  };
  return { deps, mock, captured };
}

// ======================================================================================
await checkAsync('boot() loads the mock core + ROM and becomes ready', async () => {
  const { deps } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  const res = await runner.boot();
  assert.ok(res.ok, 'boot should succeed: ' + JSON.stringify(res));
  assert.strictEqual(runner.status, 'ready');
  assert.strictEqual(runner.engineStatus, 'GameLoaded');
});

await checkAsync('frameAdvance() runs EXACTLY one frame and emits a decoded RGBA frame', async () => {
  const { deps, captured } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  assert.strictEqual(runner.currentFrame, 0);
  runner.frameAdvance();
  assert.strictEqual(runner.currentFrame, 1, 'exactly one frame advanced');
  assert.strictEqual(captured.frames.length, 1, 'exactly one video frame emitted');
  const f = captured.frames[0];
  assert.strictEqual(f.w, FB_W);
  assert.strictEqual(f.h, FB_H);
  assert.strictEqual(f.rgba.length, FB_W * FB_H * 4, 'RGBA buffer sized w*h*4');
});

await checkAsync('decoded RGBA is correct for a known RGB565 red framebuffer', async () => {
  const { deps, captured } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  runner.frameAdvance();
  const { rgba } = captured.frames[0];
  // First pixel: RED565 -> R=255, G=0, B=0, A=255.
  assert.strictEqual(rgba[0], 255, 'R');
  assert.strictEqual(rgba[1], 0, 'G');
  assert.strictEqual(rgba[2], 0, 'B');
  assert.strictEqual(rgba[3], 255, 'A');
});

await checkAsync('onHud carries the verified SMB1 addresses/values read READ-ONLY', async () => {
  const { deps, captured } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  runner.frameAdvance();
  assert.ok(captured.hud.length >= 1, 'HUD emitted at least once');
  const h = captured.hud[captured.hud.length - 1];
  // H-Speed is a SIGNED byte: seeded 0xF0 -> -16.
  assert.strictEqual(h.hSpeed, -16, 'H-Speed signed decode');
  assert.strictEqual(h.xHi, HUD_SEED[SMB1_HUD_ADDR.X_HI]);
  assert.strictEqual(h.xSub, HUD_SEED[SMB1_HUD_ADDR.X_SUB]);
  assert.strictEqual(h.xPage, HUD_SEED[SMB1_HUD_ADDR.X_PAGE]);
  assert.strictEqual(h.yHi, HUD_SEED[SMB1_HUD_ADDR.Y_HI]);
  assert.strictEqual(h.ySub, HUD_SEED[SMB1_HUD_ADDR.Y_SUB]);
});

await checkAsync('verified SMB1 HUD addresses are exactly the documented constants', async () => {
  assert.strictEqual(SMB1_HUD_ADDR.H_SPEED, 0x005d);
  assert.strictEqual(SMB1_HUD_ADDR.X_HI, 0x0042);
  assert.strictEqual(SMB1_HUD_ADDR.X_SUB, 0x0043);
  assert.strictEqual(SMB1_HUD_ADDR.X_PAGE, 0x0401);
  assert.strictEqual(SMB1_HUD_ADDR.Y_HI, 0x0002);
  assert.strictEqual(SMB1_HUD_ADDR.Y_SUB, 0x041c);
});

await checkAsync('save then load round-trips the core state', async () => {
  const { deps, mock } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  const snap = runner.saveState();
  assert.ok(snap instanceof Uint8Array && snap.length === 16, 'snapshot bytes captured');
  // Mutate the core state, then load the snapshot back and confirm restoration.
  mock.__setState(0x1234);
  assert.strictEqual(mock.__getState(), 0x1234);
  const ok = runner.loadState(snap, { frame: 42 });
  assert.strictEqual(ok, true);
  assert.strictEqual(mock.__getState(), 0xabcd, 'core state restored from snapshot');
  assert.strictEqual(runner.currentFrame, 42, 'frame metadata applied');
});

await checkAsync('loadState fires onStateLoaded for re-record truncation', async () => {
  const { deps, captured } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  const snap = runner.saveState();
  runner.loadState(snap, { frame: 10 });
  assert.deepStrictEqual(captured.stateLoaded, [10], 'onStateLoaded(frame) fired once with the frame');
});

await checkAsync('input source is consulted per frame (bit extraction)', async () => {
  const seen = [];
  const { deps } = makeDeps({ getFrameInputMask: (frame) => { seen.push(frame); return 0; } });
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  runner.frameAdvance();
  assert.ok(seen.length >= 1, 'getFrameInputMask consulted during retro_run');
});

await checkAsync('audio callbacks are NON-BLOCKING: batch ALWAYS returns the full frame count (drop-all, never stalls)', async () => {
  const { deps, mock } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  const cbs = mock.__cbs();
  // The batch callback (retro_set_audio_sample_batch) MUST report every sample consumed so a
  // real core never waits for buffer space — this is what keeps audio from throttling video.
  assert.ok(cbs.audioBatch, 'audio batch callback installed');
  for (const frames of [0, 1, 512, 4096, 65535]) {
    const consumed = mock.__call(cbs.audioBatch, 0 /* dataPtr */, frames);
    assert.strictEqual(consumed, frames, `batch claims ALL ${frames} frames consumed (no backpressure)`);
  }
  // The single-sample callback must not throw / block either.
  assert.ok(cbs.audioSample, 'audio sample callback installed');
  assert.doesNotThrow(() => mock.__call(cbs.audioSample, 100, -100), 'single-sample sink never throws');
});

await checkAsync('self-scheduling run loop advances frames and yields between them (fast-forward)', async () => {
  const { deps, captured } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  // Fast-forward runs a burst of frames per tick independent of wall-clock, so we can drive
  // the injected scheduler deterministically and prove the loop re-arms (yields) each tick.
  runner.fastForward(true);
  runner.start();
  let ticks = 0;
  for (let i = 0; i < 3 && deps.__pending; i++) {
    const cb = deps.__pending;
    deps.__pending = null;
    cb();
    ticks += 1;
  }
  assert.ok(ticks >= 1, 'loop scheduled at least one tick');
  assert.ok(runner.currentFrame >= 8, `run loop advanced a burst of frames (got ${runner.currentFrame})`);
  assert.ok(captured.frames.length >= 8, 'video frames emitted for the burst');
  runner.pause();
  // After pause the loop must not re-arm.
  assert.strictEqual(runner._loopRunning, false, 'loop stops on pause');
});

await checkAsync('speed-gated stepping runs frames once enough wall-clock elapses', async () => {
  // Drive the loop with a scheduler that advances a fake clock via performance.now override.
  const realPerf = globalThis.performance;
  let clock = 1000;
  globalThis.performance = { now: () => clock };
  try {
    const { deps } = makeDeps();
    const runner = new EmuCoreRunner(deps);
    await runner.boot();
    runner.start();
    // Tick #1 seeds _lastTs (delta 0, no frame). Advance the clock, then tick again.
    for (let i = 0; i < 4 && deps.__pending; i++) {
      const cb = deps.__pending;
      deps.__pending = null;
      clock += 100; // 100ms >> one 60fps frame time
      cb();
    }
    assert.ok(runner.currentFrame >= 1, `speed-gated loop advanced (got ${runner.currentFrame})`);
    runner.pause();
  } finally {
    globalThis.performance = realPerf;
  }
});

await checkAsync('getMemoryView is READ-ONLY and exposes no writer', async () => {
  const { deps } = makeDeps();
  const runner = new EmuCoreRunner(deps);
  await runner.boot();
  const mem = runner.getMemoryView();
  assert.ok(mem, 'memory view available after boot');
  assert.strictEqual(mem.readU8(SMB1_HUD_ADDR.X_HI), HUD_SEED[SMB1_HUD_ADDR.X_HI]);
  assert.strictEqual(mem.readS8(SMB1_HUD_ADDR.H_SPEED), -16);
  for (const k of ['writeU8', 'poke', 'write', 'set', 'inject']) {
    assert.strictEqual(typeof mem[k], 'undefined', `memory view must not expose ${k}`);
  }
});

check('runner exposes NO memory-write / cheat / level-select method', () => {
  const runner = new EmuCoreRunner({});
  for (const k of ['writeMemory', 'poke', 'pokeU8', 'writeU8', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat', 'retro_cheat_set', 'selectLevel', 'setLevel']) {
    assert.strictEqual(typeof runner[k], 'undefined', `unexpected method: ${k}`);
  }
  // retro_cheat_* must never be wrapped even after a boot with a mock core.
  assert.strictEqual(typeof runner._fn.retro_cheat_set, 'undefined');
  assert.strictEqual(typeof runner._fn.retro_cheat_reset, 'undefined');
});

check('ROM path constant is the exact auto-boot path', () => {
  assert.strictEqual(ROM_PATH, 'assets/Super Mario All-Stars (USA).sfc');
});

await checkAsync('boot() degrades gracefully when the core is missing (no throw)', async () => {
  const { deps } = makeDeps({ loadCore: async () => ({ ok: false, reason: 'core-missing' }) });
  const runner = new EmuCoreRunner(deps);
  const res = await runner.boot();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(runner.status, 'disabled');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
