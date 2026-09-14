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
  const buf = new ArrayBuffer(64);
  engine.Module = {
    HEAP32: new Int32Array(buf),
    HEAPU32: new Uint32Array(buf),
    HEAPU8: new Uint8Array(buf),
  };
  return engine;
}

// libretro env command ids used below (must match tas-engine.js).
const CMD = { SET_ROTATION: 1, GET_CAN_DUPE: 3, SET_MESSAGE: 6, SET_PERFORMANCE_LEVEL: 8, SET_PIXEL_FORMAT: 10 };
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

check('unhandled GET commands are fail-closed (return false)', () => {
  const e = makeEngineWithHeap();
  // A spread of common GET_* command ids we do NOT handle.
  for (const cmd of [15 /*GET_VARIABLE*/, 9 /*GET_SYSTEM_DIRECTORY*/, 27 /*GET_LOG_INTERFACE*/, 31 /*GET_SAVE_DIRECTORY*/, 1000]) {
    assert.strictEqual(e._handleEnvironment(cmd, 16), false, `cmd ${cmd} should be false`);
  }
});

check('SET_PIXEL_FORMAT with null data pointer returns false', () => {
  const e = makeEngineWithHeap();
  assert.strictEqual(e._handleEnvironment(CMD.SET_PIXEL_FORMAT, 0), false);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
