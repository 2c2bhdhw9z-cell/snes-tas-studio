// tools/pianoroll-perf.test.mjs
//
// THE PER-FRAME-COST REGRESSION PROOF for the TAS Studio piano roll — the harness that would
// have caught the FPS decay (60 -> ~10 in ~30s on device) years of dead ends ago.
//
// WHAT WAS WRONG (measured, not guessed — see the numbers this test prints):
// TASStudio._onEngineFrame(frame) runs on EVERY emulated frame. It used to compute
//     needed = max(MIN_ROWS, log.length, frame + LOOKAHEAD)   // LOOKAHEAD = 60
// and rebuild the WHOLE grid whenever `needed > _renderedRows`. Once frame > 60 that condition
// is TRUE ON EVERY FRAME (needed grows by one per frame), so every single frame did:
//     el.innerHTML = ''                      -> destroy the entire grid
//     13 * (frame + 60) createElement calls  -> rebuild it from scratch
//     querySelectorAll('.pr-cell--btn')      -> re-walk every cell
//     querySelector('.pr-row[data-frame=N]') -> find the current row
//     row.scrollIntoView()                   -> force layout + scroll, 60x/sec
// i.e. a per-frame cost that grows LINEARLY with the frame counter: ~8.6k elements/frame at
// frame 600, ~24k at frame 1800. That is a smooth monotonic framerate decay that never recovers,
// it is core-independent, it survives blindfolding the canvas, and it lives on the UI thread —
// which is exactly every symptom the investigation chased through the worker, the WASM heap,
// transferables, OffscreenCanvas and WebGL.
//
// WHAT THIS TEST ASSERTS (against the REAL TASStudio driven by the REAL single-thread engine +
// the REAL EmuCoreRunner + a MOCK libretro core, advancing past frame 1500):
//   (a) the TOTAL element count under #piano-roll stays BOUNDED — an ABSOLUTE ceiling, not
//       ~13x the frame number;
//   (b) ZERO createElement calls and ZERO full grid rebuilds happen during frame advance, and
//       the count does NOT grow with the frame number (early window vs late window);
//   (c) ZERO querySelector/querySelectorAll calls on the #piano-roll container during frame
//       advance (the container's query methods are spied);
//   (d) scrollIntoView is NEVER called from the per-frame path;
//   plus per-frame element/query/scroll RATES for the early vs late window, so a regression
//   shows up as a growing rate rather than an opaque failure.
//
// It also re-asserts the BEHAVIOUR the fix had to preserve: the button columns, the current-frame
// highlight moving with playback, clicking a cell toggling the shared InputLog, the grid
// reflecting the log after an edit / a state load / a truncateAfter (re-record), and the sticky
// header + sticky frame-index column still rendering.
//
// PRE-FIX BEHAVIOUR: this file FAILS hard against the old piano-roll.js (verified by restoring
// the pre-fix file and running it): the DOM ceiling, the createElement counts, the
// querySelector counts and the scrollIntoView count are all violated by orders of magnitude.
//
// Run from tools/: node pianoroll-perf.test.mjs   (requires jsdom installed here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installFakeRaf, installEngineMockRunner, makeGLCanvas } from './single-thread-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

// Frame targets. The defaults are the real regression test (advance past frame 1500). They are
// env-overridable ONLY so the PRE-FIX proof can be reproduced cheaply: the old code rebuilds the
// whole grid every frame, so it cannot reach frame 1500 in jsdom in any reasonable time. Run
//   PR_PERF_WARMUP=100 PR_PERF_WINDOW=50 PR_PERF_LATE=200 PR_PERF_MIN_REACH=250 \
//     node pianoroll-perf.test.mjs
// against the pre-fix piano-roll.js and every bounded-cost assertion below fails loudly.
const WARMUP_FRAME = Number(process.env.PR_PERF_WARMUP || 200);
const WINDOW_FRAMES = Number(process.env.PR_PERF_WINDOW || 300);
const LATE_FRAME = Number(process.env.PR_PERF_LATE || 1300);
const MIN_REACH = Number(process.env.PR_PERF_MIN_REACH || 1500);

// ---------------------------------------------------------------- jsdom + engine fixture
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

globalThis.window = window;
globalThis.document = document;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// jsdom does not implement scrollIntoView at all, so INSTALL a counting stub: if any code path
// calls it we will see it. (Pre-fix this fires once per emulated frame.)
let scrollIntoViewCalls = 0;
window.Element.prototype.scrollIntoView = function scrollIntoViewSpy() {
  scrollIntoViewCalls += 1;
};

// Count EVERY element creation on this document (the piano roll's rebuild storm shows up here).
let createElementCalls = 0;
const rawCreateElement = document.createElement.bind(document);
document.createElement = function createElementSpy(tag, opts) {
  createElementCalls += 1;
  return rawCreateElement(tag, opts);
};

// Fake rAF + monotonic clock BEFORE importing the engine.
const fake = installFakeRaf();

const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;

const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
const shared = installEngineMockRunner(engine);
engine.attach({ canvas: makeGLCanvas({ gpu }), noticeEl: document.getElementById('notice') });
await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
engine.pause();
fake.stepRaf(2);

const pianoRollEl = document.getElementById('piano-roll');

// SPY on the CONTAINER's query methods: these are precisely the calls the old per-frame path
// made (_refreshCells -> querySelectorAll('.pr-cell--btn'), _highlightCurrentRow ->
// querySelector('.pr-row[data-frame=N]')). Own properties shadow the prototype, so this counts
// every query the studio performs on #piano-roll without disturbing the rest of the document.
let qsCalls = 0;
let qsaCalls = 0;
{
  const rawQs = pianoRollEl.querySelector.bind(pianoRollEl);
  const rawQsa = pianoRollEl.querySelectorAll.bind(pianoRollEl);
  pianoRollEl.querySelector = function querySelectorSpy(sel) {
    qsCalls += 1;
    return rawQs(sel);
  };
  pianoRollEl.querySelectorAll = function querySelectorAllSpy(sel) {
    qsaCalls += 1;
    return rawQsa(sel);
  };
}

const { TASStudio } = await import('../piano-roll.js');
const studio = new TASStudio(engine, {
  pianoRoll: pianoRollEl,
  frameControls: document.getElementById('frame-controls'),
  savestateTree: document.getElementById('savestate-tree'),
});

// Count FULL GRID REBUILDS (the O(frame) operation itself). Wrapping the method proves a rebuild
// never happens from the per-frame path, whatever it is named internally.
let gridBuilds = 0;
{
  const rawBuild = studio._buildGrid.bind(studio);
  studio._buildGrid = function buildGridSpy(...args) {
    gridBuilds += 1;
    return rawBuild(...args);
  };
}

studio.init();

// ---------------------------------------------------------------- structure (build-time)
const bodyRows = pianoRollEl.querySelectorAll('.pr-body .pr-row');
const headerCols = Array.from(pianoRollEl.querySelectorAll('.pr-row--header .pr-cell[data-col]')).map(
  (c) => c.dataset.col
);
check('grid built exactly once at init', gridBuilds === 1, `gridBuilds=${gridBuilds}`);
check('piano-roll renders a usable timeline of rows', bodyRows.length >= 100, `rows=${bodyRows.length}`);
check('sticky header row rendered (.pr-row--header)', !!pianoRollEl.querySelector('.pr-row--header'));
check(
  'sticky frame-index column rendered (.pr-cell--frame)',
  pianoRollEl.querySelectorAll('.pr-cell--frame').length >= bodyRows.length
);
for (const col of ['A', 'B', 'X', 'Y', 'L', 'R', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT']) {
  check(`column ${col} present`, headerCols.includes(col));
}

const ELEMENTS_AT_BUILD = pianoRollEl.getElementsByTagName('*').length;

// ================================================================ THE PER-FRAME COST MEASUREMENT
//
// Drive the REAL engine rAF loop and let the REAL TASStudio._onEngineFrame run through
// engine.onFrame for >1500 frames, sampling the counters in an EARLY window and a LATE window.
// If the per-frame cost is O(frame) the late window explodes; if it is O(1) the two match.

function sample() {
  return {
    frame: engine.currentFrame,
    createElement: createElementCalls,
    qs: qsCalls,
    qsa: qsaCalls,
    scrollIntoView: scrollIntoViewCalls,
    builds: gridBuilds,
    elements: pianoRollEl.getElementsByTagName('*').length,
  };
}

/** Step the engine's rAF loop until currentFrame >= target (guarded). */
function advanceTo(target) {
  let guard = 0;
  while (engine.currentFrame < target && guard++ < 20000) {
    if (fake.stepRaf(25) === 0) break;
  }
  return engine.currentFrame;
}

engine.play();
advanceTo(WARMUP_FRAME); // past MIN_ROWS/LOOKAHEAD, i.e. the old code's pathological regime

const early0 = sample();
advanceTo(early0.frame + WINDOW_FRAMES);
const early1 = sample();

advanceTo(LATE_FRAME);
const late0 = sample();
advanceTo(late0.frame + WINDOW_FRAMES);
const late1 = sample();

engine.pause();
fake.stepRaf(2);

const earlyFrames = early1.frame - early0.frame;
const lateFrames = late1.frame - late0.frame;
const earlyCreate = early1.createElement - early0.createElement;
const lateCreate = late1.createElement - late0.createElement;
const earlyQueries = early1.qs + early1.qsa - (early0.qs + early0.qsa);
const lateQueries = late1.qs + late1.qsa - (late0.qs + late0.qsa);
const earlyScroll = early1.scrollIntoView - early0.scrollIntoView;
const lateScroll = late1.scrollIntoView - late0.scrollIntoView;
const builds = late1.builds - early0.builds;

console.log('--- per-frame cost measurement (REAL TASStudio via engine.onFrame) ---');
console.log(`reached frame                     : ${late1.frame}`);
console.log(`elements under #piano-roll @build  : ${ELEMENTS_AT_BUILD}`);
console.log(`elements under #piano-roll @frame ${late1.frame} : ${late1.elements}`);
console.log(
  `EARLY window (frames ${early0.frame}->${early1.frame}, ${earlyFrames} frames): createElement=${earlyCreate} ` +
    `(${(earlyCreate / Math.max(1, earlyFrames)).toFixed(2)}/frame) queries=${earlyQueries} scrollIntoView=${earlyScroll}`
);
console.log(
  `LATE  window (frames ${late0.frame}->${late1.frame}, ${lateFrames} frames): createElement=${lateCreate} ` +
    `(${(lateCreate / Math.max(1, lateFrames)).toFixed(2)}/frame) queries=${lateQueries} scrollIntoView=${lateScroll}`
);
console.log(`full grid rebuilds during frame advance: ${builds}`);
console.log('----------------------------------------------------------------------');

// (0) The measurement itself has to be meaningful.
check(`advanced past frame ${MIN_REACH} (long-session regime)`, late1.frame >= MIN_REACH, `frame=${late1.frame}`);
check('measured a meaningful early window', earlyFrames >= WINDOW_FRAMES * 0.6, `earlyFrames=${earlyFrames}`);
check('measured a meaningful late window', lateFrames >= WINDOW_FRAMES * 0.6, `lateFrames=${lateFrames}`);

// (a) BOUNDED DOM: an ABSOLUTE ceiling on elements under #piano-roll. The pre-fix grid held
// 13 * (frame + 60) elements -> ~20,000 at frame 1500. The windowed grid is constant.
const DOM_CEILING = 4200; // (1 header + 240 rows) * 13 cells + table/body/spacers ~= 3.15k
check(
  `DOM under #piano-roll stays under the hard ceiling (${DOM_CEILING})`,
  late1.elements <= DOM_CEILING,
  `elements=${late1.elements}`
);
check(
  'DOM node count does NOT grow with the frame number (constant vs build time)',
  late1.elements === ELEMENTS_AT_BUILD,
  `build=${ELEMENTS_AT_BUILD} late=${late1.elements}`
);
check(
  'DOM node count is NOT ~13x the frame number (the pre-fix signature)',
  late1.elements < late1.frame * 13 * 0.25,
  `elements=${late1.elements} vs 13*frame=${late1.frame * 13}`
);

// (b) NO element creation and NO full rebuild in the per-frame path, and no growth with frame.
check('ZERO full grid rebuilds during frame advance', builds === 0, `builds=${builds}`);
check('ZERO createElement calls in the early window', earlyCreate === 0, `createElement=${earlyCreate}`);
check('ZERO createElement calls in the late window', lateCreate === 0, `createElement=${lateCreate}`);
check(
  'createElement per frame does NOT grow with the frame number',
  lateCreate <= earlyCreate + 1,
  `early=${earlyCreate} late=${lateCreate}`
);

// (c) ZERO DOM queries on the container during frame advance.
check('ZERO querySelector/querySelectorAll in the early window', earlyQueries === 0, `queries=${earlyQueries}`);
check('ZERO querySelector/querySelectorAll in the late window', lateQueries === 0, `queries=${lateQueries}`);
check(
  'query count per frame does NOT grow with the frame number',
  lateQueries <= earlyQueries,
  `early=${earlyQueries} late=${lateQueries}`
);

// (d) scrollIntoView is not a per-frame operation any more.
check('scrollIntoView is NOT called every frame (early window)', earlyScroll === 0, `calls=${earlyScroll}`);
check('scrollIntoView is NOT called every frame (late window)', lateScroll === 0, `calls=${lateScroll}`);
check(
  'scrollIntoView total stays far below one-per-frame',
  scrollIntoViewCalls < late1.frame / 10,
  `total=${scrollIntoViewCalls} frames=${late1.frame}`
);

// The window RECYCLES rather than grows: the row pool is the same element objects it started with.
check(
  'row elements are RECYCLED (same pool object identity after 1500+ frames)',
  studio._rows.length === bodyRows.length && studio._rows[0] === bodyRows[0],
  `pool=${studio._rows.length} rows=${bodyRows.length}`
);
check(
  'the live window followed the playhead (window start advanced)',
  studio._windowStart > 0 && late1.frame >= studio._windowStart,
  `windowStart=${studio._windowStart} frame=${late1.frame}`
);
check(
  'the current frame is INSIDE the live window and highlighted',
  studio._currentRowEl && studio._currentRowEl.classList.contains('pr-row--current'),
  `currentRow=${studio._currentRow}`
);
check(
  'exactly ONE row carries the current-frame highlight',
  pianoRollEl.querySelectorAll('.pr-row--current').length === 1
);

// ================================================================ PRESERVED BEHAVIOUR
//
// Everything below must still hold after the rewrite. (These queries run OUTSIDE the measured
// windows, so they do not pollute the per-frame counters.)

// --- the highlight MOVES with playback (two-element class move, cached refs) ---
{
  const before = studio._currentRow;
  const beforeEl = studio._currentRowEl;
  engine.play();
  advanceTo(before + 5);
  engine.pause();
  fake.stepRaf(2);
  check('current-frame highlight moved with playback', studio._currentRow > before, `${before} -> ${studio._currentRow}`);
  check(
    'the previous row lost the highlight class (no stale highlights)',
    beforeEl !== studio._currentRowEl ? !beforeEl.classList.contains('pr-row--current') : true
  );
  check(
    'still exactly ONE highlighted row after moving',
    pianoRollEl.querySelectorAll('.pr-row--current').length === 1
  );
}

// --- clicking a cell still toggles the shared InputLog (mirror + in-process resolver) ---
{
  // Anchor on the playhead: the live window always spans [current - LOOKBEHIND, +WINDOW_ROWS),
  // so current + 10 is inside it and stays inside it across a re-render (the engine is paused).
  const frame = engine.currentFrame + 10;
  const cell = pianoRollEl.querySelector(`.pr-cell--btn[data-frame="${frame}"][data-col="A"]`);
  check('a cell for a windowed frame is addressable by data-frame/data-col', !!cell, `frame=${frame}`);
  cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('click toggles the cell ON (class)', cell.classList.contains('pr-cell--on'));
  check('click sets aria-pressed', cell.getAttribute('aria-pressed') === 'true');
  check('click recorded in the LOCAL MIRROR log', studio.log.isSet(frame, 'A'));
  check(
    'click applied to the engine IN-PROCESS authoritative InputLog',
    engine._resolver.getFrameInputMask(frame, 0) === (1 << 8) >>> 0
  );
  cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('second click toggles OFF everywhere', !cell.classList.contains('pr-cell--on') && !studio.log.isSet(frame, 'A'));
  check('second click cleared the in-process log', engine._resolver.getFrameInputMask(frame, 0) === 0);
}

// --- the grid REFLECTS the log after an edit made outside the click path (re-render) ---
{
  const frame = engine.currentFrame + 20;
  studio.log.set(frame, 'B', true);
  studio.renderPianoRoll();
  const cell = pianoRollEl.querySelector(`.pr-cell--btn[data-frame="${frame}"][data-col="B"]`);
  check('grid reflects a log edit after renderPianoRoll()', cell && cell.classList.contains('pr-cell--on'));
  studio.log.set(frame, 'B', false);
  studio.renderPianoRoll();
  check(
    'grid reflects the cleared bit too',
    !pianoRollEl.querySelector(`.pr-cell--btn[data-frame="${frame}"][data-col="B"]`).classList.contains('pr-cell--on')
  );
}

// --- a state load truncates the log (re-record) and the grid follows ---
{
  const loadFrame = Math.max(0, engine.currentFrame - 10);
  studio.log.set(loadFrame + 30, 'Y', true); // input AFTER the load point must not survive
  check('scripted input exists after the load point', studio.log.isSet(loadFrame + 30, 'Y'));
  engine._emitStateLoaded(loadFrame); // the engine's onStateLoaded hook -> studio truncation
  check('state load truncated the mirror log after the loaded frame', !studio.log.isSet(loadFrame + 30, 'Y'));
  check(
    'state load truncated the engine in-process log too',
    engine._resolver.getFrameInputMask(loadFrame + 30, 0) === 0
  );
  const cell = pianoRollEl.querySelector(`.pr-cell--btn[data-frame="${loadFrame + 30}"][data-col="Y"]`);
  check('grid cleared the truncated cell after the state load', cell && !cell.classList.contains('pr-cell--on'));
}

// --- rebuild accounting: the ONLY _buildGrid call for the whole session was the init one ---
check('grid was built EXACTLY ONCE for the whole session', gridBuilds === 1, `gridBuilds=${gridBuilds}`);
check(
  'DOM node count still constant after all edits/loads/re-renders',
  pianoRollEl.getElementsByTagName('*').length === ELEMENTS_AT_BUILD,
  `now=${pianoRollEl.getElementsByTagName('*').length} build=${ELEMENTS_AT_BUILD}`
);

fake.restore();

// ---------------------------------------------------------------- report
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? '  -> ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
