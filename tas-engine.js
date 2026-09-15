// tas-engine.js
//
// The libretro frontend + core glue for the SNES TAS Studio.
//
// Responsibilities:
//   - Load the WASM libretro core via core/core-loader.js.
//   - Fetch the ROM from the exact path 'assets/Super Mario All-Stars (USA).sfc'.
//   - Wrap the verified libretro C ABI (see below) through Emscripten cwrap/ccall.
//   - Drive a requestAnimationFrame run loop honoring pause + playback speed (0.1x-2x)
//     + fast-forward.
//   - Provide frame advance (exactly one retro_run when paused).
//   - Provide save/load state (retro_serialize / retro_unserialize) with a re-record hook
//     so the UI can truncate future inputs on load.
//   - Feed per-frame controller inputs into retro_set_input_state from an input provider
//     (the piano-roll buffer + live gamepad — wired in FEAT-002).
//   - Blit the RETRO framebuffer to <canvas id="screen">.
//   - Expose a small public API (window.TASEngine) including a STRICTLY READ-ONLY view
//     over WRAM for memory-watch.js.
//
// Graceful degradation is mandatory: if the core or ROM is missing, we render a notice
// and leave the UI usable in a disabled state. We never throw an unhandled error that
// halts boot, and we NEVER fall back to a file picker.
//
// -------------------------- Verified libretro ABI (libretro.h) --------------------------
//   retro_init(), retro_deinit()
//   retro_set_environment(cb), retro_set_video_refresh(cb),
//   retro_set_audio_sample(cb), retro_set_audio_sample_batch(cb),
//   retro_set_input_poll(cb), retro_set_input_state(cb)
//   retro_load_game(const struct retro_game_info*) -> bool
//   retro_run()                      -> advance EXACTLY one video frame
//   retro_serialize_size() -> size_t
//   retro_serialize(void*, size_t) -> bool
//   retro_unserialize(const void*, size_t) -> bool
//   retro_get_memory_data(unsigned id) -> void*    // id 2 = RETRO_MEMORY_SYSTEM_RAM
//   retro_get_memory_size(unsigned id) -> size_t   // READ-ONLY
//
// HARD RULES enforced here:
//   * Memory is READ-ONLY. getMemoryView() returns a view intended only for reads.
//     No poke/write/inject helper exists anywhere.
//   * retro_cheat_set / retro_cheat_reset are NEVER wrapped or called.
//   * No level/stage selection logic.
// ----------------------------------------------------------------------------------------

'use strict';

import { loadCore, DEFAULT_CORE_PATHS, CORE_CATALOG } from './core/core-loader.js';

// The exact ROM path the app auto-boots. No file picker anywhere.
export const ROM_PATH = 'assets/Super Mario All-Stars (USA).sfc';

// RETRO_MEMORY_SYSTEM_RAM — the id passed to retro_get_memory_data/size for WRAM.
const RETRO_MEMORY_SYSTEM_RAM = 2;

// Subset of RETRO_ENVIRONMENT_* commands (libretro.h). Only the ones this frontend
// explicitly handles are listed; every other command is answered fail-closed (false).
// A REAL bsnes-mercury (accuracy) core was booted headlessly (tools/run-smoke.mjs) to see
// which commands it actually issues during retro_set_environment / retro_init /
// retro_load_game. The observed set is:
//   SET_PIXEL_FORMAT(10), SET_INPUT_DESCRIPTORS(11), GET_VARIABLE(15) x4,
//   SET_VARIABLES(16), GET_LOG_INTERFACE(27), SET_SUBSYSTEM_INFO(34),
//   SET_CONTROLLER_INFO(35), SET_MEMORY_MAPS(36).
// We handle each of those (plus the common directory / can-dupe / options queries) so the
// core initializes against real answers instead of a blanket `false`. Everything else stays
// fail-closed.
const RETRO_ENVIRONMENT = Object.freeze({
  SET_ROTATION: 1, // unsigned* — we render upright only
  GET_OVERSCAN: 2, // bool* — do we want overscan? no (write 0)
  GET_CAN_DUPE: 3, // bool* — can the frontend re-show the last frame? yes.
  SET_MESSAGE: 6, // const retro_message* — acknowledge, no on-screen overlay needed
  SET_PERFORMANCE_LEVEL: 8, // const unsigned* — advisory only
  GET_SYSTEM_DIRECTORY: 9, // const char** — write a stable heap dir string
  SET_PIXEL_FORMAT: 10, // const retro_pixel_format* — the core declares its framebuffer format
  SET_INPUT_DESCRIPTORS: 11, // const retro_input_descriptor* — advisory, acknowledge
  SET_KEYBOARD_CALLBACK: 12, // const retro_keyboard_callback* — acknowledge
  GET_VARIABLE: 15, // retro_variable* — return no override (value=NULL) but report handled
  SET_VARIABLES: 16, // const retro_variable* — core option list; acknowledge
  GET_VARIABLE_UPDATE: 17, // bool* — options never change at runtime here (write 0)
  SET_SUPPORT_NO_GAME: 18, // bool* — acknowledge
  GET_LOG_INTERFACE: 27, // retro_log_callback* — see note in _handleEnvironment (fail-closed)
  GET_CORE_ASSETS_DIRECTORY: 30, // const char** — write a stable heap dir string
  GET_SAVE_DIRECTORY: 31, // const char** — write a stable heap dir string
  SET_SYSTEM_AV_INFO: 32, // const retro_system_av_info* — acknowledge (re-read in _captureAvInfo)
  SET_SUBSYSTEM_INFO: 34, // const retro_subsystem_info* — acknowledge
  SET_CONTROLLER_INFO: 35, // const retro_controller_info* — acknowledge
  SET_MEMORY_MAPS: 36, // const retro_memory_map* — acknowledge
  SET_GEOMETRY: 37, // const retro_game_geometry* — acknowledge
  GET_LANGUAGE: 39, // unsigned* — RETRO_LANGUAGE_ENGLISH (write 0)
  GET_CORE_OPTIONS_VERSION: 52, // unsigned* — options API version we support (write 0)
  SET_CORE_OPTIONS: 53, // const retro_core_option_definition* — acknowledge
  SET_CORE_OPTIONS_INTL: 54, // const retro_core_options_intl* — acknowledge
  SET_CORE_OPTIONS_DISPLAY: 55, // const retro_core_option_display* — acknowledge
});

// The experimental bit that some GET commands carry in libretro.h (e.g. GET_INPUT_BITMASKS).
const RETRO_ENVIRONMENT_EXPERIMENTAL_MASK = 0xffff;

// RETRO_PIXEL_FORMAT_* values (libretro.h).
const RETRO_PIXEL_FORMAT = Object.freeze({
  XRGB1555: 0,
  XRGB8888: 1,
  RGB565: 2,
});

// libretro device id for the standard joypad; button bit layout (RETRO_DEVICE_ID_JOYPAD_*).
export const JOYPAD = Object.freeze({
  B: 0,
  Y: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
});

/**
 * The TAS engine. A single instance is created and exposed as window.TASEngine.
 */
class TASEngine {
  constructor() {
    // Core / module state.
    this.Module = null;
    this.corePath = null;
    this.status = 'idle'; // idle | loading | ready | running | disabled | error

    // Fine-grained diagnostic status for the on-screen debug banner (app.js reads these
    // and/or subscribes via onStatus). These are STATUS/error strings only — they never
    // add any emulation capability. tas-engine never touches the banner DOM itself.
    //   coreStatus: 'Idle' | 'Loading' | 'Instantiated' | 'Failed'
    //   romStatus:  'Idle' | 'Fetching' | 'HTTP <code>' | 'Loaded <N> bytes' | 'Error <msg>'
    this.coreStatus = 'Idle';
    this.romStatus = 'Idle';
    this.romBytes = 0; // byte length of the successfully fetched ROM (0 until loaded)
    // High-level engine lifecycle for the on-screen banner (app.js renders an `Engine:` line).
    //   'Init'         — before a game is loaded
    //   'GameLoaded'   — retro_load_game succeeded
    //   'RunLoop Active'— the rAF run loop is running
    //   'Stopped'      — paused / stopped after having loaded
    this.engineStatus = 'Init';

    // Libretro wrapped functions (populated in _wrapCore).
    this._fn = {};

    // ROM bytes (never persisted; held only in memory for the current session).
    this._romBytes = null;
    // Heap pointer for the ROM DATA passed to retro_load_game. bsnes-mercury references the
    // ROM buffer for the LIFETIME of the loaded game (it does not always fully copy when the
    // ROM is passed by data pointer), so we RETAIN this pointer and only free it on
    // retro_unload_game / reload — never immediately after load.
    this._romDataPtr = 0;
    // Heap-allocated, kept-alive C strings for directory GET queries (allocated once).
    this._sysDirPtr = 0;
    this._saveDirPtr = 0;

    // Run loop state.
    this.currentFrame = 0;
    this.paused = true;
    this.speed = 1.0; // 0.1x - 2x
    this._fastForward = false;
    this._rafId = null;
    this._accumulator = 0;
    this._lastTs = 0;
    // Nominal SNES NTSC frame rate. Used as a FALLBACK until retro_get_system_av_info
    // reports the core's actual fps (see _captureAvInfo), so PAL / non-standard cores
    // are paced by their own declared rate rather than this hardcoded value.
    this.DEFAULT_FPS = 60.098;
    this.fps = this.DEFAULT_FPS;
    this._baseFrameMs = 1000 / this.fps;
    // Bind the loop tick once so a single stable function reference is used for every
    // requestAnimationFrame schedule (see _startLoop / _tick).
    this._tick = this._tick.bind(this);

    // Video framebuffer plumbing.
    this.canvas = null;
    this._ctx = null;
    this._imageData = null;
    this._fbWidth = 0;
    this._fbHeight = 0;
    // Pixel format the core declares via RETRO_ENVIRONMENT_SET_PIXEL_FORMAT. Defaults to
    // RGB565 (the libretro default) until the core says otherwise; the video blit is
    // driven by this value rather than guessing from pitch/width.
    this._pixelFormat = RETRO_PIXEL_FORMAT.RGB565;

    // Memory (WRAM) read-only view.
    this._wramPtr = 0;
    this._wramSize = 0;

    // Callbacks / providers.
    this._onFrameCbs = [];
    this._onStateLoadedCbs = [];
    this._onStatusCbs = []; // subscribers for the diagnostic banner (app.js)
    this._inputProvider = null; // (frame, port, device, index, id) => whole-joypad bitmask

    // Notice banner element (set via attach()).
    this._noticeEl = null;
  }

  // ------------------------------------------------------------------ attach / notices

  /**
   * Wire the engine to DOM elements. Safe to call before init().
   * @param {{canvas?:HTMLCanvasElement, noticeEl?:HTMLElement}} els
   */
  attach(els = {}) {
    if (els.canvas) {
      this.canvas = els.canvas;
      this._ctx = els.canvas.getContext('2d', { alpha: false });
    }
    if (els.noticeEl) this._noticeEl = els.noticeEl;
    return this;
  }

  /**
   * Render a non-blocking notice. Appends a line; never throws.
   * @param {string} message
   * @param {'info'|'warn'|'error'} [level]
   */
  showNotice(message, level = 'warn') {
    try {
      if (this._noticeEl) {
        const line = document.createElement('div');
        line.className = `notice notice--${level}`;
        line.textContent = message;
        this._noticeEl.appendChild(line);
        this._noticeEl.hidden = false;
      }
      const logf = level === 'error' ? console.error : console.warn;
      logf('[TASEngine]', message);
    } catch (_err) {
      // Never let notice rendering itself halt boot.
      console.warn('[TASEngine]', message);
    }
  }

  clearNotices() {
    if (this._noticeEl) {
      this._noticeEl.innerHTML = '';
      this._noticeEl.hidden = true;
    }
  }

  // ------------------------------------------------------------------ status surface

  /**
   * Subscribe to diagnostic status updates for the on-screen debug banner. The callback
   * receives a snapshot object { status, coreStatus, romStatus, romBytes }. Fires
   * immediately with the current snapshot so late subscribers render at once. This is a
   * READ-ONLY status channel — it exposes no emulation/memory/cheat capability.
   * @param {(snap:{status:string,coreStatus:string,romStatus:string,romBytes:number})=>void} cb
   */
  onStatus(cb) {
    if (typeof cb === 'function') {
      this._onStatusCbs.push(cb);
      try {
        cb(this.statusSnapshot());
      } catch (err) {
        console.warn('[TASEngine] onStatus callback error', err);
      }
    }
    return this;
  }

  /** Current diagnostic snapshot for the banner. */
  statusSnapshot() {
    return {
      status: this.status,
      coreStatus: this.coreStatus,
      romStatus: this.romStatus,
      romBytes: this.romBytes,
      engineStatus: this.engineStatus,
      frame: this.currentFrame,
    };
  }

  /**
   * Update one or more diagnostic status fields and notify banner subscribers. Accepts a
   * partial patch like { coreStatus:'Loading' } or { romStatus:'Loaded 12345 bytes' }.
   */
  _setStatus(patch) {
    if (patch && typeof patch === 'object') {
      if ('coreStatus' in patch) this.coreStatus = patch.coreStatus;
      if ('romStatus' in patch) this.romStatus = patch.romStatus;
      if ('romBytes' in patch) this.romBytes = patch.romBytes;
      if ('engineStatus' in patch) this.engineStatus = patch.engineStatus;
    }
    const snap = this.statusSnapshot();
    for (const cb of this._onStatusCbs) {
      try {
        cb(snap);
      } catch (err) {
        console.warn('[TASEngine] onStatus callback error', err);
      }
    }
  }

  // ------------------------------------------------------------------ init / boot

  /**
   * Initialize the engine: load the core, fetch the ROM, and (if both present) auto-boot.
   * Never throws; on missing core/ROM it renders a notice and sets a disabled state.
   * @param {{corePaths?:string[]}} [opts]
   */
  async init(opts = {}) {
    this.status = 'loading';
    this.clearNotices();
    this._setStatus({ coreStatus: 'Loading', romStatus: 'Idle', romBytes: 0, engineStatus: 'Init' });

    // 1) Load the WASM libretro core (graceful failure).
    let coreResult;
    try {
      coreResult = await loadCore({ corePaths: opts.corePaths || DEFAULT_CORE_PATHS });
    } catch (err) {
      coreResult = { ok: false, reason: 'core-missing', detail: String(err) };
    }

    const coreOk = coreResult && coreResult.ok;
    this._setStatus({ coreStatus: coreOk ? 'Instantiated' : 'Failed' });

    // 2) Fetch the ROM (graceful failure; NEVER a file picker). _fetchRom drives romStatus.
    const romResult = await this._fetchRom();

    const romOk = romResult && romResult.ok;

    if (!coreOk) {
      if (coreResult && coreResult.reason === 'core-load-failed') {
        // A core file WAS present but failed to import/instantiate — surface the real detail
        // so the failure is diagnosable (not misreported as a missing file).
        this.showNotice(
          `Emulator core failed to load. ${coreResult.detail || ''}`.trim(),
          'error'
        );
      } else {
        this.showNotice(
          'Emulator core not found in cores/. Build/drop the WASM core (e.g. cores/bsnes_mercury_accuracy_libretro.js) to enable emulation.',
          'error'
        );
      }
    }
    if (!romOk) {
      this.showNotice(
        `ROM not found at ${ROM_PATH}. Drop the ROM there to auto-boot.`,
        'error'
      );
    }

    if (!coreOk || !romOk) {
      // UI stays usable in a disabled state.
      this.status = 'disabled';
      this._setStatus({});
      this._emitFrame(); // let listeners render an initial (empty) state
      return { ok: false, coreOk, romOk };
    }

    // Both present: bind and boot.
    this.Module = coreResult.Module;
    this.corePath = coreResult.corePath;
    this._romBytes = romResult.bytes;

    try {
      this._wrapCore();
      this._installCallbacks();
      this._fn.retro_init();
      const loaded = this._loadGame(this._romBytes);
      if (!loaded) {
        this.showNotice('The core refused to load the ROM (retro_load_game returned false).', 'error');
        this.status = 'error';
        // Surface the failure on the diagnostic banner right away.
        this._setStatus({ engineStatus: 'Stopped' });
        return { ok: false, coreOk: true, romOk: true };
      }
      this._captureMemoryRegion();
      this._captureAvInfo();
      this.status = 'ready';
      this.clearNotices();
      // retro_load_game succeeded — the game is loaded and ready to run.
      this._setStatus({ engineStatus: 'GameLoaded' });
      // Auto-boot: start the run loop immediately, no user action required.
      this.play();
      return { ok: true, coreOk: true, romOk: true };
    } catch (err) {
      this.showNotice(`Failed to start emulation: ${err && err.message ? err.message : err}`, 'error');
      this.status = 'error';
      this._setStatus({ engineStatus: 'Stopped' });
      return { ok: false, coreOk, romOk, error: String(err) };
    }
  }

  /**
   * Fetch the ROM from ROM_PATH. The path contains spaces and parentheses
   * ('assets/Super Mario All-Stars (USA).sfc'), so we wrap it in encodeURI() at fetch time
   * to avoid Safari HTTP 400/404 errors from unescaped spaces. ROM_PATH itself stays
   * human-readable; only the request URL is encoded. Both the fetch and the arrayBuffer()
   * conversion are wrapped in explicit try/catch so any failure surfaces a precise status
   * to BOTH the notice banner and the diagnostic banner instead of silently halting.
   * Never throws.
   */
  async _fetchRom() {
    // encodeURI leaves parentheses as-is (fine for HTTP) and escapes the spaces (the main
    // culprit): 'assets/Super%20Mario%20All-Stars%20(USA).sfc'.
    const url = encodeURI(ROM_PATH);
    this._setStatus({ romStatus: 'Fetching', romBytes: 0 });

    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this._setStatus({ romStatus: `Error ${msg}` });
      return { ok: false, reason: 'rom-fetch-error', detail: msg };
    }

    if (!res || !res.ok) {
      const code = res ? res.status : 'no-response';
      this._setStatus({ romStatus: `HTTP ${code}` });
      return { ok: false, reason: 'rom-missing', status: res ? res.status : 0 };
    }

    let buf;
    try {
      buf = await res.arrayBuffer();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this._setStatus({ romStatus: `Error ${msg}` });
      return { ok: false, reason: 'rom-read-error', detail: msg };
    }

    if (!buf || buf.byteLength === 0) {
      this._setStatus({ romStatus: 'Error empty ROM (0 bytes)' });
      return { ok: false, reason: 'rom-empty' };
    }

    this._setStatus({ romStatus: `Loaded ${buf.byteLength} bytes`, romBytes: buf.byteLength });
    return { ok: true, bytes: new Uint8Array(buf) };
  }

  // ------------------------------------------------------------------ core switching

  /**
   * Switch to a different emulator core at runtime (e.g. accuracy <-> performance from the
   * UI dropdown). Tears the current core/run loop down cleanly, re-initializes the engine
   * against the selected core path, re-fetches + re-loads the ROM, and resumes playback if
   * it was running. Never throws; on failure it renders a notice and leaves the UI usable
   * (matching init()'s graceful-degradation contract). This is CORE selection only — it is
   * NOT a ROM/level picker and grants no cheat/memory-write capability.
   *
   * @param {string} corePath the cores/*.js loader path to switch to
   * @returns {Promise<{ok:boolean, coreOk?:boolean, romOk?:boolean}>}
   */
  async setCore(corePath) {
    if (typeof corePath !== 'string' || !corePath) {
      return { ok: false };
    }
    // No-op if it's already the active core (avoid a needless reload flash).
    if (this.corePath === corePath && (this.status === 'ready' || this.status === 'running')) {
      return { ok: true, coreOk: true, romOk: true };
    }
    const wasRunning = this.status === 'running' && !this.paused;

    // Fully tear the current core down: stop the loop, unload the game, free the ROM
    // buffer, and drop the Module reference so the old instance can be GC'd (no leaked
    // Module, no double-run rAF loop).
    this._teardownCore();

    // Re-initialize against the selected core. init() re-fetches the ROM, re-wires
    // callbacks, reloads the game, and (on success) auto-plays.
    const result = await this.init({ corePaths: [corePath] });

    // init() auto-plays on success. If the user had explicitly paused before switching,
    // honor that by pausing again; if they were running, init() already resumed.
    if (result && result.ok && !wasRunning) {
      this.pause();
    }
    return result;
  }

  /**
   * Stop the run loop and release the current core so a fresh init() can take over. Frees
   * the retained ROM buffer and directory strings and clears wrapped-ABI references. Safe
   * to call when nothing is loaded.
   */
  _teardownCore() {
    // Halt the single tracked rAF loop first so no tick fires against a torn-down core.
    this._stopLoop();
    this.paused = true;

    const M = this.Module;
    if (M) {
      try {
        if (this._fn && typeof this._fn.retro_unload_game === 'function') {
          this._fn.retro_unload_game();
        }
        if (this._fn && typeof this._fn.retro_deinit === 'function') {
          this._fn.retro_deinit();
        }
      } catch (err) {
        console.warn('[TASEngine] core teardown warning:', err);
      }
      // Free heap buffers we allocated and retained.
      try {
        if (this._romDataPtr) M._free(this._romDataPtr);
        if (this._sysDirPtr) M._free(this._sysDirPtr);
        if (this._saveDirPtr) M._free(this._saveDirPtr);
      } catch (_err) {
        /* best-effort */
      }
    }
    this._romDataPtr = 0;
    this._sysDirPtr = 0;
    this._saveDirPtr = 0;

    // Drop references so the old Emscripten Module can be garbage-collected.
    this.Module = null;
    this.corePath = null;
    this._fn = {};
    this._romBytes = null;
    this._wramPtr = 0;
    this._wramSize = 0;
    this.currentFrame = 0;
    this._imageData = null;
    this._fbWidth = 0;
    this._fbHeight = 0;
    this._pixelFormat = RETRO_PIXEL_FORMAT.RGB565;
    this.status = 'idle';
    this.engineStatus = 'Init';
  }

  // ------------------------------------------------------------------ core wrapping

  _wrapCore() {
    const M = this.Module;
    const cw = M.cwrap.bind(M);
    // Wrap the verified libretro ABI symbols. (retro_cheat_* intentionally omitted.)
    this._fn = {
      retro_init: cw('retro_init', null, []),
      retro_deinit: cw('retro_deinit', null, []),
      retro_run: cw('retro_run', null, []),
      retro_reset: cw('retro_reset', null, []),
      retro_load_game: cw('retro_load_game', 'number', ['number']),
      retro_unload_game: cw('retro_unload_game', null, []),
      retro_serialize_size: cw('retro_serialize_size', 'number', []),
      retro_serialize: cw('retro_serialize', 'number', ['number', 'number']),
      retro_unserialize: cw('retro_unserialize', 'number', ['number', 'number']),
      retro_get_memory_data: cw('retro_get_memory_data', 'number', ['number']),
      retro_get_memory_size: cw('retro_get_memory_size', 'number', ['number']),
      retro_set_environment: cw('retro_set_environment', null, ['number']),
      retro_set_video_refresh: cw('retro_set_video_refresh', null, ['number']),
      retro_set_audio_sample: cw('retro_set_audio_sample', null, ['number']),
      retro_set_audio_sample_batch: cw('retro_set_audio_sample_batch', null, ['number']),
      retro_set_input_poll: cw('retro_set_input_poll', null, ['number']),
      retro_set_input_state: cw('retro_set_input_state', null, ['number']),
      retro_get_system_av_info: cw('retro_get_system_av_info', null, ['number']),
    };
  }

  _installCallbacks() {
    const M = this.Module;
    // addFunction requires the function to be present; guard for reserved builds.
    const add = (fn, sig) => (typeof M.addFunction === 'function' ? M.addFunction(fn, sig) : 0);

    // Environment callback. FAIL-CLOSED: return `true` only for commands we actually
    // handle (and, for GET queries, only when we truly populated *data); return `false`
    // for everything else so the core knows the request was NOT satisfied and falls back
    // to its own defaults instead of reading a buffer we never wrote.
    const envCb = add((cmd, data) => this._handleEnvironment(cmd, data), 'iii');
    if (envCb) this._fn.retro_set_environment(envCb);

    // Video refresh: (const void* data, unsigned width, unsigned height, size_t pitch)
    const videoCb = add((dataPtr, width, height, pitch) => {
      this._onVideoRefresh(dataPtr, width, height, pitch);
    }, 'viiii');
    if (videoCb) this._fn.retro_set_video_refresh(videoCb);

    // Audio: we register no-op sinks in this feature (audio wiring is out of scope here).
    const audioSampleCb = add((_left, _right) => {}, 'vii');
    if (audioSampleCb) this._fn.retro_set_audio_sample(audioSampleCb);
    const audioBatchCb = add((_dataPtr, frames) => frames, 'iii');
    if (audioBatchCb) this._fn.retro_set_audio_sample_batch(audioBatchCb);

    // Input poll: no-op; inputs are pulled per-id in input_state.
    const inputPollCb = add(() => {}, 'v');
    if (inputPollCb) this._fn.retro_set_input_poll(inputPollCb);

    // Input state: (unsigned port, unsigned device, unsigned index, unsigned id) -> int16
    // Pulls the current frame's button state from the configured input provider.
    const inputStateCb = add((port, device, index, id) => {
      return this._readInput(port, device, index, id);
    }, 'iiiii');
    if (inputStateCb) this._fn.retro_set_input_state(inputStateCb);
  }

  /**
   * Handle a RETRO_ENVIRONMENT_* command. Returns true ONLY for commands we recognize and
   * (for GET-style queries) actually fulfilled; false otherwise. This fail-closed posture
   * prevents a real core from consuming a `data` buffer we never populated.
   *
   * @param {number} cmd RETRO_ENVIRONMENT_* command id
   * @param {number} data pointer into the WASM heap for the command's in/out struct
   * @returns {boolean} whether the command was handled
   */
  _handleEnvironment(cmd, data) {
    const M = this.Module;
    // Strip the experimental/private high bits so a command like GET_INPUT_BITMASKS
    // (which carries the experimental bit in libretro.h) still classifies by its base id.
    const base = cmd & RETRO_ENVIRONMENT_EXPERIMENTAL_MASK;
    switch (base) {
      case RETRO_ENVIRONMENT.SET_PIXEL_FORMAT: {
        // const retro_pixel_format* data — record the format the core declares so the
        // video blit reads the correct bytes. Reject unknown formats (fail-closed).
        // (bsnes-mercury accuracy declares XRGB8888 — verified via tools/run-smoke.mjs.)
        if (!M || !data) return false;
        const fmt = M.HEAP32[data >> 2];
        if (
          fmt === RETRO_PIXEL_FORMAT.XRGB1555 ||
          fmt === RETRO_PIXEL_FORMAT.XRGB8888 ||
          fmt === RETRO_PIXEL_FORMAT.RGB565
        ) {
          this._pixelFormat = fmt;
          return true;
        }
        return false;
      }
      case RETRO_ENVIRONMENT.GET_CAN_DUPE: {
        // bool* data — we can re-present the previous frame (video refresh with NULL data).
        if (!M || !data) return false;
        M.HEAPU8[data] = 1;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_OVERSCAN: {
        // bool* data — we do not want the core's overscan region cropped for us.
        if (!M || !data) return false;
        M.HEAPU8[data] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_SYSTEM_DIRECTORY:
      case RETRO_ENVIRONMENT.GET_CORE_ASSETS_DIRECTORY: {
        // const char** data — write a pointer to a STABLE, kept-alive heap string. A bogus
        // true with an unwritten buffer is worse than false, so we only return true after
        // successfully writing the pointer.
        if (!M || !data) return false;
        const ptr = this._ensureDirString('_sysDirPtr');
        if (!ptr) return false;
        M.HEAP32[data >> 2] = ptr;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_SAVE_DIRECTORY: {
        if (!M || !data) return false;
        const ptr = this._ensureDirString('_saveDirPtr');
        if (!ptr) return false;
        M.HEAP32[data >> 2] = ptr;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_VARIABLE: {
        // retro_variable { const char *key; const char *value; } — we provide no overrides,
        // so set value=NULL and return true; the core then uses its own defaults. Writing
        // NULL is the correct "no override" signal (never leave the buffer unwritten).
        if (!M || !data) return false;
        M.HEAP32[(data + 4) >> 2] = 0; // value = NULL
        return true;
      }
      case RETRO_ENVIRONMENT.GET_VARIABLE_UPDATE: {
        // bool* — options never change at runtime in this frontend.
        if (!M || !data) return false;
        M.HEAPU8[data] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_LANGUAGE: {
        // unsigned* — RETRO_LANGUAGE_ENGLISH == 0.
        if (!M || !data) return false;
        M.HEAP32[data >> 2] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_CORE_OPTIONS_VERSION: {
        // unsigned* — we implement the classic SET_VARIABLES options API (version 0).
        if (!M || !data) return false;
        M.HEAP32[data >> 2] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_LOG_INTERFACE:
        // retro_log_callback { retro_log_printf_t log; }. The libretro log printf is a
        // VARIADIC C callback (void(*)(enum level, const char *fmt, ...)). Emscripten's
        // addFunction cannot represent a variadic callback, and a real bsnes-mercury core
        // invoking such a mismatched table entry TRAPS with "null function or function
        // signature mismatch" (observed in tools/run-smoke.mjs). So we deliberately do NOT
        // provide a log interface and return false; the core falls back to its own logging.
        return false;
      case RETRO_ENVIRONMENT.SET_ROTATION:
      case RETRO_ENVIRONMENT.SET_MESSAGE:
      case RETRO_ENVIRONMENT.SET_PERFORMANCE_LEVEL:
      case RETRO_ENVIRONMENT.SET_INPUT_DESCRIPTORS:
      case RETRO_ENVIRONMENT.SET_KEYBOARD_CALLBACK:
      case RETRO_ENVIRONMENT.SET_VARIABLES:
      case RETRO_ENVIRONMENT.SET_SUPPORT_NO_GAME:
      case RETRO_ENVIRONMENT.SET_SYSTEM_AV_INFO:
      case RETRO_ENVIRONMENT.SET_SUBSYSTEM_INFO:
      case RETRO_ENVIRONMENT.SET_CONTROLLER_INFO:
      case RETRO_ENVIRONMENT.SET_MEMORY_MAPS:
      case RETRO_ENVIRONMENT.SET_GEOMETRY:
      case RETRO_ENVIRONMENT.SET_CORE_OPTIONS:
      case RETRO_ENVIRONMENT.SET_CORE_OPTIONS_INTL:
      case RETRO_ENVIRONMENT.SET_CORE_OPTIONS_DISPLAY:
        // Advisory SET commands: the core is informing the frontend. We keep no state that
        // requires reading `data` here (geometry/av_info are re-queried in _captureAvInfo),
        // so we simply acknowledge. None of these grant memory-write / cheat / level-select.
        return true;
      default:
        // Everything else is unhandled — say so honestly (fail-closed) so the core does not
        // read a `data` buffer we never populated.
        return false;
    }
  }

  /**
   * Lazily allocate a stable, NUL-terminated heap C string for a directory GET query and
   * cache the pointer on the instance (kept alive for the core's lifetime). We use '.' (the
   * core's working directory) which is a valid, writable path for save/system files. Returns
   * the pointer, or 0 if allocation is not possible.
   * @param {'_sysDirPtr'|'_saveDirPtr'} field
   */
  _ensureDirString(field) {
    const M = this.Module;
    if (!M || typeof M._malloc !== 'function') return 0;
    if (this[field]) return this[field];
    // '.' + NUL. Written as raw ASCII bytes (avoids relying on lengthBytesUTF8, which some
    // builds do not export).
    const bytes = [0x2e, 0x00]; // '.', '\0'
    const ptr = M._malloc(bytes.length);
    if (!ptr) return 0;
    for (let i = 0; i < bytes.length; i++) M.HEAPU8[ptr + i] = bytes[i];
    this[field] = ptr;
    return ptr;
  }

  _loadGame(romBytes) {
    const M = this.Module;
    // Copy ROM bytes into the WASM heap. We RETAIN this pointer for the lifetime of the
    // loaded game (see below) and store it on the instance.
    const dataPtr = M._malloc(romBytes.length);
    M.HEAPU8.set(romBytes, dataPtr);
    // Free any previously retained ROM buffer (reload path) before replacing it.
    if (this._romDataPtr) {
      M._free(this._romDataPtr);
      this._romDataPtr = 0;
    }
    this._romDataPtr = dataPtr;

    // Build a retro_game_info struct:
    //   const char *path; const void *data; size_t size; const char *meta;
    // On wasm32 pointers/size_t are 4 bytes. Layout: path(4) data(4) size(4) meta(4).
    const infoPtr = M._malloc(16);
    const HEAP32 = M.HEAP32;
    const idx = infoPtr >> 2;
    HEAP32[idx + 0] = 0; // path = NULL (we pass data directly)
    HEAP32[idx + 1] = dataPtr; // data
    HEAP32[idx + 2] = romBytes.length; // size
    HEAP32[idx + 3] = 0; // meta = NULL

    const ok = this._fn.retro_load_game(infoPtr);

    // Free ONLY the small info struct. We must NOT free dataPtr here: bsnes-mercury keeps a
    // reference to the ROM DATA buffer for the lifetime of the loaded game when the ROM is
    // passed by data pointer (need_fullpath == false). Freeing it now leaves the core reading
    // freed heap -> black screen. dataPtr is released on unload/reload only.
    M._free(infoPtr);
    if (!ok) {
      // Load failed: nothing references the buffer, so release it now.
      M._free(this._romDataPtr);
      this._romDataPtr = 0;
    }
    return !!ok;
  }

  _captureMemoryRegion() {
    // Obtain the WRAM base pointer + size for READ-ONLY HUD reads.
    this._wramPtr = this._fn.retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM) || 0;
    this._wramSize = this._fn.retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM) || 0;
  }

  /**
   * Query retro_get_system_av_info and drive frame pacing (and known geometry) from the
   * core's declared fps instead of the hardcoded NTSC value. Falls back to DEFAULT_FPS if
   * av_info is unavailable or reports a nonsensical rate, so timing is core-driven when
   * possible and sane otherwise.
   *
   * struct retro_system_av_info {
   *   struct retro_game_geometry geometry {  // offset 0
   *     unsigned base_width, base_height, max_width, max_height;  // 0,4,8,12
   *     float    aspect_ratio;                                    // 16
   *   };                                                          // (20 bytes, 4-byte aligned)
   *   struct retro_system_timing timing {    // offset 24 (double is 8-byte aligned)
   *     double fps;          // 24
   *     double sample_rate;  // 32
   *   };
   * };  // total 40 bytes on wasm32
   */
  _captureAvInfo() {
    const M = this.Module;
    if (!M || typeof this._fn.retro_get_system_av_info !== 'function') return;
    const AV_INFO_BYTES = 40;
    const ptr = M._malloc(AV_INFO_BYTES);
    try {
      // Zero the struct so unread fields are deterministic.
      M.HEAPU8.fill(0, ptr, ptr + AV_INFO_BYTES);
      this._fn.retro_get_system_av_info(ptr);

      // Geometry base_width / base_height (unsigned at offsets 0 / 4).
      const u32 = ptr >> 2;
      const baseW = M.HEAPU32[u32 + 0];
      const baseH = M.HEAPU32[u32 + 1];
      if (baseW > 0 && baseH > 0) {
        this.avBaseWidth = baseW;
        this.avBaseHeight = baseH;
      }

      // timing.fps is a double at byte offset 24.
      const fps = M.HEAPF64[(ptr + 24) >> 3];
      if (Number.isFinite(fps) && fps > 1 && fps < 1000) {
        this.fps = fps;
      } else {
        this.fps = this.DEFAULT_FPS;
      }
    } catch (_err) {
      this.fps = this.DEFAULT_FPS;
    } finally {
      this._baseFrameMs = 1000 / this.fps;
      M._free(ptr);
    }
  }

  // ------------------------------------------------------------------ video

  _onVideoRefresh(dataPtr, width, height, pitch) {
    if (!this._ctx || !dataPtr || !width || !height) return;
    const M = this.Module;

    if (this._fbWidth !== width || this._fbHeight !== height || !this._imageData) {
      this._fbWidth = width;
      this._fbHeight = height;
      if (this.canvas) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this._imageData = this._ctx.createImageData(width, height);
    }

    const out = this._imageData.data; // RGBA8888

    // The blit is driven by the format the core DECLARED via SET_PIXEL_FORMAT (recorded in
    // this._pixelFormat), not inferred from pitch/width. pitch is still in bytes.
    if (this._pixelFormat === RETRO_PIXEL_FORMAT.XRGB8888) {
      // XRGB8888: 4 bytes per pixel, little-endian 0x00RRGGBB.
      const heap32 = M.HEAPU32;
      for (let y = 0; y < height; y++) {
        let src = (dataPtr + y * pitch) >> 2;
        let dst = y * width * 4;
        for (let x = 0; x < width; x++) {
          const px = heap32[src++];
          out[dst++] = (px >> 16) & 0xff; // R
          out[dst++] = (px >> 8) & 0xff; // G
          out[dst++] = px & 0xff; // B
          out[dst++] = 0xff; // A
        }
      }
    } else if (this._pixelFormat === RETRO_PIXEL_FORMAT.XRGB1555) {
      // 0RRRRRGG GGGBBBBB — 2 bytes per pixel, 5 bits per channel.
      const heap16 = M.HEAPU16;
      for (let y = 0; y < height; y++) {
        let src = (dataPtr + y * pitch) >> 1;
        let dst = y * width * 4;
        for (let x = 0; x < width; x++) {
          const px = heap16[src++];
          const r5 = (px >> 10) & 0x1f;
          const g5 = (px >> 5) & 0x1f;
          const b5 = px & 0x1f;
          out[dst++] = (r5 << 3) | (r5 >> 2);
          out[dst++] = (g5 << 3) | (g5 >> 2);
          out[dst++] = (b5 << 3) | (b5 >> 2);
          out[dst++] = 0xff;
        }
      }
    } else {
      // RGB565 (libretro default): RRRRRGGG GGGBBBBB, 2 bytes per pixel.
      const heap16 = M.HEAPU16;
      for (let y = 0; y < height; y++) {
        let src = (dataPtr + y * pitch) >> 1;
        let dst = y * width * 4;
        for (let x = 0; x < width; x++) {
          const px = heap16[src++];
          const r5 = (px >> 11) & 0x1f;
          const g6 = (px >> 5) & 0x3f;
          const b5 = px & 0x1f;
          out[dst++] = (r5 << 3) | (r5 >> 2);
          out[dst++] = (g6 << 2) | (g6 >> 4);
          out[dst++] = (b5 << 3) | (b5 >> 2);
          out[dst++] = 0xff;
        }
      }
    }

    this._ctx.putImageData(this._imageData, 0, 0);
  }

  // ------------------------------------------------------------------ input

  /**
   * Set the per-frame input provider.
   *
   * CONTRACT (single shape): the provider is called as
   *   provider(frame, port, device, index, id) -> number
   * and MUST return a WHOLE-JOYPAD BITMASK for that (frame, port) in the libretro
   * RETRO_DEVICE_ID_JOYPAD_* bit layout (B=bit0 .. R=bit11 — see JOYPAD above). The engine
   * extracts the requested button's bit for the current retro_set_input_state query.
   *
   * This is the shape the piano-roll + live-input layer actually wires
   * (`log.getMask(frame) | live.getMask()`), so there is no per-button / literal-value
   * alternative shape: a bitmask of 1 unambiguously means "only B (bit 0) pressed".
   *
   * @param {(frame:number, port:number, device:number, index:number, id:number)=>number} fn
   */
  setInputProvider(fn) {
    this._inputProvider = typeof fn === 'function' ? fn : null;
  }

  _readInput(port, device, index, id) {
    if (!this._inputProvider) return 0;
    try {
      const mask = this._inputProvider(this.currentFrame, port, device, index, id);
      if (typeof mask !== 'number' || !Number.isFinite(mask)) return 0;
      // The provider returns a whole-joypad bitmask; extract the queried button's bit.
      return (mask >>> id) & 1;
    } catch (_err) {
      return 0;
    }
  }

  // ------------------------------------------------------------------ run loop

  play() {
    if (this.status !== 'ready' && this.status !== 'running') return;
    this.paused = false;
    this.status = 'running';
    this._setStatus({ engineStatus: 'RunLoop Active' });
    this._startLoop();
  }

  pause() {
    this.paused = true;
    if (this.status === 'running') this.status = 'ready';
    // Actually halt the rAF loop. There is exactly one tracked rAF id, so this fully
    // stops emulation (no orphaned chain keeps ticking).
    this._stopLoop();
    // Only report 'Stopped' once a game is actually loaded (avoid clobbering 'Init').
    if (this.engineStatus === 'RunLoop Active' || this.engineStatus === 'GameLoaded') {
      this._setStatus({ engineStatus: 'Stopped' });
    }
  }

  togglePause() {
    if (this.paused) this.play();
    else this.pause();
  }

  /**
   * Set playback speed multiplier, clamped to [0.1, 2].
   * @param {number} mult
   */
  setSpeed(mult) {
    const m = Number(mult);
    if (!Number.isFinite(m)) return;
    this.speed = Math.min(2, Math.max(0.1, m));
  }

  /** Hold fast-forward (runs multiple frames per rAF tick). */
  fastForward(on = true) {
    this._fastForward = !!on;
    if (on && this.status === 'ready') this.play();
  }

  /**
   * Advance EXACTLY one video frame. Intended for use while paused (frame stepping).
   * Runs one retro_run and increments the frame counter.
   */
  frameAdvance() {
    if (this.status !== 'ready' && this.status !== 'running') return;
    this.pause();
    this._runOneFrame();
  }

  _runOneFrame() {
    if (!this._fn.retro_run) return;
    this._fn.retro_run();
    this.currentFrame += 1;
    this._emitFrame();
  }

  _raf(cb) {
    return typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : setTimeout(() => cb(Date.now()), 16);
  }

  _startLoop() {
    // Idempotent: if a frame is already scheduled, don't schedule a second chain.
    if (this._rafId != null) return;
    this._lastTs = 0;
    this._accumulator = 0;
    // Schedule the FIRST frame here; every subsequent frame is re-armed in exactly one
    // place — the end of _tick() — so only ever ONE rAF id is outstanding and _stopLoop()
    // can always cancel it.
    this._rafId = this._raf(this._tick);
  }

  // Bound in the constructor so the same function reference is used for every schedule,
  // and so `this` is the engine regardless of how rAF invokes it.
  _tick(ts) {
    // The next frame is scheduled in this ONE place (see below) — not at the top — so the
    // tracked id always refers to the live chain.
    if (this.paused) {
      // Loop is stopped on pause via _stopLoop(); if we somehow tick while paused
      // (e.g. a straggler), do no work and do not re-arm.
      this._rafId = null;
      return;
    }

    if (!this._lastTs) this._lastTs = ts;
    const delta = ts - this._lastTs;
    this._lastTs = ts;

    if (this._fastForward) {
      // Run a burst of frames to fast-forward.
      for (let i = 0; i < 8; i++) this._runOneFrame();
    } else {
      // Speed-scaled fixed timestep. Higher speed => shorter effective frame time.
      const frameMs = this._baseFrameMs / this.speed;
      this._accumulator += delta;
      let guard = 0;
      while (this._accumulator >= frameMs && guard < 10) {
        this._runOneFrame();
        this._accumulator -= frameMs;
        guard += 1;
      }
    }

    // Re-arm the loop exactly once, replacing the tracked id in place.
    this._rafId = this._raf(this._tick);
  }

  _stopLoop() {
    if (this._rafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
  }

  // ------------------------------------------------------------------ save states

  /**
   * Serialize the current emulator state.
   * @returns {Uint8Array|null} a snapshot, or null if unavailable.
   */
  saveState() {
    if (!this._fn.retro_serialize_size) return null;
    const M = this.Module;
    const size = this._fn.retro_serialize_size();
    if (!size) return null;
    const ptr = M._malloc(size);
    try {
      const ok = this._fn.retro_serialize(ptr, size);
      if (!ok) return null;
      // Copy out of the heap into a standalone Uint8Array.
      return new Uint8Array(M.HEAPU8.subarray(ptr, ptr + size));
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Restore emulator state from a snapshot. Fires onStateLoaded callbacks so the UI can
   * truncate future inputs (TAS re-recording).
   * @param {Uint8Array} bytes
   * @param {{frame?:number}} [meta] optional metadata (e.g. the frame the state was taken at)
   * @returns {boolean} success
   */
  loadState(bytes, meta = {}) {
    if (!this._fn.retro_unserialize || !bytes || !bytes.length) return false;
    const M = this.Module;
    const ptr = M._malloc(bytes.length);
    try {
      M.HEAPU8.set(bytes, ptr);
      const ok = this._fn.retro_unserialize(ptr, bytes.length);
      if (!ok) return false;
      if (typeof meta.frame === 'number') this.currentFrame = meta.frame;
      // Notify listeners so the input log can truncate everything after this frame.
      this._emitStateLoaded(this.currentFrame);
      this._emitFrame();
      return true;
    } finally {
      M._free(ptr);
    }
  }

  /** Register a callback fired after a state load, for re-record input truncation. */
  onStateLoaded(cb) {
    if (typeof cb === 'function') this._onStateLoadedCbs.push(cb);
    return this;
  }

  _emitStateLoaded(frame) {
    for (const cb of this._onStateLoadedCbs) {
      try {
        cb(frame);
      } catch (err) {
        console.warn('[TASEngine] onStateLoaded callback error', err);
      }
    }
  }

  // ------------------------------------------------------------------ memory (READ-ONLY)

  /**
   * Return a STRICTLY READ-ONLY view over SNES WRAM for the HUD (memory-watch.js).
   *
   * The returned object exposes only read accessors. It intentionally provides NO way to
   * write, poke, or inject memory. This is by product design: the game must run 100%
   * authentically; routing is done by observation only.
   *
   * @returns {{
   *   size:number,
   *   readU8:(offset:number)=>number,
   *   readU16:(offset:number, littleEndian?:boolean)=>number,
   *   readS16:(offset:number, littleEndian?:boolean)=>number,
   *   snapshot:()=>Uint8Array
   * } | null}
   */
  getMemoryView() {
    if (!this.Module || !this._wramPtr || !this._wramSize) return null;
    const M = this.Module;
    const base = this._wramPtr;
    const size = this._wramSize;

    const inRange = (offset, width) =>
      Number.isInteger(offset) && offset >= 0 && offset + width <= size;

    return Object.freeze({
      size,
      readU8(offset) {
        if (!inRange(offset, 1)) return 0;
        return M.HEAPU8[base + offset];
      },
      readU16(offset, littleEndian = true) {
        if (!inRange(offset, 2)) return 0;
        const lo = M.HEAPU8[base + offset];
        const hi = M.HEAPU8[base + offset + 1];
        return littleEndian ? lo | (hi << 8) : hi | (lo << 8);
      },
      readS16(offset, littleEndian = true) {
        const u = this.readU16(offset, littleEndian);
        return u >= 0x8000 ? u - 0x10000 : u;
      },
      // A defensive copy of the whole region for read-only inspection.
      snapshot() {
        return new Uint8Array(M.HEAPU8.subarray(base, base + size));
      },
    });
  }

  /**
   * The catalog id of the currently active core ('realtime' | 'accuracy' | 'performance'),
   * resolved from the active corePath, or null when no core is loaded. READ-ONLY metadata:
   * memory-watch.js uses this to select the correct per-core WRAM offset map so the Live HUD
   * stays correct across core swaps. It grants no capability — it only names the active core.
   */
  get activeCoreId() {
    if (!this.corePath) return null;
    const entry = CORE_CATALOG.find((c) => c.path === this.corePath);
    return entry ? entry.id : null;
  }

  // ------------------------------------------------------------------ frame callbacks

  /** Register a per-frame callback (invoked after each advanced frame). */
  onFrame(cb) {
    if (typeof cb === 'function') this._onFrameCbs.push(cb);
    return this;
  }

  _emitFrame() {
    for (const cb of this._onFrameCbs) {
      try {
        cb(this.currentFrame, this.status);
      } catch (err) {
        console.warn('[TASEngine] onFrame callback error', err);
      }
    }
  }
}

// Create and expose a singleton for classic-script consumers (index.html bootstrap,
// memory-watch.js, and the FEAT-002 UI).
const engine = new TASEngine();
if (typeof window !== 'undefined') {
  window.TASEngine = engine;
}

export default engine;
export { TASEngine };
