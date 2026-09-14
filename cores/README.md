# cores/ — compiled WASM libretro core drop location (runtime only)

This directory holds the accuracy-focused libretro SNES core compiled to WebAssembly via
Emscripten. The binaries are **built/dropped here at deploy time** and are **NEVER
committed** (they are git-ignored: `cores/*.wasm`, `cores/*.js`, `cores/*.data`).

## Expected files (in preference order)

The core loader tries these paths in order:

1. `cores/bsnes_mercury_accuracy_libretro.js` (+ `.wasm`) — **preferred**, cycle-accurate
   (bsnes-mercury / higan-derived). Runs the game 100% authentically.
2. `cores/snes9x_libretro.js` (+ `.wasm`) — fallback. Faster but **not** cycle-accurate;
   some frame-precise glitches may not reproduce identically. Use only if the accuracy
   core is unavailable.

## Build recipe (run at deploy time; requires network + emsdk — NOT run in this repo)

```sh
# 1. Install the Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
cd ..

# 2. Build the preferred accuracy core (bsnes-mercury)
git clone https://github.com/libretro/bsnes-mercury.git
cd bsnes-mercury
emmake make -f Makefile.libretro platform=emscripten PROFILE=accuracy
# produces bsnes_mercury_accuracy_libretro.js + .wasm — copy both into ../cores/

# (fallback) snes9x
#   git clone https://github.com/libretro/snes9x.git
#   cd snes9x/libretro && emmake make platform=emscripten
#   copy snes9x_libretro.js + .wasm into cores/
```

If no core is present the app renders a graceful "Emulator core not found" notice and the
UI stays usable in a disabled state.
