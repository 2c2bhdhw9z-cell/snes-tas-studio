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

**What this project targets:** a **libretro accuracy core compiled to WebAssembly**, in
priority order:

1. **`bsnes-mercury-accuracy`** (preferred) — a bsnes/higan-derived accuracy core. This is
   the one that earns the "cycle-accurate" label.
2. **`snes9x`** (fallback) — faster, broadly compatible, but *not* cycle-accurate. Provided
   only so the studio is usable if the accuracy core cannot be built for a target.

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

| File | Role |
| --- | --- |
| `index.html` | App shell: iOS/standalone/no-bounce meta tags, canvas, HUD, piano-roll, frame controls, save-state tree, touch controls, notice banner, bootstrap. |
| `tas-engine.js` | libretro frontend + core glue: loads the WASM core, loads the ROM, run loop (pause/speed 0.1x-2x/fast-forward), frame advance, save/load state with re-record hook, per-frame input feed, framebuffer blit, read-only memory view. Exposed as `window.TASEngine`. |
| `piano-roll.js` | The TAS Studio UI (`TASStudio`): piano-roll input editor, frame-control toolbar, save-state tree with re-record truncation. Owns the shared `InputLog` and the `LiveInput`. |
| `input-log.js` | Pure, DOM-free per-frame input log (`InputLog`): a libretro joypad bitmask per frame, plus the `truncateAfter` re-record primitive. Unit-testable in Node. |
| `live-input.js` | Real-time controller input (`LiveInput`): HTML5 Gamepad API polling + on-screen touch controls, merged (OR-ed) into the current frame's input. |
| `memory-watch.js` | Read-only Live HUD: reads Mario X/Y sub-pixel, horizontal speed, and the frame counter from WRAM (observation only). |
| `core/core-loader.js` | Fetches + instantiates the Emscripten libretro core; degrades gracefully when absent. |
| `sw.js` | Service worker: cache-first offline app shell. **Never caches the ROM.** |
| `manifest.json` | PWA manifest: standalone, landscape, dark theme, icons. |
| `styles.css` | Studio UI + low-opacity on-screen touch controls. |
| `icons/` | PWA icons (placeholder solids; regenerate with `tools/make-icons.js`). |
| `cores/` | **Runtime drop location** for the compiled WASM core. Not committed. |
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

## Building / obtaining the emulator core (at deploy time)

The compiled WASM core is a large, platform-specific binary that is **built/dropped at
deploy time and never committed**. Preferred core: **bsnes-mercury-accuracy**
(cycle-accurate); fallback: **snes9x** (faster, not cycle-accurate).

You build the libretro core to WebAssembly with **Emscripten (emsdk)**. Outline:

```sh
# 1. Install and activate the Emscripten SDK.
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh

# 2. Build the accuracy core with the Emscripten toolchain.
#    (bsnes-mercury exposes an emscripten platform target; snes9x builds via its libretro
#     Makefile with emmake.)
git clone https://github.com/libretro/bsnes-mercury.git
cd bsnes-mercury
emmake make -f Makefile PROFILE=accuracy platform=emscripten

# 3. The build emits an Emscripten JS loader + a .wasm blob. Export the retro_* symbols and
#    the runtime helpers the frontend uses (ccall/cwrap + HEAP access), e.g.:
#      -s EXPORTED_FUNCTIONS='["_retro_init","_retro_load_game","_retro_run",
#         "_retro_serialize_size","_retro_serialize","_retro_unserialize",
#         "_retro_get_memory_data","_retro_get_memory_size", ...]'
#      -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAPU16"]'
```

Then **drop the two output files into `cores/`** with the names the loader looks for
(see `core/core-loader.js` — default list is
`cores/bsnes_mercury_accuracy_libretro.js` + `.wasm`, then `cores/snes9x_libretro.js` +
`.wasm`):

```
cores/bsnes_mercury_accuracy_libretro.js
cores/bsnes_mercury_accuracy_libretro.wasm
# or the snes9x fallback:
cores/snes9x_libretro.js
cores/snes9x_libretro.wasm
```

If no core is present, the app shows a graceful "core not found" notice and stays usable.
See [`cores/README.md`](cores/README.md) for more detail.

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
  single **live mask** (`LiveInput.getMask()`), which the engine's per-frame input provider
  **OR-s into the piano-roll `InputLog` mask** for the current frame. Live play/record and
  the scripted timeline coexist without one clobbering the other.

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

**Requires the ROM + compiled WASM core (cannot be verified in this environment):**

- Actual gameplay / video output.
- Real save-state bytes via `retro_serialize` / `retro_unserialize`.
- Real HUD values (the SMB / All-Stars WRAM address map may need a ROM-revision-specific
  base offset to be calibrated against the real ROM).
- End-to-end gamepad-driven play latency.

## Dev tooling / tests

```sh
# Syntax-check all JS
for f in *.js core/*.js; do node --check "$f"; done

# Validate manifest
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"

# Optional headless smoke tests (installs jsdom locally under tools/)
cd tools && npm install
node dom-smoke.test.js         # FEAT-001 shell smoke
node engine-smoke.mjs          # engine graceful-degradation + API surface
node studio-dom.test.mjs       # FEAT-002 studio UI (piano roll / toolbar / HUD)
node inputlog-truncate.test.mjs # re-record truncation
node mobile-smoke.test.mjs     # FEAT-003 gamepad + touch + gesture suppression
node precache-check.mjs        # sw.js precaches the shell and excludes the ROM
```

Full end-to-end emulation (real gameplay, real save states, real HUD values) can only be
verified once the ROM and the compiled WASM core are present.
