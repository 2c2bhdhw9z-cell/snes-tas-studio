// piano-roll.js
//
// The TAS Studio interface layer built on top of the single-thread engine API. It wires up:
//   1. The Piano Roll input editor: a scrollable per-frame timeline whose columns are the
//      SNES buttons (A/B/X/Y/L/R + D-Pad + Start/Select). Clicking a cell toggles that
//      button on that frame. The AUTHORITATIVE InputLog lives IN-PROCESS in the engine's
//      InputResolver, so a cell toggle both updates a LOCAL MIRROR log (for grid rendering)
//      and calls engine.sendInputEdit({op:'setFrameButton'}) (which forwards to
//      resolver.applyEdit) so the resolver's log stays in lockstep.
//   2. Live input: LiveInput (gamepad + touch) is polled on the MAIN THREAD each animation
//      frame and its mask is handed to the engine via engine.sendLiveMask(mask). The engine
//      holds the latest live mask and OR-s it into the frame it runs next, preserving the
//      determinism contract (log.getMask(frame) | liveMask) >>> 0.
//   3. The Frame Control toolbar: Frame Advance (sends exactly one frameAdvance), Play/Pause,
//      a 0.1x-2x speed slider, and Fast-Forward, each wired to the engine with visual state.
//   4. The Save-State Tree: Save captures engine.saveState() + the current frame + a local
//      input-log snapshot; Load restores the state, restores the local mirror snapshot, sends
//      truncateAfter through engine.sendInputEdit, and the engine's onStateLoaded hook
//      truncates the mirror so re-recording holds on every load.
//
// The whole UI stays functional with no core/ROM present: cells toggle, controls exist,
// and save/load simply operate on the local mirror log (engine commands no-op gracefully).
//
// HARD RULE: nothing here writes emulator memory, applies cheats, or selects levels.
//
// ==========================================================================================
// THE FPS-DECAY LEAK LIVED HERE (fixed below). READ THIS BEFORE TOUCHING _onEngineFrame.
// ==========================================================================================
// The app's framerate decayed monotonically (60 -> ~10 in ~30s, and ~4 FPS forever after a
// backgrounding) because THIS FILE did O(frame) DOM work on EVERY emulated frame:
//
//     _onEngineFrame(frame) {
//       const needed = Math.max(MIN_ROWS, this.log.length, frame + LOOKAHEAD);
//       if (needed > this._renderedRows) {     // TRUE ON EVERY FRAME once frame > 60,
//         this._buildGrid(needed);             // because `needed` grows by 1 every frame
//         this._refreshCells();                // -> innerHTML='' + 13*(frame+60) createElement
//       }                                      // -> querySelectorAll over ALL cells
//       this._highlightCurrentRow(frame);      // -> querySelector + scrollIntoView, per frame
//     }
//
// So at frame 600 the studio destroyed and re-created ~8,580 elements and queried all of them
// EVERY frame; at frame 1800, ~24,000. The per-frame cost grew LINEARLY with the frame
// counter, which is exactly a smooth monotonic FPS decay that never recovers. It also explains
// every dead end of the earlier investigation: it is UI/DOM work (so blindfolding the canvas
// changed nothing), it always ran on the UI thread (so both the worker and the single-thread
// architectures decayed identically), and it is core-independent (so all three cores decayed
// the same). The leak profiler drove the runner directly and measured the WASM/worker heaps, so
// it never saw the studio at all.
//
// THE FIX - a BOUNDED, WINDOWED (virtualized) grid with RECYCLED rows:
//   * The grid is built EXACTLY ONCE (_buildGrid) with a FIXED pool of WINDOW_ROWS row
//     elements. The piano roll's DOM node count is therefore CONSTANT for the whole session
//     (~3.4k elements), no matter how many frames are emulated. Nothing in the per-frame path
//     ever calls innerHTML='' or createElement.
//   * Row/cell element references are CACHED at build time (this._rows / row.__cells), and the
//     row for a frame is found by INDEX ARITHMETIC (frame - _windowStart). There is NO
//     querySelector/querySelectorAll anywhere in the per-frame path.
//   * The current-frame highlight moves by touching EXACTLY TWO elements: remove the class
//     from the cached previous row, add it to the cached new row. O(1).
//   * When the playhead leaves the window, the window RECYCLES: the same row elements are
//     re-labelled for the new frame range (_setWindowStart). That is bounded O(WINDOW_ROWS)
//     work once every ~(WINDOW_ROWS - LOOKBEHIND) frames (~3s at 60fps), i.e. a small CONSTANT
//     amortized cost per frame - never a function of the frame number.
//   * scrollIntoView is GONE from the per-frame path (it forced layout+scroll work 60x/sec).
//     Following the playhead is now a THROTTLED, cheap scrollTop assignment on the bounded
//     container, and only when the current row is actually out of view. Layout metrics are
//     measured once per build/recycle, never per frame.
//   * _refreshCells() no longer runs per frame: it runs only when the LOG changes (an edit, a
//     state load, a truncation) or when the window recycles, and it only walks the bounded
//     window via cached refs.
//   * Two spacer elements keep the SCROLL EXTENT of the full timeline, so the timeline still
//     feels like the whole movie and manual scrolling can browse outside the live window.
// Invariant to preserve: the per-frame path must stay O(1) with ZERO element creation and ZERO
// DOM queries. tools/pianoroll-perf.test.mjs is the regression proof.
// ==========================================================================================

'use strict';

import { InputLog, COLUMN_ORDER } from './input-log.js';
import { LiveInput } from './live-input.js';

// Human labels for the piano-roll column headers.
const COLUMN_LABELS = {
  A: 'A',
  B: 'B',
  X: 'X',
  Y: 'Y',
  L: 'L',
  R: 'R',
  UP: '↑',
  DOWN: '↓',
  LEFT: '←',
  RIGHT: '→',
  START: 'St',
  SELECT: 'Se',
};

// How many frames of headroom to keep in the timeline's SCROLL EXTENT ahead of the current
// frame. (This no longer sizes the DOM - see WINDOW_ROWS - it only sizes the bottom spacer.)
const LOOKAHEAD = 60;
// Minimum timeline length so the grid reads as a timeline even at frame 0.
const MIN_ROWS = 120;

// THE HARD CEILING on rendered rows. The piano roll keeps EXACTLY this many row elements alive
// for the whole session and RECYCLES them as the playhead advances, so total DOM nodes under
// #piano-roll are constant ((1 + WINDOW_ROWS) * (1 + COLUMN_ORDER.length) + spacers) forever.
// 240 rows is 4 seconds of 60fps timeline - comfortably more than fits any viewport.
export const WINDOW_ROWS = 240;
// How many frames of history stay ABOVE the current frame when the window recycles forward.
// The window therefore only recycles every (WINDOW_ROWS - LOOKBEHIND) frames of playback.
const LOOKBEHIND = 60;
// Follow-the-playhead throttle: at most one scrollTop assignment every N emulated frames
// (~10x/sec at 60fps) instead of a scrollIntoView on every single frame.
const SCROLL_FOLLOW_EVERY = 6;

export class TASStudio {
  /**
   * @param {object} engine the TAS engine (window.TASEngine / default export).
   * @param {object} els DOM elements: { pianoRoll, frameControls, savestateTree }
   */
  constructor(engine, els = {}) {
    this.engine = engine;
    // LOCAL MIRROR of the scripted input log. The authoritative log lives IN-PROCESS in the
    // engine's InputResolver; this mirror is what the grid renders from and stays in lockstep
    // via the same edits we send to the resolver (setFrameButton / truncateAfter / restore).
    this.log = new InputLog();

    // Live real-time input (gamepad + on-screen touch controls). Polled on the MAIN THREAD
    // each animation frame; its mask is handed to the engine via engine.sendLiveMask() so a
    // paired Bluetooth pad or the touch overlay merges into the frame the engine runs next.
    this.live = new LiveInput();
    this._liveRafId = null;
    this._lastStreamedMask = -1;
    // ONE reused live-poll callback so the live-mask stream does not allocate a fresh closure
    // on every animation frame either.
    this._liveTick = () => this._pollLiveMask();

    this.pianoRollEl = els.pianoRoll || null;
    this.frameControlsEl = els.frameControls || null;
    this.savestateTreeEl = els.savestateTree || null;
    this.touchControlsEl = els.touchControls || null;

    // Save-state tree: nodes keyed by id, with parent references forming the branch tree.
    this._stateNodes = new Map();
    this._stateOrder = [];
    this._stateSeq = 0;
    this._activeNodeId = null;

    // ---------------- windowed (virtualized) grid state ----------------
    // The grid is built ONCE; these caches make the per-frame path O(1) and query-free.
    this._gridBuilt = false;
    this._tableEl = null;
    this._headerEl = null;
    this._bodyEl = null;
    this._topSpacer = null;
    this._botSpacer = null;
    /** @type {HTMLElement[]} the RECYCLED row pool, DOM order == frame order in the window. */
    this._rows = [];
    // First frame currently represented by this._rows[0]. Window = [_windowStart, +_rows.length)
    this._windowStart = 0;
    // Logical timeline length (drives the scroll extent / spacers only, never the DOM size).
    this._totalRows = MIN_ROWS;
    // The currently highlighted frame + its CACHED row element (so the highlight moves in O(1)
    // without a single DOM query).
    this._currentRow = -1;
    this._currentRowEl = null;
    // Cached layout metrics, measured on build/recycle only - NEVER in the per-frame path.
    this._rowHeight = 0;
    this._headerHeight = 0;
    this._viewportHeight = 0;
    // Follow-the-playhead throttle counter + our own scroll bookkeeping.
    this._followCountdown = 0;
    this._selfScroll = false;
    this._gridClickBound = false;
    this._gridScrollBound = false;

    // Back-compat mirror of the old field name (number of rendered row elements). It is now a
    // CONSTANT (the window size), not a function of the frame counter.
    this._renderedRows = 0;
  }

  /** Wire everything up. Safe to call once the DOM is ready. */
  init() {
    this._registerStateLoadHook();
    this._wireLiveInput();
    this._startLiveMaskStream();
    this.renderPianoRoll();
    this.wireFrameControls();
    this.renderStateTree();

    // Refresh the current-frame highlight (and recycle the window) as emulation advances.
    if (typeof this.engine.onFrame === 'function') {
      this.engine.onFrame((frame) => this._onEngineFrame(frame));
    }
    return this;
  }

  // ----------------------------------------------------------------- live mask stream

  /**
   * Poll LiveInput (gamepad + touch) each animation frame on the MAIN THREAD and hand the
   * latest mask to the engine via engine.sendLiveMask(). The engine holds the most-recent
   * live mask and OR-s it into the frame retro_run runs next, so the determinism contract
   * (log.getMask(frame) | liveMask) >>> 0 is preserved without a synchronous per-frame pull.
   * We only send when the mask CHANGES to avoid redundant updates, but always re-send the
   * first non-repeat so the engine never misses a transition.
   *
   * The tick callback is created ONCE (this._liveTick) and re-armed BY REFERENCE, so this
   * stream allocates nothing per animation frame.
   */
  _startLiveMaskStream() {
    if (typeof this.engine.sendLiveMask !== 'function') return;
    this._liveRafId = this._raf(this._liveTick);
  }

  /** One live-input poll turn. Re-arms itself with the SAME callback reference. */
  _pollLiveMask() {
    try {
      this.live.poll();
      const mask = this.live.getMask() >>> 0;
      if (mask !== this._lastStreamedMask) {
        this.engine.sendLiveMask(mask);
        this._lastStreamedMask = mask;
      }
    } catch (_err) {
      /* never let the live stream crash the UI */
    }
    this._liveRafId = this._raf(this._liveTick);
  }

  _raf(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    if (typeof setTimeout === 'function') return setTimeout(cb, 16);
    return null;
  }

  // ----------------------------------------------------------------- live input wiring

  _wireLiveInput() {
    // On-screen touch controls (low-opacity overlay). Bind pointer/touch handlers so
    // pressing a button sets its live bit; releasing clears it.
    if (this.touchControlsEl) {
      this.live.bindTouchControls(this.touchControlsEl);
    }
    // React to Bluetooth pad pairing. The per-frame poll() reads state regardless; this
    // just logs connect/disconnect for visibility.
    if (typeof window !== 'undefined') {
      this.live.attachGamepadEvents(window, (count) => {
        // eslint-disable-next-line no-console
        console.info(`[live-input] gamepads connected: ${count}`);
      });
    }
  }

  // ----------------------------------------------------------------- state-load hook

  _registerStateLoadHook() {
    if (typeof this.engine.onStateLoaded !== 'function') return;
    // Standard TAS re-recording: after a state load at `frame`, everything after that
    // frame in the input log is discarded so new input forms a fresh branch. This fires
    // for EVERY load, whether triggered from the tree UI or elsewhere.
    this.engine.onStateLoaded((frame) => {
      // Truncate the LOCAL MIRROR and tell the engine's in-process authoritative log to
      // truncate too, so both stay in lockstep after a load.
      this.log.truncateAfter(frame);
      if (typeof this.engine.sendInputEdit === 'function') {
        this.engine.sendInputEdit({ op: 'truncateAfter', frame });
      }
      this.renderPianoRoll();
    });
  }

  // ----------------------------------------------------------------- piano roll

  /**
   * Render / re-render the piano roll from the current log + frame. This is the LOG-CHANGE
   * path (init, an edit, a state load, a truncation) - NOT the per-frame path. It builds the
   * fixed row pool once, then re-labels the bounded window around the current frame.
   */
  renderPianoRoll() {
    if (!this.pianoRollEl) return;
    if (!this._gridBuilt) this._buildGrid();

    const current = this._currentFrame();
    // Re-window around the current frame, re-sync the window's cells from the log, move the
    // highlight and refresh the scroll extent. ALL bounded by WINDOW_ROWS - never by the frame
    // number - and none of it happens on the per-frame path.
    this._setWindowStart(this._windowStartFor(current));
    this._refreshCells();
    this._highlightCurrentRow(current);
    this._syncScrollExtent();
  }

  /** The window start that keeps `frame` visible with LOOKBEHIND frames of history above it. */
  _windowStartFor(frame) {
    const f = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
    return Math.max(0, f - LOOKBEHIND);
  }

  /**
   * Build the grid ONCE: the sticky header, the two scroll-extent spacers, and a FIXED pool of
   * WINDOW_ROWS rows that are RECYCLED for the rest of the session. Every row/cell reference is
   * cached here (row.__cells / row.__frameCell) so no code path ever has to query the DOM.
   */
  _buildGrid() {
    const el = this.pianoRollEl;
    el.innerHTML = '';
    el.classList.add('piano-roll--active');

    const table = document.createElement('div');
    table.className = 'pr-table';
    table.setAttribute('role', 'grid');

    // Header row (sticky).
    const header = document.createElement('div');
    header.className = 'pr-row pr-row--header';
    const frameHead = document.createElement('div');
    frameHead.className = 'pr-cell pr-cell--frame pr-cell--head';
    frameHead.textContent = 'Frame';
    header.appendChild(frameHead);
    for (const col of COLUMN_ORDER) {
      const h = document.createElement('div');
      h.className = 'pr-cell pr-cell--head';
      h.textContent = COLUMN_LABELS[col] || col;
      h.dataset.col = col;
      header.appendChild(h);
    }
    table.appendChild(header);

    // Body: [top spacer][WINDOW_ROWS recycled rows][bottom spacer]. The spacers carry the
    // scroll extent of the frames OUTSIDE the live window so the scrollbar still represents the
    // whole timeline; they hold no per-frame elements.
    const body = document.createElement('div');
    body.className = 'pr-body';

    const topSpacer = document.createElement('div');
    topSpacer.className = 'pr-spacer pr-spacer--top';
    topSpacer.setAttribute('aria-hidden', 'true');
    body.appendChild(topSpacer);

    this._rows = [];
    for (let i = 0; i < WINDOW_ROWS; i++) {
      const row = document.createElement('div');
      row.className = 'pr-row';
      row.dataset.frame = String(i);

      const frameCell = document.createElement('div');
      frameCell.className = 'pr-cell pr-cell--frame';
      frameCell.textContent = String(i);
      row.appendChild(frameCell);

      const cells = [];
      for (const col of COLUMN_ORDER) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'pr-cell pr-cell--btn';
        cell.dataset.frame = String(i);
        cell.dataset.col = col;
        cell.setAttribute('aria-pressed', 'false');
        row.appendChild(cell);
        cells.push(cell);
      }
      // CACHED references: the per-frame path and the recycler use these, never a DOM query.
      row.__frameCell = frameCell;
      row.__cells = cells;
      row.__frame = i;
      row.__current = false;
      body.appendChild(row);
      this._rows.push(row);
    }

    const botSpacer = document.createElement('div');
    botSpacer.className = 'pr-spacer pr-spacer--bottom';
    botSpacer.setAttribute('aria-hidden', 'true');
    body.appendChild(botSpacer);

    table.appendChild(body);
    el.appendChild(table);

    this._tableEl = table;
    this._headerEl = header;
    this._bodyEl = body;
    this._topSpacer = topSpacer;
    this._botSpacer = botSpacer;
    this._windowStart = 0;
    this._renderedRows = this._rows.length;
    this._currentRow = -1;
    this._currentRowEl = null;
    this._gridBuilt = true;

    // One delegated click handler for the whole grid (bound once, never per rebuild).
    if (!this._gridClickBound) {
      el.addEventListener('click', (ev) => this._onGridClick(ev));
      this._gridClickBound = true;
    }
    // Manual browsing: when the user scrolls the timeline far outside the live window, move the
    // window to what they are looking at. Passive, coarse-thresholded, and never reached from
    // the per-frame path.
    if (!this._gridScrollBound) {
      const onScroll = () => this._onGridScroll();
      try {
        el.addEventListener('scroll', onScroll, { passive: true });
      } catch (_err) {
        el.addEventListener('scroll', onScroll);
      }
      this._gridScrollBound = true;
    }

    this._measureMetrics();
    this._syncScrollExtent();
  }

  /**
   * Measure the row/header/viewport geometry ONCE per build or window recycle. These are the
   * only layout reads the piano roll performs, and they never happen in the per-frame path.
   * In a headless DOM (jsdom) every metric is 0, which cleanly disables scroll-following.
   */
  _measureMetrics() {
    const el = this.pianoRollEl;
    if (!el) return;
    const firstRow = this._rows.length ? this._rows[0] : null;
    this._rowHeight = firstRow && firstRow.offsetHeight ? firstRow.offsetHeight : 0;
    this._headerHeight =
      this._headerEl && this._headerEl.offsetHeight ? this._headerEl.offsetHeight : this._rowHeight;
    this._viewportHeight = el.clientHeight || 0;
  }

  /**
   * Recycle the row pool onto the frame range starting at `start`: re-label each row's frame
   * index and re-sync its cells from the log. Bounded O(WINDOW_ROWS) and only called when the
   * playhead leaves the window (~every WINDOW_ROWS - LOOKBEHIND frames), on a log change, or
   * on a manual scroll - NEVER once per frame.
   * @param {number} start first frame of the new window
   */
  _setWindowStart(start) {
    if (!this._gridBuilt) return;
    const next = Math.max(0, Math.floor(Number.isFinite(start) ? start : 0));
    if (next === this._windowStart) return; // window unchanged: nothing to relabel
    this._windowStart = next;

    const rows = this._rows;
    const log = this.log;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const frame = next + i;
      if (row.__frame !== frame) {
        row.__frame = frame;
        const fs = String(frame);
        row.dataset.frame = fs;
        row.__frameCell.textContent = fs;
        const cells = row.__cells;
        for (let c = 0; c < cells.length; c++) cells[c].dataset.frame = fs;
      }
      this._syncRowCells(row, frame, log);
    }

    // The highlight's cached row reference points at a RECYCLED element that now shows a
    // different frame, so move the class to whichever row holds the current frame now (still
    // only two elements touched - the cached previous row and the new one).
    const prev = this._currentRowEl;
    if (prev) {
      prev.classList.remove('pr-row--current');
      prev.__current = false;
    }
    this._currentRowEl = null;
    if (this._currentRow >= 0) {
      const row = this._rowElFor(this._currentRow);
      if (row) {
        row.classList.add('pr-row--current');
        row.__current = true;
        this._currentRowEl = row;
      }
    }

    this._measureMetrics();
    this._syncScrollExtent();
  }

  /** Sync ONE row's button cells against the log (cached refs; no DOM query). */
  _syncRowCells(row, frame, log = this.log) {
    const cells = row.__cells;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      const on = log.isSet(frame, cell.dataset.col);
      if (cell.classList.contains('pr-cell--on') !== on) {
        cell.classList.toggle('pr-cell--on', on);
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  /** The cached row element for `frame`, or null when it is outside the live window. */
  _rowElFor(frame) {
    const i = frame - this._windowStart;
    if (i < 0 || i >= this._rows.length) return null;
    return this._rows[i];
  }

  /**
   * Keep the scrollbar representing the WHOLE timeline by sizing the two spacers to the frames
   * above/below the live window. Called on build / recycle / log change only. No-op until a row
   * height is measurable (headless), where scrolling is meaningless anyway.
   */
  _syncScrollExtent() {
    if (!this._gridBuilt) return;
    const current = this._currentFrame();
    this._totalRows = Math.max(MIN_ROWS, this.log.length, current + LOOKAHEAD);
    const rowH = this._rowHeight;
    if (!rowH) return;
    const above = this._windowStart;
    const below = Math.max(0, this._totalRows - (this._windowStart + this._rows.length));
    const topPx = `${above * rowH}px`;
    const botPx = `${below * rowH}px`;
    if (this._topSpacer.style.height !== topPx) this._topSpacer.style.height = topPx;
    if (this._botSpacer.style.height !== botPx) this._botSpacer.style.height = botPx;
  }

  _onGridClick(ev) {
    const cell = ev.target && ev.target.closest ? ev.target.closest('.pr-cell--btn') : null;
    if (!cell) return;
    const frame = parseInt(cell.dataset.frame, 10);
    const col = cell.dataset.col;
    if (Number.isNaN(frame) || !col) return;
    // Update the LOCAL MIRROR for immediate grid feedback...
    const on = this.log.toggle(frame, col);
    // ...and send the same edit to the engine's in-process authoritative InputLog so frame N
    // runs with exactly this scripted bit set. Controller input only, never a memory write.
    if (typeof this.engine.sendInputEdit === 'function') {
      this.engine.sendInputEdit({ op: 'setFrameButton', frame, button: col, on });
    }
    cell.classList.toggle('pr-cell--on', on);
    cell.setAttribute('aria-pressed', on ? 'true' : 'false');
    // An edit can extend the log past the current timeline length; keep the scroll extent
    // honest (cheap: two style writes at most, and only on a click).
    this._syncScrollExtent();
  }

  /**
   * Manual browsing: reposition the live window to whatever the user scrolled to, so the
   * timeline can be inspected beyond the frames around the playhead. Ignores our own
   * follow-the-playhead scrolls and does nothing without measurable geometry (headless).
   */
  _onGridScroll() {
    if (this._selfScroll || !this._gridBuilt) return;
    const rowH = this._rowHeight;
    if (!rowH) return;
    const el = this.pianoRollEl;
    const top = Math.max(0, (el.scrollTop || 0) - this._headerHeight);
    const topFrame = Math.floor(top / rowH);
    const desired = Math.max(0, Math.min(topFrame, Math.max(0, this._totalRows - this._rows.length)));
    // Only recycle when the user has scrolled well outside the window (avoids thrash).
    if (Math.abs(desired - this._windowStart) < LOOKBEHIND) return;
    this._setWindowStart(desired);
  }

  /**
   * Sync every cell in the LIVE WINDOW with the input log. This is the LOG-CHANGE path (edit /
   * state load / truncation) - it is NOT called per frame and it uses cached refs, never
   * querySelectorAll. Cost is bounded by the window size, not by the frame counter.
   */
  _refreshCells() {
    if (!this._gridBuilt) return;
    const rows = this._rows;
    const log = this.log;
    for (let i = 0; i < rows.length; i++) this._syncRowCells(rows[i], this._windowStart + i, log);
  }

  /**
   * Move the current-frame highlight in O(1): drop the class from the CACHED previous row and
   * add it to the CACHED new row. Exactly two elements are touched; no DOM query, no
   * scrollIntoView, no work proportional to the number of rows.
   */
  _highlightCurrentRow(frame) {
    if (!this._gridBuilt) return;
    if (this._currentRow === frame && this._currentRowEl) return;
    const prev = this._currentRowEl;
    if (prev) {
      prev.classList.remove('pr-row--current');
      prev.__current = false;
      this._currentRowEl = null;
    }
    const row = this._rowElFor(frame);
    if (row) {
      row.classList.add('pr-row--current');
      row.__current = true;
      this._currentRowEl = row;
    }
    this._currentRow = frame;
  }

  /**
   * Keep the playhead usefully visible WITHOUT per-frame layout work: at most one cheap
   * scrollTop assignment every SCROLL_FOLLOW_EVERY frames, and only when the current row is
   * actually outside the visible band. Replaces the old scrollIntoView-on-every-frame (which
   * forced layout + scroll anchoring 60x/sec). Because the top spacer carries the frames above
   * the window, a row's offset in the scroll content is simply header + frame * rowHeight.
   */
  _followCurrentRow(frame) {
    if (this._followCountdown > 0) {
      this._followCountdown -= 1;
      return;
    }
    this._followCountdown = SCROLL_FOLLOW_EVERY - 1;
    const rowH = this._rowHeight;
    const viewH = this._viewportHeight;
    if (!rowH || !viewH) return; // no measurable geometry (headless): nothing to follow
    const el = this.pianoRollEl;
    const rowTop = this._headerHeight + frame * rowH;
    const scrollTop = el.scrollTop || 0;
    // Comfortably visible (clear of the sticky header, fully inside the viewport)? Leave it.
    if (rowTop >= scrollTop + this._headerHeight && rowTop + rowH <= scrollTop + viewH) return;
    const target = Math.max(0, Math.round(rowTop - viewH / 2));
    this._selfScroll = true;
    try {
      el.scrollTop = target;
    } catch (_err) {
      /* never let scroll-following break the UI */
    }
    this._selfScroll = false;
  }

  /**
   * THE PER-FRAME PATH. Must stay O(1): no element creation, no DOM query, no full-grid work,
   * no scrollIntoView. It recycles the bounded window only when the playhead leaves it, moves
   * the highlight by two class toggles, and follows the playhead on a throttle.
   */
  _onEngineFrame(frame) {
    if (!this._gridBuilt) return;
    const start = this._windowStart;
    if (frame < start || frame >= start + this._rows.length) {
      // The playhead left the live window: RECYCLE the same row elements onto the new range.
      // Bounded work, ~once every (WINDOW_ROWS - LOOKBEHIND) frames.
      this._setWindowStart(this._windowStartFor(frame));
    }
    this._highlightCurrentRow(frame);
    this._followCurrentRow(frame);
  }

  _currentFrame() {
    return this.engine && typeof this.engine.currentFrame === 'number' ? this.engine.currentFrame : 0;
  }

  // ----------------------------------------------------------------- frame controls

  wireFrameControls() {
    const doc = this.frameControlsEl ? this.frameControlsEl.ownerDocument : (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    const $ = (id) => doc.getElementById(id);
    const playPause = $('btn-playpause');
    const frameAdvance = $('btn-frame-advance');
    const fastForward = $('btn-fast-forward');
    const speed = $('speed');
    const speedValue = $('speed-value');
    const save = $('btn-savestate');
    const load = $('btn-loadstate');

    const reflect = () => {
      if (playPause) {
        const paused = this.engine.paused !== false;
        playPause.textContent = paused ? '▶ Play' : '⏸ Pause';
        playPause.classList.toggle('is-active', !paused);
      }
    };

    // Primary controls (Play/Pause + Frame +1) must respond to BOTH 'pointerdown' AND
    // 'click'. In an installed iOS PWA (standalone display mode) the synthetic 'click' after
    // a tap can be delayed or suppressed, so a click-only binding leaves buttons feeling
    // dead. We act on 'pointerdown' for immediate response and then suppress the synthetic
    // 'click' that follows the same tap (via a short-lived guard flag) so the action never
    // double-fires. Mouse/keyboard clicks (no preceding pointerdown guard) still work.
    const bindPrimary = (el, action) => {
      if (!el) return;
      let handledByPointer = false;
      const run = () => {
        action();
        reflect();
      };
      el.addEventListener('pointerdown', (ev) => {
        // Only treat primary button / touch / pen as an activation.
        if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
        handledByPointer = true;
        run();
        // Clear the guard shortly after the synthetic click would have fired.
        setTimeout(() => {
          handledByPointer = false;
        }, 500);
      });
      el.addEventListener('click', () => {
        if (handledByPointer) {
          // This click is the synthetic follow-up to a pointerdown we already handled.
          handledByPointer = false;
          return;
        }
        run();
      });
    };

    bindPrimary(playPause, () => {
      if (typeof this.engine.togglePause === 'function') this.engine.togglePause();
    });
    bindPrimary(frameAdvance, () => {
      if (typeof this.engine.frameAdvance === 'function') this.engine.frameAdvance();
    });
    if (fastForward) {
      const ffOn = () => {
        if (typeof this.engine.fastForward === 'function') this.engine.fastForward(true);
        fastForward.classList.add('is-active');
      };
      const ffOff = () => {
        if (typeof this.engine.fastForward === 'function') this.engine.fastForward(false);
        fastForward.classList.remove('is-active');
      };
      fastForward.addEventListener('pointerdown', ffOn);
      fastForward.addEventListener('pointerup', ffOff);
      fastForward.addEventListener('pointerleave', ffOff);
      // Keyboard/click fallback (toggle) for environments without pointer events.
      fastForward.addEventListener('click', () => {
        const active = fastForward.classList.contains('is-active');
        if (active) ffOff();
        else ffOn();
      });
    }
    if (speed) {
      // Enforce the 0.1x-2x range on the element too, in case markup drifts.
      speed.min = '0.1';
      speed.max = '2';
      const applySpeed = () => {
        const v = parseFloat(speed.value);
        if (typeof this.engine.setSpeed === 'function') this.engine.setSpeed(v);
        if (speedValue) speedValue.textContent = `${(Number.isFinite(v) ? v : 1).toFixed(1)}x`;
      };
      speed.addEventListener('input', applySpeed);
      applySpeed();
    }
    bindPrimary(save, () => this.saveStateNode());
    bindPrimary(load, () => {
      // Load the most recent state node if one exists.
      const id = this._activeNodeId || this._stateOrder[this._stateOrder.length - 1];
      if (id != null) this.loadStateNode(id);
    });

    reflect();
  }

  // ----------------------------------------------------------------- save-state tree

  /**
   * Capture a save-state node: engine serialized bytes (may be null without a core) plus
   * the current frame and a snapshot of the input log. Branches from the active node.
   * @returns {string} the new node id
   */
  saveStateNode() {
    const frame = this._currentFrame();
    const id = `s${++this._stateSeq}`;
    const node = {
      id,
      parent: this._activeNodeId,
      frame,
      bytes: null, // Uint8Array | null; filled asynchronously by the engine (see below)
      inputSnapshot: this.log.snapshot(),
      label: `Frame ${frame}`,
      createdAt: Date.now(),
    };
    this._stateNodes.set(id, node);
    this._stateOrder.push(id);
    this._activeNodeId = id;
    this.renderStateTree();

    // engine.saveState() returns a Promise (it resolves with the serialized bytes; the
    // in-process runner serializes synchronously underneath). Fill the node's bytes when they
    // arrive and re-render the tree so the node's "has state" marker (● vs ○) updates. On no core the
    // Promise resolves to null and the node stays input-log-only (○).
    if (typeof this.engine.saveState === 'function') {
      try {
        Promise.resolve(this.engine.saveState())
          .then((bytes) => {
            node.bytes = bytes || null;
            this.renderStateTree();
          })
          .catch(() => {
            node.bytes = null;
          });
      } catch (_err) {
        node.bytes = null;
      }
    }
    return id;
  }

  /**
   * Load a save-state node. Restores the emulator state (when bytes + core are present),
   * restores the input-log snapshot captured at save time, and truncates the log after the
   * loaded frame. The engine's onStateLoaded hook also truncates, so re-recording holds
   * regardless of how the load was triggered.
   * @param {string} id
   * @returns {boolean}
   */
  loadStateNode(id) {
    const node = this._stateNodes.get(id);
    if (!node) return false;

    // Restore the LOCAL MIRROR exactly as it was when the state was saved, then apply the
    // re-record truncation so nothing beyond the saved frame survives.
    this.log.restore(node.inputSnapshot);
    this.log.truncateAfter(node.frame);

    // Restore the engine's authoritative log from the same snapshot so scripted input matches
    // the loaded state (then onStateLoaded->truncateAfter trims after the loaded frame).
    if (typeof this.engine.sendInputEdit === 'function') {
      this.engine.sendInputEdit({ op: 'restoreSnapshot', masks: node.inputSnapshot });
    }

    // Ask the engine to restore emulator state; it fires onStateLoaded(frame) which will
    // truncate again (idempotent) and re-render.
    let ok = true;
    if (node.bytes && typeof this.engine.loadState === 'function') {
      try {
        ok = this.engine.loadState(node.bytes, { frame: node.frame });
      } catch (_err) {
        ok = false;
      }
    } else {
      // No core/bytes: still restore the frame counter conceptually for the UI.
      if (typeof this.engine.currentFrame === 'number') this.engine.currentFrame = node.frame;
    }

    this._activeNodeId = id;
    this.renderPianoRoll();
    this.renderStateTree();
    return ok;
  }

  /** Render the save-state tree panel (indented by branch depth). */
  renderStateTree() {
    if (!this.savestateTreeEl) return;
    const el = this.savestateTreeEl;
    el.innerHTML = '';

    if (this._stateOrder.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'savestate-empty';
      empty.textContent = 'No states yet.';
      el.appendChild(empty);
      return;
    }

    const depthOf = (node) => {
      let d = 0;
      let p = node.parent;
      while (p != null && this._stateNodes.has(p)) {
        d++;
        p = this._stateNodes.get(p).parent;
      }
      return d;
    };

    for (const id of this._stateOrder) {
      const node = this._stateNodes.get(id);
      if (!node) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'savestate-node';
      if (id === this._activeNodeId) item.classList.add('savestate-node--active');
      item.style.marginLeft = `${depthOf(node) * 12}px`;
      item.dataset.id = id;
      const hasBytes = node.bytes ? '●' : '○';
      item.textContent = `${hasBytes} ${node.label}`;
      item.title = node.bytes
        ? `Load state at frame ${node.frame}`
        : `Load (input-log only; no core state) at frame ${node.frame}`;
      item.addEventListener('click', () => this.loadStateNode(id));
      el.appendChild(item);
    }
  }
}

// Auto-wire alongside the engine singleton when loaded as a module in the browser.
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    try {
      const engine = window.TASEngine;
      if (!engine) return;
      const studio = new TASStudio(engine, {
        pianoRoll: document.getElementById('piano-roll'),
        frameControls: document.getElementById('frame-controls'),
        savestateTree: document.getElementById('savestate-tree'),
        touchControls: document.getElementById('touch-controls'),
      });
      studio.init();
      window.__tasStudio = studio;
    } catch (err) {
      console.warn('[piano-roll] init skipped:', err);
    }
  });
}
