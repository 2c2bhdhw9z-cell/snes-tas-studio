# cores/ — compiled WASM libretro cores (bundled + committed)

This directory holds the libretro SNES cores compiled to WebAssembly via Emscripten.

**Now bundled + committed:** three **from-source, raw-libretro** cores compiled to
WebAssembly ship here so the app deploys to Netlify with a working, user-selectable engine:

| Core | Files | Export name | ASYNCIFY | Role |
| --- | --- | --- | --- | --- |
| Real-Time (snes9x) | `snes9x_libretro.js` + `.wasm` | `snes9x` | **no** | real-time playback (default) |
| Accuracy (bsnes-mercury) | `bsnes_mercury_accuracy_libretro.js` + `.wasm` | `bsnes_accuracy` | yes | paused frame-perfect (cycle-accurate) |
| Performance (bsnes-mercury) | `bsnes_mercury_performance_libretro.js` + `.wasm` | `bsnes_performance` | yes | faster bsnes profile |

`core.json`, `snes9x.json`, `build.json` and `license.txt` accompany them. These files are
intentionally **not** git-ignored. The **Core** dropdown in the toolbar switches between the
three at runtime (defaults to **Real-Time (snes9x)**). This is an emulator-core choice only
— **not** a ROM/level picker, and it grants no cheat/memory-write capability.

## snes9x — the default real-time core (NO ASYNCIFY)

`snes9x_libretro.*` is a fresh from-source raw-libretro build of
[`libretro/snes9x`](https://github.com/libretro/snes9x) (`master`) compiled to WASM with an
added `platform=emscripten` Makefile block modeled on the bsnes one but **without ASYNCIFY**.
snes9x does not use libco cooperative cothreads, so `retro_run()` returns each frame
**synchronously** — fast enough for real-time playback on the mobile main thread (the whole
reason this core was added). Verified:

```sh
node tools/run-smoke.mjs cores/snes9x_libretro.js 60   # ALL ASSERTIONS PASSED, ~1.1 ms/frame
node tools/core-probe.mjs   # (CORE=cores/snes9x_libretro.js) 17/17 retro_*, addFunction yes
```

Build (reproduce): clone `libretro/snes9x`, add the emscripten block (see `snes9x.json` for
the exact flag set — same 22 `retro_*` exports + runtime methods as bsnes, `EXPORT_NAME=snes9x`,
`MODULARIZE`+`EXPORT_ES6`, `ALLOW_TABLE_GROWTH`, **no** `-s ASYNCIFY`), then
`emmake make platform=emscripten -j$(nproc)` and copy `snes9x_libretro.{js,wasm}` here.

Its Live-HUD WRAM map is tracked separately and is currently **unverified** on snes9x (see
`snes9x.json` and `memory-watch.js`'s per-core map) — the bsnes offsets do not track Mario on
snes9x's `SYSTEM_RAM` region.

## bsnes-mercury (accuracy + performance)

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

## No-ASYNCIFY bsnes-accuracy experiment (FEAT-003) — attempted, fell back

As part of the Web Worker migration we tested whether bsnes-accuracy could ship **without
ASYNCIFY** (a smaller, faster core) now that `retro_run` runs inside a Worker, where blocking
the worker thread would not freeze the UI. The user specifically asked to try
`-s SUPPORT_LONGJMP=wasm` and native fiber switching for libco's cothreads.

**Attempted.** Built bsnes-accuracy with **no `-s ASYNCIFY`**, adding
`-s SUPPORT_LONGJMP=wasm` + `-fwasm-exceptions`, a distinct output name
(`bsnes_mercury_accuracy_libretro_noasyncify.{js,wasm}`, `EXPORT_NAME=bsnes_accuracy_noasyncify`),
keeping `-s ENVIRONMENT=web,worker,node`, MODULARIZE + EXPORT_ES6, ALLOW_TABLE_GROWTH, the
same 22 `retro_*` exports, single-threaded. The Emscripten Fibers libco backend is built **on
top of Asyncify** (`emscripten_fiber_*` need `-s ASYNCIFY`), so it cannot be used here; libco
was pointed at the **sjlj** backend under `LIBCO_NO_ASYNCIFY`, relying on
`-s SUPPORT_LONGJMP=wasm` for longjmp. (Both edits are additive + gated in the
`/projects/bsnes-mercury` source, so the shipping ASYNCIFY build is unchanged.)

**Result: FELL BACK.** The build **compiled + linked** (`.wasm` ~1.6 MB vs ~3.7 MB for the
ASYNCIFY build) and **loaded** (`retro_load_game()==true`, av_info 256x224@60), but the very
**first `retro_run()` threw a `WebAssembly.Exception`** (0 frames advanced) under
`node tools/run-smoke.mjs …_noasyncify.js 12`. Root cause: libco's sjlj backend swaps cothreads
via `sigaltstack`/`raise(SIGUSR1)`/`sigsetjmp`/`siglongjmp`, which do **not** perform a real
stack switch under WASM; `SUPPORT_LONGJMP=wasm` only turns C `longjmp` into a Wasm-EH throw, so
the cothread "switch" unwinds as an exception out of `retro_run` instead of transferring control
to the CPU/PPU cothread. This is the same class of failure that originally forced ASYNCIFY +
Emscripten Fibers.

**Decision:** no new core shipped, no build detritus committed. **snes9x-in-a-worker**
(synchronous, no ASYNCIFY) remains the real-time default and already resolves the user's iOS
main-thread issue; the two ASYNCIFY bsnes cores remain for paused frame-perfect work. All three
shipping cores still pass `run-smoke` after the experiment. Full record: `cores/build.json`
(`noasyncify_experiment`).

## Distinct filenames + export names

Each profile is emitted with a **distinct filename** and a **distinct MODULARIZE
`EXPORT_NAME`** (`bsnes_accuracy` / `bsnes_performance`) so the two cores never collide on a
shared global/UMD symbol when both are referenced. Both are emitted as **ES6 modules**
(`-s EXPORT_ES6=1`), so `core/core-loader.js` resolves either one via its dynamic-import
default-export path. (The `snes9x` core above uses its own distinct `EXPORT_NAME=snes9x`, so
all three coexist without colliding.)

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
