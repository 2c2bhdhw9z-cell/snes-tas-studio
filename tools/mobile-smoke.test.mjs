// tools/mobile-smoke.test.mjs
// Headless DOM smoke test for the FEAT-003 mobile & speedrun layer using jsdom.
//
// Asserts:
//   - #touch-controls renders at low opacity with D-Pad + A/B/X/Y/L/R/Start/Select
//   - touch/pointer press on a control sets a live bit; release clears it
//   - LiveInput.poll() maps a fake standard-mapping gamepad to SNES bits
//   - the engine input provider OR-s the live mask into the piano-roll log mask
//   - gesture-suppression handlers exist and no <input type=file> is present
// Run from tools/: node mobile-smoke.test.mjs   (requires jsdom installed here)
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
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
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
// Node's global `navigator` is read-only, so we cannot reassign it. Instead we install a
// getGamepads accessor on the object the modules actually see. The modules read the global
// `navigator` (Node provides one); point our fake pads through a shared holder.
const gamepadHolder = { pads: null };
if (!('getGamepads' in navigator)) {
  try {
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => gamepadHolder.pads,
    });
  } catch (_e) {
    /* ignore */
  }
}
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// jsdom lacks PointerEvent; force the touch/mouse fallback path in bindTouchControls.
// (Deleting the constructor makes `'PointerEvent' in window` false.)
try {
  delete window.PointerEvent;
} catch (_e) {
  /* ignore */
}

// --- Static markup / CSS checks (no modules needed) ---
const touch = document.getElementById('touch-controls');
check('#touch-controls exists', touch);
const btnNames = Array.from(document.querySelectorAll('#touch-controls [data-btn]')).map((b) =>
  b.getAttribute('data-btn')
);
for (const b of ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT']) {
  check(`touch control ${b} present`, btnNames.includes(b));
}
check('touch-controls styled low opacity (0.22)', /#touch-controls\s*\{[^}]*opacity:\s*0\.22/s.test(css));
check('no <input type=file> anywhere', document.querySelectorAll('input[type="file"]').length === 0);

// Viewport meta from FEAT-001 confirmed.
const viewport = document.querySelector('meta[name="viewport"]');
const vp = viewport ? viewport.getAttribute('content') : '';
check('viewport maximum-scale=1', /maximum-scale=1/.test(vp));
check('viewport user-scalable=no', /user-scalable=no/.test(vp));
check('viewport viewport-fit=cover', /viewport-fit=cover/.test(vp));

// Gesture-suppression + bootstrap code now live in app.js (moved out of index.html's inline
// script). Assert they exist there and that index.html loads app.js as a module.
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
check('index.html loads app.js as a module', /<script\s+type="module"\s+src="app\.js"><\/script>/.test(html));
check('gesturestart handler present (app.js)', /addEventListener\(\s*['"]gesturestart['"]/.test(appSrc));
check('gesturechange handler present (app.js)', /addEventListener\(\s*['"]gesturechange['"]/.test(appSrc));
check('gestureend handler present (app.js)', /addEventListener\(\s*['"]gestureend['"]/.test(appSrc));
check('multi-touch pinch guard present (app.js)', /e\.touches\.length\s*>\s*1/.test(appSrc));

// app.js wires the equivalent of the old inline bootstrap: SW registration, engine
// attach/init, and the debug banner + window.onerror.
check('app.js registers the service worker', /serviceWorker\.register\(\s*['"]sw\.js['"]\)/.test(appSrc));
check('app.js attaches the engine', /engine\.attach\(/.test(appSrc));
check('app.js calls engine.init()', /engine\.init\(/.test(appSrc));
check('app.js subscribes to engine status', /engine\.onStatus\(/.test(appSrc));
check("app.js listens for uncaught errors (window.onerror)", /addEventListener\(\s*['"]error['"]/.test(appSrc));
check('app.js listens for unhandledrejection', /addEventListener\(\s*['"]unhandledrejection['"]/.test(appSrc));

// On-screen debug banner element + styling.
check('#debug-banner element exists', document.getElementById('debug-banner'));
check('#debug-banner styled to respect the notch (safe-area-inset-top)', /#debug-banner\s*\{[^}]*safe-area-inset-top/s.test(css));

// ROM fetch uses encodeURI (item 2) so Safari does not 400/404 on spaces/parens.
const engineSrc = fs.readFileSync(path.join(ROOT, 'tas-engine.js'), 'utf8');
check('ROM fetch uses encodeURI', /encodeURI\(\s*ROM_PATH\s*\)/.test(engineSrc));
check('ROM fetch + arrayBuffer wrapped in try/catch', /await res\.arrayBuffer\(\)/.test(engineSrc) && /catch/.test(engineSrc));

// #frame-controls stays touch-operable (not part of the touch-controls overlay).
check('#frame-controls buttons use touch-action:manipulation', /#frame-controls button\s*\{[^}]*touch-action:\s*manipulation/s.test(css));
check('#frame-controls speed slider uses touch-action:pan-x', /#frame-controls input\[type="range"\]\s*\{[^}]*touch-action:\s*pan-x/s.test(css));

// Orientation-based layout (item 4).
check('CSS has orientation:portrait rules', /@media\s*\(orientation:\s*portrait\)/.test(css));
check('CSS has orientation:landscape rules', /@media\s*\(orientation:\s*landscape\)/.test(css));

const liveSrc = fs.readFileSync(path.join(ROOT, 'live-input.js'), 'utf8');
check('gamepad polling (getGamepads) present', /navigator\.getGamepads/.test(liveSrc));
check('gamepadconnected handled', /gamepadconnected/.test(liveSrc));
check('gamepaddisconnected handled', /gamepaddisconnected/.test(liveSrc));

// CSS gesture lockdown.
check('overscroll-behavior:none present', /overscroll-behavior:\s*none/.test(css));
check('touch-action:none on root', /touch-action:\s*none/.test(css));
check('piano-roll re-enables touch panning', /#piano-roll\s*\{[^}]*touch-action:\s*pan/s.test(css));

// --- Live behavior: modules ---
const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;
const { TASStudio } = await import('../piano-roll.js');
const { LiveInput, GAMEPAD_STANDARD_MAP } = await import('../live-input.js');

const studio = new TASStudio(engine, {
  pianoRoll: document.getElementById('piano-roll'),
  frameControls: document.getElementById('frame-controls'),
  savestateTree: document.getElementById('savestate-tree'),
  touchControls: touch,
});
studio.init();

// Touch press sets a live bit; release clears it. Use the mouse fallback (no PointerEvent).
const aBtn = document.querySelector('#touch-controls [data-btn="A"]');
check('touch A button element found', aBtn);
aBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
check('touch press sets live A bit', studio.live.getMask() !== 0);
const heldClass = aBtn.classList.contains('touch-btn--held');
check('touch press adds held class', heldClass);
aBtn.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
check('touch release clears live mask', studio.live.getMask() === 0);

// Provider merges live touch input into the current frame's mask.
studio.live.setTouch('B', true);
const providerMask = engine._inputProvider ? engine._inputProvider(0, 0, 1, 0, 0) : 0;
// B is bit 0 => mask should have bit 0 set from the live source even though log[0] is empty.
check('provider OR-s live mask into frame input', (providerMask & 1) === 1);
studio.live.clearTouch();

// Gamepad standard-mapping -> SNES bits.
const li = new LiveInput();
// Fake a standard-mapping pad: button 0 (A face) + button 5 (RB) pressed; d-pad right (15).
const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
buttons[0].pressed = true; // -> SNES B (bit 0)
buttons[5].pressed = true; // -> SNES R (bit 11)
buttons[15].pressed = true; // -> SNES RIGHT (bit 7)
const fakePad = { buttons, axes: [0, 0], mapping: 'standard', connected: true };
gamepadHolder.pads = [fakePad];
li.poll();
const gm = li.getMask();
check('gamepad button 0 -> SNES B', (gm & (1 << 0)) !== 0);
check('gamepad button 5 -> SNES R', (gm & (1 << 11)) !== 0);
check('gamepad button 15 -> SNES RIGHT', (gm & (1 << 7)) !== 0);
check('GAMEPAD_STANDARD_MAP maps face 1 -> A', GAMEPAD_STANDARD_MAP[1] === 'A');

// Analog stick as d-pad.
const li2 = new LiveInput();
gamepadHolder.pads = [{ buttons: [], axes: [-1, 0], mapping: 'standard' }];
li2.poll();
check('left stick left -> SNES LEFT', (li2.getMask() & (1 << 6)) !== 0);

// --- Report ---
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
dom.window.close();
process.exit(failed === 0 ? 0 : 1);
