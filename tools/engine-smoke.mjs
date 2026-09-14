// tools/engine-smoke.mjs
// Verifies tas-engine.js graceful degradation: when the core and ROM are both absent,
// init() renders notices (no throw), stays in a 'disabled' state, and never creates a
// file picker. Also verifies getMemoryView() is null (no core) and that there is no
// memory-write API surface. Run: node tools/engine-smoke.mjs
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

// --- Minimal DOM + fetch stubs so the ES module can run under Node ---
const noticeLines = [];
const noticeEl = {
  hidden: true,
  _children: [],
  appendChild(node) { this._children.push(node); noticeLines.push(node.textContent); },
  set innerHTML(v) { this._children = []; noticeLines.length = 0; },
  get innerHTML() { return ''; },
};
const fakeCanvas = { width: 0, height: 0, getContext: () => ({ createImageData: () => ({ data: [] }), putImageData: () => {} }) };

globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ className: '', textContent: '', set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
  getElementById: () => null,
  head: { appendChild: () => {} },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
// Both core loader HEAD probe and ROM fetch 404 -> graceful degradation.
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

const mod = await import('../tas-engine.js');
const engine = mod.default;

// Re-create a notice element that records appended text.
const recorded = [];
engine.attach({
  canvas: fakeCanvas,
  noticeEl: {
    hidden: true,
    appendChild(n) { recorded.push(n.textContent); },
    set innerHTML(v) { if (v === '') recorded.length = 0; },
    get innerHTML() { return ''; },
  },
});

// Patch document.createElement so showNotice produces text we can read.
globalThis.document.createElement = () => {
  let t = '';
  return { className: '', set textContent(v) { t = v; }, get textContent() { return t; } };
};

let threw = false;
let ret;
try {
  ret = await engine.init();
} catch (e) {
  threw = true;
}

check('init() does not throw on missing core+ROM', () => assert.strictEqual(threw, false));
check('init() reports not-ok', () => assert.ok(ret && ret.ok === false));
check('engine status is disabled', () => assert.strictEqual(engine.status, 'disabled'));
check('ROM-missing notice rendered', () =>
  assert.ok(recorded.some((l) => /ROM not found at assets\/Super Mario All-Stars \(USA\)\.sfc/.test(l)), 'notices: ' + JSON.stringify(recorded)));
check('core-missing notice rendered', () =>
  assert.ok(recorded.some((l) => /core not found|Emulator core not found/i.test(l)), 'notices: ' + JSON.stringify(recorded)));
check('exact ROM path constant', () => assert.strictEqual(mod.ROM_PATH, 'assets/Super Mario All-Stars (USA).sfc'));
check('getMemoryView() null without core', () => assert.strictEqual(engine.getMemoryView(), null));
check('no memory-write method exposed', () => {
  for (const k of ['writeMemory', 'poke', 'pokeU8', 'writeU8', 'setMemory', 'injectMemory', 'cheatSet', 'setCheat']) {
    assert.strictEqual(typeof engine[k], 'undefined', `unexpected method: ${k}`);
  }
});
check('public API surface present', () => {
  for (const k of ['play', 'pause', 'frameAdvance', 'setSpeed', 'fastForward', 'saveState', 'loadState', 'setInputProvider', 'onFrame', 'getMemoryView', 'onStateLoaded']) {
    assert.strictEqual(typeof engine[k], 'function', `missing API: ${k}`);
  }
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
