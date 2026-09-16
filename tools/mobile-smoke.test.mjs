// tools/mobile-smoke.test.mjs
//
// Headless DOM test for the mobile & speedrun layer (SINGLE-THREAD architecture) using jsdom
// + a fake requestAnimationFrame + a MOCK libretro core.
//
// THE GREAT REVERSAL (FEAT-002/003): the emulator runs SINGLE-THREADED on the main thread in
// tas-engine.js's own rAF loop -- there is NO Web Worker. Live input (gamepad + on-screen
// touch) is polled on the MAIN THREAD and fed to the engine via engine.sendLiveMask(mask); the
// engine stores it (_liveMask) and the in-process runner OR-s it into the frame it runs next.
// So this test asserts pressing a touch control / a gamepad button produces the right live
// mask AND that it reaches the engine, and it proves the OR-merge determinism directly against
// the real InputResolver (the same resolver the engine uses) -- frame N = (log(N)|live)>>>0.
//
// It also asserts the BLINDFOLD (no-present) diagnostic's on-device control surface: the
// #blindfold-toggle checkbox in #frame-controls (default OFF, labelled "Blindfold (no present)",
// styled as a tappable pill), the app.js wiring that drives engine.setBlindfold() and mirrors
// snap.blindfold/snap.present into the banner, the ?blindfold=1 / ?noPresent=1 boot parser, and
// behaviorally that a frame advance with blindfold ON still runs retro_run but performs ZERO
// GPU upload/draw.
//
// It also keeps all preserved-feature + safety assertions: #touch-controls low opacity,
// gesture suppression in app.js, standalone display-mode CSS, viewport meta, no <input
// type=file>, encodeURI ROM fetch (in emu-core-runner.js), pointerdown+click primary controls,
// gamepad mapping.
//
// Run from tools/: node mobile-smoke.test.mjs   (requires jsdom installed here)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installFakeRaf, installEngineMockRunner, makeGLCanvas } from './single-thread-harness.mjs';

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
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
// Node's global `navigator` is read-only, so we install a getGamepads accessor on it.
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
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
// Controllable fake rAF (installed on globalThis AND window) so the single-thread engine loop
// can be driven deterministically.
const fake = installFakeRaf();

// jsdom lacks PointerEvent; force the touch/mouse fallback path in bindTouchControls.
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

// Viewport meta.
const viewport = document.querySelector('meta[name="viewport"]');
const vp = viewport ? viewport.getAttribute('content') : '';
check('viewport maximum-scale=1', /maximum-scale=1/.test(vp));
check('viewport user-scalable=no', /user-scalable=no/.test(vp));
check('viewport viewport-fit=cover', /viewport-fit=cover/.test(vp));

// Gesture-suppression + bootstrap code live in app.js.
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
check('index.html loads app.js as a module', /<script\s+type="module"\s+src="app\.js"><\/script>/.test(html));
check('gesturestart handler present (app.js)', /addEventListener\(\s*['"]gesturestart['"]/.test(appSrc));
check('gesturechange handler present (app.js)', /addEventListener\(\s*['"]gesturechange['"]/.test(appSrc));
check('gestureend handler present (app.js)', /addEventListener\(\s*['"]gestureend['"]/.test(appSrc));
check('multi-touch pinch guard present (app.js)', /e\.touches\.length\s*>\s*1/.test(appSrc));

// app.js wires SW registration, engine attach/init, and the debug banner + window.onerror.
check('app.js registers the service worker', /serviceWorker\.register\(\s*['"]sw\.js['"]\)/.test(appSrc));
check('app.js attaches the engine', /engine\.attach\(/.test(appSrc));
check('app.js calls engine.init()', /engine\.init\(/.test(appSrc));
check('app.js subscribes to engine status', /engine\.onStatus\(/.test(appSrc));
check("app.js listens for uncaught errors (window.onerror)", /addEventListener\(\s*['"]error['"]/.test(appSrc));
check('app.js listens for unhandledrejection', /addEventListener\(\s*['"]unhandledrejection['"]/.test(appSrc));

// On-screen debug banner element + styling.
check('#debug-banner element exists', document.getElementById('debug-banner'));
check('#debug-banner styled to respect the notch (safe-area-inset-top)', /#debug-banner\s*\{[^}]*safe-area-inset-top/s.test(css));

// Live FPS readout (rolling 1s window of ACTUAL advanced frames) — prominent + easy to read
// on-device, sitting in the toolbar next to the frame counter. app.js renders it ~2x/sec and
// also carries an "FPS" field in the debug banner. READ-ONLY perf display, no emulation power.
check('#fps-readout element exists (prominent live FPS)', document.getElementById('fps-readout'));
check('#fps-readout lives inside #frame-controls (near the core controls)', (() => {
  const fc = document.getElementById('frame-controls');
  const el = document.getElementById('fps-readout');
  return fc && el && fc.contains(el);
})());
check('#fps-readout styled prominent (bold, accent, tabular-nums)', /\.fps-readout\s*\{[^}]*font-weight:\s*700/s.test(css));
check('app.js sources FPS from a rolling-window FpsMeter', /new\s+FpsMeter\(/.test(appSrc));
check('app.js ticks the FPS meter on each advanced frame (fpsMeter.tick)', /fpsMeter\.tick\(/.test(appSrc));
check('app.js renders the FPS readout element (#fps-readout text)', /getElementById\(\s*['"]fps-readout['"]\s*\)/.test(appSrc));
check('debug banner carries an FPS field', /mk\(\s*['"]fps['"]\s*,\s*['"]FPS['"]/.test(appSrc));

// BLINDFOLD (no-present) DIAGNOSTIC — the on-device control surface. The user must be able to
// flip it from a phone three ways (URL param, on-screen checkbox, programmatic setter) and read
// the ACTIVE mode straight off a screen recording, so: markup + CSS + app.js wiring + the
// engine's URL parser and banner fields are all asserted here.
const engineSrc = fs.readFileSync(path.join(ROOT, 'tas-engine.js'), 'utf8');
check('#blindfold-toggle checkbox exists in the markup', (() => {
  const el = document.getElementById('blindfold-toggle');
  return el && el.tagName === 'INPUT' && el.type === 'checkbox';
})());
check('#blindfold-toggle lives inside #frame-controls (thumb-reachable next to the frame controls)', (() => {
  const fc = document.getElementById('frame-controls');
  const el = document.getElementById('blindfold-toggle');
  return fc && el && fc.contains(el);
})());
check('blindfold control is DEFAULT OFF (unchecked in the markup)', (() => {
  const el = document.getElementById('blindfold-toggle');
  return el && el.checked === false && !el.hasAttribute('checked');
})());
check('blindfold control is labelled "Blindfold (no present)"', /Blindfold \(no present\)/.test(html));
check('blindfold control styled as a tappable pill (touch-action: manipulation)', /\.blindfold-group\s*\{[^}]*touch-action:\s*manipulation/s.test(css));
check('blindfold control gets an ACTIVE highlight (.blindfold-group.is-active)', /\.blindfold-group\.is-active\s*\{/.test(css));
check('debug banner has a highlighted BLINDFOLD state (.debug-banner--blindfold)', /\.debug-banner--blindfold\s*\{/.test(css));
check('app.js wires the on-screen blindfold checkbox', /getElementById\(\s*['"]blindfold-toggle['"]\s*\)/.test(appSrc));
check('app.js drives engine.setBlindfold() from the checkbox', /engine\.setBlindfold\(/.test(appSrc));
check('app.js seeds/syncs the checkbox from engine.isBlindfold()', /engine\.isBlindfold\(\)/.test(appSrc));
check('debug banner carries a Present (blindfold) field', /mk\(\s*['"]present['"]\s*,\s*['"]Present['"]/.test(appSrc));
check('app.js mirrors snap.blindfold / snap.present into the banner', /snap\.blindfold/.test(appSrc) && /snap\.present/.test(appSrc));
check('tas-engine.js parses ?blindfold at boot (with the noPresent alias)', /parseBlindfoldParam/.test(engineSrc) && /nopresent/.test(engineSrc));
check('tas-engine.js exposes setBlindfold()/isBlindfold()', /setBlindfold\s*\(/.test(engineSrc) && /isBlindfold\s*\(/.test(engineSrc));
check('tas-engine.js gates ONLY the present path on blindfold (early return in _present)', /_present\(rgba, width, height\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*if \(this\._blindfold\) return;/.test(engineSrc));
check('banner videoPath is suffixed while blindfolded (BLINDFOLD: no present)', /BLINDFOLD: no present/.test(engineSrc));
// DOM-REUSE (steady-decay fix): the per-frame banner render must MUTATE cached text nodes,
// not rebuild the banner every frame. renderBanner() runs up to 60x/sec (once per onFrame), so
// a per-frame `innerHTML=''` + createElement x5 would churn ~300 nodes/sec + force full layout.
check('app.js builds the banner skeleton once (buildBannerSkeleton) and caches value nodes', /buildBannerSkeleton\s*\(/.test(appSrc) && /bannerDom\.values/.test(appSrc));
check('app.js updates banner text via a change-detecting cached-node setter (setBannerText)', /function\s+setBannerText\s*\(/.test(appSrc) && /nodeValue\s*=/.test(appSrc));
check('renderBanner() does NOT rebuild the banner every call (no unconditional innerHTML reset in the frame path)', !/renderBanner\s*\(\s*\)\s*\{[\s\S]*?\bel\.innerHTML\s*=\s*['"]{2}/.test(appSrc));

// ROM fetch uses encodeURI so Safari does not 400/404 on spaces/parens. The fetch now lives
// in the worker-side core runner (emu-core-runner.js), not the main-thread proxy.
const runnerSrc = fs.readFileSync(path.join(ROOT, 'emu-core-runner.js'), 'utf8');
check('ROM fetch uses encodeURI (worker-side runner)', /encodeURI\(\s*ROM_PATH\s*\)/.test(runnerSrc));
check('ROM fetch + arrayBuffer present in the runner', /await res\.arrayBuffer\(\)/.test(runnerSrc));

// #frame-controls stays touch-operable (not part of the touch-controls overlay).
check('#frame-controls buttons use touch-action:manipulation', /#frame-controls button\s*\{[^}]*touch-action:\s*manipulation/s.test(css));
check('#frame-controls speed slider uses touch-action:pan-x', /#frame-controls input\[type="range"\]\s*\{[^}]*touch-action:\s*pan-x/s.test(css));

// Orientation-based layout.
check('CSS has orientation:portrait rules', /@media\s*\(orientation:\s*portrait\)/.test(css));
check('CSS has orientation:landscape rules', /@media\s*\(orientation:\s*landscape\)/.test(css));

// Installed PWA (iOS standalone) touch fixes.
check('CSS has an @media (display-mode: standalone) block', /@media\s*\(display-mode:\s*standalone\)/.test(css));
const standaloneMatch = css.match(/@media\s*\(display-mode:\s*standalone\)\s*\{([\s\S]*?)\n\}\s*$/);
const standaloneBlock = standaloneMatch ? standaloneMatch[1] : '';
check('standalone: #touch-controls overlay stays pointer-events:none', /#touch-controls\s*\{[^}]*pointer-events:\s*none/s.test(standaloneBlock));
check('standalone: touch-control clusters/buttons get pointer-events:auto', /#touch-controls[^{]*\.touch-btn[\s\S]*?pointer-events:\s*auto/s.test(standaloneBlock));
check('standalone: #frame-controls gets pointer-events:auto', /#frame-controls\s*\{[^}]*pointer-events:\s*auto/s.test(standaloneBlock));
check('standalone: #frame-controls buttons/save-state nodes get pointer-events:auto', /#frame-controls button[\s\S]*?pointer-events:\s*auto/s.test(standaloneBlock));
check('standalone: #speed slider gets pointer-events:auto + pan-x', /#speed[\s\S]*?pointer-events:\s*auto/s.test(standaloneBlock) && /#speed[\s\S]*?touch-action:\s*pan-x/s.test(standaloneBlock));
check('standalone: #frame-controls raised above the stage (z-index)', /#frame-controls\s*\{[^}]*z-index:/s.test(standaloneBlock));

// =========================================================================================
// THE LANDSCAPE "TAS GRID" DRAWER — markup + the CSS proof that hiding is TRANSFORM-based.
//
// The bug: in landscape #app is a 2-pane grid ("stage sidebar") and #sidebar is ONE independent
// scroll column holding #frame-controls, #side (Live HUD + save-state tree) and — last — the
// piano roll, all forced to natural height. On a short landscape phone the toolbar + HUD + tree
// consume the entire visible height, so a 240-row grid at height:auto ends up far BELOW THE FOLD
// and the user never sees the timeline. The fix presents it as a slide-out fixed overlay.
//
// The piano roll is VIRTUALIZED: a fixed pool of 240 recycled rows, cached row/cell refs, and
// offsetHeight/clientHeight reads (_measureMetrics) that drive both the scroll-extent spacers and
// the throttled scrollTop playhead-following. So `display: none` is forbidden — on the drawer OR
// any ancestor — because it makes those metrics read 0 and silently kills scroll-following. These
// checks are the CSS-side regression proof: the closed state is a TRANSFORM, and no rule anywhere
// sets display:none on the drawer or the roll. (The behavioural/DOM-identity proof lives in
// studio-dom.test.mjs.)
// =========================================================================================

/**
 * Split the stylesheet into { selector, body } rules. Comments are stripped first, and @media
 * wrappers are skipped naturally (their own "selector" never matches a brace-free body), so the
 * inner rules of every media block are included in the scan.
 */
function cssRules(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    rules.push({ sel, body: m[2] });
  }
  return rules;
}
const ALL_RULES = cssRules(css);
const portraitBlock = (css.match(/@media\s*\(orientation:\s*portrait\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
const landscapeBlock = (css.match(/@media\s*\(orientation:\s*landscape\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
const reducedMotionBlock =
  (css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';

// --- markup: the toggle, the drawer wrapper, the ✕, the backdrop ---
{
  const topbar = document.getElementById('topbar');
  const banner = document.getElementById('debug-banner');
  const toggle = document.getElementById('btn-tas-grid');
  const drawer = document.getElementById('tas-grid-drawer');
  const closeBtn = document.getElementById('btn-tas-grid-close');
  const backdrop = document.getElementById('tas-grid-backdrop');
  const roll = document.getElementById('piano-roll');
  check('#btn-tas-grid toggle exists and is a real <button type="button">',
    !!toggle && toggle.tagName === 'BUTTON' && toggle.type === 'button');
  check('#btn-tas-grid is labelled "TAS Grid" (glyph + text)',
    !!toggle && /TAS Grid/.test(toggle.textContent || '') && /▦/.test(toggle.textContent || ''));
  check('#btn-tas-grid declares aria-expanded="false" + aria-controls="tas-grid-drawer"',
    !!toggle && toggle.getAttribute('aria-expanded') === 'false' &&
      toggle.getAttribute('aria-controls') === 'tas-grid-drawer');
  check('#btn-tas-grid sits in the TOP-RIGHT top bar, aligned with #debug-banner',
    !!topbar && !!toggle && !!banner && topbar.contains(banner) && topbar.contains(toggle) &&
      Array.from(topbar.children).indexOf(toggle) > Array.from(topbar.children).indexOf(banner));
  check('#btn-tas-grid is NOT inside #debug-banner (app.js rewrites the banner children)',
    !!banner && !!toggle && !banner.contains(toggle));
  check('the debug banner still carries its diagnostics fields untouched',
    !!banner && banner.querySelectorAll('.debug-banner__item').length >= 3);
  check('the toolbar controls are untouched by the new toggle',
    !!document.getElementById('core-select') && !!document.getElementById('blindfold-toggle') &&
      !!document.getElementById('fps-readout') && !!document.getElementById('btn-frame-advance'));
  check('#tas-grid-drawer wrapper exists (STATIC markup, so the roll is parented once)', !!drawer);
  check('#piano-roll is a direct child of #tas-grid-drawer', !!roll && roll.parentElement === drawer);
  check('the drawer lives inside #sidebar (portrait keeps the roll in the stacked flow)',
    !!drawer && document.getElementById('sidebar').contains(drawer));
  check('#btn-tas-grid-close exists inside the drawer with an accessible label',
    !!closeBtn && closeBtn.tagName === 'BUTTON' && closeBtn.type === 'button' &&
      drawer.contains(closeBtn) && !!(closeBtn.getAttribute('aria-label') || '').trim());
  check('#tas-grid-backdrop exists (dimmed tap-to-dismiss scrim)', !!backdrop);
  check('the drawer markup carries no inline display/visibility style (CSS owns presentation)',
    !!drawer && !/display|visibility/.test(drawer.getAttribute('style') || ''));
}

// --- THE CSS PROOF: hidden by TRANSFORM, never display:none ---
{
  const drawerRules = ALL_RULES.filter((r) => r.sel.split(',').some((s) => s.trim() === '#tas-grid-drawer'));
  const closedRule = drawerRules.find((r) => /position:\s*fixed/.test(r.body));
  const openRule = ALL_RULES.find((r) => /#tas-grid-drawer\.is-open/.test(r.sel) && /transform/.test(r.body));
  check('landscape: the drawer is a position:fixed overlay', !!closedRule);
  check('CLOSED state hides the drawer with a TRANSFORM (translateX(100%))',
    !!closedRule && /transform:\s*translateX\(100%\)/.test(closedRule.body));
  check('CLOSED state keeps the layout boxes alive (visibility:hidden + pointer-events:none)',
    !!closedRule && /visibility:\s*hidden/.test(closedRule.body) && /pointer-events:\s*none/.test(closedRule.body));
  check('CLOSED state does NOT use display:none (metrics would read 0)',
    !!closedRule && !/display:\s*none/.test(closedRule.body));
  check('OPEN state slides it in with a transform (translateX(0))',
    !!openRule && /transform:\s*translateX\(0\)/.test(openRule.body));
  check('OPEN state restores hit-testing (visibility:visible + pointer-events:auto)',
    !!openRule && /visibility:\s*visible/.test(openRule.body) && /pointer-events:\s*auto/.test(openRule.body));

  // NOT ONE rule anywhere in the stylesheet may display:none the drawer or the timeline.
  const offenders = ALL_RULES.filter(
    (r) =>
      r.sel.split(',').some((s) => /#tas-grid-drawer\b/.test(s) || /#piano-roll\b/.test(s)) &&
      /display:\s*none/.test(r.body)
  ).map((r) => r.sel.replace(/\s+/g, ' '));
  check(
    `NO CSS rule sets display:none on the drawer or #piano-roll${offenders.length ? ' -> ' + offenders.join(' | ') : ''}`,
    offenders.length === 0
  );
  // ...nor by collapsing it to zero height (which would zero out offsetHeight just like
  // display:none). `min-height: 0` is a flexbox necessity and is deliberately not matched here.
  check('the drawer is never hidden by a zero height/max-height either',
    !ALL_RULES.some(
      (r) =>
        r.sel.split(',').some((s) => /#tas-grid-drawer\b/.test(s) || /#piano-roll\b/.test(s)) &&
        /(?:^|[;\s])(?:max-height|height):\s*0(?:px|%)?\s*(?:;|$)/.test(r.body)
    ));

  // Transition: transform ONLY, short, and no layout-animating property.
  const transition = ((closedRule || { body: '' }).body.match(/transition:\s*([^;]+);/) || [])[1] || '';
  check('the drawer transition animates TRANSFORM only (no layout-animating properties)',
    /transform/.test(transition) && !/\b(width|height|top|left|right|bottom|margin|padding|inset)\b/.test(transition));
  check('the drawer transition is short (~180-220ms)', (() => {
    const ms = Number((transition.match(/transform\s+(\d+)ms/) || [])[1]);
    return ms >= 180 && ms <= 220;
  })());

  // Sizing / notch / stacking / touch.
  check('landscape: the drawer is a full-height RIGHT panel (top+bottom+right, sane width)',
    /#tas-grid-drawer\s*\{[^}]*top:\s*0/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*\{[^}]*bottom:\s*0/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*\{[^}]*right:\s*0/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*\{[^}]*width:\s*min\(520px,\s*92vw\)/s.test(landscapeBlock));
  check('landscape: the drawer respects the notch/home indicator (env(safe-area-inset-*))',
    /#tas-grid-drawer\s*\{[^}]*env\(safe-area-inset-top/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*\{[^}]*env\(safe-area-inset-right/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*\{[^}]*env\(safe-area-inset-bottom/s.test(landscapeBlock));
  check('landscape: the timeline scrolls INSIDE the panel (real clientHeight for the metrics)',
    /#tas-grid-drawer\s*>\s*#piano-roll\s*\{[^}]*overflow:\s*auto/s.test(landscapeBlock) &&
      /#tas-grid-drawer\s*>\s*#piano-roll\s*\{[^}]*min-height:\s*0/s.test(landscapeBlock));
  check('landscape: the drawer keeps single-finger panning (touch-action: pan-*, not none)',
    /#tas-grid-drawer\s*\{[^}]*touch-action:\s*pan/s.test(landscapeBlock));
  check('#tas-grid-backdrop is a dimmed full-viewport fixed scrim',
    /#tas-grid-backdrop\s*\{[^}]*position:\s*fixed/s.test(css) &&
      /#tas-grid-backdrop\s*\{[^}]*inset:\s*0/s.test(css) &&
      /#tas-grid-backdrop\s*\{[^}]*background:\s*rgba/s.test(css));
  check('stacking is sane: drawer above backdrop, backdrop above the stage/toolbar', (() => {
    const drawerZ = Number((landscapeBlock.match(/#tas-grid-drawer\s*\{[^}]*z-index:\s*(\d+)/s) || [])[1]);
    const backdropZ = Number((css.match(/#tas-grid-backdrop\s*\{[^}]*z-index:\s*(\d+)/s) || [])[1]);
    const toolbarZ = Number((standaloneBlock.match(/#frame-controls\s*\{[^}]*z-index:\s*(\d+)/s) || [])[1]);
    return drawerZ > backdropZ && backdropZ > toolbarZ;
  })());
}

// --- reduced motion: instant show/hide ---
check('CSS has a prefers-reduced-motion: reduce branch', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css));
check('reduced motion disables the drawer + backdrop slide transition (instant show/hide)',
  /#tas-grid-drawer/.test(reducedMotionBlock) && /#tas-grid-backdrop/.test(reducedMotionBlock) &&
    /transition:\s*none/.test(reducedMotionBlock));

// --- PORTRAIT MUST NOT REGRESS: the roll stays inline, the wrapper is a pass-through ---
check('portrait: the drawer wrapper is a plain in-flow pass-through (position:static, transform:none)',
  /#sidebar\s*>\s*#tas-grid-drawer\s*\{[^}]*position:\s*static/s.test(portraitBlock) &&
    /#sidebar\s*>\s*#tas-grid-drawer\s*\{[^}]*transform:\s*none/s.test(portraitBlock));
check('portrait: nothing is fixed-positioned (no stuck overlay after a rotation)',
  !/position:\s*fixed/.test(portraitBlock));
check('portrait: #piano-roll keeps its own inner scroll in the stacked flow',
  /#sidebar\s*>\s*#tas-grid-drawer\s*>\s*#piano-roll\s*\{[^}]*max-height:\s*40vh/s.test(portraitBlock) &&
    /#sidebar\s*>\s*#tas-grid-drawer\s*>\s*#piano-roll\s*\{[^}]*overflow:\s*auto/s.test(portraitBlock));
check('portrait: the landscape-only toggle + backdrop are hidden (harmless in portrait)',
  /#btn-tas-grid,\s*#tas-grid-backdrop\s*\{[^}]*display:\s*none/s.test(portraitBlock));
check('the drawer chrome (header/✕) is landscape-only, hidden by class NOT by the drawer id',
  /\.tas-grid-drawer__head\s*\{\s*display:\s*none/s.test(css) &&
    /\.tas-grid-drawer__head\s*\{[^}]*display:\s*flex/s.test(landscapeBlock));

// --- standalone (installed PWA): the drawer controls stay tappable ---
check('standalone: #btn-tas-grid / ✕ get pointer-events:auto + touch-action:manipulation',
  /#btn-tas-grid,\s*#btn-tas-grid-close\s*\{[^}]*pointer-events:\s*auto/s.test(standaloneBlock) &&
    /#btn-tas-grid,\s*#btn-tas-grid-close\s*\{[^}]*touch-action:\s*manipulation/s.test(standaloneBlock));
check('standalone: only the OPEN drawer/backdrop get pointer-events:auto (closed must not hit-test)',
  /#tas-grid-drawer\.is-open,\s*#tas-grid-backdrop\.is-open\s*\{[^}]*pointer-events:\s*auto/s.test(standaloneBlock) &&
    !/#tas-grid-drawer\s*\{[^}]*pointer-events:\s*auto/s.test(standaloneBlock));

// --- app.js: the drawer is exempt from the multi-finger gesture guard ---
check('app.js exempts the TAS Grid drawer from the multi-finger gesture guard',
  /tas-grid-drawer/.test(appSrc) && /isInsideTimeline/.test(appSrc));

// Primary controls in piano-roll.js listen for BOTH pointerdown AND click.
const pianoSrc = fs.readFileSync(path.join(ROOT, 'piano-roll.js'), 'utf8');
check('piano-roll binds pointerdown on primary controls', /addEventListener\(\s*['"]pointerdown['"]/.test(pianoSrc));
check('piano-roll still binds click on primary controls', /addEventListener\(\s*['"]click['"]/.test(pianoSrc));
check('piano-roll guards against pointerdown+click double-fire', /handledByPointer/.test(pianoSrc));

// TAS Grid drawer, JS side: event-driven only, a PUBLIC re-measure hook, and never a
// display:none / re-parent of the virtualized timeline.
check('piano-roll.js wires the TAS Grid drawer (wireTasGridDrawer)', /wireTasGridDrawer\s*\(/.test(pianoSrc));
check('piano-roll.js exposes the PUBLIC re-measure hooks refreshLayout()/onDrawerShown()',
  /\brefreshLayout\s*\(\)\s*\{/.test(pianoSrc) && /\bonDrawerShown\s*\(\)\s*\{/.test(pianoSrc));
check('the open path re-measures the geometry then re-syncs the window',
  /_measureMetrics\(\);[\s\S]{0,240}renderPianoRoll\(\)/.test(pianoSrc));
check('the drawer toggle binds pointerdown+click (tappable in the installed PWA)',
  /function\s+bindTap\s*\(/.test(pianoSrc) && /bindTap\(\s*this\.drawerToggleEl/.test(pianoSrc));
check('piano-roll.js dismisses on Escape', /['"]Escape['"]/.test(pianoSrc));
check('piano-roll.js tracks orientation with matchMedia((orientation: landscape))',
  /matchMedia\(\s*['"]\(orientation:\s*landscape\)['"]\s*\)/.test(pianoSrc));
check('piano-roll.js removes the orientation listener on teardown (destroy)',
  /destroy\s*\(\)\s*\{/.test(pianoSrc) && /removeEventListener\(\s*['"]change['"]/.test(pianoSrc));
check('piano-roll.js NEVER hides anything with an inline display style', !/\.style\.display\s*=/.test(pianoSrc));
check('piano-roll.js never re-parents #piano-roll at runtime',
  !/(appendChild|append|insertBefore|replaceChild)\(\s*(this\.)?pianoRoll/.test(pianoSrc));
check('the drawer adds NO work to the per-frame path (_onEngineFrame stays drawer-free)',
  !/_onEngineFrame\(frame\)\s*\{[\s\S]{0,700}?(TasGrid|drawer|refreshLayout)/.test(pianoSrc));

const liveSrc = fs.readFileSync(path.join(ROOT, 'live-input.js'), 'utf8');
check('gamepad polling (getGamepads) present', /navigator\.getGamepads/.test(liveSrc));
check('gamepadconnected handled', /gamepadconnected/.test(liveSrc));
check('gamepaddisconnected handled', /gamepaddisconnected/.test(liveSrc));

// CSS gesture lockdown.
check('overscroll-behavior:none present', /overscroll-behavior:\s*none/.test(css));
check('touch-action:none on root', /touch-action:\s*none/.test(css));
check('piano-roll re-enables touch panning', /#piano-roll\s*\{[^}]*touch-action:\s*pan/s.test(css));

// --- Live behavior: modules + REAL single-thread engine + mock core ---
const engineMod = await import('../tas-engine.js');
const engine = engineMod.default;
window.TASEngine = engine;
const shared = installEngineMockRunner(engine);
// Count GPU calls so the BLINDFOLD (no-present) diagnostic can be verified behaviorally below.
const gpu = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0, createTexture: 0, createProgram: 0 };
engine.attach({ canvas: makeGLCanvas({ gpu }), noticeEl: document.getElementById('notice') });
check('engine created NO worker (single-thread; no worker handle)', typeof engine.worker === 'undefined' && typeof globalThis.Worker === 'undefined');
check('engine presents on a MAIN-thread path (videoPath main-*)', /^main-/.test(engine.videoPath));

// Boot the in-process runner (auto-plays), then pause so the live-mask frame test is
// deterministic. The mock core needs no real WASM.
await engine.init({ corePaths: ['cores/snes9x_libretro.js'] });
engine.pause();
fake.stepRaf(2);

// --- BLINDFOLD (no-present) behaviour on the device path: boot parser + live toggle ---
check('parseBlindfoldParam is exported for the boot URL (?blindfold=1)', typeof engineMod.parseBlindfoldParam === 'function');
check('?blindfold=1 selects blindfold at boot', engineMod.parseBlindfoldParam('?blindfold=1') === true);
check('?noPresent=1 alias selects blindfold at boot', engineMod.parseBlindfoldParam('?noPresent=1') === true);
check('a plain URL (no param) leaves blindfold OFF', engineMod.parseBlindfoldParam('') === false && engine.isBlindfold() === false);
{
  // Blindfold OFF (default): a frame advance presents exactly once (unchanged behaviour).
  gpu.drawArrays = 0;
  shared.resolvedPerFrame.length = 0;
  {
    const r = engine.frameAdvance();
    if (r && typeof r.then === 'function') await r;
  }
  check('blindfold OFF: frame advance presents exactly once', gpu.drawArrays === 1 && shared.resolvedPerFrame.length === 1);
  // Blindfold ON: the SAME frame advance still runs retro_run but performs NO GPU work.
  engine.setBlindfold(true);
  gpu.drawArrays = 0;
  gpu.texSubImage2D = 0;
  gpu.texImage2D = 0;
  shared.resolvedPerFrame.length = 0;
  {
    const r = engine.frameAdvance();
    if (r && typeof r.then === 'function') await r;
  }
  check('blindfold ON: retro_run still advances the frame', shared.resolvedPerFrame.length === 1);
  check('blindfold ON: ZERO GPU upload/draw for that frame', gpu.drawArrays === 0 && gpu.texSubImage2D === 0 && gpu.texImage2D === 0);
  check('blindfold ON: banner reports Present: OFF (BLINDFOLD)', engine.statusSnapshot().present === 'OFF (BLINDFOLD)');
  check('blindfold ON: banner videoPath is suffixed', /\(BLINDFOLD: no present\)$/.test(engine.statusSnapshot().videoPath));
  engine.setBlindfold(false);
  check('blindfold OFF again: banner reports Present: ON', engine.statusSnapshot().present === 'ON');
}

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

// Live input is fed to the ENGINE in-process: pressing B then polling stores a live mask on
// the engine whose bit 0 (B) is set. We drive the studio's stream tick directly (deterministic)
// and assert the engine's stored live mask, then that the in-process runner OR-s it into the
// next frame it runs.
studio.live.setTouch('B', true);
studio.live.poll();
engine.sendLiveMask(studio.live.getMask() >>> 0);
check('live touch mask reaches the engine (engine._liveMask has B bit)', (engine._liveMask & 1) === 1);
// Prove the stored live mask OR-s into the next frame the in-process runner executes.
engine.pause();
fake.stepRaf(2);
shared.resolvedPerFrame.length = 0;
{
  const r = engine.frameAdvance();
  if (r && typeof r.then === 'function') await r;
}
check('engine live mask OR-ed into the next in-process frame (B ran)', shared.resolvedPerFrame.length === 1 && (shared.resolvedPerFrame[0].mask & 1) === 1);
studio.live.clearTouch();
engine.sendLiveMask(0);

// --- OR-merge determinism proven against the REAL InputResolver (the worker's resolver) ---
// frame N runs with exactly (scripted log mask for N | liveMask) >>> 0.
const { InputResolver } = await import('../input-resolver.js');
const resolver = new InputResolver();
// Scripted: A (bit 8) on frame 4. Live: B (bit 0) held via the streamed mask.
resolver.applyEdit({ op: 'setFrameButton', frame: 4, button: 'A', on: true });
const A = 1 << 8, B = 1 << 0;
check('resolver OR-merges scripted A + live B on frame 4', resolver.getFrameInputMask(4, B) === ((A | B) >>> 0));
check('resolver: frame 3 (no script) = live only', resolver.getFrameInputMask(3, B) === (B >>> 0));
check('resolver: frame 4 without live = scripted only', resolver.getFrameInputMask(4, 0) === (A >>> 0));
check('resolver: frame 3 never reflects frame 4 scripted input', resolver.getFrameInputMask(3, 0) === 0);

// Gamepad standard-mapping -> SNES bits.
const li = new LiveInput();
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

// --- Behavioral: a pointerdown on Play toggles the engine (standalone tap path) ---
let toggled = 0;
engine.togglePause = () => { toggled += 1; };
const playBtn = document.getElementById('btn-playpause');
check('#btn-playpause exists', playBtn);
const pd = new window.Event('pointerdown', { bubbles: true });
Object.defineProperty(pd, 'button', { value: 0 });
playBtn.dispatchEvent(pd);
check('pointerdown on Play toggles the engine once', toggled === 1);
playBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
check('synthetic click after pointerdown does not double-toggle', toggled === 1);

// Frame +1 pointerdown runs exactly one frameAdvance.
let advanced = 0;
engine.frameAdvance = () => { advanced += 1; };
const stepBtn = document.getElementById('btn-frame-advance');
check('#btn-frame-advance exists', stepBtn);
const pd2 = new window.Event('pointerdown', { bubbles: true });
Object.defineProperty(pd2, 'button', { value: 0 });
stepBtn.dispatchEvent(pd2);
check('pointerdown on Frame +1 advances exactly one frame', advanced === 1);
stepBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
check('synthetic click after Frame +1 pointerdown does not double-advance', advanced === 1);

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
