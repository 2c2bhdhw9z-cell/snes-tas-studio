// app.js — app-level bootstrap / orchestration for the SNES TAS Studio.
//
// This module owns everything that used to live in index.html's inline <script type=module>
// bootstrap, plus the new on-screen diagnostic banner:
//   1) Service worker registration (offline shell).
//   2) Engine wiring: attach the canvas + notice element (attach() builds a WebGL presenter on
//      the DOM canvas on the MAIN thread; the emulator now runs SINGLE-THREADED in the
//      engine's own requestAnimationFrame loop, so there is NO Web Worker and the canvas is
//      never transferred anywhere; the main thread presents via a WebGL presenter, so the
//      Video banner reads main-webgl2), mirror the frame counter, and auto-boot the engine
//      (engine.init() never throws; missing ROM/core degrade to a notice + disabled state,
//      never a file picker). snes9x's ~1.2ms retro_run fits the 16.6ms frame budget, so the
//      single main-thread rAF loop never blocks DOM/touch.
//   3) iOS Safari bounce/pinch gesture suppression (gesturestart/change/end + multi-touch
//      pinch touchmove preventDefault, while leaving #piano-roll scrolling intact).
//   4) The always-visible on-screen debug banner (#debug-banner): live WASM core status,
//      ROM fetch status, and a window.onerror / unhandledrejection listener that prints
//      uncaught JS/WASM exceptions on screen so mobile errors are visible without a
//      desktop console.
//
// It is loaded as a deferred ES module (<script type="module" src="app.js">). memory-watch.js
// and piano-roll.js still self-wire on DOMContentLoaded via window.TASEngine, so module load
// order is not relied upon here.
//
// SAFETY: the banner is STATUS/errors only. It adds no memory-write, cheat, or level-select
// capability, and it never introduces a file picker.

import engine from './tas-engine.js';
import { CORE_CATALOG, coreById } from './core/core-loader.js';
import { FpsMeter } from './fps-meter.js';

// localStorage key for the persisted core choice (nice-to-have). DEFAULT is 'realtime'
// (snes9x): with no stored preference the app boots the synchronous snes9x core for
// real-time playback. bsnes accuracy/performance remain selectable for paused frame-perfect
// work and persist across reloads once chosen.
const CORE_PREF_KEY = 'tas-studio.core';
const DEFAULT_CORE_ID = 'realtime';

function readCorePref() {
  try {
    const v = window.localStorage ? window.localStorage.getItem(CORE_PREF_KEY) : null;
    return v && coreById(v) ? v : DEFAULT_CORE_ID;
  } catch (_err) {
    return DEFAULT_CORE_ID;
  }
}

function writeCorePref(id) {
  try {
    if (window.localStorage) window.localStorage.setItem(CORE_PREF_KEY, id);
  } catch (_err) {
    /* private mode / disabled storage — ignore, choice just won't persist */
  }
}

// --------------------------------------------------------------------- debug banner

// A tiny always-visible diagnostic banner rendered into #debug-banner (declared at the very
// top of index.html, above #notice, and positioned to respect the notch via
// env(safe-area-inset-top) in styles.css). We keep the three status lines in one place and
// re-render on every engine status update / captured error.
const bannerState = {
  core: 'Idle', // WASM core: Idle | Loading | Instantiated | Failed
  rom: 'Idle', // ROM fetch: Idle | Fetching | HTTP <code> | Loaded <N> bytes | Error <msg>
  engine: 'Init', // Engine lifecycle: Init | GameLoaded | RunLoop Active | Stopped
  frame: 0, // live frame number (advances one per retro_run)
  fps: 0, // live measured FPS over a rolling 1-second window (see FpsMeter)
  video: 'none', // ACTIVE present path: main-webgl2|main-webgl1|main-2d (single main-thread present)
  errors: [], // captured uncaught errors (most-recent last, capped)
};
const MAX_BANNER_ERRORS = 5;

// --------------------------------------------------------------------- live FPS meter
//
// The user asked for an easy-to-read, HONEST FPS readout. We measure the ACTUAL advanced
// frames the user sees: the engine fires engine.onFrame once per emulated frame (advanced by
// the main-thread rAF loop), and we count those over a rolling 1-second window.
// FPS = frames in the last second — no timestamp math on the user's part, no divide-by-zero,
// reads 0 cleanly when paused (no frames arrive so the window empties). READ-ONLY display.
const fpsMeter = new FpsMeter(1000);
const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// Render the FPS readout ~2x/sec (independent of frame arrival) so it updates smoothly and
// decays to 0 shortly after playback pauses. The dedicated #fps-readout element sits in the
// toolbar next to the frame counter; the banner also carries an "FPS: NN" field.
const FPS_RENDER_INTERVAL_MS = 500;
function renderFps() {
  const n = fpsMeter.fps(nowMs());
  bannerState.fps = n;
  const el = typeof document !== 'undefined' ? document.getElementById('fps-readout') : null;
  if (el) el.textContent = `FPS: ${n}`;
  renderBanner();
}

// Cached banner DOM so the per-frame render MUTATES existing text nodes instead of rebuilding
// the whole banner every frame. renderBanner() runs up to 60x/sec (once per emulated frame),
// so the old `el.innerHTML = '' + createElement x5` churned ~300 DOM nodes/sec and forced a
// full layout each time — a per-frame allocation + layout-thrash leak contributing to the
// steady FPS decay. We now build the skeleton ONCE, cache the value text nodes, and update a
// node's textContent ONLY when its value actually changed (no churn, no needless layout).
const bannerDom = {
  el: null, // the #debug-banner container the skeleton was built into
  values: null, // { core, rom, engine, fps, video, err } -> the Text node holding each value
  items: null, // { err } -> the wrapper span (for the per-error class toggle)
  last: { core: null, rom: null, engine: null, fps: null, video: null, err: null, hasError: null, errItem: null },
};

function buildBannerSkeleton(el) {
  el.innerHTML = '';
  const values = {};
  const items = {};
  const mk = (key, label, extraClass) => {
    const span = document.createElement('span');
    span.className = 'debug-banner__item' + (extraClass ? ' ' + extraClass : '');
    const strong = document.createElement('strong');
    strong.textContent = label + ': ';
    span.appendChild(strong);
    const value = document.createTextNode('');
    span.appendChild(value);
    el.appendChild(span);
    values[key] = value;
    items[key] = span;
  };
  mk('core', 'Core');
  mk('rom', 'ROM');
  mk('engine', 'Engine');
  mk('fps', 'FPS');
  mk('video', 'Video');
  mk('err', 'Err');
  bannerDom.el = el;
  bannerDom.values = values;
  bannerDom.items = items;
  bannerDom.last = { core: null, rom: null, engine: null, fps: null, video: null, err: null, hasError: null, errItem: null };
}

// Update a cached Text node only when its value changed (avoids needless layout invalidation).
function setBannerText(key, text) {
  if (bannerDom.last[key] !== text) {
    bannerDom.values[key].nodeValue = text;
    bannerDom.last[key] = text;
  }
}

function renderBanner() {
  const el = document.getElementById('debug-banner');
  if (!el) return;
  // Build (or rebuild if the element was replaced) the skeleton once, then mutate in place.
  if (bannerDom.el !== el || !bannerDom.values) buildBannerSkeleton(el);

  const errLine =
    bannerState.errors.length > 0
      ? bannerState.errors[bannerState.errors.length - 1]
      : 'none';
  const hasError = bannerState.errors.length > 0 || /Failed|Error|HTTP/.test(bannerState.rom + bannerState.core);

  if (bannerDom.last.hasError !== hasError) {
    el.classList.toggle('debug-banner--error', hasError);
    bannerDom.last.hasError = hasError;
  }

  setBannerText('core', bannerState.core);
  setBannerText('rom', bannerState.rom);
  // Engine lifecycle + live frame counter, exactly as:  Engine: [state] | Frame: [N]
  setBannerText('engine', `${bannerState.engine} | Frame: ${bannerState.frame}`);
  // Live measured FPS (rolling 1-second window of actual advanced frames).
  setBannerText('fps', String(bannerState.fps));
  // ACTIVE video present path (so the device can report which renderer engaged). This is the
  // diagnostic that tells us which main-thread renderer (main-webgl2/main-webgl1/main-2d) engaged.
  setBannerText('video', bannerState.video);
  setBannerText('err', errLine);

  // Toggle the error class on the Err item only when it changes.
  const errItem = bannerState.errors.length > 0;
  if (bannerDom.last.errItem !== errItem) {
    bannerDom.items.err.classList.toggle('debug-banner__item--err', errItem);
    bannerDom.last.errItem = errItem;
  }
}

function recordError(message) {
  const text = String(message || 'unknown error');
  bannerState.errors.push(text);
  if (bannerState.errors.length > MAX_BANNER_ERRORS) {
    bannerState.errors.shift();
  }
  renderBanner();
}

// Wire uncaught-error listeners as early as possible so failures during boot are visible.
// window.onerror catches synchronous JS + (in most browsers) WASM aborts; the
// 'unhandledrejection' listener catches rejected promises (e.g. async import failures).
window.addEventListener('error', (event) => {
  const msg =
    event && event.message
      ? `${event.message}${event.filename ? ` @ ${event.filename}:${event.lineno || 0}` : ''}`
      : 'uncaught error';
  recordError(msg);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const msg = reason && reason.message ? reason.message : String(reason);
  recordError(`unhandled rejection: ${msg}`);
});

// Subscribe to engine diagnostic status (fires immediately with the current snapshot).
engine.onStatus((snap) => {
  bannerState.core = snap.coreStatus;
  bannerState.rom = snap.romStatus;
  if (typeof snap.engineStatus === 'string') bannerState.engine = snap.engineStatus;
  if (typeof snap.frame === 'number') bannerState.frame = snap.frame;
  if (typeof snap.videoPath === 'string') bannerState.video = snap.videoPath;
  renderBanner();
});

// Render once up front in case the DOM is already parsed.
renderBanner();

// --------------------------------------------------------------------- service worker

// Register the service worker for offline play (non-fatal if unsupported).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[app] service worker registration failed:', err);
    });
  });
}

// --------------------------------------------------------------------- engine boot

// Wire the engine to the DOM and start it. init() never throws: on a missing ROM or core it
// renders a notice and leaves the UI usable in a disabled state.
window.addEventListener('DOMContentLoaded', () => {
  renderBanner(); // ensure the banner element (now parsed) shows the current snapshot

  const canvas = document.getElementById('screen');
  const noticeEl = document.getElementById('notice');
  // attach() builds the MAIN-THREAD presenter on #screen (a WebGL presenter, or a 2D context
  // as last resort) and records the video path. No worker is created and the canvas is never
  // transferred anywhere; the emulator runs on the main thread in the engine's rAF loop.
  engine.attach({ canvas, noticeEl });

  // Frame counter readout. The full toolbar wiring (play/pause, frame advance, speed
  // slider, fast-forward, save/load) lives in piano-roll.js (TASStudio).
  const frameCounter = document.getElementById('frame-counter');
  let lastFrameForFps = -1;
  engine.onFrame((frame) => {
    if (frameCounter) frameCounter.textContent = `Frame: ${frame}`;
    // Mirror the live frame number into the diagnostic banner's Engine line.
    bannerState.frame = frame;
    // Count ACTUAL advanced frames for the live FPS readout. Only count genuine forward
    // advances (one per emulated frame) — a save-state load or repeat tick that reports the
    // same/earlier frame number must not inflate the rate.
    if (typeof frame === 'number' && frame !== lastFrameForFps) {
      if (frame > lastFrameForFps) fpsMeter.tick(nowMs());
      lastFrameForFps = frame;
    }
    renderBanner();
  });

  // Drive the FPS readout on a steady ~2x/sec cadence so it updates smoothly and decays to 0
  // shortly after the user pauses (when no frames arrive, the rolling window empties to 0).
  renderFps();
  if (typeof setInterval === 'function') {
    setInterval(renderFps, FPS_RENDER_INTERVAL_MS);
  }

  // Core selection dropdown. Populated from the core catalog; defaults to Real-Time (snes9x)
  // (or the persisted choice). Changing it dynamically swaps the WASM core via engine.setCore(),
  // which tears down the old core/run loop and re-inits with the new one (no leaked Module,
  // no double rAF loop). This is emulator-core selection ONLY — never a ROM/level picker.
  const coreSelect = document.getElementById('core-select');
  const initialCoreId = readCorePref();
  if (coreSelect) {
    // Rebuild options from the catalog so labels/paths stay in one place.
    coreSelect.innerHTML = '';
    for (const c of CORE_CATALOG) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      coreSelect.appendChild(opt);
    }
    coreSelect.value = initialCoreId;

    coreSelect.addEventListener('change', () => {
      const entry = coreById(coreSelect.value) || coreById(DEFAULT_CORE_ID);
      if (!entry) return;
      writeCorePref(entry.id);
      coreSelect.disabled = true;
      // A core swap resets the frame stream; forget stale frame stamps so FPS starts clean.
      fpsMeter.reset();
      lastFrameForFps = -1;
      Promise.resolve(engine.setCore(entry.path))
        .catch((err) => {
          console.warn('[app] core switch error (handled):', err);
          recordError(`core switch: ${err && err.message ? err.message : err}`);
        })
        .finally(() => {
          coreSelect.disabled = false;
        });
    });
  }

  // Auto-boot with the selected/persisted core. No user action required; degrades
  // gracefully (missing core/ROM -> banner notice, no crash, no file picker).
  const bootEntry = coreById(initialCoreId) || coreById(DEFAULT_CORE_ID);
  engine.init({ corePaths: bootEntry ? [bootEntry.path] : undefined }).catch((err) => {
    console.warn('[app] engine init error (handled):', err);
    recordError(`engine init: ${err && err.message ? err.message : err}`);
  });
});

// --------------------------------------------------------------------- iOS gesture lockdown

// iOS Safari bounce / pinch-zoom gesture suppression.
//
// 1) gesturestart/gesturechange/gestureend are Safari-only pinch-zoom gestures;
//    preventDefault stops page zoom entirely.
// 2) Multi-touch touchmove (2+ fingers) is a pinch: preventDefault it UNLESS the touch is
//    inside the piano-roll container, which must keep scrolling.
// 3) Double-tap-to-zoom is handled by the viewport meta (maximum-scale=1, user-scalable=no)
//    plus touch-action CSS.
//
// IMPORTANT: we deliberately do NOT preventDefault single-finger touches, so taps and slider
// drags on #frame-controls (buttons + the speed range input) are never swallowed here.
const suppressGesture = (e) => e.preventDefault();
document.addEventListener('gesturestart', suppressGesture, { passive: false });
document.addEventListener('gesturechange', suppressGesture, { passive: false });
document.addEventListener('gestureend', suppressGesture, { passive: false });

document.addEventListener(
  'touchmove',
  (e) => {
    // Legacy WebKit reports a non-unit scale during a pinch.
    if (e.scale && e.scale !== 1) {
      e.preventDefault();
      return;
    }
    // Multi-finger move = pinch/zoom. Allow it only inside the scrollable piano roll so
    // single-finger scrolling of the timeline still works everywhere else. Single-finger
    // moves (touches.length <= 1) are never prevented, so control taps/slider drags work.
    if (e.touches && e.touches.length > 1) {
      const target = e.target;
      const pianoRollEl = document.getElementById('piano-roll');
      const insidePianoRoll =
        pianoRollEl && target && typeof target.closest === 'function'
          ? pianoRollEl.contains(target)
          : false;
      if (!insidePianoRoll) e.preventDefault();
    }
  },
  { passive: false }
);
