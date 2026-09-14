// app.js — app-level bootstrap / orchestration for the SNES TAS Studio.
//
// This module owns everything that used to live in index.html's inline <script type=module>
// bootstrap, plus the new on-screen diagnostic banner:
//   1) Service worker registration (offline shell).
//   2) Engine wiring: attach the canvas + notice element, mirror the frame counter, and
//      auto-boot the engine (engine.init() never throws; missing ROM/core degrade to a
//      notice + disabled state, never a file picker).
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

// --------------------------------------------------------------------- debug banner

// A tiny always-visible diagnostic banner rendered into #debug-banner (declared at the very
// top of index.html, above #notice, and positioned to respect the notch via
// env(safe-area-inset-top) in styles.css). We keep the three status lines in one place and
// re-render on every engine status update / captured error.
const bannerState = {
  core: 'Idle', // WASM core: Idle | Loading | Instantiated | Failed
  rom: 'Idle', // ROM fetch: Idle | Fetching | HTTP <code> | Loaded <N> bytes | Error <msg>
  errors: [], // captured uncaught errors (most-recent last, capped)
};
const MAX_BANNER_ERRORS = 5;

function renderBanner() {
  const el = document.getElementById('debug-banner');
  if (!el) return;

  const errLine =
    bannerState.errors.length > 0
      ? bannerState.errors[bannerState.errors.length - 1]
      : 'none';
  const hasError = bannerState.errors.length > 0 || /Failed|Error|HTTP/.test(bannerState.rom + bannerState.core);

  el.classList.toggle('debug-banner--error', hasError);
  el.innerHTML = '';

  const mk = (label, value, extraClass) => {
    const span = document.createElement('span');
    span.className = 'debug-banner__item' + (extraClass ? ' ' + extraClass : '');
    const strong = document.createElement('strong');
    strong.textContent = label + ': ';
    span.appendChild(strong);
    span.appendChild(document.createTextNode(value));
    return span;
  };

  el.appendChild(mk('Core', bannerState.core));
  el.appendChild(mk('ROM', bannerState.rom));
  el.appendChild(
    mk('Err', errLine, bannerState.errors.length > 0 ? 'debug-banner__item--err' : '')
  );
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
  engine.attach({ canvas, noticeEl });

  // Frame counter readout. The full toolbar wiring (play/pause, frame advance, speed
  // slider, fast-forward, save/load) lives in piano-roll.js (TASStudio).
  const frameCounter = document.getElementById('frame-counter');
  engine.onFrame((frame) => {
    if (frameCounter) frameCounter.textContent = `Frame: ${frame}`;
  });

  // Auto-boot. No user action required; degrades gracefully.
  engine.init().catch((err) => {
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
