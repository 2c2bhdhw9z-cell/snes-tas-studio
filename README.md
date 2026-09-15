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

### The emulator runs in a Web Worker (why, and how the boundary works)

**The problem this solves:** on real iOS Safari a synchronous WASM libretro core running on
the **main thread** starves the UI — the emulator crawls (~15 FPS) and, because it never
yields, the browser swallows touch/DOM events, so the on-screen controller stops responding.
No amount of tuning fixes a synchronous Wasm emulator sharing the main thread with a DOM UI
on iOS.

**The fix:** the entire emulator was moved **off the main thread into a dedicated module Web
Worker**. The main thread now does **only** DOM events + presentation; every heavy thing
(WASM instantiation, `retro_run`, save/load, WRAM reads, framebuffer decode) happens in the
worker. Touch is never blocked again.

```
 main thread (DOM only)                          worker thread (all WASM)
 ┌───────────────────────────┐   postMessage    ┌───────────────────────────────┐
 │ app.js  (bootstrap)        │  ───────────────▶│ emu-worker.js (message router)│
 │ piano-roll.js (UI + input) │   init/play/     │   └ emu-core-runner.js (ABI +  │
 │ memory-watch.js (HUD)      │     pause/edit/   │        run loop + decode)      │
 │ tas-engine.js  (PROXY)     │◀───────────────  │   └ input-resolver.js (log)    │
 └───────────────────────────┘   frame/hud/      └───────────────────────────────┘
        ▲ OffscreenCanvas          video/saved/
        └ (transferred to worker)  stateLoaded
```

**How each concern crosses the boundary:**

- **Input (deterministic).** The **authoritative scripted `InputLog` lives in the worker**
  (wrapped by `input-resolver.js`). The UI sends `{type:'inputEdit'}` edits
  (`setFrameButton` / `truncateAfter` / `restoreSnapshot`) when you toggle a piano-roll cell,
  and it streams the **live** controller/touch mask each animation frame via
  `{type:'liveMask'}`. The worker resolves **exactly `(log.getMask(frame) | latestLiveMask)
  >>> 0`** at the instant `retro_run` pulls input for the frame it is about to run — so frame
  N always runs with frame N's input and never N+1's. Frame-advance runs **exactly one**
  `retro_run` with that frame's resolved input.
- **Video (OffscreenCanvas, with an iOS-safe fallback).** `tas-engine.js` feature-detects
  `HTMLCanvasElement.prototype.transferControlToOffscreen` + a working `OffscreenCanvas` 2d
  context. **If supported**, it `transferControlToOffscreen()` and posts the canvas to the
  worker (as a transferable), and the worker blits decoded RGBA **directly** — no per-frame
  message crosses the boundary. **If not supported** (older Safari), the worker posts each
  frame as `{type:'video'}` with a transferable `ArrayBuffer` of RGBA + dimensions and the
  main thread blits it. Both paths use the same decoder in `emu-core-runner.js`.
- **HUD (streamed, read-only).** The worker reads the verified SMB1 WRAM addresses
  **read-only** each frame and posts a small values object via `{type:'hud'}`. The proxy
  surfaces those through `getMemoryView()` (read accessors only, keyed by WRAM offset) so
  `memory-watch.js` renders with **no synchronous WRAM read** and **no write path** anywhere
  across the boundary.
- **Save / load (transferable bytes).** `saveState()` messages the worker, which
  `retro_serialize`s and returns the bytes as a transferable `ArrayBuffer` (`{type:'saved'}`);
  `loadState(bytes)` sends the bytes (transferable) to the worker's `retro_unserialize`, and
  the worker's `{type:'stateLoaded'}` ack fires the proxy's `onStateLoaded` so re-record
  truncation still runs.
- **Core switch.** The **Core** dropdown calls `setCore(path)`, which posts `{type:'setCore'}`;
  the worker tears the current core down and boots the selected one (snes9x is driven as a
  **synchronous** self-scheduling loop; the ASYNCIFY bsnes cores are **awaited**). snes9x
  remains the default.

| File | Role |
| --- | --- |
| `index.html` | App shell: iOS/standalone/no-bounce meta tags, canvas, HUD, piano-roll, frame controls, save-state tree, touch controls, notice banner, on-screen debug banner. Loads `app.js` as the bootstrap module. |
| `app.js` | App-level bootstrap/orchestration: service-worker registration, engine attach/init wiring (attach() creates the worker and, when supported, transfers the canvas to it as an OffscreenCanvas **before** any main-thread `getContext`), iOS bounce/pinch gesture suppression, and the always-visible on-screen debug banner (WASM core status, ROM fetch status, and a `window.onerror`/`unhandledrejection` listener that prints uncaught JS/WASM errors on screen). Status/errors only — adds no emulation, memory-write, cheat, or level-select capability. |
| `tas-engine.js` | The **thin main-thread PROXY** (`window.TASEngine`). Creates the emulator module worker (`new Worker(url, {type:'module'})`), forwards commands as `postMessage`, and mirrors `currentFrame`/`status`/`coreStatus`/`romStatus`/`engineStatus`/`activeCoreId` from worker messages so the banner + piano-roll + HUD read them without blocking. Does the OffscreenCanvas feature-detect + transfer (or the fallback `{type:'video'}` blit). Contains **no** `retro_*`/`cwrap`/`addFunction`/`retro_run` — no synchronous WASM work on the main thread. |
| `emu-worker.js` | The **module Web Worker entry**: routes the IN/OUT message protocol, owns the authoritative `InputResolver` (scripted `InputLog`) + the latest live mask, hosts one `EmuCoreRunner`, and either blits to a transferred OffscreenCanvas or posts `{type:'video'}` frames. Enforces the determinism contract by construction. |
| `emu-core-runner.js` | The **DOM-free libretro core runner** (runs inside the worker): dynamic-imports the core, fetches the ROM (`encodeURI`), `cwrap`s the `retro_*` ABI, installs env/video/audio/input callbacks, drives the self-scheduling run loop (synchronous core yields between frames; ASYNCIFY core awaits `retro_run`), decodes the framebuffer to RGBA, save/load, and read-only WRAM/HUD reads. Unit-testable in Node with a mock core. |
| `input-resolver.js` | The **deterministic input resolver** (in the worker): wraps the authoritative `InputLog` and resolves `(log.getMask(frame) \| liveMask) >>> 0`; applies the scripted-edit op protocol. Pure, DOM-free, unit-testable. |
| `piano-roll.js` | The TAS Studio UI (`TASStudio`): piano-roll input editor (cell toggle → local mirror log **+** `{type:'inputEdit'}` to the worker), frame-control toolbar, save-state tree with re-record truncation, and the per-animation-frame live-mask stream to the worker. Owns a local **mirror** `InputLog` (for grid rendering) and the `LiveInput`. |
| `input-log.js` | Pure, DOM-free per-frame input log (`InputLog`): a libretro joypad bitmask per frame, plus the `truncateAfter` re-record primitive. Used as the worker's authoritative log **and** the UI's render mirror. Unit-testable in Node. |
| `live-input.js` | Real-time controller input (`LiveInput`): HTML5 Gamepad API polling + on-screen touch controls; its mask is streamed to the worker and OR-ed into the frame the worker runs next. |
| `memory-watch.js` | Read-only Live HUD: renders Mario X/Y sub-pixel, horizontal speed, and the frame counter from the **streamed** HUD values (observation only). |
| `core/core-loader.js` | Fetches + instantiates the Emscripten libretro core **inside the worker**; degrades gracefully when absent. |
| `sw.js` | Service worker (`tas-studio-v14`): cache-first offline app shell, now precaching `emu-worker.js` + `emu-core-runner.js` + `input-resolver.js`. **Never caches the ROM.** |
| `manifest.json` | PWA manifest: standalone, landscape, dark theme, icons. |
| `styles.css` | Studio UI + low-opacity on-screen touch controls. |
| `icons/` | PWA icons (placeholder solids; regenerate with `tools/make-icons.js`). |
| `cores/` | Bundled from-source **bsnes-mercury** WASM cores — **accuracy** (`bsnes_mercury_accuracy_libretro.*`, `EXPORT_NAME=bsnes_accuracy`) and **performance** (`bsnes_mercury_performance_libretro.*`, `EXPORT_NAME=bsnes_performance`), plus `core.json`, `build.json`, GPLv3 `license.txt` — **committed** and deployed. Both are ASYNCIFY builds so `retro_run` yields (proven by `tools/run-smoke.mjs`) and are selectable from the toolbar **Core** dropdown. |
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
  `transferControlToOffscreen` + worker 2d blit is taken, or the `{type:'video'}` fallback is
  used, on that specific iOS build.
- **The FEAT-003 no-ASYNCIFY bsnes result on-device** — documented as a NEGATIVE result
  (libco cothread switch throws a Wasm exception out of `retro_run` even off the main thread;
  no core shipped). See `cores/README.md` / `cores/build.json`. snes9x-in-worker remains the
  real-time default; confirming this on the device is the final check.

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
