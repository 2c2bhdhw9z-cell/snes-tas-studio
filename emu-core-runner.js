// emu-core-runner.js
//
// The DOM-free, worker-ready libretro core runner for the SNES TAS Studio.
//
// This module is the emulator ENGINE proper — everything that must run OFF the main thread:
//   - Load the WASM libretro core via core/core-loader.js (dynamic import).
//   - Fetch the ROM from the exact path 'assets/Super Mario All-Stars (USA).sfc'
//     (encodeURI at fetch time; NEVER a file picker).
//   - Wrap the verified libretro C ABI through Emscripten cwrap (retro_cheat_* NEVER wrapped).
//   - Install env/video/audio/input_poll/input_state callbacks via Module.addFunction.
//   - Handle RETRO_ENVIRONMENT_* fail-closed (verbatim semantics from the original engine).
//   - Load the game, capture the READ-ONLY WRAM region + av_info geometry/fps.
//   - Drive a SELF-SCHEDULING run loop: for a SYNCHRONOUS core (snes9x) it calls retro_run
//     then yields (setTimeout(0)/queueMicrotask) so control + input messages are received
//     BETWEEN frames; for an ASYNCIFY core it awaits retro_run.
//   - Honor speed (0.1x-2x), fast-forward, and frame-advance (EXACTLY one retro_run).
//   - Save/load state (retro_serialize / retro_unserialize) over standalone byte buffers.
//   - Decode the framebuffer (XRGB8888 / XRGB1555 / RGB565) into an RGBA buffer and hand it
//     to an injected sink — it NEVER touches a canvas or the DOM.
//   - Read the verified SMB1 HUD addresses READ-ONLY and hand a small values object to a sink.
//
// DEPENDENCY INJECTION (why this is worker-ready AND unit-testable in Node with a mock core):
// the runner references NO window / document / canvas. Instead the caller injects:
//   sinks:
//     onVideoFrame(rgba, width, height, pitch, pixelFormat)  // RGBA8888 Uint8ClampedArray
//     onHud(values)                                          // { hSpeed, x, y, ... }
//     onStatus(snapshot)                                     // diagnostic banner fields
//     onFrame(frameNumber, status)                           // per-frame tick
//     onStateLoaded(frame)                                   // re-record truncation hook
//   input source:
//     getFrameInputMask(frame) -> number                     // (log.getMask|liveMask)>>>0
//   optional platform deps (defaulted for the browser/worker; overridable for tests):
//     loadCore, fetchRom, scheduleYield
//
// HARD RULES enforced here (regressions == failure):
//   * Memory is STRICTLY READ-ONLY. No poke/write/inject/setMemory helper exists anywhere.
//   * retro_cheat_set / retro_cheat_reset are NEVER wrapped or called.
//   * No level / stage selection logic. No file picker.

'use strict';

import { loadCore as defaultLoadCore, DEFAULT_CORE_PATHS, CORE_CATALOG } from './core/core-loader.js';

// The exact ROM path the app auto-boots. No file picker anywhere.
export const ROM_PATH = 'assets/Super Mario All-Stars (USA).sfc';

// RETRO_MEMORY_SYSTEM_RAM — the id passed to retro_get_memory_data/size for WRAM.
const RETRO_MEMORY_SYSTEM_RAM = 2;

// The subset of RETRO_ENVIRONMENT_* commands this frontend explicitly handles. Every other
// command is answered fail-closed (false). Copied verbatim from the original main-thread
// engine so the extracted runner boots real cores identically (proven by run-smoke.mjs).
const RETRO_ENVIRONMENT = Object.freeze({
  SET_ROTATION: 1,
  GET_OVERSCAN: 2,
  GET_CAN_DUPE: 3,
  SET_MESSAGE: 6,
  SET_PERFORMANCE_LEVEL: 8,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  SET_INPUT_DESCRIPTORS: 11,
  SET_KEYBOARD_CALLBACK: 12,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  SET_SUPPORT_NO_GAME: 18,
  GET_LOG_INTERFACE: 27,
  GET_CORE_ASSETS_DIRECTORY: 30,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
  SET_SUBSYSTEM_INFO: 34,
  SET_CONTROLLER_INFO: 35,
  SET_MEMORY_MAPS: 36,
  SET_GEOMETRY: 37,
  GET_LANGUAGE: 39,
  GET_CORE_OPTIONS_VERSION: 52,
  SET_CORE_OPTIONS: 53,
  SET_CORE_OPTIONS_INTL: 54,
  SET_CORE_OPTIONS_DISPLAY: 55,
});

// The experimental/private high bits some GET commands carry in libretro.h.
const RETRO_ENVIRONMENT_EXPERIMENTAL_MASK = 0xffff;

// RETRO_PIXEL_FORMAT_* values (libretro.h).
const RETRO_PIXEL_FORMAT = Object.freeze({
  XRGB1555: 0,
  XRGB8888: 1,
  RGB565: 2,
});

// libretro device id for the standard joypad; bit layout (RETRO_DEVICE_ID_JOYPAD_*).
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

// The empirically-verified SMB1 (All-Stars) WRAM HUD addresses. READ-ONLY. Shared across
// all cores (verified identical for snes9x and bsnes). H-Speed is a signed byte; X and Y are
// composed from a high byte + a sub-pixel byte (and, for X, a screen page at 0x0401).
export const SMB1_HUD_ADDR = Object.freeze({
  H_SPEED: 0x005d, // signed horizontal speed (S8)
  X_HI: 0x0042, // X position high byte
  X_SUB: 0x0043, // X sub-pixel
  X_PAGE: 0x0401, // X screen page
  Y_HI: 0x0002, // Y position high byte
  Y_SUB: 0x041c, // Y sub-pixel
});

/** Default ROM fetcher used in the browser/worker. Split out so tests can inject their own. */
async function defaultFetchRom() {
  const url = encodeURI(ROM_PATH);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res || !res.ok) {
    return { ok: false, status: res ? res.status : 0, reason: 'rom-missing' };
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) return { ok: false, reason: 'rom-empty' };
  return { ok: true, bytes: new Uint8Array(buf) };
}

/**
 * Default per-frame yield used by the synchronous run loop so control + input messages are
 * received BETWEEN retro_run calls. setTimeout(0) yields the macrotask queue (drains posted
 * messages); a browser worker can also override with a MessageChannel for a tighter loop.
 */
function defaultScheduleYield(cb) {
  if (typeof setTimeout === 'function') return setTimeout(cb, 0);
  Promise.resolve().then(cb);
  return 0;
}

/**
 * The DOM-free libretro core runner.
 *
 * Construct with injected sinks + an input source, then call boot() to load the core + ROM,
 * and start()/pause()/frameAdvance()/setSpeed()/fastForward() to drive it. The runner posts
 * decoded RGBA frames, HUD values, status snapshots, and per-frame ticks through the injected
 * sinks — it renders nothing itself.
 */
export class EmuCoreRunner {
  /**
   * @param {{
   *   onVideoFrame?: (rgba:Uint8ClampedArray, width:number, height:number, pitch:number, pixelFormat:number)=>void,
   *   onHud?: (values:object)=>void,
   *   onStatus?: (snapshot:object)=>void,
   *   onFrame?: (frame:number, status:string)=>void,
   *   onStateLoaded?: (frame:number)=>void,
   *   getFrameInputMask?: (frame:number)=>number,
   *   loadCore?: Function,
   *   fetchRom?: () => Promise<{ok:boolean, bytes?:Uint8Array}>,
   *   scheduleYield?: (cb:Function)=>any,
   *   asyncify?: boolean,
   * }} [deps]
   */
  constructor(deps = {}) {
    // Injected sinks (all optional; default to no-ops so the runner never assumes a DOM).
    this._onVideoFrame = typeof deps.onVideoFrame === 'function' ? deps.onVideoFrame : () => {};
    this._onHud = typeof deps.onHud === 'function' ? deps.onHud : () => {};
    this._onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : () => {};
    this._onFrame = typeof deps.onFrame === 'function' ? deps.onFrame : () => {};
    this._onStateLoaded = typeof deps.onStateLoaded === 'function' ? deps.onStateLoaded : () => {};

    // Injected input source: frame -> whole-joypad bitmask.
    this._getFrameInputMask =
      typeof deps.getFrameInputMask === 'function' ? deps.getFrameInputMask : () => 0;

    // Injectable platform deps (defaulted for browser/worker, overridable for tests).
    this._loadCore = typeof deps.loadCore === 'function' ? deps.loadCore : defaultLoadCore;
    this._fetchRom = typeof deps.fetchRom === 'function' ? deps.fetchRom : defaultFetchRom;
    this._scheduleYield =
      typeof deps.scheduleYield === 'function' ? deps.scheduleYield : defaultScheduleYield;
    // Whether retro_run may suspend (ASYNCIFY cores return a Promise from retro_run). The
    // synchronous default (snes9x) is false; a caller loading a bsnes core sets this true.
    this._asyncify = !!deps.asyncify;

    // Core / module state.
    this.Module = null;
    this.corePath = null;
    this.status = 'idle'; // idle | loading | ready | running | disabled | error
    this.coreStatus = 'Idle';
    this.romStatus = 'Idle';
    this.romBytes = 0;
    this.engineStatus = 'Init';

    this._fn = {};
    this._romData = null;
    this._romDataPtr = 0;
    this._sysDirPtr = 0;
    this._saveDirPtr = 0;

    // Run loop state.
    this.currentFrame = 0;
    this.paused = true;
    this.speed = 1.0;
    this._fastForward = false;
    this._loopHandle = null;
    this._loopRunning = false;
    this._accumulator = 0;
    this._lastTs = 0;
    this.DEFAULT_FPS = 60.098;
    this.fps = this.DEFAULT_FPS;
    this._baseFrameMs = 1000 / this.fps;

    // Video framebuffer plumbing (RGBA output only — no canvas).
    this._rgba = null;
    this._fbWidth = 0;
    this._fbHeight = 0;
    this._pixelFormat = RETRO_PIXEL_FORMAT.RGB565;

    // Memory (WRAM) read-only region.
    this._wramPtr = 0;
    this._wramSize = 0;
  }

  // ------------------------------------------------------------------ status surface

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

  _setStatus(patch) {
    if (patch && typeof patch === 'object') {
      if ('coreStatus' in patch) this.coreStatus = patch.coreStatus;
      if ('romStatus' in patch) this.romStatus = patch.romStatus;
      if ('romBytes' in patch) this.romBytes = patch.romBytes;
      if ('engineStatus' in patch) this.engineStatus = patch.engineStatus;
    }
    try {
      this._onStatus(this.statusSnapshot());
    } catch (err) {
      console.warn('[EmuCoreRunner] onStatus sink error', err);
    }
  }

  // ------------------------------------------------------------------ boot

  /**
   * Load the core + ROM and load the game. Never throws; on missing core/ROM it sets a
   * disabled state and returns { ok:false }. On success the game is loaded and ready; the
   * caller decides whether to start() (the main-thread engine auto-plays).
   *
   * @param {{corePaths?:string[]}} [opts]
   * @returns {Promise<{ok:boolean, coreOk?:boolean, romOk?:boolean, error?:string}>}
   */
  async boot(opts = {}) {
    this.status = 'loading';
    this._setStatus({ coreStatus: 'Loading', romStatus: 'Idle', romBytes: 0, engineStatus: 'Init' });

    let coreResult;
    try {
      coreResult = await this._loadCore({ corePaths: opts.corePaths || DEFAULT_CORE_PATHS });
    } catch (err) {
      coreResult = { ok: false, reason: 'core-missing', detail: String(err) };
    }
    const coreOk = coreResult && coreResult.ok;
    this._setStatus({ coreStatus: coreOk ? 'Instantiated' : 'Failed' });

    this._setStatus({ romStatus: 'Fetching', romBytes: 0 });
    let romResult;
    try {
      romResult = await this._fetchRom();
    } catch (err) {
      romResult = { ok: false, reason: 'rom-fetch-error', detail: String(err) };
    }
    const romOk = romResult && romResult.ok;
    if (romOk) {
      this._setStatus({ romStatus: `Loaded ${romResult.bytes.length} bytes`, romBytes: romResult.bytes.length });
    } else {
      const code = romResult && 'status' in romResult ? romResult.status : (romResult && romResult.reason) || 'error';
      this._setStatus({ romStatus: `Error ${code}` });
    }

    if (!coreOk || !romOk) {
      this.status = 'disabled';
      this._setStatus({});
      this._emitFrame();
      return { ok: false, coreOk: !!coreOk, romOk: !!romOk, coreResult, romResult };
    }

    this.Module = coreResult.Module;
    this.corePath = coreResult.corePath;
    this._romData = romResult.bytes;

    try {
      this._wrapCore();
      this._installCallbacks();
      this._fn.retro_init();
      const loaded = this._loadGame(this._romData);
      if (!loaded) {
        this.status = 'error';
        this._setStatus({ engineStatus: 'Stopped' });
        return { ok: false, coreOk: true, romOk: true, error: 'retro_load_game returned false' };
      }
      this._captureMemoryRegion();
      this._captureAvInfo();
      this.status = 'ready';
      this._setStatus({ engineStatus: 'GameLoaded' });
      return { ok: true, coreOk: true, romOk: true };
    } catch (err) {
      this.status = 'error';
      this._setStatus({ engineStatus: 'Stopped' });
      return { ok: false, coreOk: true, romOk: true, error: String(err && err.message ? err.message : err) };
    }
  }

  // ------------------------------------------------------------------ core teardown

  /**
   * Tear the current core down: stop the loop, unload the game, free retained heap buffers,
   * and drop the Module reference so a fresh boot() can take over. Safe when nothing loaded.
   */
  teardown() {
    this._stopLoop();
    this.paused = true;

    const M = this.Module;
    if (M) {
      try {
        if (this._fn && typeof this._fn.retro_unload_game === 'function') this._fn.retro_unload_game();
        if (this._fn && typeof this._fn.retro_deinit === 'function') this._fn.retro_deinit();
      } catch (err) {
        console.warn('[EmuCoreRunner] core teardown warning:', err);
      }
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
    this.Module = null;
    this.corePath = null;
    this._fn = {};
    this._romData = null;
    this._wramPtr = 0;
    this._wramSize = 0;
    this.currentFrame = 0;
    this._rgba = null;
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
    // Wrap the verified libretro ABI symbols. (retro_cheat_* intentionally omitted forever.)
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
    const add = (fn, sig) => (typeof M.addFunction === 'function' ? M.addFunction(fn, sig) : 0);

    const envCb = add((cmd, data) => this._handleEnvironment(cmd, data), 'iii');
    if (envCb) this._fn.retro_set_environment(envCb);

    const videoCb = add((dataPtr, width, height, pitch) => {
      this._onVideoRefresh(dataPtr, width, height, pitch);
    }, 'viiii');
    if (videoCb) this._fn.retro_set_video_refresh(videoCb);

    // Audio: no-op sinks in this feature (audio wiring is out of scope for the migration).
    const audioSampleCb = add((_left, _right) => {}, 'vii');
    if (audioSampleCb) this._fn.retro_set_audio_sample(audioSampleCb);
    const audioBatchCb = add((_dataPtr, frames) => frames, 'iii');
    if (audioBatchCb) this._fn.retro_set_audio_sample_batch(audioBatchCb);

    const inputPollCb = add(() => {}, 'v');
    if (inputPollCb) this._fn.retro_set_input_poll(inputPollCb);

    const inputStateCb = add((port, device, index, id) => {
      return this._readInput(port, device, index, id);
    }, 'iiiii');
    if (inputStateCb) this._fn.retro_set_input_state(inputStateCb);
  }

  /**
   * Handle a RETRO_ENVIRONMENT_* command. Returns true ONLY for commands we recognize and
   * (for GET-style queries) actually fulfilled; false otherwise (fail-closed). Verbatim
   * semantics from the original main-thread engine.
   */
  _handleEnvironment(cmd, data) {
    const M = this.Module;
    const base = cmd & RETRO_ENVIRONMENT_EXPERIMENTAL_MASK;
    switch (base) {
      case RETRO_ENVIRONMENT.SET_PIXEL_FORMAT: {
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
        if (!M || !data) return false;
        M.HEAPU8[data] = 1;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_OVERSCAN: {
        if (!M || !data) return false;
        M.HEAPU8[data] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_SYSTEM_DIRECTORY:
      case RETRO_ENVIRONMENT.GET_CORE_ASSETS_DIRECTORY: {
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
        if (!M || !data) return false;
        M.HEAP32[(data + 4) >> 2] = 0; // value = NULL
        return true;
      }
      case RETRO_ENVIRONMENT.GET_VARIABLE_UPDATE: {
        if (!M || !data) return false;
        M.HEAPU8[data] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_LANGUAGE: {
        if (!M || !data) return false;
        M.HEAP32[data >> 2] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_CORE_OPTIONS_VERSION: {
        if (!M || !data) return false;
        M.HEAP32[data >> 2] = 0;
        return true;
      }
      case RETRO_ENVIRONMENT.GET_LOG_INTERFACE:
        // Variadic C callback — addFunction cannot represent it; a real core invoking a
        // mismatched table entry TRAPS. Deliberately fail-closed so the core self-logs.
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
        return true;
      default:
        return false;
    }
  }

  _ensureDirString(field) {
    const M = this.Module;
    if (!M || typeof M._malloc !== 'function') return 0;
    if (this[field]) return this[field];
    const bytes = [0x2e, 0x00]; // '.', '\0'
    const ptr = M._malloc(bytes.length);
    if (!ptr) return 0;
    for (let i = 0; i < bytes.length; i++) M.HEAPU8[ptr + i] = bytes[i];
    this[field] = ptr;
    return ptr;
  }

  _loadGame(romBytes) {
    const M = this.Module;
    const dataPtr = M._malloc(romBytes.length);
    M.HEAPU8.set(romBytes, dataPtr);
    if (this._romDataPtr) {
      M._free(this._romDataPtr);
      this._romDataPtr = 0;
    }
    this._romDataPtr = dataPtr;

    // retro_game_info { const char *path; const void *data; size_t size; const char *meta; }.
    const infoPtr = M._malloc(16);
    const HEAP32 = M.HEAP32;
    const idx = infoPtr >> 2;
    HEAP32[idx + 0] = 0; // path = NULL
    HEAP32[idx + 1] = dataPtr; // data
    HEAP32[idx + 2] = romBytes.length; // size
    HEAP32[idx + 3] = 0; // meta = NULL

    const ok = this._fn.retro_load_game(infoPtr);

    // Free ONLY the info struct. The ROM DATA buffer is retained for the game's lifetime
    // (bsnes references it when need_fullpath == false); released on unload/reload only.
    M._free(infoPtr);
    if (!ok) {
      M._free(this._romDataPtr);
      this._romDataPtr = 0;
    }
    return !!ok;
  }

  _captureMemoryRegion() {
    this._wramPtr = this._fn.retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM) || 0;
    this._wramSize = this._fn.retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM) || 0;
  }

  /**
   * Query retro_get_system_av_info to drive frame pacing + known geometry from the core's
   * declared fps. Falls back to DEFAULT_FPS on missing/nonsensical values.
   * struct layout (wasm32): geometry.base_width@0, base_height@4; timing.fps (double)@24.
   */
  _captureAvInfo() {
    const M = this.Module;
    if (!M || typeof this._fn.retro_get_system_av_info !== 'function') return;
    const AV_INFO_BYTES = 40;
    const ptr = M._malloc(AV_INFO_BYTES);
    try {
      M.HEAPU8.fill(0, ptr, ptr + AV_INFO_BYTES);
      this._fn.retro_get_system_av_info(ptr);
      const u32 = ptr >> 2;
      const baseW = M.HEAPU32[u32 + 0];
      const baseH = M.HEAPU32[u32 + 1];
      if (baseW > 0 && baseH > 0) {
        this.avBaseWidth = baseW;
        this.avBaseHeight = baseH;
      }
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

  // ------------------------------------------------------------------ video (RGBA out)

  /**
   * Decode the core framebuffer into an RGBA8888 buffer and hand it to the injected video
   * sink. NEVER touches a canvas or the DOM — the sink decides how to present the pixels
   * (worker blits to an OffscreenCanvas, or posts the buffer to the main thread).
   */
  _onVideoRefresh(dataPtr, width, height, pitch) {
    if (!dataPtr || !width || !height) return;
    const M = this.Module;

    if (this._fbWidth !== width || this._fbHeight !== height || !this._rgba) {
      this._fbWidth = width;
      this._fbHeight = height;
      this._rgba = new Uint8ClampedArray(width * height * 4);
    }
    const out = this._rgba;

    if (this._pixelFormat === RETRO_PIXEL_FORMAT.XRGB8888) {
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
      // RGB565 (libretro default).
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

    try {
      this._onVideoFrame(out, width, height, pitch, this._pixelFormat);
    } catch (err) {
      console.warn('[EmuCoreRunner] onVideoFrame sink error', err);
    }
  }

  // ------------------------------------------------------------------ input

  _readInput(port, device, index, id) {
    try {
      const mask = this._getFrameInputMask(this.currentFrame, port, device, index, id);
      if (typeof mask !== 'number' || !Number.isFinite(mask)) return 0;
      // The source returns a whole-joypad bitmask; extract the queried button's bit.
      return (mask >>> id) & 1;
    } catch (_err) {
      return 0;
    }
  }

  // ------------------------------------------------------------------ run loop

  start() {
    if (this.status !== 'ready' && this.status !== 'running') return;
    this.paused = false;
    this.status = 'running';
    this._setStatus({ engineStatus: 'RunLoop Active' });
    this._startLoop();
  }

  pause() {
    this.paused = true;
    if (this.status === 'running') this.status = 'ready';
    this._stopLoop();
    if (this.engineStatus === 'RunLoop Active' || this.engineStatus === 'GameLoaded') {
      this._setStatus({ engineStatus: 'Stopped' });
    }
  }

  togglePause() {
    if (this.paused) this.start();
    else this.pause();
  }

  /** Set playback speed multiplier, clamped to [0.1, 2]. */
  setSpeed(mult) {
    const m = Number(mult);
    if (!Number.isFinite(m)) return;
    this.speed = Math.min(2, Math.max(0.1, m));
  }

  /** Hold fast-forward (runs a burst of frames per loop tick). */
  fastForward(on = true) {
    this._fastForward = !!on;
    if (on && this.status === 'ready') this.start();
  }

  /**
   * Advance EXACTLY one video frame (frame stepping). Runs one retro_run and increments the
   * frame counter. For an ASYNCIFY core this returns the awaited retro_run promise.
   */
  frameAdvance() {
    if (this.status !== 'ready' && this.status !== 'running') return;
    this.pause();
    return this._runOneFrame();
  }

  _runOneFrame() {
    if (!this._fn.retro_run) return;
    if (this._asyncify) {
      // ASYNCIFY core: retro_run may return a Promise when it suspends. Await it, then tick.
      return Promise.resolve(this._fn.retro_run()).then(() => {
        this.currentFrame += 1;
        this._afterFrame();
      });
    }
    this._fn.retro_run();
    this.currentFrame += 1;
    this._afterFrame();
  }

  _afterFrame() {
    this._emitHud();
    this._emitFrame();
  }

  /**
   * Start the self-scheduling run loop. Unlike the main-thread rAF engine, this yields via
   * the injected scheduler (setTimeout(0) by default) BETWEEN frames so a worker receives
   * control + input messages between retro_run calls. A hard guard bounds catch-up frames.
   */
  _startLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._lastTs = 0;
    this._accumulator = 0;
    this._scheduleTick();
  }

  _scheduleTick() {
    this._loopHandle = this._scheduleYield(() => this._tick());
  }

  async _tick() {
    if (this.paused || !this._loopRunning) {
      this._loopRunning = false;
      this._loopHandle = null;
      return;
    }

    const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (!this._lastTs) this._lastTs = now;
    const delta = now - this._lastTs;
    this._lastTs = now;

    // Run this tick's burst/catch-up frames. For a synchronous core (snes9x, the shipped
    // real-time default) _runOneFrame runs inline and this loop is fully synchronous — the
    // exact original behavior. For an ASYNCIFY core (bsnes) retro_run may suspend and return
    // a Promise, so we MUST await each frame before starting the next, otherwise multiple
    // retro_run suspensions overlap (which libco/Asyncify does not support).
    if (this._fastForward) {
      for (let i = 0; i < 8; i++) {
        if (this._asyncify) await this._runOneFrame();
        else this._runOneFrame();
      }
    } else {
      const frameMs = this._baseFrameMs / this.speed;
      this._accumulator += delta;
      let guard = 0;
      while (this._accumulator >= frameMs && guard < 10) {
        if (this._asyncify) await this._runOneFrame();
        else this._runOneFrame();
        this._accumulator -= frameMs;
        guard += 1;
      }
    }

    // We re-arm exactly once, AFTER this tick's work (post-await for ASYNCIFY), so only ONE
    // tick — and for ASYNCIFY only ONE retro_run suspension — is ever outstanding.
    if (this._loopRunning && !this.paused) this._scheduleTick();
    else {
      this._loopRunning = false;
      this._loopHandle = null;
    }
  }

  _stopLoop() {
    this._loopRunning = false;
    if (this._loopHandle != null && typeof clearTimeout === 'function') {
      clearTimeout(this._loopHandle);
    }
    this._loopHandle = null;
  }

  // ------------------------------------------------------------------ save states

  /**
   * Serialize the current emulator state into a standalone Uint8Array (safe to transfer
   * across the worker boundary). Returns null if unavailable.
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
      return new Uint8Array(M.HEAPU8.subarray(ptr, ptr + size));
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Restore emulator state from a snapshot. Fires the onStateLoaded sink so the UI can
   * truncate future inputs (TAS re-recording).
   * @param {Uint8Array} bytes
   * @param {{frame?:number}} [meta]
   * @returns {boolean}
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
      this._emitStateLoaded(this.currentFrame);
      this._emitFrame();
      return true;
    } finally {
      M._free(ptr);
    }
  }

  _emitStateLoaded(frame) {
    try {
      this._onStateLoaded(frame);
    } catch (err) {
      console.warn('[EmuCoreRunner] onStateLoaded sink error', err);
    }
  }

  // ------------------------------------------------------------------ memory (READ-ONLY)

  /**
   * A STRICTLY READ-ONLY view over SNES WRAM for HUD reads. Exposes only read accessors;
   * there is intentionally NO way to write/poke/inject memory anywhere in this class.
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
      readS8(offset) {
        if (!inRange(offset, 1)) return 0;
        const u = M.HEAPU8[base + offset];
        return u >= 0x80 ? u - 0x100 : u;
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
      snapshot() {
        return new Uint8Array(M.HEAPU8.subarray(base, base + size));
      },
    });
  }

  /**
   * Read the verified SMB1 HUD addresses READ-ONLY into a small values object for the HUD
   * sink. Returns null if no WRAM is available. STRICTLY READ-ONLY: this only observes.
   */
  readHudValues() {
    const mem = this.getMemoryView();
    if (!mem) return null;
    return {
      hSpeed: mem.readS8(SMB1_HUD_ADDR.H_SPEED),
      xHi: mem.readU8(SMB1_HUD_ADDR.X_HI),
      xSub: mem.readU8(SMB1_HUD_ADDR.X_SUB),
      xPage: mem.readU8(SMB1_HUD_ADDR.X_PAGE),
      yHi: mem.readU8(SMB1_HUD_ADDR.Y_HI),
      ySub: mem.readU8(SMB1_HUD_ADDR.Y_SUB),
      // Composite positions for convenience (page*256 + hi, then sub for fractional part).
      x: (mem.readU8(SMB1_HUD_ADDR.X_PAGE) << 8) | mem.readU8(SMB1_HUD_ADDR.X_HI),
      y: mem.readU8(SMB1_HUD_ADDR.Y_HI),
    };
  }

  _emitHud() {
    const values = this.readHudValues();
    if (!values) return;
    try {
      this._onHud(values);
    } catch (err) {
      console.warn('[EmuCoreRunner] onHud sink error', err);
    }
  }

  /**
   * The catalog id of the active core ('realtime' | 'accuracy' | 'performance'), or null.
   * READ-ONLY metadata used to select the correct per-core WRAM offset map. Grants nothing.
   */
  get activeCoreId() {
    if (!this.corePath) return null;
    const entry = CORE_CATALOG.find((c) => c.path === this.corePath);
    return entry ? entry.id : null;
  }

  // ------------------------------------------------------------------ frame ticks

  _emitFrame() {
    try {
      this._onFrame(this.currentFrame, this.status);
    } catch (err) {
      console.warn('[EmuCoreRunner] onFrame sink error', err);
    }
  }
}

export default EmuCoreRunner;
