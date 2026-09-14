// core/core-loader.js
//
// Loads and instantiates the Emscripten-compiled libretro SNES core.
//
// The core is a from-source, raw-libretro bsnes-mercury accuracy core compiled to
// WebAssembly via Emscripten. Emscripten produces two files per core:
//   - a JS loader (cores/bsnes_mercury_accuracy_libretro.js) that, when evaluated,
//     defines a module factory and fetches its sibling .wasm.
//   - the .wasm binary itself (cores/bsnes_mercury_accuracy_libretro.wasm).
//
// The files are named honestly for the core they contain. Note the loader's INTERNAL
// Emscripten factory export SYMBOL is still `snes9x_libretro` (EXPORT_NAME baked into the
// 230KB minified build); that JS symbol is independent of the file name and is intentionally
// retained in `factoryNameGuesses` below so factory resolution keeps working.
//
// Neither file is committed to this repo; both are dropped into cores/ at deploy time.
// This loader therefore MUST degrade gracefully: on any failure it returns a structured
// { ok:false, reason:'core-missing' } result instead of throwing, so the app shell can
// render a notice and stay usable.
//
// ---------------------------------------------------------------------------------------
// Expected exported libretro symbols on the instantiated Module (wrapped by tas-engine.js
// via Module.cwrap / Module.ccall, with memory read through Module.HEAPU8):
//
//   retro_init(void)                              // one-time core init
//   retro_deinit(void)
//   retro_api_version(void) -> unsigned
//   retro_get_system_info(struct retro_system_info*)
//   retro_get_system_av_info(struct retro_system_av_info*)
//   retro_set_environment(cb)
//   retro_set_video_refresh(cb)                   // frame -> canvas blit
//   retro_set_audio_sample(cb)
//   retro_set_audio_sample_batch(cb)
//   retro_set_input_poll(cb)
//   retro_set_input_state(cb)                     // per-frame TAS input feed
//   retro_load_game(const struct retro_game_info*) -> bool
//   retro_unload_game(void)
//   retro_run(void)                               // advance EXACTLY one video frame
//   retro_reset(void)
//   retro_serialize_size(void) -> size_t          // save-state size
//   retro_serialize(void* data, size_t size) -> bool
//   retro_unserialize(const void* data, size_t size) -> bool
//   retro_get_memory_data(unsigned id) -> void*   // id 2 = RETRO_MEMORY_SYSTEM_RAM (WRAM)
//   retro_get_memory_size(unsigned id) -> size_t  // READ-ONLY use only
//
// NOTE: retro_cheat_set / retro_cheat_reset are intentionally NEVER wrapped or called.
// ---------------------------------------------------------------------------------------

'use strict';

export const DEFAULT_CORE_PATHS = [
  'cores/bsnes_mercury_accuracy_libretro.js',
];

// The catalog of selectable emulator cores. Both are bsnes-mercury profiles compiled to
// WASM with -s ASYNCIFY (so retro_run yields to the browser and returns) + the Emscripten
// Fibers libco backend (so bsnes's cooperative cothreads cooperate with ASYNCIFY).
//
// This is CORE selection only — an emulator-accuracy choice. It is NOT a ROM/level picker
// and grants no cheat/memory-write capability. Each entry records the MODULARIZE
// EXPORT_NAME baked into that build so factory resolution can find the right global if the
// ES-module default-export path is unavailable (the two cores use DISTINCT export names so
// they never collide when both are referenced).
export const CORE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'accuracy',
    label: 'Accuracy (bsnes-mercury)',
    path: 'cores/bsnes_mercury_accuracy_libretro.js',
    exportName: 'bsnes_accuracy',
  }),
  Object.freeze({
    id: 'performance',
    label: 'Performance (bsnes-mercury)',
    path: 'cores/bsnes_mercury_performance_libretro.js',
    exportName: 'bsnes_performance',
  }),
]);

/** Look up a catalog entry by its id (e.g. 'accuracy' | 'performance'). */
export function coreById(id) {
  return CORE_CATALOG.find((c) => c.id === id) || null;
}

/**
 * Probe whether a core loader file actually exists at the given path.
 *
 * Uses a ranged GET (`Range: bytes=0-0`) as the PRIMARY probe rather than HEAD: some
 * CDNs (e.g. Netlify) return 404 for HEAD on static files, so a HEAD-first probe gives
 * false negatives. A ranged GET fetches at most one byte and is answered with 206
 * (or 200 for servers that ignore Range) on a file that exists, and 404 on one that
 * does not. Graceful: any network error resolves to false.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function coreFileExists(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    return res.ok || res.status === 206;
  } catch (_err) {
    return false;
  }
}

/**
 * Dynamically evaluate an Emscripten core loader script and obtain its module factory.
 *
 * Emscripten cores can be emitted in a few shapes depending on build flags:
 *   - as an ES module exporting a default factory function (MODULARIZE + EXPORT_ES6),
 *   - as a global factory function assigned to a name (MODULARIZE),
 *   - as a script that populates a global `Module` object.
 * We try the ES-module import path first (cleanest, no globals), then fall back to a
 * classic <script> injection.
 *
 * @param {string} url
 * @returns {Promise<Function|null>} a module factory `(moduleArg) => Promise<Module>` or null
 */
async function resolveModuleFactory(url) {
  // 1) Try native ES module import (works when the core was built with EXPORT_ES6).
  try {
    const mod = await import(/* webpackIgnore: true */ url);
    if (mod && typeof mod.default === 'function') return mod.default;
  } catch (_esErr) {
    // Not an ES module (or import blocked) — fall through to classic script injection.
  }

  // 2) Classic <script> injection. Capture any global factory or Module the script defines.
  if (typeof document === 'undefined') return null;

  const factoryNameGuesses = [
    'libretro',
    'Module',
    'createModule',
    'bsnes_mercury_accuracy_libretro',
    'bsnes_mercury_performance_libretro',
    // The ASYNCIFY rebuilds use DISTINCT MODULARIZE EXPORT_NAMEs per profile so the two
    // cores never collide on a shared UMD/global symbol: the accuracy core exports
    // `bsnes_accuracy`, the performance core `bsnes_performance`. Both are also emitted with
    // -s EXPORT_ES6=1, so resolveModuleFactory's dynamic-import default-export path (tried
    // first, above) resolves either one cleanly without touching globals. These names are
    // the classic-<script> fallback for environments without ES-module import.
    'bsnes_accuracy',
    'bsnes_performance',
    // Legacy: the ORIGINAL committed core used EXPORT_NAME `snes9x_libretro`. Retained so an
    // older pre-ASYNCIFY core dropped into cores/ still resolves.
    'snes9x_libretro',
  ];

  const before = new Set(Object.keys(globalThis));

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = url;
    script.onload = () => {
      // Prefer a newly-introduced global that is a function factory.
      for (const key of Object.keys(globalThis)) {
        if (before.has(key)) continue;
        const val = globalThis[key];
        if (typeof val === 'function') {
          resolve(val);
          return;
        }
      }
      // Fall back to well-known names.
      for (const name of factoryNameGuesses) {
        const val = globalThis[name];
        if (typeof val === 'function') {
          resolve(val);
          return;
        }
        if (val && typeof val === 'object') {
          // A prebuilt Module object; wrap it so callers get a uniform factory shape.
          resolve(() => Promise.resolve(val));
          return;
        }
      }
      resolve(null);
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

/**
 * Attempt to load and instantiate the libretro WASM core.
 *
 * @param {{ corePaths?: string[], moduleOverrides?: object }} [opts]
 * @returns {Promise<{ok:true, Module:object, corePath:string} | {ok:false, reason:string, detail?:string}>}
 */
export async function loadCore(opts = {}) {
  const corePaths = Array.isArray(opts.corePaths) && opts.corePaths.length
    ? opts.corePaths
    : DEFAULT_CORE_PATHS;
  const moduleOverrides = opts.moduleOverrides || {};

  const attempted = [];

  for (const corePath of corePaths) {
    attempted.push(corePath);

    // Skip paths whose loader file is not present, so we can try the next candidate.
    const exists = await coreFileExists(corePath);
    if (!exists) continue;

    const factory = await resolveModuleFactory(corePath);
    if (typeof factory !== 'function') continue;

    try {
      // Point Emscripten at the correct .wasm sibling and forward any overrides.
      const wasmPath = corePath.replace(/\.js$/, '.wasm');
      const Module = await factory({
        locateFile: (file) => {
          if (file.endsWith('.wasm')) return wasmPath;
          return file;
        },
        // Keep the core quiet unless it errors; callers can override.
        print: () => {},
        printErr: (msg) => console.warn('[core]', msg),
        ...moduleOverrides,
      });

      if (Module && typeof Module.cwrap === 'function') {
        return { ok: true, Module, corePath };
      }
      // Some builds resolve to the factory-provided object without cwrap ready yet.
      if (Module) {
        return { ok: true, Module, corePath };
      }
    } catch (err) {
      console.warn(`[core-loader] failed to instantiate ${corePath}:`, err);
      // Try the next candidate rather than throwing.
    }
  }

  return {
    ok: false,
    reason: 'core-missing',
    detail: `No usable libretro core found. Tried: ${attempted.join(', ')}`,
  };
}
