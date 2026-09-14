# cores/ — compiled WASM libretro core (bundled + committed)

This directory holds the libretro SNES core compiled to WebAssembly via Emscripten.

**Now bundled + committed:** a **from-source, raw-libretro `bsnes-mercury` accuracy core**
compiled to WebAssembly ships here (`snes9x_libretro.js`, `snes9x_libretro.wasm`,
`core.json`, `build.json`, `license.txt`) so the app deploys to Netlify with a working
engine present. These files are intentionally **not** git-ignored.

> **Filename note:** the output files keep the historical `snes9x_libretro.*` names so the
> loader (`core/core-loader.js`), the service worker (`sw.js`) and the probe
> (`tools/core-probe.mjs`) all reference one consistent pair of paths. **The core inside is
> bsnes-mercury accuracy, not snes9x.** See `core.json` / `build.json` for the exact source
> commit, emsdk version and link flags.

## Why bsnes-mercury accuracy (cycle-accurate)

The whole point of this studio is hardware-accurate behavior: frame-precise glitches and
memory contents must match real SNES hardware. That requires a bsnes/higan-derived core.
snes9x is faster but **not** cycle-accurate, so it was explicitly rejected. The accuracy
profile trades speed for correctness — the WASM binary is larger (~1.5 MB) and slower than
a performance core, which is an acceptable tradeoff for TAS work.

## Verified drivable

The bundled core is a genuine **raw libretro** core: it exports the raw `retro_*` C ABI and
was linked with `-sALLOW_TABLE_GROWTH`, so `Module.addFunction` is available for registering
the libretro callbacks. `tas-engine.js` can drive it directly. Verified by
`node tools/core-probe.mjs` from the repo root:

```
raw retro_* ABI exports present : 17/17
Module.addFunction available    : yes
```

## How this core was built (reproduce)

```sh
# 1. Install the Emscripten SDK (this repo used emsdk 6.0.9)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
cd ..

# 2. Clone bsnes-mercury (this repo used commit 79d7f9d)
git clone https://github.com/libretro/bsnes-mercury.git
cd bsnes-mercury

# 3. Build the accuracy profile to WASM.
#    NOTE: the upstream emscripten platform block only emits an intermediate
#    LLVM bitcode archive (.bc). It was edited to perform the full Emscripten
#    link to .js + .wasm with the raw-libretro flags below.
emmake make platform=emscripten PROFILE=accuracy -j$(nproc)
# produces bsnes_mercury_accuracy_libretro.js + .wasm

# 4. Copy both into ../cores/ under the historical snes9x_libretro.* names:
cp bsnes_mercury_accuracy_libretro.js  ../<repo>/cores/snes9x_libretro.js
cp bsnes_mercury_accuracy_libretro.wasm ../<repo>/cores/snes9x_libretro.wasm
```

Key Emscripten link flags (the raw-libretro contract):

- `-s ALLOW_TABLE_GROWTH=1` — enables `Module.addFunction` at runtime (required to register
  the environment/video/audio/input libretro callbacks).
- `-s EXPORTED_RUNTIME_METHODS=[ccall,cwrap,addFunction,removeFunction,setValue,getValue,UTF8ToString,stringToUTF8,HEAPU8,HEAPU16,HEAP32,HEAPU32,HEAPF64]`
- `-s EXPORTED_FUNCTIONS=[_malloc,_free,_retro_init,_retro_deinit,_retro_run,_retro_reset,_retro_load_game,_retro_unload_game,_retro_serialize_size,_retro_serialize,_retro_unserialize,_retro_get_memory_data,_retro_get_memory_size,_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_get_system_av_info,_retro_get_system_info,_retro_api_version]`
  (note: `retro_cheat_*` is intentionally **not** exported — no cheats).
- `-s MODULARIZE=1 -s EXPORT_NAME=snes9x_libretro` — factory the loader/probe resolve.
- `-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728` — accuracy needs more RAM.
- Single-threaded (no pthreads / no SharedArrayBuffer) for broad browser + iOS support.
- `-s INVOKE_RUN=0 -s EXIT_RUNTIME=0` — treat it as a library, no `main()`.

## License

bsnes-mercury is **GPLv3** (see `license.txt`, copied verbatim from the bsnes-mercury source
tree). Distributing this compiled core means the project as shipped is subject to GPLv3.

If no core is present the app renders a graceful "Emulator core not found" notice and the
UI stays usable in a disabled state.
