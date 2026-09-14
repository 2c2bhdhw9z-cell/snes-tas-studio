// tools/env-callback.test.mjs
//
// Tests the fail-closed libretro environment callback and pixel-format capture
// (review fixes #3 and #4):
//   - Unhandled commands return false (fail-closed), so a real core won't read a data
//     buffer the frontend never populated.
//   - SET_PIXEL_FORMAT records the format the core declares (XRGB8888 / RGB565 / XRGB1555)
//     and rejects unknown values.
//   - GET_CAN_DUPE writes the bool and returns true.
//   - Handled SET commands (rotation / message / performance level) are acknowledged.
// Run: node tools/env-callback.test.mjs
import assert from 'node:assert';

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message }); }
}

// DOM/fetch stubs so the module imports.
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ className: '', textContent: '' }),
  getElementById: () => null,
  head: { appendChild: () => {} },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

const mod = await import('../tas-engine.js');
const { TASEngine } = mod;

// A tiny fake WASM heap so _handleEnvironment can read/write through the same views the
// real Emscripten Module exposes.
function makeEngineWithHeap() {
  const engine = new TASEngine();
  const buf = new ArrayBuffer(256);
  // A tiny bump allocator so _ensureDirString (which calls Module._malloc) can allocate the
  // kept-alive directory C string. Hands out offsets above the low scratch region the tests
  // poke directly.
  let brk = 128;
  engine.Module = {
    HEAP32: new Int32Array(buf),
    HEAPU32: new Uint32Array(buf),
    HEAPU8: new Uint8Array(buf),
    _malloc(n) {
      const p = brk;
      brk += n;
      return p;
    },
    _free() {},
  };
  return engine;
}

// libretro env command ids used below (must match tas-engine.js).
const CMD = {
  SET_ROTATION: 1,
  GET_OVERSCAN: 2,
  GET_CAN_DUPE: 3,
  SET_MESSAGE: 6,
  SET_PERFORMANCE_LEVEL: 8,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  SET_INPUT_DESCRIPTORS: 11,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  GET_LOG_INTERFACE: 27,
  GET_SAVE_DIRECTORY: 31,
  SET_SUBSYSTEM_INFO: 34,
  SET_CONTROLLER_INFO: 35,
  SET_MEMORY_MAPS: 36,
  GET_LANGUAGE: 39,
  GET_CORE_OPTIONS_VERSION: 52,
};
const FMT = { XRGB1555: 0, XRGB8888: 1, RGB565: 2 };

check('default pixel format is RGB565', () => {
  const e = makeEngineWithHeap();
  assert.strictEqual(e._pixelFormat, FMT.RGB565);
});

check('SET_PIXEL_FORMAT XRGB8888 recorded, returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  e.Module.HEAP32[ptr >> 2] = FMT.XRGB8888;
  const ok = e._handleEnvironment(CMD.SET_PIXEL_FORMAT, ptr);
  assert.strictEqual(ok, true);
  assert.strictEqual(e._pixelFormat, FMT.XRGB8888);
});

check('SET_PIXEL_FORMAT RGB565 recorded', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  e.Module.HEAP32[ptr >> 2] = FMT.RGB565;
  assert.strictEqual(e._handleEnvironment(CMD.SET_PIXEL_FORMAT, ptr), true);
  assert.strictEqual(e._pixelFormat, FMT.RGB565);
});

check('SET_PIXEL_FORMAT unknown value rejected (false), format unchanged', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  e.Module.HEAP32[ptr >> 2] = 999;
  const before = e._pixelFormat;
  assert.strictEqual(e._handleEnvironment(CMD.SET_PIXEL_FORMAT, ptr), false);
  assert.strictEqual(e._pixelFormat, before);
});

check('GET_CAN_DUPE writes bool and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 4;
  e.Module.HEAPU8[ptr] = 0;
  assert.strictEqual(e._handleEnvironment(CMD.GET_CAN_DUPE, ptr), true);
  assert.strictEqual(e.Module.HEAPU8[ptr], 1);
});

check('acknowledged SET commands return true', () => {
  const e = makeEngineWithHeap();
  assert.strictEqual(e._handleEnvironment(CMD.SET_ROTATION, 0), true);
  assert.strictEqual(e._handleEnvironment(CMD.SET_MESSAGE, 0), true);
  assert.strictEqual(e._handleEnvironment(CMD.SET_PERFORMANCE_LEVEL, 0), true);
});

check('truly unhandled commands are fail-closed (return false)', () => {
  const e = makeEngineWithHeap();
  // A spread of command ids we do NOT handle.
  for (const cmd of [7, 20, 40, 1000]) {
    assert.strictEqual(e._handleEnvironment(cmd, 16), false, `cmd ${cmd} should be false`);
  }
});

check('SET_PIXEL_FORMAT with null data pointer returns false', () => {
  const e = makeEngineWithHeap();
  assert.strictEqual(e._handleEnvironment(CMD.SET_PIXEL_FORMAT, 0), false);
});

// --- commands the REAL bsnes-mercury core requests (verified via tools/run-smoke.mjs) ---

check('GET_LOG_INTERFACE is fail-closed (variadic printf cannot be bridged)', () => {
  const e = makeEngineWithHeap();
  // Even with a valid data pointer we must NOT claim to provide a log interface, because a
  // real core would then invoke a variadic callback and trap.
  assert.strictEqual(e._handleEnvironment(CMD.GET_LOG_INTERFACE, 16), false);
});

check('GET_SYSTEM_DIRECTORY writes a non-null pointer and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 8; // where the const char** out-param lives
  e.Module.HEAP32[ptr >> 2] = 0;
  assert.strictEqual(e._handleEnvironment(CMD.GET_SYSTEM_DIRECTORY, ptr), true);
  const strPtr = e.Module.HEAP32[ptr >> 2];
  assert.ok(strPtr > 0, 'a heap string pointer was written');
  // The string is "." (0x2e) NUL-terminated.
  assert.strictEqual(e.Module.HEAPU8[strPtr], 0x2e);
  assert.strictEqual(e.Module.HEAPU8[strPtr + 1], 0x00);
});

check('GET_SAVE_DIRECTORY writes a non-null pointer and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 12;
  e.Module.HEAP32[ptr >> 2] = 0;
  assert.strictEqual(e._handleEnvironment(CMD.GET_SAVE_DIRECTORY, ptr), true);
  assert.ok(e.Module.HEAP32[ptr >> 2] > 0);
});

check('directory strings are allocated ONCE and kept alive (stable pointer)', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  e._handleEnvironment(CMD.GET_SYSTEM_DIRECTORY, ptr);
  const first = e.Module.HEAP32[ptr >> 2];
  e._handleEnvironment(CMD.GET_SYSTEM_DIRECTORY, ptr);
  const second = e.Module.HEAP32[ptr >> 2];
  assert.strictEqual(first, second, 'same stable pointer returned each time');
});

check('GET_VARIABLE sets value=NULL and returns true (no override, core uses defaults)', () => {
  const e = makeEngineWithHeap();
  const ptr = 8; // retro_variable { key; value; }
  e.Module.HEAP32[(ptr + 4) >> 2] = 0x12345; // pretend value was garbage
  assert.strictEqual(e._handleEnvironment(CMD.GET_VARIABLE, ptr), true);
  assert.strictEqual(e.Module.HEAP32[(ptr + 4) >> 2], 0, 'value pointer set to NULL');
});

check('GET_VARIABLE_UPDATE writes 0 and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 4;
  e.Module.HEAPU8[ptr] = 9;
  assert.strictEqual(e._handleEnvironment(CMD.GET_VARIABLE_UPDATE, ptr), true);
  assert.strictEqual(e.Module.HEAPU8[ptr], 0);
});

check('GET_OVERSCAN writes 0 and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 4;
  e.Module.HEAPU8[ptr] = 9;
  assert.strictEqual(e._handleEnvironment(CMD.GET_OVERSCAN, ptr), true);
  assert.strictEqual(e.Module.HEAPU8[ptr], 0);
});

check('GET_LANGUAGE writes 0 (English) and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  e.Module.HEAP32[ptr >> 2] = 9;
  assert.strictEqual(e._handleEnvironment(CMD.GET_LANGUAGE, ptr), true);
  assert.strictEqual(e.Module.HEAP32[ptr >> 2], 0);
});

check('GET_CORE_OPTIONS_VERSION writes 0 and returns true', () => {
  const e = makeEngineWithHeap();
  const ptr = 8;
  assert.strictEqual(e._handleEnvironment(CMD.GET_CORE_OPTIONS_VERSION, ptr), true);
  assert.strictEqual(e.Module.HEAP32[ptr >> 2], 0);
});

check('advisory SET commands the core issues are acknowledged (true)', () => {
  const e = makeEngineWithHeap();
  for (const cmd of [
    CMD.SET_INPUT_DESCRIPTORS,
    CMD.SET_VARIABLES,
    CMD.SET_SUBSYSTEM_INFO,
    CMD.SET_CONTROLLER_INFO,
    CMD.SET_MEMORY_MAPS,
  ]) {
    assert.strictEqual(e._handleEnvironment(cmd, 16), true, `cmd ${cmd} should be acknowledged`);
  }
});

check('experimental bit is stripped before classifying (SET_MEMORY_MAPS | 0x10000)', () => {
  const e = makeEngineWithHeap();
  assert.strictEqual(e._handleEnvironment(CMD.SET_MEMORY_MAPS | 0x10000, 16), true);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
