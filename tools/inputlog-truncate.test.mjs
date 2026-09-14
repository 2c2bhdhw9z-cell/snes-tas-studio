// tools/inputlog-truncate.test.mjs
// Proves the TAS re-recording rule: after seeding input at frames 0..10 and "saving" at
// frame 5, loading (which truncates the log after the loaded frame) leaves NO entries
// beyond frame 5. Exercises the pure InputLog directly and the TASStudio load path.
// Run: node tools/inputlog-truncate.test.mjs
import assert from 'node:assert';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

const { InputLog } = await import('../input-log.js');

// --- 1) Pure InputLog truncation ---
const log = new InputLog();
// Seed input at frames 0..10 (press A on every frame).
for (let f = 0; f <= 10; f++) log.set(f, 'A', true);
check('log has 11 frames after seeding 0..10', () => assert.strictEqual(log.length, 11));

// Snapshot at frame 5 (what a save would capture).
const snapAt5 = log.snapshot();

// Continue building future input (frames 6..10 already set; add more up to 15).
for (let f = 11; f <= 15; f++) log.set(f, 'B', true);
check('log grew to 16 frames', () => assert.strictEqual(log.length, 16));

// Load-state at frame 5: restore the snapshot then truncate after frame 5.
log.restore(snapAt5);
log.truncateAfter(5);
check('after load+truncate, length is 6 (frames 0..5)', () => assert.strictEqual(log.length, 6));
check('no input survives beyond frame 5', () => {
  for (let f = 6; f < 20; f++) assert.strictEqual(log.getMask(f), 0, `frame ${f} should be empty`);
});
check('frames 0..5 input preserved', () => {
  for (let f = 0; f <= 5; f++) assert.ok(log.isSet(f, 'A'), `frame ${f} A should be set`);
});

// --- 2) TASStudio.loadStateNode path (no engine core; uses input-log truncation) ---
// Minimal engine stub with the FEAT-001 API surface used by TASStudio.
const stateLoadedCbs = [];
const engineStub = {
  currentFrame: 0,
  paused: true,
  setInputProvider() {},
  onStateLoaded(cb) { stateLoadedCbs.push(cb); },
  onFrame() {},
  saveState() { return null; }, // no core -> null bytes
  loadState(_bytes, meta) {
    if (meta && typeof meta.frame === 'number') this.currentFrame = meta.frame;
    for (const cb of stateLoadedCbs) cb(this.currentFrame);
    return true;
  },
};

const { TASStudio } = await import('../piano-roll.js');
const studio = new TASStudio(engineStub, {}); // no DOM elements -> render calls no-op
studio._registerStateLoadHook();

// Seed input 0..10, save at frame 5, extend to 15, then load the frame-5 node.
for (let f = 0; f <= 10; f++) studio.log.set(f, 'A', true);
engineStub.currentFrame = 5;
const nodeId = studio.saveStateNode();
for (let f = 11; f <= 15; f++) studio.log.set(f, 'B', true);
check('studio log grew past save point', () => assert.ok(studio.log.length >= 16));

studio.loadStateNode(nodeId);
check('studio load truncates log after frame 5', () => assert.strictEqual(studio.log.length, 6));
check('studio load leaves no input beyond frame 5', () => {
  for (let f = 6; f < 20; f++) assert.strictEqual(studio.log.getMask(f), 0);
});
check('studio restored frame counter to 5', () => assert.strictEqual(engineStub.currentFrame, 5));

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
