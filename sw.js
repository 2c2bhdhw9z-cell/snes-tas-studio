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

const CACHE_VERSION = 'tas-studio-v9';
const CACHE_NAME = `${CACHE_VERSION}`;

// Core app shell — always precached. These are the files this feature ships.
const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'app.js',
  'tas-engine.js',
  'piano-roll.js',
  'input-log.js',
  'live-input.js',
  'memory-watch.js',
  'core/core-loader.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Optional core binaries — cached if present, tolerated if absent (404 must not fail install).
// BOTH selectable ASYNCIFY cores (accuracy + performance) are precached so either can be
// chosen from the Core dropdown and still work fully offline. The ROM is NEVER listed here.
const OPTIONAL_CORE_FILES = [
  'cores/bsnes_mercury_accuracy_libretro.js',
  'cores/bsnes_mercury_accuracy_libretro.wasm',
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
