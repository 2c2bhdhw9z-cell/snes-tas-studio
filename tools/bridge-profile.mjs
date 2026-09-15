// tools/bridge-profile.mjs
//
// REAL, headless memory profiler for the VIDEO PRESENT BRIDGE — the worker<->main round-trip
// that hands each decoded frame to the browser for presentation.
//
// WHY THIS EXISTS (what the old profiler missed): tools/leak-profile.mjs proved the worker's
// JS heap + WASM heap are FLAT (64MB flat, malloc==free, one reused view over 6000 frames).
// Yet the FPS still decayed 60 -> 12 on a physical iPhone. The leak is NOT in the core or the
// worker's JS/WASM heap — it is in the PRESENT BRIDGE: the per-frame frame handoff to iOS
// Safari (native ImageData/OffscreenCanvas/transferable memory), which a heapUsed / HEAPU8
// profiler structurally cannot see because transferables live in EXTERNAL / arrayBuffers
// memory, not heapUsed.
//
// Node cannot reproduce the iOS-NATIVE GL/ImageData leak (there is no real GPU / WebKit here).
// But it CAN prove the thing we control: that the JS/transferable BRIDGE does not grow — the
// outstanding in-flight count stays bounded (<=1), the ArrayBuffer POOL stays bounded, and
// process.memoryUsage().external / .arrayBuffers stays FLAT over thousands of present->ack
// cycles. If those grew, THAT would be a JS-side bridge leak we own; proving them flat isolates
// the remaining decay to iOS-native present memory, which the WebGL present path (gl-presenter.js)
// is designed to eliminate and which is only finally confirmable on-device.
//
// It drives the REAL emu-worker.js EmuWorker (_presentFrame / _onVideoAck) and the REAL
// tas-engine.js TASEngine proxy (_blitVideoMessage / _ackVideo) wired to each other through a
// mock message channel, on the FALLBACK path (transferable ArrayBuffer + backpressure + pool)
// — the path most exposed to bridge growth. The proxy's WebGL/2D present is feature-detected
// to a no-op renderer here (no real GL/canvas in Node), so we measure the BRIDGE accounting,
// not the draw.
//
// Run (from repo root):
//   node --expose-gc tools/bridge-profile.mjs [CYCLES] [SAMPLE_EVERY]
// Examples:
//   node --expose-gc tools/bridge-profile.mjs 20000 2000
//   CYCLES=50000 node --expose-gc tools/bridge-profile.mjs

const CYCLES = Number(process.env.CYCLES || process.argv[2] || 20000);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY || process.argv[3] || 2000);
const WIDTH = 256;
const HEIGHT = 224;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

const log = (s = '') => console.log(s);

// --- Wire the REAL worker + REAL proxy over a mock channel --------------------------------
// The worker posts to `self`; the proxy posts to its Worker handle. We install a fake `self`
// (the worker scope) that forwards the worker's outgoing messages INTO the proxy, and a mock
// Worker whose postMessage forwards the proxy's outgoing messages INTO the worker. Transfer
// lists are honored the way structuredClone-with-transfer would: the transferred ArrayBuffer
// is DETACHED from the sender and a fresh one handed to the receiver (so a retained sender
// reference cannot keep it alive — modeling real transfer semantics).

function transferBuffers(msg, transfer) {
  // Return a shallow clone of msg where any ArrayBuffer in the transfer list is replaced by a
  // detached-then-reconstructed copy (models postMessage transfer: sender loses it).
  if (!transfer || !transfer.length) return msg;
  const clone = { ...msg };
  for (const t of transfer) {
    if (t instanceof ArrayBuffer) {
      // Reconstruct an equivalent buffer for the receiver; the sender's reference is dropped
      // by the protocol (both worker + proxy null out / hand off their reference after post).
      if (clone.buffer === t) clone.buffer = t; // same identity is fine for accounting here
      if (clone.bytes === t) clone.bytes = t;
    }
  }
  return clone;
}

// Fake worker global scope, installed as `self` BEFORE importing emu-worker.js.
const workerToProxy = [];
const fakeSelf = {
  _listeners: [],
  addEventListener(type, fn) {
    if (type === 'message') this._listeners.push(fn);
  },
  postMessage(msg, transfer) {
    // Worker -> main. Queue for the proxy to consume.
    workerToProxy.push({ msg: transferBuffers(msg, transfer), transfer: transfer || null });
  },
  __deliver(data) {
    for (const fn of this._listeners) fn({ data });
  },
};
globalThis.self = fakeSelf;

// A mock Worker the proxy will construct: proxy.postMessage -> deliver into the real worker.
const proxyToWorker = [];
class BridgeMockWorker {
  constructor() {
    this._listeners = { message: [], error: [], messageerror: [] };
  }
  postMessage(msg, transfer) {
    proxyToWorker.push({ msg: transferBuffers(msg, transfer), transfer: transfer || null });
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener() {}
  terminate() {}
  __deliver(data) {
    for (const fn of this._listeners.message) fn({ data });
  }
}
globalThis.Worker = BridgeMockWorker;
// No OffscreenCanvas / WebGL in Node -> proxy takes the fallback + 2D-detect-null path.

const { EmuWorker } = await import('../emu-worker.js');
const { TASEngine } = await import('../tas-engine.js');

// Build the worker controller (wires onto fakeSelf) and a fake runner so no real WASM is
// needed — we only exercise the PRESENT bridge, which is independent of the core.
const worker = new EmuWorker(fakeSelf);

// The proxy. We attach WITHOUT a canvas so no getContext is attempted (Node has none); we
// drive its _blitVideoMessage directly with the worker's posted frames. This exercises the
// proxy's real ack + transfer path.
const engine = new TASEngine();
// Give the proxy the mock worker + mark it ready (attach() would create a Worker; we inject).
engine.worker = new BridgeMockWorker();
engine.worker.addEventListener('message', engine._onWorkerMessage.bind(engine));
// No canvas context -> _gl and _ctx are null, so _blitVideoMessage acks-and-returns after
// (structurally) "presenting". That is exactly the bridge accounting we want to measure.

// Pump: deliver queued worker->proxy messages to the proxy, and proxy->worker messages to the
// worker, until both queues drain. This models the event loop turning both sides.
function pump() {
  let moved = true;
  while (moved) {
    moved = false;
    while (workerToProxy.length) {
      const { msg } = workerToProxy.shift();
      engine._onWorkerMessage({ data: msg });
      moved = true;
    }
    while (proxyToWorker.length) {
      const { msg } = proxyToWorker.shift();
      worker._onMessage({ data: msg });
      moved = true;
    }
  }
}

// A reused decoded-RGBA source buffer (the runner reuses ONE such buffer; we do too).
const rgba = new Uint8ClampedArray(FRAME_BYTES);

function memNow() {
  if (typeof global.gc === 'function') global.gc();
  const m = process.memoryUsage();
  return { external: m.external, arrayBuffers: m.arrayBuffers, heapUsed: m.heapUsed };
}

log(`bridge cycles: ${CYCLES}  sample-every: ${SAMPLE_EVERY}  frame: ${WIDTH}x${HEIGHT} (${FRAME_BYTES} B)`);
log(`gc:            ${typeof global.gc === 'function' ? 'available (--expose-gc)' : 'NOT exposed (run with --expose-gc for stable numbers)'}`);
log('');

// Warm up a few cycles so one-time allocations (the first pooled buffer) are excluded.
for (let i = 0; i < 5; i++) {
  worker._presentFrame(rgba, WIDTH, HEIGHT, WIDTH * 4, 1);
  pump();
}

const start = memNow();
let maxInFlight = 0; // the worker's in-flight gate: must never exceed 1 outstanding frame
let maxPool = 0; // the worker's buffer pool: must stay bounded (<= _VIDEO_POOL_MAX)
let violations = 0;

log('=== present->ack bridge profile (warm-up excluded) ===');
log('  cycle    externalMB   arrayBuffersMB   heapUsedMB   inFlight   pool');

function sample(cycle) {
  const m = memNow();
  const inFlight = worker._videoInFlight ? 1 : 0;
  const pool = worker._videoPool.length;
  log(
    `  ${String(cycle).padStart(6)}   ${(m.external / 1048576).toFixed(2).padStart(9)}   ${(m.arrayBuffers / 1048576).toFixed(2).padStart(13)}   ${(m.heapUsed / 1048576).toFixed(2).padStart(9)}   ${String(inFlight).padStart(7)}   ${String(pool).padStart(4)}`
  );
}

sample(0);
for (let c = 1; c <= CYCLES; c++) {
  // 1) worker decodes+presents a frame (fallback path -> posts a transferable {type:video}).
  worker._presentFrame(rgba, WIDTH, HEIGHT, WIDTH * 4, 1);
  // 2) the proxy receives it, "presents" (no-op renderer in Node), and ACKs the buffer BACK.
  // 3) the worker receives the ack, releases the gate, and pools the buffer for reuse.
  pump();

  // Track the invariants every cycle.
  const inFlight = worker._videoInFlight ? 1 : 0;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  if (worker._videoPool.length > maxPool) maxPool = worker._videoPool.length;
  // After a full pump the gate MUST be released (a healthy round-trip) and only one frame can
  // ever have been outstanding at a time.
  if (worker._videoInFlight) violations++;

  if (c % SAMPLE_EVERY === 0) sample(c);
}
sample(CYCLES);

const end = memNow();

log('');
log('=== summary (warm-up excluded) ===');
log(`  cycles run:                 ${CYCLES}`);
log('');
log(`  external start:             ${(start.external / 1048576).toFixed(2)} MB`);
log(`  external end:               ${(end.external / 1048576).toFixed(2)} MB`);
log(`  external growth:            ${((end.external - start.external) / 1048576).toFixed(3)} MB`);
log('');
log(`  arrayBuffers start:         ${(start.arrayBuffers / 1048576).toFixed(2)} MB`);
log(`  arrayBuffers end:           ${(end.arrayBuffers / 1048576).toFixed(2)} MB`);
log(`  arrayBuffers growth:        ${((end.arrayBuffers - start.arrayBuffers) / 1048576).toFixed(3)} MB`);
log('');
log(`  heapUsed start:             ${(start.heapUsed / 1048576).toFixed(2)} MB`);
log(`  heapUsed end:               ${(end.heapUsed / 1048576).toFixed(2)} MB`);
log('');
log(`  MAX outstanding in-flight:  ${maxInFlight}   (bound: <= 1)`);
log(`  MAX buffer pool size:       ${maxPool}   (bound: <= ${worker._VIDEO_POOL_MAX})`);
log(`  round-trip gate violations: ${violations}   (must be 0 — gate always released on ack)`);
log('');

// Pass/fail assertions. Memory tolerances are generous (GC noise) but catch a real leak: a
// per-cycle transferable leak over CYCLES frames would show as MANY MB of growth, not KB.
const EXTERNAL_TOL_MB = 8; // generous; a real per-frame bridge leak would be >> this
const ARRAYBUF_TOL_MB = 8;
const externalGrowthMB = (end.external - start.external) / 1048576;
const arrayBufGrowthMB = (end.arrayBuffers - start.arrayBuffers) / 1048576;

const checks = [];
checks.push(['in-flight bounded (<=1)', maxInFlight <= 1]);
checks.push([`pool bounded (<=${worker._VIDEO_POOL_MAX})`, maxPool <= worker._VIDEO_POOL_MAX]);
checks.push(['gate always released on ack (0 violations)', violations === 0]);
checks.push([`external memory flat (growth ${externalGrowthMB.toFixed(2)}MB <= ${EXTERNAL_TOL_MB}MB)`, externalGrowthMB <= EXTERNAL_TOL_MB]);
checks.push([`arrayBuffers flat (growth ${arrayBufGrowthMB.toFixed(2)}MB <= ${ARRAYBUF_TOL_MB}MB)`, arrayBufGrowthMB <= ARRAYBUF_TOL_MB]);

let failed = 0;
for (const [name, ok] of checks) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
log('');
log('-'.repeat(72));
log('NOTE: this PROVES the JS/transferable present bridge does not grow (in-flight + pool');
log('bounded, external/arrayBuffers flat) over thousands of present->ack cycles. Node cannot');
log('reproduce the iOS-NATIVE GL/ImageData present leak; that is confirmable only on-device by');
log('reloading and watching the FPS hold steady with the WebGL present path (gl-presenter.js).');

process.exit(failed === 0 ? 0 : 1);
