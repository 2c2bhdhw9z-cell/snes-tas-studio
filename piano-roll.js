// piano-roll.js
//
// The TAS Studio interface layer built on top of the FEAT-001 engine API. It wires up:
//   1. The Piano Roll input editor: a scrollable per-frame timeline whose columns are the
//      SNES buttons (A/B/X/Y/L/R + D-Pad + Start/Select). Clicking a cell toggles that
//      button on that frame in the shared InputLog. The engine's input provider reads the
//      current frame's bitmask straight out of the log.
//   2. The Frame Control toolbar: Frame Advance, Play/Pause, a 0.1x-2x speed slider, and
//      Fast-Forward, each wired to the corresponding engine method with visual state.
//   3. The Save-State Tree: Save captures engine.saveState() + current frame + an input-log
//      snapshot as a tree node; Load restores the state and TRUNCATES the input log after
//      the loaded frame (re-recording). The engine's onStateLoaded hook guarantees the
//      truncation fires on every load, from the tree UI or elsewhere.
//
// The whole UI stays functional with no core/ROM present: cells toggle, controls exist,
// and save/load simply operate on the input log (engine save/load no-ops gracefully).
//
// HARD RULE: nothing here writes emulator memory, applies cheats, or selects levels.

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

// How many frames of headroom to keep rendered ahead of the current frame.
const LOOKAHEAD = 60;
// Minimum number of rows to show so the grid is visibly a timeline even at frame 0.
const MIN_ROWS = 120;

export class TASStudio {
  /**
   * @param {object} engine the TAS engine (window.TASEngine / default export).
   * @param {object} els DOM elements: { pianoRoll, frameControls, savestateTree }
   */
  constructor(engine, els = {}) {
    this.engine = engine;
    this.log = new InputLog();

    // Live real-time input (gamepad + on-screen touch controls). Its mask is OR-ed into
    // the piano-roll log's mask by the engine input provider, so a paired Bluetooth pad or
    // the touch overlay can play/record the current frame alongside the timeline.
    this.live = new LiveInput();
    this._lastPolledFrame = -1;

    this.pianoRollEl = els.pianoRoll || null;
    this.frameControlsEl = els.frameControls || null;
    this.savestateTreeEl = els.savestateTree || null;
    this.touchControlsEl = els.touchControls || null;

    // Save-state tree: nodes keyed by id, with parent references forming the branch tree.
    this._stateNodes = new Map();
    this._stateOrder = [];
    this._stateSeq = 0;
    this._activeNodeId = null;

    // Rendered-rows cache so we only rebuild the grid when the row count changes.
    this._renderedRows = 0;
    this._currentRow = -1;
  }

  /** Wire everything up. Safe to call once the DOM is ready. */
  init() {
    this._registerInputProvider();
    this._registerStateLoadHook();
    this._wireLiveInput();
    this.renderPianoRoll();
    this.wireFrameControls();
    this.renderStateTree();

    // Refresh the current-frame highlight (and extend the grid) as emulation advances.
    if (typeof this.engine.onFrame === 'function') {
      this.engine.onFrame((frame) => this._onEngineFrame(frame));
    }
    return this;
  }

  // ----------------------------------------------------------------- input provider

  _registerInputProvider() {
    if (typeof this.engine.setInputProvider !== 'function') return;
    // The engine's input-provider contract is a single shape: return a WHOLE-JOYPAD
    // BITMASK (libretro joypad-bit layout) for the requested frame. We return the piano-
    // roll log's mask for that frame OR-ed with the live gamepad/touch mask so real-time
    // input merges into the frame that retro_set_input_state reads.
    //
    // Latency: poll the gamepad exactly once per frame, the first time the engine reads
    // input for that frame (this happens inside retro_run, i.e. the same rAF tick), so the
    // live mask reflects the freshest pad state with no extra frame of delay.
    this.engine.setInputProvider((frame /*, port, device, index, id */) => {
      if (frame !== this._lastPolledFrame) {
        this.live.poll();
        this._lastPolledFrame = frame;
      }
      return (this.log.getMask(frame) | this.live.getMask()) >>> 0;
    });
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
      this.log.truncateAfter(frame);
      this.renderPianoRoll();
    });
  }

  // ----------------------------------------------------------------- piano roll

  /** (Re)build the piano-roll grid to cover the frames we need to show. */
  renderPianoRoll() {
    if (!this.pianoRollEl) return;

    const current = this._currentFrame();
    const needed = Math.max(MIN_ROWS, this.log.length, current + LOOKAHEAD);

    // Full rebuild when the row count changes; otherwise just refresh cell states.
    if (needed !== this._renderedRows) {
      this._buildGrid(needed);
      this._renderedRows = needed;
    }
    this._refreshCells();
    this._highlightCurrentRow(current);
  }

  _buildGrid(rowCount) {
    const el = this.pianoRollEl;
    el.innerHTML = '';
    el.classList.add('piano-roll--active');

    const table = document.createElement('div');
    table.className = 'pr-table';
    table.setAttribute('role', 'grid');

    // Header row.
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

    // Body rows.
    const body = document.createElement('div');
    body.className = 'pr-body';
    for (let f = 0; f < rowCount; f++) {
      const row = document.createElement('div');
      row.className = 'pr-row';
      row.dataset.frame = String(f);

      const frameCell = document.createElement('div');
      frameCell.className = 'pr-cell pr-cell--frame';
      frameCell.textContent = String(f);
      row.appendChild(frameCell);

      for (const col of COLUMN_ORDER) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'pr-cell pr-cell--btn';
        cell.dataset.frame = String(f);
        cell.dataset.col = col;
        cell.setAttribute('aria-pressed', 'false');
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    table.appendChild(body);
    el.appendChild(table);

    // One delegated click handler for the whole grid.
    if (!this._gridClickBound) {
      el.addEventListener('click', (ev) => this._onGridClick(ev));
      this._gridClickBound = true;
    }
  }

  _onGridClick(ev) {
    const cell = ev.target && ev.target.closest ? ev.target.closest('.pr-cell--btn') : null;
    if (!cell) return;
    const frame = parseInt(cell.dataset.frame, 10);
    const col = cell.dataset.col;
    if (Number.isNaN(frame) || !col) return;
    const on = this.log.toggle(frame, col);
    cell.classList.toggle('pr-cell--on', on);
    cell.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Sync every rendered cell's on/off class with the input log. */
  _refreshCells() {
    if (!this.pianoRollEl) return;
    const cells = this.pianoRollEl.querySelectorAll('.pr-cell--btn');
    for (const cell of cells) {
      const frame = parseInt(cell.dataset.frame, 10);
      const on = this.log.isSet(frame, cell.dataset.col);
      cell.classList.toggle('pr-cell--on', on);
      cell.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  _highlightCurrentRow(frame) {
    if (!this.pianoRollEl) return;
    if (this._currentRow === frame) return;
    const prev = this.pianoRollEl.querySelector('.pr-row--current');
    if (prev) prev.classList.remove('pr-row--current');
    const row = this.pianoRollEl.querySelector(`.pr-row[data-frame="${frame}"]`);
    if (row) {
      row.classList.add('pr-row--current');
      // Keep the current frame visible as playback advances.
      if (typeof row.scrollIntoView === 'function') {
        try {
          row.scrollIntoView({ block: 'nearest' });
        } catch (_err) {
          /* jsdom may not implement scrollIntoView; ignore */
        }
      }
    }
    this._currentRow = frame;
  }

  _onEngineFrame(frame) {
    // Auto-extend the grid if we are approaching the end, then move the highlight.
    const needed = Math.max(MIN_ROWS, this.log.length, frame + LOOKAHEAD);
    if (needed > this._renderedRows) {
      this._buildGrid(needed);
      this._renderedRows = needed;
      this._refreshCells();
      this._currentRow = -1;
    }
    this._highlightCurrentRow(frame);
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

    if (playPause) {
      playPause.addEventListener('click', () => {
        if (typeof this.engine.togglePause === 'function') this.engine.togglePause();
        reflect();
      });
    }
    if (frameAdvance) {
      frameAdvance.addEventListener('click', () => {
        if (typeof this.engine.frameAdvance === 'function') this.engine.frameAdvance();
        reflect();
      });
    }
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
    if (save) save.addEventListener('click', () => this.saveStateNode());
    if (load) {
      load.addEventListener('click', () => {
        // Load the most recent state node if one exists.
        const id = this._activeNodeId || this._stateOrder[this._stateOrder.length - 1];
        if (id != null) this.loadStateNode(id);
      });
    }

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
    let bytes = null;
    if (typeof this.engine.saveState === 'function') {
      try {
        bytes = this.engine.saveState();
      } catch (_err) {
        bytes = null;
      }
    }
    const id = `s${++this._stateSeq}`;
    const node = {
      id,
      parent: this._activeNodeId,
      frame,
      bytes, // Uint8Array | null (null when no core is loaded)
      inputSnapshot: this.log.snapshot(),
      label: `Frame ${frame}`,
      createdAt: Date.now(),
    };
    this._stateNodes.set(id, node);
    this._stateOrder.push(id);
    this._activeNodeId = id;
    this.renderStateTree();
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

    // Restore the input log exactly as it was when the state was saved, then apply the
    // re-record truncation so nothing beyond the saved frame survives.
    this.log.restore(node.inputSnapshot);
    this.log.truncateAfter(node.frame);

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
