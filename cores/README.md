# cores/ — compiled WASM libretro cores (bundled + committed)

This directory holds the libretro SNES cores compiled to WebAssembly via Emscripten.

**Now bundled + committed:** two **from-source, raw-libretro `bsnes-mercury`** cores compiled
to WebAssembly ship here so the app deploys to Netlify with a working, user-selectable engine:

| Profile | Files | Export name | Cycle-accurate |
| --- | --- | --- | --- |
| Accuracy | `bsnes_mercury_accuracy_libretro.js` + `.wasm` | `bsnes_accuracy` | yes |
| Performance | `bsnes_mercury_performance_libretro.js` + `.wasm` | `bsnes_performance` | no |

`core.json`, `build.json` and `license.txt` accompany them. These files are intentionally
**not** git-ignored. The **Core** dropdown in the toolbar switches between the two at
runtime (defaults to Accuracy). This is an emulator-accuracy choice only — **not** a
ROM/level picker, and it grants no cheat/memory-write capability.

## ASYNCIFY (why the cores changed)

bsnes uses **libco** cooperative cothreads for its CPU/PPU/SMP scheduler. In a plain
single-threaded, non-ASYNCIFY WASM build, `retro_run()` **never returns** — the libco
scheduler never yields back to JS, so the very first frame hangs the main thread (a single
call was observed to run for >10 min). The fix is to build **with ASYNCIFY** so `retro_run`
unwinds the Emscripten stack and returns to the browser event loop.

ASYNCIFY alone is not enough: libco context-switches **raw stacks** ASYNCIFY does not track.
So this build also adds an **Emscripten Fibers** libco backend (`libco/emscripten.c`, wired
into `libco/libco.c` for the `__EMSCRIPTEN__` target) built on `emscripten_fiber_*`, which
makes each cothread switch cooperate with ASYNCIFY. With both in place, `retro_run` yields
and returns on **both** profiles (proven headlessly — see below).

> **Size note:** ASYNCIFY instrumentation inflates the binaries. Each `.wasm` is ~3.7 MB
> (vs ~1.5 MB pre-ASYNCIFY). This is the accepted cost of a core that actually runs.

## Distinct filenames + export names

Each profile is emitted with a **distinct filename** and a **distinct MODULARIZE
`EXPORT_NAME`** (`bsnes_accuracy` / `bsnes_performance`) so the two cores never collide on a
shared global/UMD symbol when both are referenced. Both are emitted as **ES6 modules**
(`-s EXPORT_ES6=1`), so `core/core-loader.js` resolves either one via its dynamic-import
default-export path. The legacy `snes9x_libretro` name is retained only in
`core-loader.js`'s `factoryNameGuesses` for backward compatibility with an older
pre-ASYNCIFY core.

## Verified drivable (retro_run proven to yield)

Both cores export the raw `retro_*` C ABI and were linked with `-sALLOW_TABLE_GROWTH`, so
`Module.addFunction` is available for registering the libretro callbacks. The real proof
that `retro_run` no longer hangs is the headless boot-and-run harness:

```sh
# from the repo root (Node 22):
node tools/run-smoke.mjs cores/bsnes_mercury_accuracy_libretro.js 12
node tools/run-smoke.mjs cores/bsnes_mercury_performance_libretro.js 12
```

For each core the harness loads the real ROM, asserts `retro_load_game()===true`, then runs
`retro_run()` in a loop **bounded by a hard wall-clock timeout** and asserts: retro_run
returns (no hang), `video_refresh` fired with a non-null framebuffer (~256 wide), and the
frame counter advanced. Both cores pass all assertions.

> The harness transparently re-execs Node with `--liftoff-only`. Node's V8 TurboFan
> tier-2 compiler can crash (`Check failed: IdField::is_valid(id)`) when optimizing these
> large ASYNCIFY WASM modules — a Node-side JIT limit, **not** a core defect. Browsers do
> not hit it, and `retro_run` genuinely returns (it resolves in ~110 ms/frame).

## How these cores were built (reproduce)

```sh
# 1. Install the Emscripten SDK (this repo used emsdk 6.0.9)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
cd ..

# 2. Clone bsnes-mercury (this repo used commit 79d7f9d) and add the Emscripten Fibers
#    libco backend (libco/emscripten.c) + the ASYNCIFY / per-profile EXPORT_NAME edits to
#    the Makefile's `platform=emscripten` block. (See build.json for details.)
git clone https://github.com/libretro/bsnes-mercury.git
cd bsnes-mercury

# 3. Build BOTH profiles to WASM (clean between them so objects don't leak):
find . -name '*.o' -delete
emmake make platform=emscripten PROFILE=accuracy -j$(nproc)
find . -name '*.o' -delete
emmake make platform=emscripten PROFILE=performance -j$(nproc)

# 4. Copy all four files into ../<repo>/cores/ (names are already the honest bsnes names):
cp bsnes_mercury_accuracy_libretro.js    ../<repo>/cores/
cp bsnes_mercury_accuracy_libretro.wasm  ../<repo>/cores/
cp bsnes_mercury_performance_libretro.js   ../<repo>/cores/
cp bsnes_mercury_performance_libretro.wasm ../<repo>/cores/
```

Key Emscripten link flags (the raw-libretro + ASYNCIFY contract):

- `-s ASYNCIFY=1 -s ASYNCIFY_STACK_SIZE=1048576` — so `retro_run` yields and returns.
- `-s ALLOW_TABLE_GROWTH=1` — enables `Module.addFunction` at runtime (required to register
  the environment/video/audio/input libretro callbacks).
- `-s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=<bsnes_accuracy|bsnes_performance>` —
  ES6 default-export factory the loader resolves; distinct name per profile.
- `-s EXPORTED_RUNTIME_METHODS=[ccall,cwrap,addFunction,removeFunction,setValue,getValue,UTF8ToString,stringToUTF8,HEAPU8,HEAPU16,HEAP32,HEAPU32,HEAPF64]`
- `-s EXPORTED_FUNCTIONS=[_malloc,_free,_retro_init,_retro_deinit,_retro_run,_retro_reset,_retro_load_game,_retro_unload_game,_retro_serialize_size,_retro_serialize,_retro_unserialize,_retro_get_memory_data,_retro_get_memory_size,_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_get_system_av_info,_retro_get_system_info,_retro_api_version]`
  (note: `retro_cheat_*` is intentionally **not** exported — no cheats).
- `-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728` — accuracy needs more RAM.
- Single-threaded (no pthreads / no SharedArrayBuffer) for broad browser + iOS support.
- `-s INVOKE_RUN=0 -s EXIT_RUNTIME=0` — treat it as a library, no `main()`.

## License

bsnes-mercury is **GPLv3** (see `license.txt`, copied verbatim from the bsnes-mercury source
tree). Distributing these compiled cores means the project as shipped is subject to GPLv3.

If no core is present the app renders a graceful "Emulator core not found" notice and the
UI stays usable in a disabled state.
