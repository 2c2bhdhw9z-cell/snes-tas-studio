// tools/studio-dom.test.mjs
//
// Headless DOM test for the TAS Studio UI (worker-proxy architecture) using jsdom + a MOCK
// Worker. jsdom does not execute <script type=module>, so we load index.html for its markup,
// then drive the engine PROXY + TASStudio + memory-watch modules directly.
//
// FEAT-004 rewrite: the emulator runs in a Web Worker; tas-engine.js is a thin proxy. This
// test installs a mock Worker (recording postMessage + letting us push worker messages back)
// so the REAL proxy + REAL piano-roll/memory-watch logic run against it. It asserts:
//   - piano-roll grid renders rows-per-frame with the SNES button columns
//   - clicking a cell toggles it (class + aria-pressed), updates the LOCAL MIRROR, AND sends
//     an {type:'inputEdit', op:'setFrameButton'} message to the worker
//   - toolbar has frame-advance / play-pause / speed slider (0.1-2) / fast-forward and they
//     forward the correct worker messages
//   - HUD renders from STREAMED {type:'hud'} values (verified SMB1 addresses)
//   - save/load send saveState/loadState + restoreSnapshot/truncateAfter, and the worker's
//     stateLoaded ack truncates the log (re-record)
//   - core-select maps to setCore messages; three cores incl. snes9x default; no file picker
//
// Run from tools/: node studio-dom.test.mjs   (requires jsdom installed here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installMockWorkerEnv, mockWorkerRegistry } from './mock-worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  virtualConsole,
});
const { window } = dom;
const { document } = window;

// Expose jsdom globals so the ES modules operate on this document.
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// Install the mock Worker BEFORE importing the proxy. No OffscreenCanvas support here, so the
// proxy keeps a main-thread 2d context and would blit posted {type:'video'} frames.
installMockWorkerEnv({ offscreen: false });

// Load engine singleton (proxy), then studio + HUD; wire them like the bootstrap would.
const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;

// Attach a canvas so the proxy creates its worker (jsdom canvas has no
// transferControlToOffscreen, so the fallback path is taken — exactly like older Safari).
const canvasEl = document.getElementById('screen');
engine.attach({ canvas: canvasEl, noticeEl: document.getElementById('notice') });
const worker = mockWorkerRegistry.last;
check('proxy created a module worker on attach', worker && worker.opts.type === 'module');

const { TASStudio } = await import('../piano-roll.js');
const { createMemoryWatch } = await import('../memory-watch.js');

const studio = new TASStudio(engine, {
  pianoRoll: document.getElementById('piano-roll'),
  frameControls: document.getElementById('frame-controls'),
  savestateTree: document.getElementById('savestate-tree'),
});
studio.init();

const watch = createMemoryWatch(engine, document.getElementById('hud'));
watch.update();

// --- Piano roll structure ---
const headerCells = document.querySelectorAll('#piano-roll .pr-row--header .pr-cell--head');
const headerCols = Array.from(document.querySelectorAll('#piano-roll .pr-row--header .pr-cell[data-col]')).map(
  (c) => c.dataset.col
);
check('piano-roll header rendered', headerCells.length > 0);
for (const col of ['A', 'B', 'X', 'Y', 'L', 'R', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT']) {
  check(`column ${col} present`, headerCols.includes(col));
}
const rows = document.querySelectorAll('#piano-roll .pr-body .pr-row');
check('piano-roll has many frame rows', rows.length >= 100);
check('rows are indexed by frame', document.querySelector('#piano-roll .pr-row[data-frame="0"]'));

// --- Clicking a cell toggles it AND sends an inputEdit message to the worker ---
worker.__clear();
const targetCell = document.querySelector('#piano-roll .pr-cell--btn[data-frame="3"][data-col="A"]');
check('target cell exists (frame 3, A)', targetCell);
const before = targetCell.classList.contains('pr-cell--on');
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const after = targetCell.classList.contains('pr-cell--on');
check('clicking cell toggles class', before === false && after === true);
check('clicking cell sets aria-pressed', targetCell.getAttribute('aria-pressed') === 'true');
check('toggle recorded in LOCAL MIRROR input log', studio.log.isSet(3, 'A'));
const edit = worker.__last('inputEdit');
check('cell toggle sends {type:inputEdit, op:setFrameButton} to the worker',
  edit && edit.msg.op === 'setFrameButton' && edit.msg.frame === 3 && edit.msg.button === 'A' && edit.msg.on === true);
// Click again to toggle off (and send another edit with on:false).
worker.__clear();
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('second click toggles off', !targetCell.classList.contains('pr-cell--on') && !studio.log.isSet(3, 'A'));
const edit2 = worker.__last('inputEdit');
check('second toggle sends inputEdit on:false', edit2 && edit2.msg.op === 'setFrameButton' && edit2.msg.on === false);

// --- Toolbar controls ---
check('frame advance button exists', document.getElementById('btn-frame-advance'));
check('play/pause button exists', document.getElementById('btn-playpause'));
check('fast-forward button exists', document.getElementById('btn-fast-forward'));
const speed = document.getElementById('speed');
check('speed slider exists', speed);
check('speed slider min=0.1', speed && speed.min === '0.1');
check('speed slider max=2', speed && speed.max === '2');
check('save button exists', document.getElementById('btn-savestate'));
check('load button exists', document.getElementById('btn-loadstate'));
// Live FPS readout sits in the toolbar next to the frame counter (prominent, read-only perf
// display; sourced from actual advanced frames over a rolling 1s window by app.js).
check('frame counter exists', document.getElementById('frame-counter'));
check('#fps-readout exists in the toolbar', document.getElementById('fps-readout'));
check('#fps-readout is inside #frame-controls', (() => {
  const fc = document.getElementById('frame-controls');
  const fps = document.getElementById('fps-readout');
  return fc && fps && fc.contains(fps);
})());
check('#fps-readout initial text is a plain FPS label', /FPS:\s*0/.test((document.getElementById('fps-readout') || {}).textContent || ''));

// Speed slider drives engine.setSpeed (clamped) and posts a setSpeed message.
worker.__clear();
speed.value = '1.5';
speed.dispatchEvent(new window.Event('input', { bubbles: true }));
check('speed slider updates engine.speed', Math.abs(engine.speed - 1.5) < 1e-6);
check('speed slider posts a setSpeed message', worker.__last('setSpeed') && Math.abs(worker.__last('setSpeed').msg.mult - 1.5) < 1e-6);

// Frame-advance button posts EXACTLY one frameAdvance message.
worker.__clear();
document.getElementById('btn-frame-advance').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Frame +1 posts exactly one frameAdvance message', worker.__all('frameAdvance').length === 1);

// --- HUD renders from STREAMED {type:'hud'} values (verified SMB1 addresses) ---
const hud = document.getElementById('hud');
const keys = Array.from(hud.querySelectorAll('.hud__value')).map((v) => v.dataset.key);
for (const k of ['frame', 'marioX', 'marioY', 'speedX']) {
  check(`HUD field ${k} rendered`, keys.includes(k));
}
// Before any HUD message, emulation-dependent fields show placeholder dashes.
check('HUD shows placeholder before any streamed HUD value', hud.querySelector('[data-key="marioX"]').textContent === '--');
// Simulate the worker streaming HUD values read from the verified SMB1 addresses. The worker
// labels each byte by the ADDRESS it was read at (SMB1_HUD_ADDR): xHi=byte@0x0042,
// xSub=byte@0x0043 (this is the X PAGE per memory-watch.js), xPage=byte@0x0401 (the X
// SUB-PIXEL). memory-watch.js reads readU8(0x0043) as the page and readU8(0x0401) as the
// sub-pixel, so with page=0x80 and pixel=0x30: marioX = 0x80*256 + 0x30 = 32816, sub = 0x02.
// (Distinct bytes at 0x0043 vs 0x0401 make this FAIL if the proxy transposes them.)
worker.__emit({ type: 'hud', values: { hSpeed: -16, xHi: 0x30, xSub: 0x80, xPage: 0x02, yHi: 0xb0, ySub: 0x40 } });
watch.update();
check('HUD X renders page(0x0043)*256+pixel(0x0042) . sub(0x0401)', hud.querySelector('[data-key="marioX"]').textContent === '32816.002');
check('HUD Y renders from streamed values (hi . sub)', hud.querySelector('[data-key="marioY"]').textContent === '176.064');
check('HUD H-Speed renders the signed streamed value', hud.querySelector('[data-key="speedX"]').textContent === '-16');

// --- DOM-REUSE PROOF: the per-frame HUD update MUTATES cached nodes in place; it does NOT
// rebuild rows / churn DOM nodes each frame (the layout-thrash leak that fed the FPS decay). ---
{
  const marioXNodeBefore = hud.querySelector('[data-key="marioX"]');
  const rowsBefore = hud.querySelectorAll('.hud__row').length;
  // Repaint the SAME values many times (models 60x/sec identical frames). Node identity must
  // be preserved (no createElement/innerHTML rebuild) and row count must not grow.
  for (let i = 0; i < 60; i++) watch.update();
  const marioXNodeAfter = hud.querySelector('[data-key="marioX"]');
  check('HUD update reuses the SAME value node (no per-frame createElement/innerHTML)', marioXNodeBefore === marioXNodeAfter);
  check('HUD update does not append rows over time (no unbounded DOM growth)', hud.querySelectorAll('.hud__row').length === rowsBefore);
  // A CHANGED value updates the SAME node in place (mutation, not replacement).
  worker.__emit({ type: 'hud', values: { hSpeed: 8, xHi: 0x31, xSub: 0x80, xPage: 0x03, yHi: 0xb1, ySub: 0x41 } });
  watch.update();
  check('HUD value change mutates the cached node in place', hud.querySelector('[data-key="marioX"]') === marioXNodeBefore);
  check('HUD value change is reflected (in-place textContent update)', hud.querySelector('[data-key="marioX"]').textContent === '32817.003');
}

// --- Save-state tree renders a node after Save; save posts a saveState command ---
worker.__clear();
document.getElementById('btn-savestate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('save-state tree shows a node', document.querySelector('#savestate-tree .savestate-node'));
check('Save posts a saveState command to the worker', worker.__last('saveState'));
// The worker replies with serialized bytes; the node fills in asynchronously.
worker.__emit({ type: 'saved', bytes: new Uint8Array([1, 2, 3, 4]).buffer });
await new Promise((r) => setTimeout(r, 0));

// --- Load path: sends restoreSnapshot + loadState; stateLoaded ack truncates the log ---
// Script some input past the saved frame first (frame 0 is the saved node's frame).
studio.log.set(5, 'B', true);
worker.__clear();
const saveNodeBtn = document.querySelector('#savestate-tree .savestate-node');
saveNodeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Load sends a restoreSnapshot inputEdit', worker.__all('inputEdit').some((e) => e.msg.op === 'restoreSnapshot'));
// The worker acks the load with stateLoaded(frame) -> proxy onStateLoaded -> truncateAfter.
worker.__emit({ type: 'stateLoaded', frame: 0 });
check('stateLoaded ack truncates the mirror log after the loaded frame (re-record)', !studio.log.isSet(5, 'B'));
check('stateLoaded ack sends a truncateAfter inputEdit to the worker', worker.__all('inputEdit').some((e) => e.msg.op === 'truncateAfter' && e.msg.frame === 0));

// --- Core selection dropdown maps to setCore messages ---
const coreSelect = document.getElementById('core-select');
check('core-select dropdown exists', !!coreSelect);
check('core-select is a <select>', coreSelect && coreSelect.tagName === 'SELECT');
const coreOptionValues = coreSelect
  ? Array.from(coreSelect.querySelectorAll('option')).map((o) => o.value)
  : [];
check('core-select has a Real-Time (snes9x) option', coreOptionValues.includes('realtime'));
check('core-select has an Accuracy option', coreOptionValues.includes('accuracy'));
check('core-select has a Performance option', coreOptionValues.includes('performance'));
check('Real-Time (snes9x) is the first/default option', coreOptionValues[0] === 'realtime');
check('core-select is NOT a file/ROM picker', coreSelect && coreSelect.tagName !== 'INPUT');
check('no file input introduced anywhere', document.querySelectorAll('input[type="file"]').length === 0);

// Core catalog + resolver from core-loader.
const loaderMod = await import('../core/core-loader.js');
const { CORE_CATALOG, coreById, DEFAULT_CORE_PATHS } = loaderMod;
check('CORE_CATALOG has three cores', Array.isArray(CORE_CATALOG) && CORE_CATALOG.length === 3);
check('catalog realtime path is the snes9x core',
  coreById('realtime') && coreById('realtime').path === 'cores/snes9x_libretro.js');
check('catalog realtime is the FIRST catalog entry (default-selected)',
  CORE_CATALOG[0] && CORE_CATALOG[0].id === 'realtime');
check('catalog accuracy path is the accuracy core',
  coreById('accuracy') && coreById('accuracy').path === 'cores/bsnes_mercury_accuracy_libretro.js');
check('catalog performance path is the performance core',
  coreById('performance') && coreById('performance').path === 'cores/bsnes_mercury_performance_libretro.js');
check('all three cores have DISTINCT export names',
  new Set(CORE_CATALOG.map((c) => c.exportName)).size === 3);
check('DEFAULT_CORE_PATHS now defaults to snes9x (real-time)',
  Array.isArray(DEFAULT_CORE_PATHS) && DEFAULT_CORE_PATHS[0] === 'cores/snes9x_libretro.js');

// engine.setCore() maps to a setCore worker message (core swap over the boundary).
check('engine.setCore is a function', typeof engine.setCore === 'function');
worker.__clear();
const switchResult = await engine.setCore('cores/bsnes_mercury_performance_libretro.js');
check('setCore resolves a dispatched command (does not throw)', switchResult && switchResult.ok === true);
const sc = worker.__last('setCore');
check('setCore posts a setCore message with the selected core path',
  sc && sc.msg.corePath === 'cores/bsnes_mercury_performance_libretro.js');
check('setCore updates the mirrored activeCoreId', engine.activeCoreId === 'performance');
check('setCore did not introduce a file picker', document.querySelectorAll('input[type="file"]').length === 0);

// --- Report ---
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
