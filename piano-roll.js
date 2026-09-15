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
    this._registerStateLoadHook();
    this._wireLiveInput();
    this._startLiveMaskStream();
    this.renderPianoRoll();
    this.wireFrameControls();
    this.renderStateTree();

    // Refresh the current-frame highlight (and extend the grid) as emulation advances.
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
   */
  _startLiveMaskStream() {
    if (typeof this.engine.sendLiveMask !== 'function') return;
    const tick = () => {
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
      this._liveRafId = this._raf(tick);
    };
    this._liveRafId = this._raf(tick);
  }

  _raf(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    if (typeof setTimeout === 'function') return setTimeout(() => cb(Date.now()), 16);
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
    // Update the LOCAL MIRROR for immediate grid feedback...
    const on = this.log.toggle(frame, col);
    // ...and send the same edit to the engine's in-process authoritative InputLog so frame N
    // runs with exactly this scripted bit set. Controller input only, never a memory write.
    if (typeof this.engine.sendInputEdit === 'function') {
      this.engine.sendInputEdit({ op: 'setFrameButton', frame, button: col, on });
    }
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
      bytes: null, // Uint8Array | null; filled asynchronously by the worker (see below)
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

    // Restore the WORKER's authoritative log from the same snapshot so scripted input matches
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
