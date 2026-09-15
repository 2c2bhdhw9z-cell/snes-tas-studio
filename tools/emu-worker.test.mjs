// tools/emu-worker.test.mjs
//
// Unit-tests the worker boundary (emu-worker.js) + the main-thread proxy determinism contract
// in Node with NO real browser / WASM. We build a FAKE DedicatedWorkerGlobalScope (an
// EventTarget-like object with addEventListener + postMessage) BEFORE importing emu-worker.js,
// drive the message protocol, and assert:
//   * DETERMINISM: the input source the worker hands its runner resolves EXACTLY
//     (InputLog.getMask(frame) | latestLiveMask) >>> 0 — scripted edits arrive via
//     {type:'inputEdit'} and the live mask via {type:'liveMask'}.
//   * frame-advance runs EXACTLY one frame with that frame's resolved input.
//   * truncateAfter re-record holds after a loadState (onStateLoaded -> stateLoaded).
//   * save/load round-trips over the message protocol with transferable bytes.
//   * BOTH video paths exist: an OffscreenCanvas transfer -> the worker blits (no 'video'
//     message); no OffscreenCanvas -> the worker posts a transferable {type:'video'} frame.
//
// Run: node tools/emu-worker.test.mjs

import assert from 'node:assert';

const results = [];
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

// --- Fake worker global scope ----------------------------------------------------------
// A minimal DedicatedWorkerGlobalScope: message listeners + a postMessage that records
// outgoing messages (and any transfer list) so we can assert what the worker sent.
function makeFakeScope() {
  const listeners = { message: [] };
  const posted = [];
  return {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    postMessage(msg, transfer) {
      posted.push({ msg, transfer: transfer || null });
    },
    // test-only: deliver an inbound message to the worker
    __deliver(data) {
      for (const fn of listeners.message) fn({ data });
    },
    __posted: posted,
  };
}

// --- Fake OffscreenCanvas + 2d context -------------------------------------------------
function makeFakeOffscreen() {
  const blits = [];
  const ctx = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => blits.push({ w: img.width, h: img.height }),
  };
  const ctxOpts = [];
  return {
    width: 256,
    height: 224,
    getContext: (type, opts) => { ctxOpts.push({ type, opts }); return ctx; },
    __blits: blits,
    __ctxOpts: ctxOpts,
  };
}

// Install the fake scope as `self` BEFORE importing the worker module (the module wires a
// message listener onto `self` at import time).
const scope = makeFakeScope();
globalThis.self = scope;

const { EmuWorker } = await import('../emu-worker.js');

// --- A controllable fake runner --------------------------------------------------------
// We capture the injected getFrameInputMask (the determinism resolver) and the sinks so we
// can prove the exact contract without any real WASM. runOne() simulates retro_run pulling
// input for the CURRENT frame, then ticking the frame + emitting a video/hud frame.
function makeFakeRunnerFactory(shared) {
  return function fakeMakeRunner() {
    const runner = {
      status: 'ready',
      paused: true,
      currentFrame: 0,
      _deps: null,
      boot: async () => ({ ok: true, coreOk: true, romOk: true }),
      start() { this.paused = false; this.status = 'running'; },
      pause() { this.paused = true; this.status = 'ready'; },
      setSpeed() {},
      fastForward() {},
      teardown() {},
      // Simulate retro_run for exactly one frame: pull the resolved mask for the CURRENT
      // frame (the determinism moment), record it, then advance + emit a video frame.
      runOne() {
        const resolved = shared.getMask(this.currentFrame);
        shared.resolvedPerFrame.push({ frame: this.currentFrame, mask: resolved });
        shared.sinks.onVideoFrame(new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2, 8, 2);
        shared.sinks.onHud({ hSpeed: -16, xHi: 0x30, xSub: 0x80, xPage: 0x02, yHi: 0xb0, ySub: 0x40 });
        this.currentFrame += 1;
        shared.sinks.onFrame(this.currentFrame, this.status);
      },
      frameAdvance() { this.pause(); this.runOne(); },
      saveState() { return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); },
      loadState(bytes, meta) {
        shared.loaded.push({ bytes, meta });
        if (meta && typeof meta.frame === 'number') this.currentFrame = meta.frame;
        shared.sinks.onStateLoaded(this.currentFrame);
        return true;
      },
    };
    shared.runner = runner;
    return runner;
  };
}

/** Build an EmuWorker whose _makeRunner returns our fake runner and capture its wiring. */
function makeWorker() {
  const shared = { resolvedPerFrame: [], loaded: [], getMask: null, sinks: null, runner: null };
  const worker = new EmuWorker(scope);
  worker._makeRunner = function () {
    // Instead of the real EmuCoreRunner, mirror EXACTLY how the worker wires the determinism
    // resolver + sinks for the real runner, then return the fake runner driven by them. This
    // proves the worker resolves (log.getMask(frame) | liveMask) at the frame it runs.
    shared.getMask = (frame) => worker.resolver.getFrameInputMask(frame, worker.liveMask);
    shared.sinks = {
      onVideoFrame: (rgba, w, h, pitch, fmt) => worker._presentFrame(rgba, w, h, pitch, fmt),
      onHud: (v) => worker.post({ type: 'hud', values: v }),
      onStatus: (s) => worker.post({ type: 'status', snapshot: s }),
      onFrame: (f, st) => worker.post({ type: 'frame', frame: f, status: st }),
      onStateLoaded: (f) => worker.post({ type: 'stateLoaded', frame: f }),
    };
    return makeFakeRunnerFactory(shared)();
  };
  return { worker, shared };
}

function lastPosted(scopeObj, type) {
  for (let i = scopeObj.__posted.length - 1; i >= 0; i--) {
    if (scopeObj.__posted[i].msg && scopeObj.__posted[i].msg.type === type) return scopeObj.__posted[i];
  }
  return null;
}

// ======================================================================================

await checkAsync('init boots the runner and auto-plays; ready message posted', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init', corePath: 'cores/snes9x_libretro.js' } });
  const ready = lastPosted(scope, 'ready');
  assert.ok(ready, 'ready message posted');
  assert.strictEqual(ready.msg.ok, true);
  assert.strictEqual(worker.runner.paused, false, 'auto-play on boot');
});

await checkAsync('DETERMINISM: frame N runs with exactly (log.getMask(N) | liveMask) >>> 0', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });

  // Scripted: set button B (bit 0) on frame 0 and button A (bit 8) on frame 2 via inputEdit.
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 0, button: 'B', on: true } });
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 2, button: 'A', on: true } });
  // Live: START (bit 3) held.
  await worker._onMessage({ data: { type: 'liveMask', mask: 1 << 3 } });

  // Frame-advance three frames, one at a time.
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // runs frame 0
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // runs frame 1
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // runs frame 2

  const B = 1 << 0, A = 1 << 8, START = 1 << 3;
  const perFrame = shared.resolvedPerFrame;
  assert.strictEqual(perFrame.length, 3, 'exactly three frames ran');
  // Frame 0: scripted B | live START.
  assert.strictEqual(perFrame[0].frame, 0);
  assert.strictEqual(perFrame[0].mask, (B | START) >>> 0, 'frame 0 = B | START');
  // Frame 1: no scripted input | live START.
  assert.strictEqual(perFrame[1].mask, START >>> 0, 'frame 1 = START only (no bleed from f0/f2)');
  // Frame 2: scripted A | live START.
  assert.strictEqual(perFrame[2].mask, (A | START) >>> 0, 'frame 2 = A | START');
});

await checkAsync('frame N never reflects frame N+1 scripted input across the boundary', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: 1, button: 'A', on: true } });
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 0
  assert.strictEqual(shared.resolvedPerFrame[0].mask, 0, 'frame 0 must NOT see frame 1 input');
});

await checkAsync('frameAdvance runs EXACTLY one frame per message', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  const before = worker.runner.currentFrame;
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  assert.strictEqual(worker.runner.currentFrame, before + 1, 'exactly one retro_run');
  assert.strictEqual(shared.resolvedPerFrame.length, 1);
});

await checkAsync('liveMask updates take effect on the NEXT frame only', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'liveMask', mask: 1 << 6 } }); // LEFT
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 0 sees LEFT
  await worker._onMessage({ data: { type: 'liveMask', mask: 1 << 7 } }); // RIGHT
  await worker._onMessage({ data: { type: 'frameAdvance' } }); // frame 1 sees RIGHT (not LEFT)
  assert.strictEqual(shared.resolvedPerFrame[0].mask, (1 << 6) >>> 0);
  assert.strictEqual(shared.resolvedPerFrame[1].mask, (1 << 7) >>> 0);
});

await checkAsync('truncateAfter re-record holds after a loadState', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  // Script input on frames 0..3.
  for (let f = 0; f <= 3; f++) {
    await worker._onMessage({ data: { type: 'inputEdit', op: 'setFrameButton', frame: f, button: 'A', on: true } });
  }
  // Load a state at frame 1, then truncate after frame 1 (the proxy sends this on onStateLoaded).
  const bytes = new Uint8Array([9, 9, 9, 9]).buffer;
  await worker._onMessage({ data: { type: 'loadState', bytes, frame: 1 } });
  await worker._onMessage({ data: { type: 'inputEdit', op: 'truncateAfter', frame: 1 } });
  // Frames after 1 must now be gone; the resolver's log length reflects the truncation.
  const A = 1 << 8;
  assert.strictEqual(worker.resolver.getFrameInputMask(0, 0), A, 'frame 0 kept');
  assert.strictEqual(worker.resolver.getFrameInputMask(1, 0), A, 'frame 1 kept');
  assert.strictEqual(worker.resolver.getFrameInputMask(2, 0), 0, 'frame 2 truncated');
  assert.strictEqual(worker.resolver.getFrameInputMask(3, 0), 0, 'frame 3 truncated');
  // onStateLoaded fired the stateLoaded message so the proxy re-record path triggers.
  assert.ok(lastPosted(scope, 'stateLoaded'), 'stateLoaded posted for re-record');
});

await checkAsync('restoreSnapshot restores the authoritative scripted log', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  // masks[0] = B(bit0), masks[2] = A(bit8).
  await worker._onMessage({ data: { type: 'inputEdit', op: 'restoreSnapshot', masks: [1 << 0, 0, 1 << 8] } });
  assert.strictEqual(worker.resolver.getFrameInputMask(0, 0), 1 << 0);
  assert.strictEqual(worker.resolver.getFrameInputMask(1, 0), 0);
  assert.strictEqual(worker.resolver.getFrameInputMask(2, 0), 1 << 8);
});

await checkAsync('save/load round-trips over the message protocol (transferable bytes)', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'saveState' } });
  const saved = lastPosted(scope, 'saved');
  assert.ok(saved, 'saved message posted');
  assert.ok(saved.msg.bytes instanceof ArrayBuffer, 'saved bytes are a transferable ArrayBuffer');
  assert.ok(saved.transfer && saved.transfer[0] === saved.msg.bytes, 'buffer is in the transfer list');
  // Load it back.
  await worker._onMessage({ data: { type: 'loadState', bytes: saved.msg.bytes, frame: 7 } });
  assert.strictEqual(shared.loaded.length, 1, 'loadState invoked on the runner');
  assert.strictEqual(worker.runner.currentFrame, 7, 'frame metadata applied on load');
});

await checkAsync('VIDEO fallback path: no OffscreenCanvas -> transferable {type:video} posted', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } }); // no offscreen transferred
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  const video = lastPosted(scope, 'video');
  assert.ok(video, 'video message posted in the fallback path');
  assert.ok(video.msg.buffer instanceof ArrayBuffer, 'RGBA carried as a transferable ArrayBuffer');
  assert.strictEqual(video.msg.width, 2);
  assert.strictEqual(video.msg.height, 2);
  assert.ok(video.transfer && video.transfer[0] === video.msg.buffer, 'buffer transferred zero-copy');
});

await checkAsync('VIDEO direct path: OffscreenCanvas transferred -> worker blits, NO video message', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  const off = makeFakeOffscreen();
  await worker._onMessage({ data: { type: 'init', offscreen: off } });
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  assert.ok(off.__blits.length >= 1, 'worker blitted directly onto the OffscreenCanvas 2d context');
  assert.strictEqual(lastPosted(scope, 'video'), null, 'NO video message crosses the boundary in the direct path');
  // The 2d context must be requested with the low-latency present options.
  const got = off.__ctxOpts.find((c) => c.type === '2d');
  assert.ok(got, 'a 2d context was requested');
  assert.strictEqual(got.opts && got.opts.alpha, false, "getContext('2d') requested with alpha:false");
  assert.strictEqual(got.opts && got.opts.desynchronized, true, "getContext('2d') requested with desynchronized:true (low-latency present)");
});

await checkAsync('setOffscreen adopts a later-transferred canvas', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  const off = makeFakeOffscreen();
  await worker._onMessage({ data: { type: 'setOffscreen', canvas: off } });
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  assert.ok(off.__blits.length >= 1, 'blits after setOffscreen adoption');
});

await checkAsync('HUD values (verified SMB1 fields) are streamed read-only', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  await worker._onMessage({ data: { type: 'frameAdvance' } });
  const hud = lastPosted(scope, 'hud');
  assert.ok(hud, 'hud message posted');
  assert.strictEqual(hud.msg.values.hSpeed, -16);
  assert.ok('xHi' in hud.msg.values && 'yHi' in hud.msg.values, 'verified SMB1 fields present');
});

await checkAsync('BACKPRESSURE: fallback video never posts a 2nd undrawn frame (drops/coalesces, never queues)', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } }); // no offscreen -> fallback video path
  // Present MANY frames with NO ack in between (models a main thread that has not drawn yet).
  for (let i = 0; i < 50; i++) {
    worker._presentFrame(new Uint8ClampedArray(2 * 2 * 4).fill(i & 0xff), 2, 2, 8, 2);
  }
  const videos = scope.__posted.filter((p) => p.msg && p.msg.type === 'video');
  // Only ONE undrawn video frame may be outstanding — the other 49 are DROPPED, not queued.
  assert.strictEqual(videos.length, 1, `at most one undrawn frame posted (got ${videos.length}; must not queue)`);
  assert.ok(worker._videoInFlight, 'the in-flight backpressure gate is set while unacked');

  // Now the main thread acks the drawn frame (transferring the buffer back). The gate clears
  // and exactly one MORE frame may be posted for the next present.
  const buf = videos[0].msg.buffer;
  await worker._onMessage({ data: { type: 'videoAck', buffer: buf } });
  assert.ok(!worker._videoInFlight, 'gate released on ack');
  worker._presentFrame(new Uint8ClampedArray(2 * 2 * 4).fill(1), 2, 2, 8, 2);
  const videos2 = scope.__posted.filter((p) => p.msg && p.msg.type === 'video');
  assert.strictEqual(videos2.length, 2, 'exactly one further frame posted after the ack (still bounded)');
});

await checkAsync('BUFFER REUSE: acked buffers are pooled and reused (no unbounded per-frame allocation)', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  const distinct = new Set();
  // Present -> ack -> present -> ack ... many times. Each ack returns the buffer for reuse, so
  // steady state must recycle a tiny fixed set of buffers, NOT allocate a fresh one per frame.
  let lastBuf = null;
  for (let i = 0; i < 100; i++) {
    worker._presentFrame(new Uint8ClampedArray(2 * 2 * 4).fill(i & 0xff), 2, 2, 8, 2);
    const last = scope.__posted.filter((p) => p.msg && p.msg.type === 'video').pop();
    if (!last) continue;
    distinct.add(last.msg.buffer);
    lastBuf = last.msg.buffer;
    await worker._onMessage({ data: { type: 'videoAck', buffer: lastBuf } });
  }
  // With ack-gated reuse the worker cycles a bounded pool (<= its cap), never ~100 buffers.
  assert.ok(distinct.size <= worker._VIDEO_POOL_MAX, `buffers reused from a bounded pool (distinct=${distinct.size}, cap=${worker._VIDEO_POOL_MAX})`);
  assert.ok(distinct.size >= 1, 'at least one buffer was used');
});

await checkAsync('present NEVER blocks compute: dropping video frames does not stop retro_run/frame emission', async () => {
  scope.__posted.length = 0;
  const { worker, shared } = makeWorker();
  await worker._onMessage({ data: { type: 'init' } });
  // Never ack. Drive many frame-advances: video frames drop after the first, but the emulator
  // keeps advancing (frame messages keep flowing) — present is decoupled from compute.
  for (let i = 0; i < 20; i++) await worker._onMessage({ data: { type: 'frameAdvance' } });
  const frames = scope.__posted.filter((p) => p.msg && p.msg.type === 'frame');
  const videos = scope.__posted.filter((p) => p.msg && p.msg.type === 'video');
  assert.strictEqual(frames.length, 20, 'all 20 frames ran (compute never blocked on present)');
  assert.strictEqual(videos.length, 1, 'video dropped to a single undrawn frame (best-effort present)');
  assert.strictEqual(shared.resolvedPerFrame.length, 20, 'all frames resolved deterministic input');
});

await checkAsync('OffscreenCanvas direct-blit path posts NO video messages and needs no ack gate', async () => {
  scope.__posted.length = 0;
  const { worker } = makeWorker();
  const off = makeFakeOffscreen();
  await worker._onMessage({ data: { type: 'init', offscreen: off } });
  for (let i = 0; i < 30; i++) await worker._onMessage({ data: { type: 'frameAdvance' } });
  assert.ok(off.__blits.length >= 30, 'worker blit directly for every frame on the direct path');
  assert.strictEqual(scope.__posted.filter((p) => p.msg && p.msg.type === 'video').length, 0, 'no video messages crossed the boundary');
  assert.ok(!worker._videoInFlight, 'direct path never sets the fallback backpressure gate');
});

check('unknown / malformed messages are ignored (fail-closed, no throw)', () => {
  const { worker } = makeWorker();
  // These must not throw.
  worker._onMessage({ data: null });
  worker._onMessage({ data: { type: 'nope' } });
  worker._onMessage({ data: { notype: true } });
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
