// sw.js — Service Worker for the SNES TAS Studio PWA.
//
// Strategy: cache-first offline app shell so the studio works 100% offline once loaded.
//
// EXPLICITLY DOES NOT CACHE:
//   - the ROM (assets/*.sfc / assets/*.smc) — copyrighted, supplied at deploy time.
//   - anything under assets/ (ROM location).
// The compiled WASM core in cores/ is cached opportunistically at install if present,
// but its absence never fails the install.

'use strict';

// v24: the FPS-decay fix. piano-roll.js (windowed/recycled grid - the O(frame) per-frame DOM
// rebuild is gone), emu-core-runner.js (iOS suspend/resume overdue clamp + resetClockAnchor),
// tas-engine.js (zero-allocation rAF scheduling + resume re-anchor listeners), app.js (cached
// banner node) and styles.css (.pr-spacer) all changed, so returning users MUST get the new
// files instead of the service worker's cached v23 copies.
// v25: the bsnes-mercury core binaries were REBUILT with real link-time optimization
// (the Emscripten link step had been running at its -O0 default), so both bsnes .js/.wasm
// files changed bytes under the SAME filenames, and a third bsnes profile
// (bsnes_mercury_balanced_libretro) was added. Returning devices must refetch them
// instead of serving the v24 copies out of cache.
// v26: the LANDSCAPE "TAS Grid" drawer. In landscape the piano roll was the last item in the
// single scrolling #sidebar column, so on a short phone viewport it sat far below the fold and
// was effectively invisible; it is now a slide-out fixed overlay. index.html (the #topbar +
// #btn-tas-grid toggle, the #tas-grid-drawer wrapper around #piano-roll, the #tas-grid-backdrop),
// styles.css (the transform-based drawer/backdrop rules + a prefers-reduced-motion branch),
// piano-roll.js (wireTasGridDrawer/refreshLayout) and app.js (the drawer is exempt from the
// multi-finger gesture guard) all changed, so returning users MUST get the new files instead of
// the service worker's cached v25 copies.
const CACHE_VERSION = 'tas-studio-v26';
const CACHE_NAME = `${CACHE_VERSION}`;

// Core app shell (always precached). These are the files this feature ships. The emulator now
// runs SINGLE-THREADED on the MAIN thread: tas-engine.js is the engine and statically imports
// emu-core-runner.js (the libretro glue), input-resolver.js (the deterministic scripted log),
// and gl-presenter.js (the WebGL video presenter). There is NO Web Worker (emu-worker.js is
// retired), so all of these are imported directly by the main thread and MUST be precached for
// the studio to boot fully offline.
const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'app.js',
  'fps-meter.js',
  'tas-engine.js',
  'gl-presenter.js',
  'emu-core-runner.js',
  'input-resolver.js',
  'piano-roll.js',
  'input-log.js',
  'live-input.js',
  'memory-watch.js',
  'core/core-loader.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Optional core binaries — cached if present, tolerated if absent (404 must not fail install).
// ALL FOUR selectable cores are precached so any can be chosen from the Core dropdown and
// still work fully offline: the synchronous snes9x real-time core (default boot core) plus
// all three ASYNCIFY bsnes-mercury profiles (accuracy + balanced + performance). The ROM is
// NEVER listed here.
const OPTIONAL_CORE_FILES = [
  'cores/snes9x_libretro.js',
  'cores/snes9x_libretro.wasm',
  'cores/bsnes_mercury_accuracy_libretro.js',
  'cores/bsnes_mercury_accuracy_libretro.wasm',
  'cores/bsnes_mercury_balanced_libretro.js',
  'cores/bsnes_mercury_balanced_libretro.wasm',
  'cores/bsnes_mercury_performance_libretro.js',
  'cores/bsnes_mercury_performance_libretro.wasm',
];

// Never cache these (ROM). Requests matching this are always passed to the network.
function isRomRequest(url) {
  return /\/assets\//.test(url) || /\.(sfc|smc)$/i.test(url);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Precache the app shell. Add individually so one failure does not abort the rest.
      await Promise.all(
        APP_SHELL.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'no-store' });
            if (res && res.ok) await cache.put(path, res.clone());
          } catch (_err) {
            // Non-fatal: keep installing the rest of the shell.
          }
        })
      );

      // Opportunistically cache core binaries if they exist.
      await Promise.all(
        OPTIONAL_CORE_FILES.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'no-store' });
            if (res && res.ok) await cache.put(path, res.clone());
          } catch (_err) {
            // Absent core is expected; ignore.
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean up any old versioned caches.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle GET; let the browser deal with the rest.
  if (request.method !== 'GET') return;

  const url = request.url;

  // Never intercept/cache the ROM — always go to network, degrade gracefully upstream.
  if (isRomRequest(url)) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 404 })));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Cache-first.
      const cached = await cache.match(request);
      if (cached) return cached;

      // Network fallback; cache successful same-origin responses for next time.
      try {
        const res = await fetch(request);
        if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      } catch (_err) {
        // Offline fallback: for navigations, serve the cached shell.
        if (request.mode === 'navigate') {
          const shell = (await cache.match('index.html')) || (await cache.match('./'));
          if (shell) return shell;
        }
        return new Response('Offline and resource not cached.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })()
  );
});
