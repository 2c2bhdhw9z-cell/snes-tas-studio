// tools/studio-dom.test.mjs
// Headless DOM smoke test for the FEAT-002 TAS Studio UI using jsdom. jsdom does not
// execute <script type=module>, so we load index.html for its markup, then drive the
// engine + TASStudio + memory-watch modules directly (same approach as engine-smoke.mjs).
//
// Asserts:
//   - piano-roll grid renders rows-per-frame with A/B/X/Y/L/R/D-Pad/Start/Select columns
//   - clicking a cell toggles it (class + aria-pressed)
//   - toolbar has frame-advance, play/pause, speed slider (min=0.1 max=2), fast-forward
//   - HUD renders X / Y / speed / frame fields (placeholders acceptable without a ROM)
// Run from tools/: node studio-dom.test.mjs   (requires jsdom installed here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

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
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// Load engine singleton, then studio + HUD; wire them like the bootstrap would.
const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;

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

// --- Clicking a cell toggles it ---
const targetCell = document.querySelector('#piano-roll .pr-cell--btn[data-frame="3"][data-col="A"]');
check('target cell exists (frame 3, A)', targetCell);
const before = targetCell.classList.contains('pr-cell--on');
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const after = targetCell.classList.contains('pr-cell--on');
check('clicking cell toggles class', before === false && after === true);
check('clicking cell sets aria-pressed', targetCell.getAttribute('aria-pressed') === 'true');
check('toggle recorded in input log', studio.log.isSet(3, 'A'));
// Click again to toggle off.
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('second click toggles off', !targetCell.classList.contains('pr-cell--on') && !studio.log.isSet(3, 'A'));

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

// Speed slider drives engine.setSpeed (clamped).
speed.value = '1.5';
speed.dispatchEvent(new window.Event('input', { bubbles: true }));
check('speed slider updates engine.speed', Math.abs(engine.speed - 1.5) < 1e-6);

// --- HUD fields ---
const hud = document.getElementById('hud');
const keys = Array.from(hud.querySelectorAll('.hud__value')).map((v) => v.dataset.key);
for (const k of ['frame', 'marioX', 'marioY', 'speedX']) {
  check(`HUD field ${k} rendered`, keys.includes(k));
}
// Without a core/ROM, emulation-dependent fields show placeholder dashes.
const marioXVal = hud.querySelector('[data-key="marioX"]').textContent;
check('HUD shows placeholder without ROM', marioXVal === '--');

// --- Save-state tree renders a node after Save ---
document.getElementById('btn-savestate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('save-state tree shows a node', document.querySelector('#savestate-tree .savestate-node'));

// --- Core selection dropdown ---
// The dropdown lives in the frame-controls toolbar. index.html ships static options and
// app.js repopulates them from CORE_CATALOG; here we assert the markup + catalog + engine
// API that make the live core swap work. (jsdom does not run app.js, so we assert the
// pieces app.js relies on rather than the change handler itself.)
const coreSelect = document.getElementById('core-select');
check('core-select dropdown exists', !!coreSelect);
check('core-select is a <select>', coreSelect && coreSelect.tagName === 'SELECT');
const coreOptionValues = coreSelect
  ? Array.from(coreSelect.querySelectorAll('option')).map((o) => o.value)
  : [];
check('core-select has an Accuracy option', coreOptionValues.includes('accuracy'));
check('core-select has a Performance option', coreOptionValues.includes('performance'));
check('core-select is NOT a file/ROM picker', coreSelect && coreSelect.tagName !== 'INPUT');
check('no file input introduced anywhere', document.querySelectorAll('input[type="file"]').length === 0);

// Core catalog + resolver from core-loader.
const loaderMod = await import('../core/core-loader.js');
const { CORE_CATALOG, coreById, DEFAULT_CORE_PATHS } = loaderMod;
check('CORE_CATALOG has two cores', Array.isArray(CORE_CATALOG) && CORE_CATALOG.length === 2);
check(
  'catalog accuracy path is the accuracy core',
  coreById('accuracy') && coreById('accuracy').path === 'cores/bsnes_mercury_accuracy_libretro.js'
);
check(
  'catalog performance path is the performance core',
  coreById('performance') && coreById('performance').path === 'cores/bsnes_mercury_performance_libretro.js'
);
check(
  'accuracy and performance have DISTINCT export names',
  coreById('accuracy').exportName !== coreById('performance').exportName
);
check(
  'DEFAULT_CORE_PATHS still defaults to accuracy',
  Array.isArray(DEFAULT_CORE_PATHS) && DEFAULT_CORE_PATHS[0] === 'cores/bsnes_mercury_accuracy_libretro.js'
);

// Engine exposes a setCore() API for the dropdown to call. Without a core present it must
// degrade gracefully (resolve to a not-ok result, never throw).
check('engine.setCore is a function', typeof engine.setCore === 'function');
const switchResult = await engine.setCore('cores/bsnes_mercury_performance_libretro.js');
check('setCore resolves without throwing (graceful when core absent)', switchResult && switchResult.ok === false);
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
