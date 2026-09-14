// tools/core-probe.mjs
//
// Node instantiation harness for the bundled SNES WASM core
// (cores/bsnes_mercury_accuracy_libretro.js + cores/bsnes_mercury_accuracy_libretro.wasm).
//
// The bundled core is a from-source, raw-libretro **bsnes-mercury accuracy**
// core compiled to WebAssembly with Emscripten (see cores/core.json for the
// exact commit + flags). The files are named honestly for the core they
// contain. Note the loader's INTERNAL Emscripten factory export SYMBOL is still
// `snes9x_libretro` (EXPORT_NAME baked into the build) — that JS symbol is
// independent of the file name, which is why this probe resolves the factory via
// the `snes9x_libretro` export below.
//
// PURPOSE: prove, before shipping, whether our thin custom libretro frontend
// (tas-engine.js) can actually DRIVE this core. tas-engine.js assumes a *raw
// libretro* core: it wants the raw C ABI exports (retro_run, retro_serialize,
// retro_get_memory_data, ...) plus a way to register libretro C
// function-pointer callbacks via Module.addFunction(fn, sig) -- which requires
// the core to have been linked with -sALLOW_TABLE_GROWTH.
//
// This harness require()s the Emscripten MODULARIZE loader (UMD:
// `module.exports = snes9x_libretro`, the internal export symbol), invokes the
// factory in Node (the loader
// has an ENVIRONMENT_IS_NODE branch), feeds the .wasm bytes via
// Module.instantiateWasm so no network fetch is needed, waits for the module,
// and then reports exactly which symbols our frontend needs are present vs.
// absent.
//
// Run: node tools/core-probe.mjs   (from repo root; or `npm run test:coreprobe` in tools/)
//
// It is a diagnostic, not a pass/fail gate for CI: it prints a symbol table and
// a verdict. Exit code is 0 as long as the module instantiates, non-zero only
// if instantiation itself fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, '..');
const CORE_JS = join(ROOT, 'cores', 'bsnes_mercury_accuracy_libretro.js');
const CORE_WASM = join(ROOT, 'cores', 'bsnes_mercury_accuracy_libretro.wasm');

function line(s = '') { console.log(s); }
function has(mod, key) { return typeof mod[key] !== 'undefined' && mod[key] !== null; }

line('=== SNES TAS Studio :: prebuilt core probe ===');
line(`core js  : ${CORE_JS}`);
line(`core wasm: ${CORE_WASM}`);
line('');

// 1) Resolve the module factory the way core/core-loader.js would. The
//    Emscripten MODULARIZE loader assigns `var snes9x_libretro = (()=>{...})()`
//    and, in a CommonJS environment, also does `module.exports = snes9x_libretro`
//    (plus `.default`). In Node, require() gives us the exported factory directly.
let factory;
try {
  factory = require(CORE_JS);
  if (factory && factory.default) factory = factory.default; // also sets .default
} catch (err) {
  line(`FATAL: could not require the core loader: ${err && err.message}`);
  process.exit(2);
}

if (typeof factory !== 'function') {
  line(`FATAL: core export is not a factory function (got ${typeof factory}).`);
  line('Expected a MODULARIZE factory (EXPORT_NAME=snes9x_libretro).');
  process.exit(2);
}
line('module factory: resolved (MODULARIZE export "snes9x_libretro") -> typeof function  [OK]');

// 2) Feed the wasm bytes ourselves so no fetch/locateFile network path is taken.
//    The core is built with INVOKE_RUN=0 so there is no main() auto-run; we set
//    noInitialRun as belt-and-suspenders so the harness never spins up a loop.
const wasmBytes = readFileSync(CORE_WASM);

const moduleArg = {
  noInitialRun: true,
  locateFile: (p) => (p.endsWith('.wasm') ? CORE_WASM : p),
  print: () => {},
  printErr: () => {},
  // Instantiate synchronously from our local bytes.
  instantiateWasm(imports, successCallback) {
    WebAssembly.instantiate(wasmBytes, imports)
      .then((result) => successCallback(result.instance, result.module))
      .catch((err) => {
        line(`FATAL: WebAssembly.instantiate failed: ${err && err.message}`);
        process.exit(3);
      });
    return {};
  },
};

let Module;
try {
  Module = await factory(moduleArg);
} catch (err) {
  line(`FATAL: factory invocation rejected: ${err && err.message}`);
  process.exit(3);
}
line('factory invocation: snes9x_libretro({...}) -> Promise<Module> resolved  [OK]');
line('');

// 3) Report the symbols tas-engine.js needs from a RAW libretro core.
const RAW_LIBRETRO_EXPORTS = [
  '_retro_init', '_retro_deinit', '_retro_run',
  '_retro_load_game', '_retro_unload_game',
  '_retro_serialize_size', '_retro_serialize', '_retro_unserialize',
  '_retro_get_memory_data', '_retro_get_memory_size',
  '_retro_set_environment', '_retro_set_video_refresh',
  '_retro_set_audio_sample', '_retro_set_audio_sample_batch',
  '_retro_set_input_poll', '_retro_set_input_state',
  '_retro_get_system_av_info',
];
const RUNTIME_HELPERS = ['cwrap', 'ccall', 'addFunction', 'removeFunction',
  'setValue', 'getValue', 'UTF8ToString', 'stringToUTF8',
  '_malloc', '_free'];
const HEAP_VIEWS = ['HEAPU8', 'HEAPU16', 'HEAP32', 'HEAPU32'];
// What THIS build actually exposes (EmulatorJS high-level API).
const EJS_API = ['_main', '_simulate_input', '_get_current_frame_count',
  '_get_video_dimensions', '_save_state_info', '_load_state',
  '_supports_states', '_set_ff_ratio', '_toggleMainLoop', '_set_cheat'];

function reportGroup(title, keys) {
  line(`--- ${title} ---`);
  let present = 0;
  for (const k of keys) {
    const ok = has(Module, k);
    if (ok) present++;
    line(`  [${ok ? 'x' : ' '}] Module.${k}`);
  }
  line(`  => ${present}/${keys.length} present`);
  line('');
  return present;
}

const rawPresent = reportGroup('RAW libretro ABI exports (tas-engine.js requires these)', RAW_LIBRETRO_EXPORTS);
const helpersPresent = reportGroup('Emscripten runtime helpers', RUNTIME_HELPERS);
reportGroup('HEAP typed-array views', HEAP_VIEWS);
const ejsPresent = reportGroup('EmulatorJS high-level C API (what this build DOES expose)', EJS_API);

// addFunction is the single most important primitive for our frontend.
const addFnPresent = has(Module, 'addFunction');

line('=== VERDICT ===');
line(`raw retro_* ABI exports present : ${rawPresent}/${RAW_LIBRETRO_EXPORTS.length}`);
line(`Module.addFunction available    : ${addFnPresent ? 'yes' : 'NO'}`);
line(`EmulatorJS high-level API present: ${ejsPresent}/${EJS_API.length}`);
line('');
if (rawPresent === 0 && !addFnPresent) {
  line('CONCLUSION: This is an EmulatorJS RetroArch-linked application binary, NOT a');
  line('raw libretro core. It exposes NO retro_* ABI and NO addFunction. Our thin');
  line('custom libretro frontend (tas-engine.js) CANNOT drive this build: there are no');
  line('retro_run / retro_serialize / retro_get_memory_data exports to cwrap, and no');
  line('addFunction to register the environment/video/input callbacks. Integration via');
  line('the raw ABI is impossible with this prebuilt binary. See README "Prebuilt core"');
  line('section for the two viable paths (drop in a raw libretro core, or adopt the EJS API).');
} else if (rawPresent === RAW_LIBRETRO_EXPORTS.length && (addFnPresent || helpersPresent)) {
  line('CONCLUSION: raw libretro ABI + a callback-registration primitive are present.');
  line('tas-engine.js can drive this core.');
} else {
  line('CONCLUSION: partial ABI. Review the table above before wiring tas-engine.js.');
}

// Instantiation itself succeeded, so exit 0 (diagnostic tool).
process.exit(0);
