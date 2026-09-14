// core/core-loader.js
//
// Loads and instantiates the Emscripten-compiled libretro SNES core.
//
// The core is a libretro C core (bsnes-mercury-accuracy preferred, snes9x fallback)
// compiled to WebAssembly via Emscripten. Emscripten produces two files per core:
//   - a JS loader (e.g. cores/bsnes_mercury_accuracy_libretro.js) that, when evaluated,
//     defines a module factory and fetches its sibling .wasm.
//   - the .wasm binary itself.
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
  'cores/snes9x_libretro.js',
];

/**
 * Probe whether a core loader file actually exists at the given path.
 * Uses a HEAD-ish GET so a 404 is detected without downloading a large binary twice.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function coreFileExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return true;
    // Some static servers do not implement HEAD; fall back to a ranged GET.
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      return getRes.ok || getRes.status === 206;
    }
    return false;
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
    'snes9x_libretro',
    // Legacy fallback name: some prebuilt EmulatorJS cores expose their factory as a UMD
    // global `EJS_Runtime`. Harmless to keep in the guess list. The core actually bundled
    // here is a from-source bsnes-mercury accuracy core built with MODULARIZE +
    // EXPORT_NAME=snes9x_libretro, so it resolves via the ES-module/UMD default export or
    // the `snes9x_libretro` global above — not this name. See cores/README.md and
    // tools/core-probe.mjs (probe reports 17/17 retro_* + addFunction: yes).
    'EJS_Runtime',
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
