// tools/studio-dom.test.mjs
//
// Headless DOM test for the TAS Studio UI (SINGLE-THREAD architecture) using jsdom + a fake
// requestAnimationFrame + a MOCK libretro core. jsdom does not execute <script type=module>,
// so we load index.html for its markup, then drive the REAL single-thread engine + TASStudio +
// memory-watch modules directly.
//
// THE GREAT REVERSAL (FEAT-002/003): the emulator runs SINGLE-THREADED on the main thread in
// tas-engine.js's own rAF loop -- there is NO Web Worker. This test wires the REAL engine to
// its REAL EmuCoreRunner + REAL InputResolver backed by a MOCK core (no WASM), so the REAL
// piano-roll/memory-watch logic runs against the real in-process engine. It asserts:
//   - piano-roll grid renders rows-per-frame with the SNES button columns
//   - clicking a cell toggles it (class + aria-pressed), updates the LOCAL MIRROR, AND applies
//     an {op:'setFrameButton'} edit to the engine's IN-PROCESS authoritative InputLog
//   - toolbar has frame-advance / play-pause / speed slider (0.1-2) / fast-forward and they
//     drive the engine directly (setSpeed clamps; frame-advance runs exactly one)
//   - HUD renders from the engine's READ-ONLY memory view (verified SMB1 addresses)
//   - save/load: save produces a state node; load restores + fires onStateLoaded so the log
//     truncates (re-record); no memory-write path
//   - core-select maps to setCore (in-process teardown+reinit); four cores incl. snes9x
//     default; no file picker
//   - the engine created NO worker (single-thread)
//   - the BLINDFOLD (no-present) diagnostic: the #blindfold-toggle checkbox exists in
//     #frame-controls, is DEFAULT OFF, and flipping engine.setBlindfold() at runtime stops ALL
//     per-frame GPU work (zero texSubImage2D/drawArrays) while retro_run keeps advancing, with
//     the status snapshot's videoPath suffix + Present field reflecting the active mode
//
// Run from tools/: node studio-dom.test.mjs   (requires jsdom installed here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  installFakeRaf,
  installEngineMockRunner,
  makeGLCanvas,
  SMB1_HUD_ADDR,
} from './single-thread-harness.mjs';

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
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// A CONTROLLABLE matchMedia for '(orientation: landscape)'. jsdom's own matchMedia always
// reports matches:false and never fires 'change', so without this the ORIENTATION-dependent
// half of the TAS Grid drawer (overlay-only inert/aria-hidden + focus moves, and the
// rotate-while-open reset) could not be exercised at all. Installed BEFORE TASStudio.init() so
// wireTasGridDrawer() subscribes to this one.
const mediaState = { landscape: false, listeners: new Set() };
window.matchMedia = (query) => {
  const orientationQuery = /orientation:\s*landscape/.test(String(query));
  return {
    media: String(query),
    get matches() {
      return orientationQuery ? mediaState.landscape : false;
    },
    addEventListener: (type, fn) => {
      if (type === 'change') mediaState.listeners.add(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'change') mediaState.listeners.delete(fn);
    },
    addListener: (fn) => mediaState.listeners.add(fn),
    removeListener: (fn) => mediaState.listeners.delete(fn),
    dispatchEvent: () => true,
  };
};
/** Flip the reported orientation and notify subscribers, exactly as a real rotation would. */
function setOrientation(landscape) {
  mediaState.landscape = !!landscape;
  const ev = { matches: mediaState.landscape, media: '(orientation: landscape)' };
  for (const fn of Array.from(mediaState.listeners)) fn(ev);
}

// Install the CONTROLLABLE fake rAF (on globalThis AND window) BEFORE importing the engine.
const fake = installFakeRaf();

// Load the engine singleton (single-thread), then studio + HUD; wire them like the bootstrap.
const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;

// Wire the engine's internal runner to a MOCK core (real EmuCoreRunner, no WASM) BEFORE init.
// Use a WebGL-capable canvas so the engine builds a real GLPresenter on the main thread.
const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
const glCanvas = makeGLCanvas({ gpu });
const shared = installEngineMockRunner(engine);

// jsdom's #screen canvas has no WebGL; use our GL canvas object for the presenter, but keep
// the DOM canvas element in the tree for layout. attach() only needs a getContext-capable obj.
engine.attach({ canvas: glCanvas, noticeEl: document.getElementById('notice') });
check('engine created NO worker on attach (single-thread)', typeof engine.worker === 'undefined' && typeof globalThis.Worker === 'undefined');
check('engine presents on a MAIN-thread path (videoPath main-*)', /^main-/.test(engine.videoPath));

// Boot the in-process runner (auto-plays), then pause so our clicks are deterministic.
await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
engine.pause();
fake.stepRaf(2);

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

// --- Clicking a cell toggles it AND applies an inputEdit to the engine's in-process log ---
const targetCell = document.querySelector('#piano-roll .pr-cell--btn[data-frame="3"][data-col="A"]');
check('target cell exists (frame 3, A)', targetCell);
const before = targetCell.classList.contains('pr-cell--on');
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const after = targetCell.classList.contains('pr-cell--on');
check('clicking cell toggles class', before === false && after === true);
check('clicking cell sets aria-pressed', targetCell.getAttribute('aria-pressed') === 'true');
check('toggle recorded in LOCAL MIRROR input log', studio.log.isSet(3, 'A'));
// The engine's IN-PROCESS authoritative resolver now reflects the scripted A on frame 3.
check('cell toggle applied to the engine in-process InputLog (frame 3 A set)',
  engine._resolver.getFrameInputMask(3, 0) === (1 << 8) >>> 0);
// Click again to toggle off.
targetCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('second click toggles off', !targetCell.classList.contains('pr-cell--on') && !studio.log.isSet(3, 'A'));
check('second toggle cleared the in-process log (frame 3 A cleared)',
  engine._resolver.getFrameInputMask(3, 0) === 0);

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
check('frame counter exists', document.getElementById('frame-counter'));
check('#fps-readout exists in the toolbar', document.getElementById('fps-readout'));
check('#fps-readout is inside #frame-controls', (() => {
  const fc = document.getElementById('frame-controls');
  const fps = document.getElementById('fps-readout');
  return fc && fps && fc.contains(fps);
})());
check('#fps-readout initial text is a plain FPS label', /FPS:\s*0/.test((document.getElementById('fps-readout') || {}).textContent || ''));

// --- BLINDFOLD (no-present) diagnostic control + engine API ---
// The on-screen toggle lets a phone-held user run the blindfold test (rAF loop + retro_run +
// decode + HUD + FPS as normal, but NO per-frame GPU upload/draw) without a reload. It must be
// present in the toolbar, DEFAULT OFF (so a fresh load behaves exactly as before), and it must
// be a checkbox — never a file picker.
{
  const box = document.getElementById('blindfold-toggle');
  const fc = document.getElementById('frame-controls');
  check('#blindfold-toggle control exists', !!box);
  check('#blindfold-toggle is a checkbox (not a file/ROM picker)', box && box.tagName === 'INPUT' && box.type === 'checkbox');
  check('#blindfold-toggle lives inside #frame-controls (near the frame controls)', !!(fc && box && fc.contains(box)));
  check('#blindfold-toggle is UNCHECKED by default (blindfold OFF on a fresh load)', box && box.checked === false);
  const group = document.getElementById('blindfold-group');
  check('blindfold control is labelled "Blindfold (no present)"', !!group && /Blindfold \(no present\)/.test(group.textContent || ''));
  check('blindfold label is wired to the checkbox (for=blindfold-toggle)', !!group && group.getAttribute('for') === 'blindfold-toggle');
}
check('engine exposes setBlindfold()/isBlindfold()', typeof engine.setBlindfold === 'function' && typeof engine.isBlindfold === 'function');
check('engine blindfold defaults OFF (no ?blindfold URL param)', engine.isBlindfold() === false);
check('status snapshot reports Present: ON and a suffix-free videoPath by default',
  engine.statusSnapshot().present === 'ON' && !/BLINDFOLD/.test(engine.statusSnapshot().videoPath));
{
  // Runtime flip: the banner surface must make the active mode unmistakable, and the per-frame
  // GPU work must stop while the engine keeps running.
  engine.setBlindfold(true);
  const snap = engine.statusSnapshot();
  check('blindfold ON: snapshot videoPath is suffixed "(BLINDFOLD: no present)"', /\(BLINDFOLD: no present\)$/.test(snap.videoPath));
  check('blindfold ON: snapshot present field reads OFF (BLINDFOLD)', snap.present === 'OFF (BLINDFOLD)');
  check('blindfold ON: videoPathBase still reports the REAL present path', /^main-/.test(snap.videoPathBase));
  // Drive the real loop and prove zero GPU calls, then flip back off.
  engine.play();
  gpu.texSubImage2D = 0;
  gpu.texImage2D = 0;
  gpu.drawArrays = 0;
  shared.resolvedPerFrame.length = 0;
  fake.stepRaf(20);
  check('blindfold ON: ZERO GL uploads/draws over 20 rAF turns', gpu.texSubImage2D === 0 && gpu.texImage2D === 0 && gpu.drawArrays === 0);
  check('blindfold ON: emulation still advanced (retro_run kept running)', shared.resolvedPerFrame.length >= 12);
  engine.setBlindfold(false);
  check('blindfold OFF again: snapshot present field back to ON', engine.statusSnapshot().present === 'ON');
  gpu.drawArrays = 0;
  fake.stepRaf(10);
  check('blindfold OFF again: presenting resumed (draws > 0, still <= turns)', gpu.drawArrays > 0 && gpu.drawArrays <= 10);
  engine.pause();
  fake.stepRaf(2);
}

// Speed slider drives engine.setSpeed (clamped) directly.
speed.value = '1.5';
speed.dispatchEvent(new window.Event('input', { bubbles: true }));
check('speed slider updates engine.speed', Math.abs(engine.speed - 1.5) < 1e-6);
check('speed slider drives the runner speed', Math.abs(shared.runner.speed - 1.5) < 1e-6);
engine.setSpeed(1);

// Frame-advance button runs EXACTLY one retro_run through the in-process runner.
engine.pause();
fake.stepRaf(2);
shared.resolvedPerFrame.length = 0;
const frameBefore = shared.runner.currentFrame;
document.getElementById('btn-frame-advance').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Frame +1 runs exactly one retro_run in-process', shared.resolvedPerFrame.length === 1 && shared.runner.currentFrame === frameBefore + 1);

// --- HUD renders from the engine's READ-ONLY memory view (verified SMB1 addresses) ---
const hud = document.getElementById('hud');
const keys = Array.from(hud.querySelectorAll('.hud__value')).map((v) => v.dataset.key);
for (const k of ['frame', 'marioX', 'marioY', 'speedX']) {
  check(`HUD field ${k} rendered`, keys.includes(k));
}
// Seed the mock core WRAM with DISTINCT bytes at each verified SMB1 address so a transpose bug
// (X page 0x0043 vs X sub-pixel 0x0401) is caught. memory-watch reads:
//   marioX = readU8(0x0043)*256 + readU8(0x0042), sub = readU8(0x0401)
//   marioY = readU8(0x0002),                      sub = readU8(0x041c)
//   speedX = signed readU8(0x005d)
// So with page(0x0043)=0x80, pixel(0x0042)=0x30, sub(0x0401)=0x02: marioX = 0x80*256+0x30 =
// 32816, sub = 002; Y hi(0x0002)=0xb0=176, Y sub(0x041c)=0x40=064; H-Speed(0x005d)=0xf0=-16.
{
  const M = shared.module;
  const base = M.WRAM_PTR;
  M.HEAPU8[base + SMB1_HUD_ADDR.H_SPEED] = 0xf0; // -16
  M.HEAPU8[base + SMB1_HUD_ADDR.X_HI] = 0x30; // X pixel 0x0042
  M.HEAPU8[base + SMB1_HUD_ADDR.X_SUB] = 0x80; // X PAGE 0x0043
  M.HEAPU8[base + SMB1_HUD_ADDR.X_PAGE] = 0x02; // X SUB-PIXEL 0x0401
  M.HEAPU8[base + SMB1_HUD_ADDR.Y_HI] = 0xb0; // Y pixel 0x0002
  M.HEAPU8[base + SMB1_HUD_ADDR.Y_SUB] = 0x40; // Y SUB-PIXEL 0x041c
}
watch.update();
check('HUD X renders page(0x0043)*256+pixel(0x0042) . sub(0x0401)', hud.querySelector('[data-key="marioX"]').textContent === '32816.002');
check('HUD Y renders from WRAM (hi . sub)', hud.querySelector('[data-key="marioY"]').textContent === '176.064');
check('HUD H-Speed renders the signed value', hud.querySelector('[data-key="speedX"]').textContent === '-16');
// Read-only: the engine memory view exposes no writer.
{
  const mem = engine.getMemoryView();
  check('engine memory view is READ-ONLY (no writer)', mem && ['writeU8', 'poke', 'set', 'inject'].every((k) => typeof mem[k] === 'undefined'));
}

// --- DOM-REUSE PROOF: the per-frame HUD update MUTATES cached nodes in place ---
{
  const marioXNodeBefore = hud.querySelector('[data-key="marioX"]');
  const rowsBefore = hud.querySelectorAll('.hud__row').length;
  for (let i = 0; i < 60; i++) watch.update();
  const marioXNodeAfter = hud.querySelector('[data-key="marioX"]');
  check('HUD update reuses the SAME value node (no per-frame createElement/innerHTML)', marioXNodeBefore === marioXNodeAfter);
  check('HUD update does not append rows over time (no unbounded DOM growth)', hud.querySelectorAll('.hud__row').length === rowsBefore);
  // A CHANGED value updates the SAME node in place (mutation, not replacement).
  const M = shared.module;
  const base = M.WRAM_PTR;
  M.HEAPU8[base + SMB1_HUD_ADDR.X_HI] = 0x31; // pixel -> 0x31
  M.HEAPU8[base + SMB1_HUD_ADDR.X_SUB] = 0x80; // page stays 0x80
  M.HEAPU8[base + SMB1_HUD_ADDR.X_PAGE] = 0x03; // sub -> 0x03
  watch.update();
  check('HUD value change mutates the cached node in place', hud.querySelector('[data-key="marioX"]') === marioXNodeBefore);
  check('HUD value change is reflected (in-place textContent update)', hud.querySelector('[data-key="marioX"]').textContent === '32817.003');
}

// --- Save-state tree renders a node after Save; save serializes in-process ---
document.getElementById('btn-savestate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('save-state tree shows a node', document.querySelector('#savestate-tree .savestate-node'));
// Save is async (engine.saveState returns a Promise); let it settle.
await new Promise((r) => setTimeout(r, 0));

// --- Load path: restore + onStateLoaded truncates the mirror log (re-record) ---
// Script some input past the saved frame first (frame 0 is the saved node's frame).
studio.log.set(5, 'B', true);
const saveNodeBtn = document.querySelector('#savestate-tree .savestate-node');
saveNodeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 0));
check('load truncates the mirror log after the loaded frame (re-record)', !studio.log.isSet(5, 'B'));
check('load truncates the engine in-process log after the loaded frame',
  engine._resolver.getFrameInputMask(5, 0) === 0);

// =========================================================================================
// --- THE LANDSCAPE "TAS GRID" DRAWER ---
//
// In landscape the piano roll was the LAST item in the single scrolling #sidebar column, so on a
// short phone viewport the toolbar + Live HUD + save-state tree consumed the whole visible height
// and the timeline sat far below the fold. It is now a slide-out fixed overlay driven by
// #btn-tas-grid.
//
// THE CRITICAL CONSTRAINT is DOM PRESERVATION: the roll is virtualized (a fixed pool of 240
// recycled rows with cached row/cell refs, and offsetHeight/clientHeight reads that drive the
// spacers + scroll-following), so hiding it must NOT unmount it, re-parent it or display:none it.
// Hiding is a CSS transform; these checks prove the node identity, the descendant element count,
// the recycled row pool, the cached cell refs AND the per-frame frame-tracker all survive
// arbitrary toggling. (The CSS side of that proof - transform-based hiding, no display:none rule
// anywhere, the reduced-motion branch, the portrait pass-through - lives in mobile-smoke.)
// =========================================================================================
{
  const drawer = document.getElementById('tas-grid-drawer');
  const toggle = document.getElementById('btn-tas-grid');
  const closeBtn = document.getElementById('btn-tas-grid-close');
  const backdrop = document.getElementById('tas-grid-backdrop');
  const roll = document.getElementById('piano-roll');

  // -- structure + a11y contract -----------------------------------------------------------
  check('#tas-grid-drawer wrapper exists in the STATIC markup', !!drawer);
  check('#piano-roll is parented INSIDE the drawer (once, at parse time)', !!roll && roll.parentElement === drawer);
  check('the drawer still lives inside #sidebar (so portrait keeps the roll in the stacked flow)',
    !!drawer && document.getElementById('sidebar').contains(drawer));
  check('#btn-tas-grid is a real <button type="button">',
    !!toggle && toggle.tagName === 'BUTTON' && toggle.type === 'button');
  check('#btn-tas-grid is labelled "TAS Grid"', !!toggle && /TAS Grid/.test(toggle.textContent || ''));
  check('#btn-tas-grid has aria-controls pointing at the drawer',
    !!toggle && toggle.getAttribute('aria-controls') === 'tas-grid-drawer');
  check('#btn-tas-grid starts collapsed (aria-expanded="false")',
    !!toggle && toggle.getAttribute('aria-expanded') === 'false');
  check('#btn-tas-grid is NOT inside #debug-banner (app.js rewrites the banner children)',
    !!toggle && !document.getElementById('debug-banner').contains(toggle));
  check('#btn-tas-grid-close is a real <button type="button"> with an accessible label',
    !!closeBtn && closeBtn.tagName === 'BUTTON' && closeBtn.type === 'button' &&
      !!(closeBtn.getAttribute('aria-label') || '').trim());
  check('the ✕ close button lives inside the drawer', !!closeBtn && drawer.contains(closeBtn));
  check('#tas-grid-backdrop exists (tap-outside-to-dismiss target)', !!backdrop);
  check('TASStudio exposes the PUBLIC re-measure hooks refreshLayout()/onDrawerShown()',
    typeof studio.refreshLayout === 'function' && typeof studio.onDrawerShown === 'function');
  check('the drawer starts CLOSED (class + data-open + state)',
    studio.isTasGridOpen() === false && drawer.dataset.open === 'false' && !drawer.classList.contains('is-open'));

  // -- toggling flips aria-expanded AND an open class/attribute -----------------------------
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('toggle click OPENS: is-open class + data-open="true" + aria-expanded="true"',
    studio.isTasGridOpen() === true && drawer.classList.contains('is-open') &&
      drawer.dataset.open === 'true' && toggle.getAttribute('aria-expanded') === 'true');
  check('opening marks the backdrop visible (.is-open)', backdrop.classList.contains('is-open'));
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('toggle click again CLOSES it (open -> close on the same button)',
    studio.isTasGridOpen() === false && !drawer.classList.contains('is-open') &&
      drawer.dataset.open === 'false' && toggle.getAttribute('aria-expanded') === 'false');
  check('closing clears the backdrop', !backdrop.classList.contains('is-open'));

  // -- every dismissal path keeps aria-expanded in sync ------------------------------------
  studio.openTasGrid();
  check('openTasGrid() opens programmatically', studio.isTasGridOpen() === true && toggle.getAttribute('aria-expanded') === 'true');
  closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('the ✕ close button dismisses (aria-expanded back to false)',
    studio.isTasGridOpen() === false && toggle.getAttribute('aria-expanded') === 'false');

  studio.openTasGrid();
  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('tap-outside (backdrop click) dismisses',
    studio.isTasGridOpen() === false && toggle.getAttribute('aria-expanded') === 'false' &&
      !backdrop.classList.contains('is-open'));

  studio.openTasGrid();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape dismisses',
    studio.isTasGridOpen() === false && toggle.getAttribute('aria-expanded') === 'false');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape while already closed is a harmless no-op',
    studio.isTasGridOpen() === false && toggle.getAttribute('aria-expanded') === 'false');

  // -- the open path re-measures + re-syncs through the PUBLIC hook -------------------------
  let refreshCalls = 0;
  const rawRefresh = studio.refreshLayout.bind(studio);
  studio.refreshLayout = function refreshLayoutSpy(...args) {
    refreshCalls += 1;
    return rawRefresh(...args);
  };
  let measureCalls = 0;
  const rawMeasure = studio._measureMetrics.bind(studio);
  studio._measureMetrics = function measureMetricsSpy(...args) {
    measureCalls += 1;
    return rawMeasure(...args);
  };
  {
    const before = refreshCalls;
    studio.openTasGrid();
    check('opening the drawer runs the PUBLIC re-measure hook exactly once', refreshCalls === before + 1);
    check('the open-time refresh re-MEASURES the grid geometry (_measureMetrics)', measureCalls >= 1);
    studio.closeTasGrid();
  }
  delete studio._measureMetrics;

  // -- DOM PRESERVATION across many toggles ------------------------------------------------
  const rollNode = roll;
  const elementsBefore = roll.getElementsByTagName('*').length;
  const poolBefore = studio._rows;
  const firstRowBefore = studio._rows[0];
  const firstCellsBefore = firstRowBefore.__cells;
  const rawCreateElement = document.createElement.bind(document);
  let createCalls = 0;
  document.createElement = function createElementSpy(tag, opts) {
    createCalls += 1;
    return rawCreateElement(tag, opts);
  };
  for (let i = 0; i < 4; i++) {
    studio.openTasGrid();
    studio.closeTasGrid();
  }
  document.createElement = rawCreateElement;
  check('closed->open->closed x4: #piano-roll is the SAME node (never unmounted or rebuilt)',
    document.getElementById('piano-roll') === rollNode);
  check('closed->open->closed x4: #piano-roll was never re-parented (same drawer parent)',
    rollNode.parentElement === drawer);
  check('closed->open->closed x4: descendant element COUNT is unchanged',
    roll.getElementsByTagName('*').length === elementsBefore);
  check('closed->open->closed x4: ZERO createElement calls (nothing rebuilt)', createCalls === 0);
  check('closed->open->closed x4: the recycled row pool is the same object identity',
    studio._rows === poolBefore && studio._rows[0] === firstRowBefore);
  check('closed->open->closed x4: cached row/cell refs survive (row.__cells / row.__frameCell)',
    firstRowBefore.__cells === firstCellsBefore && firstCellsBefore.length === 12 && !!firstRowBefore.__frameCell);
  check('closed->open->closed x4: the drawer never got an inline display style',
    !/display/.test(drawer.getAttribute('style') || '') && !/display/.test(rollNode.getAttribute('style') || ''));

  // -- the FRAME TRACKER keeps working while the drawer is CLOSED --------------------------
  // This is the payoff of transform-based hiding: the row pool and its cached refs are live, so
  // the O(1) per-frame highlight keeps tracking the playhead even when nothing is on screen.
  check('drawer is CLOSED for the frame-tracker check', studio.isTasGridOpen() === false);
  {
    const frameBefore = engine.currentFrame;
    let creates = 0;
    document.createElement = function createElementSpy2(tag, opts) {
      creates += 1;
      return rawCreateElement(tag, opts);
    };
    for (let i = 0; i < 5; i++) {
      const r = engine.frameAdvance();
      if (r && typeof r.then === 'function') await r;
    }
    document.createElement = rawCreateElement;
    check('closed drawer: the engine still advanced 5 frames', engine.currentFrame === frameBefore + 5);
    check('closed drawer: the current-frame highlight MOVED with the engine',
      studio._currentRow === engine.currentFrame && studio._currentRow === frameBefore + 5);
    check('closed drawer: the highlight is on the CACHED row for the live frame',
      !!studio._currentRowEl && studio._currentRowEl.__frame === engine.currentFrame &&
        studio._currentRowEl.classList.contains('pr-row--current'));
    check('closed drawer: exactly ONE row carries the highlight',
      document.querySelectorAll('#piano-roll .pr-row--current').length === 1);
    check('closed drawer: the frame path still created ZERO elements', creates === 0);
    check('closed drawer: the element count is STILL unchanged',
      roll.getElementsByTagName('*').length === elementsBefore);
  }

  // -- and it keeps tracking after REOPENING ----------------------------------------------
  {
    const before = refreshCalls;
    studio.openTasGrid();
    check('reopening runs the re-measure hook again', refreshCalls === before + 1);
    const frameBefore = engine.currentFrame;
    for (let i = 0; i < 3; i++) {
      const r = engine.frameAdvance();
      if (r && typeof r.then === 'function') await r;
    }
    check('reopened drawer: the highlight tracks the live frame again',
      studio._currentRow === engine.currentFrame && engine.currentFrame === frameBefore + 3 &&
        studio._currentRowEl.__frame === engine.currentFrame);
    check('reopened drawer: still the SAME node and element count',
      document.getElementById('piano-roll') === rollNode && roll.getElementsByTagName('*').length === elementsBefore);
    studio.closeTasGrid();
  }

  // -- cell clicks still edit the log while the drawer is OPEN ----------------------------
  {
    studio.openTasGrid();
    const frame = engine.currentFrame + 4;
    const cell = document.querySelector(`#piano-roll .pr-cell--btn[data-frame="${frame}"][data-col="X"]`);
    check('open drawer: a windowed cell is still addressable', !!cell);
    cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('open drawer: clicking a cell still toggles the local mirror log', studio.log.isSet(frame, 'X'));
    check('open drawer: the edit still reached the engine in-process log (X = bit 9)',
      engine._resolver.getFrameInputMask(frame, 0) === ((1 << 9) >>> 0));
    cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('open drawer: a second click clears it everywhere',
      !studio.log.isSet(frame, 'X') && engine._resolver.getFrameInputMask(frame, 0) === 0);
    studio.closeTasGrid();
  }

  // -- ORIENTATION: overlay-only a11y state, and a rotate-while-open reset -----------------
  setOrientation(true); // now landscape: the drawer IS an overlay
  check('landscape + closed: the panel is marked inert + aria-hidden (layout metrics untouched)',
    drawer.getAttribute('aria-hidden') === 'true' && drawer.inert === true);
  studio.openTasGrid();
  check('landscape + open: aria-hidden/inert are cleared',
    !drawer.hasAttribute('aria-hidden') && drawer.inert === false);
  check('landscape + open: focus moves into the panel (the ✕)', document.activeElement === closeBtn);
  check('landscape + open: metrics reads are unaffected by hiding (offsetHeight is not forced to 0 by a display:none)',
    typeof rollNode.offsetHeight === 'number');
  setOrientation(false); // ROTATE TO PORTRAIT WHILE OPEN
  check('rotating to portrait RESETS the drawer to closed (no stuck fixed overlay)',
    studio.isTasGridOpen() === false && !drawer.classList.contains('is-open') && drawer.dataset.open === 'false');
  check('rotating to portrait keeps aria-expanded honest', toggle.getAttribute('aria-expanded') === 'false');
  check('portrait: the INLINE timeline is never inert/aria-hidden',
    !drawer.hasAttribute('aria-hidden') && drawer.inert === false);
  check('portrait: #piano-roll is still the same node in the same parent (no re-parenting on rotate)',
    document.getElementById('piano-roll') === rollNode && rollNode.parentElement === drawer);
  check('portrait: element count still unchanged after a rotation',
    roll.getElementsByTagName('*').length === elementsBefore);
  setOrientation(true);
  check('rotating back to landscape leaves it CLOSED (no surprise reopen)', studio.isTasGridOpen() === false);
  setOrientation(false);

  // -- teardown removes the listeners the drawer added -------------------------------------
  {
    const refreshAtDestroy = refreshCalls;
    check('TASStudio exposes destroy()', typeof studio.destroy === 'function');
    studio.destroy();
    setOrientation(true);
    setOrientation(false);
    check('destroy() removed the orientation-change listener (no further refreshes)',
      refreshCalls === refreshAtDestroy);
    studio.openTasGrid();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('destroy() removed the Escape handler too', studio.isTasGridOpen() === true);
    studio.closeTasGrid();
    check('the timeline node SURVIVED teardown untouched',
      document.getElementById('piano-roll') === rollNode && roll.getElementsByTagName('*').length === elementsBefore);
  }
}

// --- Core selection dropdown maps to setCore (in-process teardown + reinit) ---
const coreSelect = document.getElementById('core-select');
check('core-select dropdown exists', !!coreSelect);
check('core-select is a <select>', coreSelect && coreSelect.tagName === 'SELECT');
const coreOptionValues = coreSelect
  ? Array.from(coreSelect.querySelectorAll('option')).map((o) => o.value)
  : [];
check('core-select has a Real-Time (snes9x) option', coreOptionValues.includes('realtime'));
check('core-select has an Accuracy option', coreOptionValues.includes('accuracy'));
check('core-select has a Balanced option', coreOptionValues.includes('balanced'));
check('core-select has a Performance option', coreOptionValues.includes('performance'));
check('Real-Time (snes9x) is the first/default option', coreOptionValues[0] === 'realtime');
check('core-select is NOT a file/ROM picker', coreSelect && coreSelect.tagName !== 'INPUT');
check('no file input introduced anywhere', document.querySelectorAll('input[type="file"]').length === 0);

// Core catalog + resolver from core-loader.
const loaderMod = await import('../core/core-loader.js');
const { CORE_CATALOG, coreById, DEFAULT_CORE_PATHS } = loaderMod;
check('CORE_CATALOG has four cores', Array.isArray(CORE_CATALOG) && CORE_CATALOG.length === 4);
check('catalog realtime path is the snes9x core',
  coreById('realtime') && coreById('realtime').path === 'cores/snes9x_libretro.js');
check('catalog realtime is the FIRST catalog entry (default-selected)',
  CORE_CATALOG[0] && CORE_CATALOG[0].id === 'realtime');
check('catalog accuracy path is the accuracy core',
  coreById('accuracy') && coreById('accuracy').path === 'cores/bsnes_mercury_accuracy_libretro.js');
check('catalog balanced path is the balanced core',
  coreById('balanced') && coreById('balanced').path === 'cores/bsnes_mercury_balanced_libretro.js');
check('catalog performance path is the performance core',
  coreById('performance') && coreById('performance').path === 'cores/bsnes_mercury_performance_libretro.js');
check('all four cores have DISTINCT export names',
  new Set(CORE_CATALOG.map((c) => c.exportName)).size === 4);
check('DEFAULT_CORE_PATHS now defaults to snes9x (real-time)',
  Array.isArray(DEFAULT_CORE_PATHS) && DEFAULT_CORE_PATHS[0] === 'cores/snes9x_libretro.js');

// engine.setCore() tears the runner down and re-inits in-process (core swap on the main thread).
check('engine.setCore is a function', typeof engine.setCore === 'function');
installEngineMockRunner(engine, 'cores/bsnes_mercury_performance_libretro.js');
const switchResult = await engine.setCore('cores/bsnes_mercury_performance_libretro.js');
check('setCore re-inits in-process (does not throw)', switchResult && switchResult.ok === true);
check('setCore updates the mirrored activeCoreId', engine.activeCoreId === 'performance');
check('setCore did not introduce a file picker', document.querySelectorAll('input[type="file"]').length === 0);

fake.restore();

// --- Report ---
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
