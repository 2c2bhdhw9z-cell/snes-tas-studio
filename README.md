# SNES TAS Studio

A standalone, offline **Progressive Web App** that is a pure, cycle-accurate **SNES
Tool-Assisted Speedrun (TAS) studio**. It runs the game 100% authentically so complex
glitches can be executed strictly through in-game routing and inputs.

> **Hard product rules (enforced throughout the code):**
> - **NO cheat menus, NO RAM injectors, NO level selectors.**
> - Memory access is **strictly read-only** (HUD observation only).
> - **No file picker.** The ROM auto-boots from a fixed path.
> - The game runs 100% authentically.

## The honest cycle-accuracy decision (read this first)

The product goal is a **cycle-accurate** SNES so glitches reproduce exactly as they do on
hardware. That constraint drives the core choice, and it is worth being blunt about the
tradeoff:

- **Snes9x is NOT cycle-accurate.** It is fast and highly compatible, but it approximates
  timing. Sub-frame / timing-dependent glitches (the kind TAS routing relies on) can behave
  differently than on real hardware. Naming it "cycle-accurate" would be dishonest.
- **True cycle accuracy needs a bsnes / higan-derived core.** The accuracy profile of
  bsnes (and its libretro descendants) emulates the SNES at the cycle level.

**What this project ships — a two-family workflow:** **three** libretro cores compiled to
WebAssembly, selectable from a **Core** dropdown in the toolbar:

- **Real-Time (snes9x)** — the **default** boot core. Built from source **without ASYNCIFY**,
  so `retro_run()` is a normal **synchronous** call that returns each frame. That makes it
  fast enough for **real-time routing/playback on the mobile main thread**, which the heavy
  ASYNCIFY bsnes cores are not (unpaused, they turn the frame rate into a slideshow and the
  blocked main thread swallows touch input on iOS).
- **Accuracy (bsnes-mercury)** — the bsnes/higan-derived, cycle-accurate core. Use it
  **paused** for frame-perfect, sub-pixel-precise manipulation.
- **Performance (bsnes-mercury)** — a faster (still ASYNCIFY) bsnes profile.

The intended workflow is therefore: **snes9x for real-time playback/routing (default), bsnes
(paused) for frame-perfect sub-pixel work.** snes9x is *not* cycle-accurate — that is the
explicit, honest tradeoff of using it for the real-time role while the cycle-accurate bsnes
core remains one dropdown-click away for the precision work.

## Bundled cores: snes9x (synchronous, default) + bsnes-mercury (ASYNCIFY, accuracy + performance)

Three genuine **raw-libretro cores**, **built from source** and compiled to WebAssembly with
Emscripten, are **bundled and committed** under `cores/`:

| Core | Files | Export name | ASYNCIFY | Role |
| --- | --- | --- | --- | --- |
| Real-Time (snes9x) | `snes9x_libretro.js` + `.wasm` | `snes9x` | **no** | real-time playback (default) |
| Accuracy (bsnes-mercury) | `bsnes_mercury_accuracy_libretro.js` + `.wasm` | `bsnes_accuracy` | yes | paused frame-perfect (cycle-accurate) |
| Performance (bsnes-mercury) | `bsnes_mercury_performance_libretro.js` + `.wasm` | `bsnes_performance` | yes | faster bsnes profile |

(plus `core.json`, `snes9x.json`, `build.json`, `license.txt`). The **Core** dropdown swaps
between them at runtime; this is an emulator-core choice only — **not** a ROM/level picker.

### snes9x (the real-time core)

- **Source:** [`libretro/snes9x`](https://github.com/libretro/snes9x) @ branch `master`,
  built with an added `platform=emscripten` Makefile block (modeled on the bsnes one but
  **without** ASYNCIFY). **Toolchain:** Emscripten (emsdk) **6.0.9**.
- **NO ASYNCIFY (the performance win):** snes9x does not use bsnes's libco cooperative
  cothreads, so `retro_run()` returns each frame **synchronously** — no stack unwind, no
  suspend. Verified by `tools/run-smoke.mjs cores/snes9x_libretro.js 60`: **ALL ASSERTIONS
  PASSED**, ~**1.1 ms/frame** (60 frames in 66 ms) vs the bsnes cores' ~73-235 ms/frame, and
  the JS loader contains zero `asyncify` references. WASM is ~3.3 MB. Distinct
  `EXPORT_NAME=snes9x` and an ES6 default-export factory (`-s EXPORT_ES6=1`), so
  `core-loader.js` resolves it via dynamic import like the others.
- **Live HUD memory map (honest status):** snes9x reports the same 131072-byte
  `RETRO_MEMORY_SYSTEM_RAM` size as bsnes, but its region has a **different base/mirroring** —
  the bsnes-verified SMB1 All-Stars offsets do **not** track Mario on it
  (`tools/hud-crosscheck.mjs` against the snes9x core fails every physics proof at those
  offsets). `memory-watch.js` therefore keeps a **per-core** map keyed on
  `engine.activeCoreId`: the bsnes rows stay empirically proven and render clean, while the
  snes9x rows render an explicit **"(unverified)"** tag until snes9x's own offsets are proven
  (the project's rule is to never present an unproven address as confirmed). The frame counter
  is engine-sourced and correct on every core.

- **Source:** [`libretro/bsnes-mercury`](https://github.com/libretro/bsnes-mercury) @
  commit `79d7f9d`, `PROFILE=accuracy` and `PROFILE=performance`.
- **Toolchain:** Emscripten (emsdk) **6.0.9**.
- **ASYNCIFY (critical):** bsnes uses **libco** cooperative cothreads; in a plain
  non-ASYNCIFY WASM build `retro_run()` never returns (the scheduler never yields to JS) and
  the first frame hangs. Both cores are built with **`-s ASYNCIFY=1`** plus an **Emscripten
  Fibers** libco backend (`libco/emscripten.c`, so cothread switches cooperate with
  ASYNCIFY). With both in place `retro_run` yields and returns on both profiles — proven by
  `tools/run-smoke.mjs`. ASYNCIFY inflates the binaries to ~3.7 MB each.
- **Filenames + export names:** each core has a **distinct filename** and a **distinct
  MODULARIZE `EXPORT_NAME`** (`snes9x` / `bsnes_accuracy` / `bsnes_performance`) so they never
  collide; all are ES6 modules (`-s EXPORT_ES6=1`) that `core-loader.js` resolves via dynamic
  import. The `cores/snes9x_libretro.*` files are a **fresh from-source raw-libretro build**
  (17/17 `retro_*` exports, 0/10 EmulatorJS high-level API per `tools/core-probe.mjs`) — not
  the old EmulatorJS file of the same name that was removed earlier. See `cores/core.json`,
  `cores/snes9x.json`, `cores/build.json`.
- **License:** bsnes-mercury is **GPLv3** (`cores/license.txt`); the app as shipped is
  therefore subject to GPLv3.

**It IS drivable by our thin frontend.** The core exports the raw `retro_*` C ABI and was
linked with `-sALLOW_TABLE_GROWTH`, so `Module.addFunction` is available to register the
libretro environment/video/audio/input callbacks. `tas-engine.js` (a raw-libretro frontend
that `cwrap`s the `retro_*` exports) can drive it directly. Verified by the Node harness
`tools/core-probe.mjs`, which instantiates the actual core and reports:

```
raw retro_* ABI exports present : 17/17
Module.addFunction available    : yes
```

**Accuracy tradeoff (honest note):** the accuracy profile is larger (~1.5 MB WASM) and
slower than a performance core. That is the correct tradeoff for a TAS studio, where
frame-precise, hardware-faithful behavior matters more than raw speed.

**Rebuilding the core** is documented in `cores/README.md` (emsdk install, bsnes-mercury
clone, the Makefile emscripten-block edit, and the full Emscripten link flag set).

**Why libretro specifically?** The libretro ABI exposes exactly the three primitives a TAS
studio needs, which is why the whole engine is a thin libretro frontend:

- `retro_run()` — advance **exactly one video frame** (deterministic frame stepping).
- `retro_serialize()` / `retro_unserialize()` — **save/load state** for re-recording.
- `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)` — a pointer to WRAM for the
  **read-only** HUD (Mario X/Y sub-pixel, speed).

## Architecture

This is a **static, client-side vanilla-JS PWA** (no framework, no build step to run). It
uses a **thin custom libretro JS frontend** (not the full EmulatorJS UI) so we control
frame-advance, state serialize/deserialize, and raw read-only memory peek directly.

### The emulator runs single-threaded in one main-thread rAF loop (why, and how)

**The Great Reversal.** The emulator used to run in a dedicated Web Worker. That was a
misdiagnosis. The main thread only ever choked on iOS because of three now-fixed bugs: a
`setTimeout(0)` clamp that half-vsync-locked the loop, ~300 DOM nodes/sec banner+HUD churn,
and a per-frame HUD object allocation storm. With all three fixed (cached DOM nodes mutated
in place, one reused HUD values object, a bounded target-time accumulator), the numbers are
clear: snes9x executes `retro_run` in **~1.2 ms**, which fits comfortably inside a 16.6 ms
frame budget without blocking touch. The Web Worker added cross-thread `postMessage` latency,
transferable pooling, and iOS WebKit bridging that were themselves incompatible with iOS
Safari's GC at 60 Hz - the decay persisted even on the worker-computes + main-thread-WebGL
fallback path, which proved the boundary itself was the liability.

**The fix:** the emulator moves **back onto the main thread** and runs in **one tight
`requestAnimationFrame` loop**. There is **no Web Worker, no `postMessage`, no
`MessageChannel`, and no `OffscreenCanvas`** anywhere in the running app. `emu-worker.js` is
retired. `tas-engine.js` is now the single-thread engine: it **owns** one `EmuCoreRunner`
(the libretro glue), one `InputResolver` (the authoritative scripted log, now in-process), and
one `GLPresenter` (the WebGL presenter on the DOM canvas), and drives them all from its own
rAF loop.

```
 main thread - one requestAnimationFrame loop
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ app.js (bootstrap) · piano-roll.js (UI + input) · memory-watch.js (HUD)    │
 │ tas-engine.js (TASEngine)                                                  │
 │   ├ input-resolver.js  (authoritative scripted InputLog, in-process)       │
 │   ├ emu-core-runner.js (libretro ABI + target-time accumulator + decode)   │
 │   └ gl-presenter.js    (one texture, per-frame texSubImage2D + drawArrays) │
 │                                                                            │
 │  each rAF tick, IN ORDER:                                                  │
 │    (a) read inputs  → resolved inside retro_run via getFrameInputMask      │
 │    (b) retro_run    → advance emulation (bounded catch-up, frame-skip)     │
 │    (c) update HUD   → from the cached read-only WRAM view                  │
 │    (d) present ONCE → gl.texSubImage2D + gl.drawArrays (latest frame)      │
 └──────────────────────────────────────────────────────────────────────────┘
```

**How each concern works now (all in-process):**

- **Input (deterministic).** The **authoritative scripted `InputLog` lives in-process** in the
  engine's `InputResolver`. `piano-roll.js` applies `sendInputEdit()` edits (`setFrameButton` /
  `truncateAfter` / `restoreSnapshot`) when you toggle a piano-roll cell, and streams the
  **live** controller/touch mask each animation frame via `sendLiveMask()`. The runner resolves
  **exactly `(log.getMask(frame) | liveMask) >>> 0`** at the instant `retro_run` pulls input
  for the frame it is about to run - so frame N always runs with frame N's input and never
  N+1's. Frame-advance runs **exactly one** `retro_run` with that frame's resolved input.
- **The single rAF loop (the heart of this).** The engine owns **one**
  `requestAnimationFrame` loop and paces the runner's target-time accumulator with it. Each
  tick, in order: (a) inputs are resolved inside `retro_run`; (b) the accumulator advances
  emulation up to real time - **1-2 `retro_run` at 1x (~60/sec), ~30/sec at 0.5x**, with
  bounded catch-up (`MAX_CATCHUP_FRAMES`) so a slow device **frame-skips** instead of bursting
  (no death-spiral); (c) the HUD updates from the cached read-only WRAM view; (d) the engine
  presents **exactly one** frame - the **latest** decoded that turn - via `gl.texSubImage2D` +
  `gl.drawArrays`, so even a catch-up or fast-forward burst issues **one present per refresh**.
  rAF gives **native vsync pacing + implicit WebGL backpressure**: the browser will not
  schedule the next rAF until the previous frame's GL commands are consumed, so the command
  queue cannot flood. Frame-advance while paused is a **separate one-shot present**, not the
  loop.
- **Video (WebGL on the main thread).** `attach()` builds a `GLPresenter` directly on the DOM
  canvas via `createGLPresenter(canvas, 'main')` - one texture + one program + one quad, with
  per-frame `texSubImage2D` + `drawArrays` (no per-frame `putImageData`). A 2D `putImageData`
  context is kept **only** as a last resort when WebGL is unavailable (e.g. jsdom). The active
  present path is surfaced in the status snapshot as `videoPath`, so the debug banner **Video**
  field reads **`main-webgl2`** (or `main-webgl1` / `main-2d`). **On-device steady-FPS is the
  final judge** of the reversal.
- **ASYNCIFY (bsnes) single-threaded.** The bsnes accuracy/performance cores are ASYNCIFY, so
  `retro_run` may return a Promise (libco/Asyncify can have **at most one** suspension
  outstanding). The runner **awaits** each `retro_run`; the engine's rAF wrapper **awaits** the
  tick before presenting the stashed frame and before scheduling the next rAF, so only one
  suspension is ever outstanding and exactly one present happens per rAF. snes9x (synchronous)
  presents immediately after the tick.
- **HUD (read-only).** The runner reads the verified SMB1 WRAM addresses **read-only** each
  frame into one reused values object. `getMemoryView()` returns the runner's **cached
  read-only** WRAM view (rebuilt only when the WRAM ptr/size changes), which exposes read
  accessors only (`readU8`/`readS8`/`readU16`/`readS16`/`snapshot`) - there is **no write
  path** anywhere. `memory-watch.js` renders from it, observation only.
- **Save / load.** `saveState()` returns a Promise resolving to the runner's serialized
  `Uint8Array`; `loadState(bytes, {frame})` calls `retro_unserialize` in-process and fires
  `onStateLoaded` so re-record truncation still runs, then presents the restored frame once.
- **Core switch.** The **Core** dropdown calls `setCore(path)`, which tears the current runner
  down and re-boots the selected core in-process, restoring the prior paused state (snes9x is
  driven as a **synchronous** loop; the ASYNCIFY bsnes cores are **awaited**). snes9x remains
  the default.

| File | Role |
| --- | --- |
| `index.html` | App shell: iOS/standalone/no-bounce meta tags, canvas, HUD, piano-roll, frame controls, save-state tree, touch controls, notice banner, on-screen debug banner. Loads `app.js` as the bootstrap module. |
| `app.js` | App-level bootstrap/orchestration: service-worker registration, engine attach/init wiring (attach() builds the main-thread WebGL presenter on `#screen`; no worker, no canvas transfer), iOS bounce/pinch gesture suppression, and the always-visible on-screen debug banner (WASM core status, ROM fetch status, and a `window.onerror`/`unhandledrejection` listener that prints uncaught JS/WASM errors on screen). Status/errors only - adds no emulation, memory-write, cheat, or level-select capability. |
| `tas-engine.js` | The **single-thread main-thread engine** (`window.TASEngine`). **Owns** one `EmuCoreRunner`, one in-process `InputResolver`, and one `GLPresenter`, and drives them from **one `requestAnimationFrame` loop** (read input → `retro_run` → update HUD → `texSubImage2D` + `drawArrays`, one present per rAF). Exposes `currentFrame`/`status`/`coreStatus`/`romStatus`/`engineStatus`/`activeCoreId`/`videoPath` for the banner + piano-roll + HUD. **No** `new Worker`/`postMessage`/`MessageChannel`/`OffscreenCanvas`. |
| `emu-core-runner.js` | The **DOM-free libretro core runner** (now driven on the main thread): dynamic-imports the core, fetches the ROM (`encodeURI`), `cwrap`s the `retro_*` ABI, installs env/video/audio/input callbacks, runs the target-time accumulator loop (synchronous snes9x; ASYNCIFY bsnes awaits `retro_run`), decodes the framebuffer to RGBA, save/load, and cached read-only WRAM/HUD reads. Dependency-injected + unit-testable in Node with a mock core. |
| `input-resolver.js` | The **deterministic input resolver** (in-process): wraps the authoritative `InputLog` and resolves `(log.getMask(frame) \| liveMask) >>> 0`; applies the scripted-edit op protocol. Pure, DOM-free, unit-testable. |
| `piano-roll.js` | The TAS Studio UI (`TASStudio`): piano-roll input editor (cell toggle → local mirror log **+** `engine.sendInputEdit()`), frame-control toolbar, save-state tree with re-record truncation, and the per-animation-frame live-mask stream via `engine.sendLiveMask()`. Owns a local **mirror** `InputLog` (for grid rendering) and the `LiveInput`. |
| `input-log.js` | Pure, DOM-free per-frame input log (`InputLog`): a libretro joypad bitmask per frame, plus the `truncateAfter` re-record primitive. Used as the engine's authoritative log **and** the UI's render mirror. Unit-testable in Node. |
| `live-input.js` | Real-time controller input (`LiveInput`): HTML5 Gamepad API polling + on-screen touch controls; its mask is streamed to the engine and OR-ed into the frame `retro_run` runs next. |
| `gl-presenter.js` | The **WebGL video presenter**: one texture + one program + one quad, created once; per-frame `texSubImage2D` + `drawArrays` (a `texImage2D` realloc only on geometry change). Built on the DOM canvas via `createGLPresenter(canvas, 'main')` - labels `main-webgl2`/`main-webgl1`. Returns `null` when WebGL is unavailable so the engine falls back to a 2D context (`main-2d`). |
| `memory-watch.js` | Read-only Live HUD: renders Mario X/Y sub-pixel, horizontal speed, and the frame counter from the runner's cached read-only WRAM view via `engine.getMemoryView()` (observation only). |
| `core/core-loader.js` | Fetches + instantiates the Emscripten libretro core **on the main thread**; degrades gracefully when absent. |
| `sw.js` | Service worker (`tas-studio-v22`): cache-first offline app shell, precaching `tas-engine.js` + `emu-core-runner.js` + `input-resolver.js` + `gl-presenter.js`. **Never caches the ROM.** |
| `manifest.json` | PWA manifest: standalone, landscape, dark theme, icons. |
| `styles.css` | Studio UI + low-opacity on-screen touch controls. |
| `icons/` | PWA icons (placeholder solids; regenerate with `tools/make-icons.js`). |
| `cores/` | Bundled from-source **bsnes-mercury** WASM cores - **accuracy** (`bsnes_mercury_accuracy_libretro.*`, `EXPORT_NAME=bsnes_accuracy`) and **performance** (`bsnes_mercury_performance_libretro.*`, `EXPORT_NAME=bsnes_performance`), plus `core.json`, `build.json`, GPLv3 `license.txt` - **committed** and deployed. Both are ASYNCIFY builds so `retro_run` yields (proven by `tools/run-smoke.mjs`) and are selectable from the toolbar **Core** dropdown. |
| `assets/` | **Runtime drop location** for the ROM. Not committed. |

### Verified libretro ABI hooks (from `libretro.h`)

- `retro_run()` — advance exactly one video frame.
- `retro_serialize_size` / `retro_serialize` / `retro_unserialize` — save/load state.
- `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM=2)` + `retro_get_memory_size(2)` — WRAM base
  pointer/size for **read-only** reads.
- `retro_set_video_refresh` / `retro_set_audio_sample_batch` / `retro_set_input_poll` /
  `retro_set_input_state` callbacks.

`retro_cheat_set` / `retro_cheat_reset` are intentionally **never** wrapped or called.

## Dropping in the ROM (at deploy time)

The ROM is **copyrighted, supplied by you, and never committed**. Place your legally-owned
copy here with this exact filename so it auto-boots:

```
assets/Super Mario All-Stars (USA).sfc
```

If it is missing, the app shows a graceful "ROM not found" notice and stays usable — it
never crashes and never falls back to a file chooser.

## The emulator core (already built and committed)

Unlike the ROM, the compiled WASM cores **are committed** to this repo (under `cores/`) so
the app deploys with a working engine. They are from-source **bsnes-mercury** cores
(accuracy + performance) built with **Emscripten (emsdk 6.0.9)** from
[`libretro/bsnes-mercury`](https://github.com/libretro/bsnes-mercury) @ `79d7f9d`, each with
**`-s ASYNCIFY`** so `retro_run` yields to the browser instead of hanging in bsnes's libco
scheduler (see `cores/README.md` for the full ASYNCIFY + Emscripten-Fibers explanation).

To **rebuild** them yourself:

```sh
# 1. Install and activate the Emscripten SDK.
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh && cd ..

# 2. Build BOTH cores with the Emscripten toolchain.
#    NOTE: the upstream emscripten platform block only emits an intermediate LLVM bitcode
#    archive (.bc); it was edited to perform the full Emscripten link to .js + .wasm with
#    the raw-libretro flags (ALLOW_TABLE_GROWTH, exported retro_* + runtime methods), to add
#    -s ASYNCIFY=1 + a per-profile distinct EXPORT_NAME, and an Emscripten Fibers libco
#    backend (libco/emscripten.c) so cothread switches cooperate with ASYNCIFY.
git clone https://github.com/libretro/bsnes-mercury.git
cd bsnes-mercury
find . -name '*.o' -delete
emmake make platform=emscripten PROFILE=accuracy -j$(nproc)
find . -name '*.o' -delete
emmake make platform=emscripten PROFILE=performance -j$(nproc)

# 3. Copy all four output files into cores/ (names are already the honest bsnes names):
cp bsnes_mercury_accuracy_libretro.js    ../<repo>/cores/
cp bsnes_mercury_accuracy_libretro.wasm  ../<repo>/cores/
cp bsnes_mercury_performance_libretro.js   ../<repo>/cores/
cp bsnes_mercury_performance_libretro.wasm ../<repo>/cores/

# 4. Prove retro_run yields on both (bounded, non-hanging headless harness):
cd ../<repo>
node tools/run-smoke.mjs cores/bsnes_mercury_accuracy_libretro.js 12
node tools/run-smoke.mjs cores/bsnes_mercury_performance_libretro.js 12
```

The full flag set and Makefile edit are documented in
[`cores/README.md`](cores/README.md) and `cores/build.json`. The loader
(`core/core-loader.js`) loads the single committed core at
`cores/bsnes_mercury_accuracy_libretro.js` (with its sibling
`cores/bsnes_mercury_accuracy_libretro.wasm`).

If no core is present, the app shows a graceful "core not found" notice and stays usable.

## Design guarantees (enforced in code)

These are hard product rules, enforced by construction, not just by policy:

- **No cheats.** `retro_cheat_set` / `retro_cheat_reset` are never wrapped or called
  anywhere. There is no cheat menu.
- **No RAM injector.** There is no code path that writes to emulator memory. The only
  memory access is `getMemoryView()`, which exposes **read accessors only**
  (`readU8` / `readU16` / `readS16` / `snapshot`) — no poke/write/inject.
- **No level selector.** There is no stage-jump / level-warp logic. The game is played
  from boot, authentically.
- **No file picker.** The ROM auto-boots from a fixed path; there is no `<input type=file>`
  anywhere in the app.
- **Runs authentically.** The studio only advances frames and feeds controller input; it
  never manipulates game state.

## Mobile & speedrun input

- **HTML5 Gamepad API (zero-latency).** Paired Bluetooth pads (Xbox / PlayStation /
  8BitDo) in the browser "standard mapping" are polled once per frame **inside the same
  `requestAnimationFrame` tick as `retro_run`**, so live input has no extra frame of lag.
  `gamepadconnected` / `gamepaddisconnected` are handled. Standard mapping is translated to
  SNES buttons in `live-input.js` (`GAMEPAD_STANDARD_MAP`): bottom face → **B**, right face
  → **A**, left face → **Y**, top face → **X**, bumpers → **L/R**, d-pad → d-pad,
  start/select → **Start/Select**. The left analog stick also acts as a d-pad.
- **Low-opacity on-screen touch controls.** A minimal overlay (`#touch-controls`) with a
  D-Pad and A/B/X/Y/L/R/Start/Select at ~0.22 opacity. Buttons use pointer/touch events and
  set/clear live bits.
- **How live input merges with the timeline.** Both the gamepad and touch controls feed a
  single **live mask** (`LiveInput.getMask()`), polled on the main thread and **streamed to
  the worker** (`{type:'liveMask'}`) each animation frame. The worker OR-s the latest live
  mask into the **scripted `InputLog`** mask for the frame it runs next — i.e. exactly
  `(log.getMask(frame) | liveMask) >>> 0`. Live play/record and the scripted timeline coexist
  without one clobbering the other, and the determinism contract holds without a synchronous
  per-frame pull across the boundary.

## Running locally

```sh
# Serve the directory statically over HTTP (service workers require http/https).
python3 -m http.server 8080
# then open http://localhost:8080/
```

## Installing as an iOS PWA

1. Serve the app over **HTTPS** (or `localhost`) — service workers and PWA install require
   a secure context.
2. Open the site in **Safari on iOS**.
3. Tap **Share → Add to Home Screen**. The `manifest.json` (`display: standalone`,
   landscape, dark theme, icons) and the `apple-mobile-web-app-*` meta tags make it launch
   fullscreen with no browser chrome.
4. Once loaded, the service worker precaches the shell so it works **100% offline** — the
   ROM is intentionally excluded from the cache and stays local to your device.

iOS gesture lockdown is handled by the viewport meta
(`maximum-scale=1, user-scalable=no, viewport-fit=cover`), `overscroll-behavior: none` +
`touch-action: none` CSS on a `position: fixed` root, and JS `preventDefault` on
`gesturestart` / `gesturechange` / `gestureend` and multi-touch pinch `touchmove`. The
piano-roll container re-enables touch panning so the timeline still scrolls.

## What is verified vs. what needs the ROM

**Verified now (no ROM / no core required):**

- App boots; service worker registers; graceful "ROM not found" / "core not found" notices.
- No file picker anywhere in the DOM.
- Piano-roll grid renders with per-frame rows and A/B/X/Y/L/R/D-Pad/Start/Select columns;
  clicking a cell toggles it.
- Frame-control toolbar (frame advance, play/pause, 0.1x–2x speed slider, fast-forward) and
  the HUD placeholders render.
- Save → Load truncates the input log after the loaded frame (re-recording).
- On-screen touch controls render at low opacity; gamepad polling code + gesture-suppression
  handlers are present; no memory-write/cheat/level-select capability exists.
- Offline: a second load with the network down still serves the cached shell.
- The bundled **bsnes-mercury accuracy** WASM core instantiates and exposes the raw
  libretro ABI our frontend needs: `node tools/core-probe.mjs` reports **17/17** `retro_*`
  exports present and **`addFunction: yes`**, so `tas-engine.js` can drive it.

**Verified now (worker-proxy boundary, headless with mocks):**

- The proxy (`tas-engine.js`) creates a **module worker** and does **no** synchronous WASM
  work (`tools/engine-smoke.mjs`).
- **Determinism across the boundary:** frame N runs with exactly
  `(log.getMask(N) | latestLiveMask) >>> 0`, never N+1's input; frame-advance = one frame;
  re-record truncation holds after a load (`tools/worker-boundary.test.mjs`,
  `tools/emu-worker.test.mjs`).
- **Both video paths:** OffscreenCanvas-transferred (worker blits, no `{type:'video'}`) and
  the fallback (`{type:'video'}` + main-thread blit) (`tools/worker-boundary.test.mjs`).
- **Streamed read-only HUD** carries the verified SMB1 addresses; **save/load round-trips**
  over transferable bytes; no memory-write/cheat path crosses the boundary.
- The worker's **self-scheduling run loop** (speed 0.1×–2×, fast-forward burst, one-frame
  step, ASYNCIFY awaiting) via `tools/runloop.test.mjs`.

**Requires the ROM (the core is present; gameplay still needs a legally-owned ROM):**

- Actual gameplay / video output.
- Real save-state bytes via `retro_serialize` / `retro_unserialize`.
- Real HUD values against the real ROM.
- End-to-end gamepad-driven play latency.

### Device-only (CANNOT be confirmed headless — only on the physical device)

These depend on the real iOS Safari runtime and cannot be proven by the Node/jsdom harnesses;
they must be checked on the actual hardware:

- **Actual iPhone FPS** with the emulator in the worker (the whole point of the migration —
  headless timing does not represent the device GPU/CPU or Safari's scheduler). *Target: the
  ~15 FPS main-thread slideshow is replaced by real-time snes9x playback.*
- **Real touch responsiveness** — that the virtual controller and UI buttons respond
  immediately now that the main thread is never blocked by `retro_run`.
- **OffscreenCanvas behavior on the user's exact Safari version** — whether
  `transferControlToOffscreen` + the worker WebGL present is taken, or the `{type:'video'}`
  fallback is used, on that specific iOS build.
- **The sustained 60-FPS hold under the V-Sync-bound present loop** — the headless harnesses
  prove the *mechanism* (present is now **one draw per rAF**, vsync-paced and backpressured,
  instead of open-loop per emulated frame, with exactly one loop driver active). Whether that
  actually stops the iOS **GPU-command-queue** decay (the 60 → 12 slide) can only be confirmed
  on the physical device: reload and watch the FPS meter **hold** steady with the debug
  banner's **Video** field reading `offscreen-webgl2`. **On-device FPS-hold is the final judge.**
- **The FEAT-003 no-ASYNCIFY bsnes result on-device** — documented as a NEGATIVE result
  (libco cothread switch throws a Wasm exception out of `retro_run` even off the main thread;
  no core shipped). See `cores/README.md` / `cores/build.json`. snes9x-in-worker remains the
  real-time default; confirming this on the device is the final check.

### The BLINDFOLD test (`?blindfold=1`) — is it the WASM core, or Apple's WebGL?

The monotonic 60 → 8 FPS decay on the physical device has now survived the elimination of the JS
heap, the WASM heap, native transferable memory, GPU command-queue flooding, OffscreenCanvas and
the **entire Web Worker + postMessage bridge** (The Great Reversal). Two suspects remain:

1. the `snes9x.wasm` core leaking/fragmenting on every `retro_run`, or
2. iOS Safari leaking natively inside `gl.texSubImage2D` / main-thread WebGL presentation.

**Blindfold mode** separates them. It runs the rAF loop, input resolution, `retro_run` (same
accumulator, same bounded catch-up), the framebuffer **decode** into the reused RGBA buffer, the
HUD reads, `onFrame` emission and the FPS meter **exactly as normal**, and skips **only** the
per-frame GPU upload+draw: `tas-engine.js`'s single present choke point `_present()` returns
before any `texSubImage2D`, `drawArrays` or `putImageData`. Presenter/GL-context **setup is
deliberately unchanged**, so the only variable between the two runs is the per-frame GPU work.

Three ways to drive it (default **OFF** — a fresh load behaves exactly as before):

| Route | How |
| --- | --- |
| URL at boot | `…/index.html?blindfold=1` (alias `?noPresent=1`; bare `?blindfold` also works) |
| On screen | the **“Blindfold (no present)”** checkbox in the frame-controls toolbar, next to the FPS readout — flips live, no reload |
| Programmatic | `window.TASEngine.setBlindfold(true \| false)`, read back with `isBlindfold()` or the `blindfold` property |

The debug banner states the active mode twice, so a phone screen recording can never attribute an
FPS number to the wrong mode: **`Present: ON`** with `Video: main-webgl2` normally, and
**`Present: OFF (BLINDFOLD)`** with `Video: main-webgl2 (BLINDFOLD: no present)` while
blindfolded (banner + toggle turn warning-colored).

**Reading the result on-device** (watch the FPS field for ≥45 s):

- FPS **still decays to ~8** → the drawing was never the problem: the **snes9x WASM core** is
  leaking/fragmenting per `retro_run`. Next step: swap cores.
- FPS **holds at 60** → emulation is innocent: **Apple's WebGL present path** is leaking. Next
  step: find a non-WebGL present path.

The screen stays frozen while blindfolded — that is expected; the FPS counter is the signal.

## Dev tooling / tests

```sh
# Syntax-check all JS
for f in *.js core/*.js; do node --check "$f"; done

# Validate manifest
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"

# Full headless suite (installs jsdom locally under tools/)
cd tools && npm install && npm test
# individual suites:
node engine-smoke.mjs          # the main-thread PROXY vs a mock Worker (protocol + mirroring)
node studio-dom.test.mjs       # studio UI over the proxy + mock worker (piano roll / toolbar / HUD)
node mobile-smoke.test.mjs     # gamepad + touch (streamed liveMask) + gesture suppression
node runloop.test.mjs          # the WORKER's self-scheduling run loop (speed / FF / step / asyncify)
node worker-boundary.test.mjs  # authoritative determinism + OffscreenCanvas + save/load boundary
node emu-worker.test.mjs       # worker message-protocol plumbing (fake runner)
node emu-core-runner.test.mjs  # DOM-free runner with a mock core (decode / save-load / HUD)
node input-resolver.test.mjs   # deterministic (log | live) resolution + op protocol
node inputlog-truncate.test.mjs # re-record truncation
node precache-check.mjs        # sw.js precaches the shell (v14) and excludes the ROM

# From the repo root: verify the bundled WASM core exposes the raw libretro ABI
node tools/core-probe.mjs      # expect 17/17 retro_* exports + addFunction: yes
```

Full end-to-end emulation (real gameplay, real save states, real HUD values) can only be
verified once the ROM and the compiled WASM core are present.
