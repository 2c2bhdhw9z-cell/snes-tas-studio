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
// Both cores are built with `-s MODULARIZE=1 -s EXPORT_ES6=1` and DISTINCT MODULARIZE
// EXPORT_NAMEs (accuracy -> `bsnes_accuracy`, performance -> `bsnes_performance`). The JS
// loader ends with `export default <factory>`, so we obtain the factory purely via a native
// dynamic `import()` of the module's default export — no global symbols, no classic <script>.
// A classic <script> injection is deliberately NOT used: these files use `import.meta`, which
// throws `SyntaxError: import.meta is only valid inside modules` when parsed as a classic
// script (that was the live production bug this loader fixes).
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
 * Resolve a (possibly page-relative) core path to an ABSOLUTE, importable URL.
 *
 * WHY THIS EXISTS (the actual browser bug this fixes):
 * The catalog stores page-relative specifiers like 'cores/bsnes_mercury_accuracy_libretro.js'
 * (no leading './' or '/'). A dynamic `import('cores/...js')` treats that as a BARE module
 * specifier and throws `TypeError: Failed to resolve module specifier "cores/..."`. Previously
 * that error was swallowed and execution fell through to a classic-<script> injection of the
 * SAME file — but the core is an ES6 module using `import.meta.url`, so the browser parsed it
 * as a classic script and died with the fatal:
 *   `SyntaxError: import.meta is only valid inside modules.`
 * Resolving to an absolute URL against the page base makes `import()` succeed, so we never
 * fall through to the (removed) harmful classic-script path.
 *
 * An already-absolute URL (http:, https:, file:, blob:, data:) or an explicitly relative one
 * ('./' or '../') is returned effectively unchanged after normalization against the base.
 *
 * @param {string} corePath e.g. 'cores/bsnes_mercury_accuracy_libretro.js'
 * @param {string} [base] the base to resolve against (defaults to the document/page base)
 * @returns {string} an absolute URL string safe to hand to dynamic import()
 */
export function resolveCoreUrl(corePath, base) {
  const baseHref = base
    || (typeof document !== 'undefined' && document.baseURI)
    || (typeof location !== 'undefined' && location.href)
    || 'file:///';
  return new URL(corePath, baseHref).href;
}

/**
 * Dynamically import an Emscripten ES6-module core loader and obtain its module factory.
 *
 * Our cores are built with `-s MODULARIZE=1 -s EXPORT_ES6=1`, so the JS loader ends with
 * `export default <factory>` where the factory is `(moduleArg) => Promise<Module>`. We import
 * the module and read its default export.
 *
 * IMPORTANT: the specifier MUST be resolved to an absolute URL first (see resolveCoreUrl),
 * otherwise a page-relative path is a bare specifier and import() throws. We do NOT fall back
 * to injecting the file as a classic <script>: these cores use `import.meta` and a classic
 * script would throw `SyntaxError: import.meta is only valid inside modules`. Any real import
 * failure is surfaced (returned) rather than silently swallowed.
 *
 * @param {string} url an ABSOLUTE URL (already run through resolveCoreUrl)
 * @returns {Promise<{factory:Function|null, error:Error|null}>}
 */
async function resolveModuleFactory(url) {
  let mod;
  try {
    mod = await import(/* webpackIgnore: true */ url);
  } catch (err) {
    // Surface the real error to the console so the failure is diagnosable — never swallow it.
    console.error(`[core-loader] dynamic import of ES6 core failed for ${url}:`, err);
    return { factory: null, error: err instanceof Error ? err : new Error(String(err)) };
  }

  // Emscripten EXPORT_ES6 emits `export default <factory>`. Read mod.default; tolerate a
  // double-default (mod.default.default) and a directly-callable namespace defensively.
  let candidate = mod && mod.default;
  if (candidate && typeof candidate !== 'function' && typeof candidate.default === 'function') {
    candidate = candidate.default;
  }
  if (typeof candidate !== 'function' && typeof mod === 'function') {
    candidate = mod;
  }

  if (typeof candidate === 'function') return { factory: candidate, error: null };

  const err = new Error(
    `Core module at ${url} did not export a factory function (default export was ${typeof (mod && mod.default)}).`
  );
  console.error('[core-loader]', err.message);
  return { factory: null, error: err };
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
  let lastError = null;

  for (const corePath of corePaths) {
    attempted.push(corePath);

    // Resolve the (page-relative) corePath to an absolute URL up front. Both the existence
    // probe and the dynamic import use this so the specifier is never a bare one.
    const coreUrl = resolveCoreUrl(corePath);

    // Skip paths whose loader file is not present, so we can try the next candidate.
    const exists = await coreFileExists(coreUrl);
    if (!exists) continue;

    const { factory, error } = await resolveModuleFactory(coreUrl);
    if (typeof factory !== 'function') {
      // A PRESENT-but-failing import is a real error: remember it so loadCore can report it
      // instead of masquerading as a plain 'core-missing'. Then try the next candidate.
      if (error) lastError = error;
      continue;
    }

    try {
      // Point Emscripten at the correct .wasm sibling and forward any overrides. locateFile
      // must return a URL emscripten can fetch, so resolve the sibling to an absolute URL too.
      const wasmUrl = resolveCoreUrl(corePath.replace(/\.js$/, '.wasm'));
      const Module = await factory({
        locateFile: (file) => {
          if (file.endsWith('.wasm')) return wasmUrl;
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
      console.error(`[core-loader] failed to instantiate ${corePath}:`, err);
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try the next candidate rather than throwing.
    }
  }

  // If a core FILE was present but failed to import/instantiate, report that distinctly so the
  // app banner can show the real reason (e.g. an import/instantiate error) rather than
  // implying the file is simply missing.
  if (lastError) {
    return {
      ok: false,
      reason: 'core-load-failed',
      detail: `Core file present but failed to load. Tried: ${attempted.join(', ')}. Last error: ${lastError.message}`,
    };
  }

  return {
    ok: false,
    reason: 'core-missing',
    detail: `No usable libretro core found. Tried: ${attempted.join(', ')}`,
  };
}
