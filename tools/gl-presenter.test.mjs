// tools/gl-presenter.test.mjs
//
// Unit-tests gl-presenter.js — the WebGL video PRESENTER that replaces the iOS-leak-prone
// 2D putImageData present. jsdom / Node have NO real WebGL, so we drive a MOCK gl context
// that records every GL call. The point is to PROVE the leak-fix invariants structurally,
// without any real GPU:
//
//   1. FEATURE-DETECT: createGLPresenter() prefers 'webgl2', falls back to 'webgl', and
//      returns null when neither is available (so the caller uses its 2D fallback).
//   2. CREATED ONCE: the presenter creates exactly ONE program, ONE texture, ONE buffer —
//      in its constructor, NEVER per frame. This is the whole point: reuse a fixed set of GPU
//      objects so there is no per-frame native allocation (what iOS leaks).
//   3. PER-FRAME UPLOAD via texSubImage2D: after the first frame allocates texture storage
//      (texImage2D, once per geometry), every subsequent same-size frame uploads via
//      texSubImage2D — NOT texImage2D, and NOT a new texture/canvas each frame.
//   4. GEOMETRY CHANGE: switching 256x224 <-> 512x448 re-allocates storage (texImage2D) again
//      but STILL reuses the same texture object (no new createTexture).
//   5. ORIENTATION: the vertex shader flips V (1 - uv.y) so the top-down SNES framebuffer is
//      not drawn upside-down (matches what putImageData produced).
//   6. DRAWING BUFFER stays SNES-native: canvas.width/height are set to the frame size, never
//      DPR-inflated.
//
// Run: node tools/gl-presenter.test.mjs

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

const { createGLPresenter, GLPresenter, acquireGL } = await import('../gl-presenter.js');

// --- A faithful-enough mock WebGL context that records calls + object creations ------------
// GL enum values are irrelevant to the logic under test; we hand out unique-ish numbers and
// only assert on the CALL COUNTS + which upload path (texImage2D vs texSubImage2D) is taken.
function makeMockGL(kind) {
  let nextId = 1;
  const calls = {
    createProgram: 0,
    createShader: 0,
    createTexture: 0,
    createBuffer: 0,
    createVertexArray: 0,
    texImage2D: 0,
    texSubImage2D: 0,
    drawArrays: 0,
    bufferData: 0,
    viewport: [],
  };
  const shaderSrc = [];
  const gl = {
    // enum-ish constants
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    TEXTURE_2D: 3553,
    TEXTURE0: 33984,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    NEAREST: 9728,
    CLAMP_TO_EDGE: 33071,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    UNPACK_ALIGNMENT: 3317,
    FLOAT: 5126,
    TRIANGLES: 4,
    LINK_STATUS: 35714,
    COMPILE_STATUS: 35713,

    createShader() { calls.createShader++; return { id: nextId++ }; },
    shaderSource(sh, src) { shaderSrc.push(src); },
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    deleteShader() {},
    createProgram() { calls.createProgram++; return { id: nextId++ }; },
    attachShader() {},
    bindAttribLocation() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    useProgram() {},
    getUniformLocation() { return { id: nextId++ }; },
    uniform1i() {},
    createBuffer() { calls.createBuffer++; return { id: nextId++ }; },
    bindBuffer() {},
    bufferData() { calls.bufferData++; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    createTexture() { calls.createTexture++; return { id: nextId++ }; },
    activeTexture() {},
    bindTexture() {},
    texParameteri() {},
    pixelStorei() {},
    texImage2D() { calls.texImage2D++; },
    texSubImage2D() { calls.texSubImage2D++; },
    viewport(x, y, w, h) { calls.viewport.push([x, y, w, h]); },
    drawArrays() { calls.drawArrays++; },
    deleteTexture() {},
    deleteBuffer() {},
    deleteProgram() {},
  };
  if (kind === 'webgl2') {
    gl.createVertexArray = () => { calls.createVertexArray++; return { id: nextId++ }; };
    gl.bindVertexArray = () => {};
    gl.deleteVertexArray = () => {};
  }
  return { gl, calls, shaderSrc };
}

// A canvas-like object that hands out the requested mock context (or null) — mirrors the
// feature-detect the real code does against a <canvas> / OffscreenCanvas.
function makeCanvas({ webgl2 = false, webgl = false } = {}) {
  const record = { requested: [], mocks: {} };
  return {
    width: 0,
    height: 0,
    getContext(type, opts) {
      record.requested.push({ type, opts });
      if (type === 'webgl2' && webgl2) {
        const m = makeMockGL('webgl2');
        record.mocks.webgl2 = m;
        return m.gl;
      }
      if ((type === 'webgl' || type === 'experimental-webgl') && webgl) {
        const m = makeMockGL('webgl');
        record.mocks.webgl = m;
        return m.gl;
      }
      return null;
    },
    __record: record,
  };
}

// ======================================================================================

check('feature-detect: no WebGL -> createGLPresenter returns null (caller uses 2D fallback)', () => {
  const canvas = makeCanvas({ webgl2: false, webgl: false });
  const p = createGLPresenter(canvas, 'main');
  assert.strictEqual(p, null, 'null when no WebGL context is available');
});

check('feature-detect: prefers webgl2 and labels it', () => {
  const canvas = makeCanvas({ webgl2: true, webgl: true });
  const p = createGLPresenter(canvas, 'offscreen');
  assert.ok(p, 'presenter created');
  assert.strictEqual(p.isWebGL2, true, 'webgl2 chosen');
  assert.strictEqual(p.label, 'offscreen-webgl2');
  // webgl2 requested first.
  assert.strictEqual(canvas.__record.requested[0].type, 'webgl2');
});

check('feature-detect: falls back to webgl1 when webgl2 missing', () => {
  const canvas = makeCanvas({ webgl2: false, webgl: true });
  const p = createGLPresenter(canvas, 'fallback');
  assert.ok(p, 'presenter created');
  assert.strictEqual(p.isWebGL2, false, 'webgl1 chosen');
  assert.strictEqual(p.label, 'fallback-webgl1');
});

check('context options: no-leak throughput options are requested', () => {
  const canvas = makeCanvas({ webgl2: true });
  createGLPresenter(canvas, 'main');
  const opts = canvas.__record.requested[0].opts;
  assert.strictEqual(opts.alpha, false);
  assert.strictEqual(opts.antialias, false);
  assert.strictEqual(opts.depth, false);
  assert.strictEqual(opts.stencil, false);
  assert.strictEqual(opts.desynchronized, true);
  assert.strictEqual(opts.preserveDrawingBuffer, false);
  assert.strictEqual(opts.powerPreference, 'high-performance');
});

check('CREATED ONCE: exactly one program/texture/buffer built in the constructor, none per frame', () => {
  const canvas = makeCanvas({ webgl2: true });
  const mock = () => canvas.__record.mocks.webgl2.calls;
  const p = createGLPresenter(canvas, 'offscreen');
  const afterCtor = { ...mock() };
  assert.strictEqual(afterCtor.createProgram, 1, 'one program');
  assert.strictEqual(afterCtor.createTexture, 1, 'one texture');
  assert.strictEqual(afterCtor.createBuffer, 1, 'one buffer');
  assert.strictEqual(afterCtor.createVertexArray, 1, 'one VAO (webgl2)');

  // Present many frames; NO new program/texture/buffer/VAO may be created.
  const rgba = new Uint8ClampedArray(256 * 224 * 4).fill(200);
  for (let i = 0; i < 500; i++) p.present(rgba, 256, 224);
  const afterFrames = mock();
  assert.strictEqual(afterFrames.createProgram, 1, 'still one program after 500 frames');
  assert.strictEqual(afterFrames.createTexture, 1, 'still one texture after 500 frames');
  assert.strictEqual(afterFrames.createBuffer, 1, 'still one buffer after 500 frames');
  assert.strictEqual(afterFrames.createVertexArray, 1, 'still one VAO after 500 frames');
});

check('PER-FRAME UPLOAD: first frame allocates (texImage2D once), rest are texSubImage2D', () => {
  const canvas = makeCanvas({ webgl2: true });
  const calls = () => canvas.__record.mocks.webgl2.calls;
  const p = createGLPresenter(canvas, 'main');
  const rgba = new Uint8ClampedArray(256 * 224 * 4).fill(120);
  const N = 300;
  for (let i = 0; i < N; i++) p.present(rgba, 256, 224);
  const c = calls();
  assert.strictEqual(c.texImage2D, 1, 'exactly ONE texImage2D storage allocation for a fixed geometry');
  assert.strictEqual(c.texSubImage2D, N - 1, 'every subsequent frame uploads via texSubImage2D');
  assert.strictEqual(c.drawArrays, N, 'one draw per present');
  // The presenter's own stats mirror this.
  assert.strictEqual(p.stats.texAllocs, 1);
  assert.strictEqual(p.stats.texSubUploads, N - 1);
  assert.strictEqual(p.stats.draws, N);
});

check('GEOMETRY CHANGE: 256x224 <-> 512x448 re-allocates storage but reuses the SAME texture', () => {
  const canvas = makeCanvas({ webgl2: true });
  const calls = () => canvas.__record.mocks.webgl2.calls;
  const p = createGLPresenter(canvas, 'main');
  const small = new Uint8ClampedArray(256 * 224 * 4).fill(1);
  const big = new Uint8ClampedArray(512 * 448 * 4).fill(2);
  p.present(small, 256, 224); // alloc #1
  p.present(small, 256, 224); // sub
  p.present(big, 512, 448); // alloc #2 (geometry changed)
  p.present(big, 512, 448); // sub
  p.present(small, 256, 224); // alloc #3 (changed back)
  const c = calls();
  assert.strictEqual(c.texImage2D, 3, 'three storage re-allocs across three geometry changes');
  assert.strictEqual(c.texSubImage2D, 2, 'two same-size uploads');
  assert.strictEqual(c.createTexture, 1, 'STILL only one texture object — never re-created on resize');
});

check('DRAWING BUFFER stays SNES-native (canvas sized to frame, never DPR-inflated)', () => {
  const canvas = makeCanvas({ webgl2: true });
  const calls = () => canvas.__record.mocks.webgl2.calls;
  const p = createGLPresenter(canvas, 'main');
  const rgba = new Uint8ClampedArray(256 * 224 * 4).fill(9);
  p.present(rgba, 256, 224);
  assert.strictEqual(canvas.width, 256, 'canvas backing width = native frame width');
  assert.strictEqual(canvas.height, 224, 'canvas backing height = native frame height');
  const vp = calls().viewport[0];
  assert.deepStrictEqual(vp, [0, 0, 256, 224], 'viewport covers the native frame');
});

check('canvas resize happens ONLY on geometry change (not every frame)', () => {
  const canvas = makeCanvas({ webgl2: true });
  const p = createGLPresenter(canvas, 'main');
  let sets = 0;
  let w = 0, h = 0;
  Object.defineProperty(canvas, 'width', { get: () => w, set: (v) => { w = v; sets++; } });
  Object.defineProperty(canvas, 'height', { get: () => h, set: (v) => { h = v; sets++; } });
  const rgba = new Uint8ClampedArray(256 * 224 * 4).fill(3);
  for (let i = 0; i < 100; i++) p.present(rgba, 256, 224);
  // width+height set once (2 sets) for the single geometry; not 200 times.
  assert.strictEqual(sets, 2, `canvas resized once (2 property sets), got ${sets}`);
});

check('ORIENTATION: vertex shader flips V so the top-down framebuffer is not upside-down', () => {
  const canvas = makeCanvas({ webgl2: true });
  createGLPresenter(canvas, 'main');
  const vsrc = canvas.__record.mocks.webgl2.shaderSrc.find((s) => s.includes('a_pos'));
  assert.ok(vsrc, 'vertex shader source captured');
  assert.ok(/1\.0\s*-\s*a_uv\.y/.test(vsrc), 'V coordinate is flipped (1.0 - a_uv.y) in the shader');
});

check('present is a no-op for zero-size frames (never uploads/draws garbage)', () => {
  const canvas = makeCanvas({ webgl2: true });
  const calls = () => canvas.__record.mocks.webgl2.calls;
  const p = createGLPresenter(canvas, 'main');
  p.present(new Uint8ClampedArray(0), 0, 0);
  assert.strictEqual(calls().texImage2D, 0);
  assert.strictEqual(calls().texSubImage2D, 0);
  assert.strictEqual(calls().drawArrays, 0);
});

check('accepts a raw ArrayBuffer-backed view (fallback path wraps a transferred buffer)', () => {
  const canvas = makeCanvas({ webgl2: true });
  const p = createGLPresenter(canvas, 'fallback');
  const buf = new ArrayBuffer(256 * 224 * 4);
  // Simulate the proxy wrapping a transferred ArrayBuffer in a Uint8ClampedArray.
  p.present(new Uint8ClampedArray(buf), 256, 224);
  assert.strictEqual(p.stats.texAllocs, 1);
  assert.strictEqual(p.stats.draws, 1);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
