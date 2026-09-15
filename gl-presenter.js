// gl-presenter.js
//
// The WebGL video PRESENTER for the SNES TAS Studio — the iOS-native-memory-leak fix.
//
// WHY THIS EXISTS (the user's *actual* remaining bug): the FPS still decays 60 -> 12 in ~45s
// on a physical iPhone even though the worker's JS heap + WASM heap are PROVEN FLAT
// (tools/leak-profile.mjs: 64MB flat, malloc==free, one reused view over 6000 frames). The
// leak is therefore NOT in the core or the worker's JS/WASM heap — it is in NATIVE BROWSER
// memory during the per-frame VIDEO PRESENT. Both prior present paths used a 2D canvas +
// ImageData + `putImageData` (either OffscreenCanvas.getContext('2d') in the worker or the
// main-thread canvas on the fallback). iOS Safari is known to leak native memory on repeated
// getContext('2d')/putImageData blits even when the JS side pools its buffers perfectly; the
// steady monotonic decay is that native growth's fingerprint. A JS heapUsed / HEAPU8 profiler
// structurally cannot see it, which is why every prior "heap" fix left the decay unchanged.
//
// THE FIX (what every real emulator frontend does): present via WebGL. Create ONE GL context,
// ONE texture, ONE shader program, ONE quad — ONCE. Per frame, upload the decoded RGBA into
// the SAME texture with `texSubImage2D` and draw the quad. This reuses a fixed set of GPU
// objects; there is NO per-frame native ImageData/canvas allocation, which is exactly what
// iOS leaks. The texture storage is (re)allocated with `texImage2D` ONLY when the SNES frame
// geometry actually changes (256x224 <-> 512x448); every steady-state frame is a texSubImage2D
// + drawArrays.
//
// ENVIRONMENT-AGNOSTIC BY DESIGN: this module references NO window / document. It takes a
// canvas-like object that exposes getContext (a real <canvas> on the main thread OR a
// transferred OffscreenCanvas in the worker) and drives it. WebGL is feature-detected in each
// environment: `getContext('webgl2')` then `getContext('webgl')`. If neither is available
// (e.g. jsdom in tests, or an environment where WebGL on an OffscreenCanvas is unreliable),
// createGLPresenter() returns null and the caller falls back to the existing 2D putImageData
// path. So WebGL is the PRIMARY present path on modern iOS, with 2D kept only as a last resort.
//
// ORIENTATION: the SNES framebuffer the runner decodes is TOP-DOWN (row 0 = top), the same
// order putImageData expects. A GL textured quad samples with (0,0) at the bottom-left by
// default, so we FLIP vertically in the texture coordinates (v = 1 - y) to match what
// putImageData produced — otherwise the picture is upside-down.
//
// CANVAS BACKING: the drawing buffer stays SNES-native (256x224 / 512x448); CSS stretches it.
// We set canvas.width/height to the frame size (NOT devicePixelRatio-inflated) so the GL
// drawing buffer is never larger than the source — no wasted GPU memory, no DPR blow-up.
//
// SAFETY: presentation only. No memory-write / cheat / level-select / file-picker path lives
// here; it consumes an already-decoded RGBA buffer and draws it.

'use strict';

// A stable identifier for the active present path, surfaced to the debug banner so the device
// can tell us which renderer actually engaged. One of:
//   'offscreen-webgl2' | 'offscreen-webgl1' | 'offscreen-2d'   (worker, OffscreenCanvas)
//   'main-webgl2'      | 'main-webgl1'      | 'main-2d'        (main thread, <canvas>)
// The 2D variants are the last-resort fallback (this module is NOT used for those; the caller
// keeps its putImageData path and labels it accordingly).

// GLSL is intentionally minimal: a fullscreen quad, one sampler, a vertical flip in the UVs.
const VERT_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  // Flip V so the top-down SNES framebuffer is not drawn upside-down (matches putImageData).
  v_uv = vec2(a_uv.x, 1.0 - a_uv.y);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

// Two triangles covering clip space [-1,1], with matching UVs in [0,1].
// Interleaved: [ posX, posY, u, v ] per vertex.
const QUAD = new Float32Array([
  -1, -1, 0, 0,
  1, -1, 1, 0,
  -1, 1, 0, 1,
  -1, 1, 0, 1,
  1, -1, 1, 0,
  1, 1, 1, 1,
]);

/**
 * Try to acquire a WebGL2 (preferred) or WebGL1 context on a canvas-like object, with the
 * throughput + no-leak context options. Returns { gl, isWebGL2 } or null.
 *
 * Context options rationale:
 *   alpha:false               — opaque; no compositing blend of a per-frame alpha plane.
 *   antialias:false           — pixel-exact SNES output; MSAA would add cost + framebuffers.
 *   depth:false, stencil:false— we draw one 2D quad; no depth/stencil buffers to allocate.
 *   desynchronized:true       — low-latency present (skip the compositor round-trip when able).
 *   preserveDrawingBuffer:false— allow the buffer to be discarded after present (no retained copy).
 *   powerPreference           — 'high-performance' for the discrete/perf GPU where relevant.
 */
export function acquireGL(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const opts = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  };
  let gl = null;
  let isWebGL2 = false;
  try {
    gl = canvas.getContext('webgl2', opts);
    if (gl) isWebGL2 = true;
  } catch (_err) {
    gl = null;
  }
  if (!gl) {
    try {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (_err) {
      gl = null;
    }
  }
  if (!gl) return null;
  return { gl, isWebGL2 };
}

/**
 * A single-texture, single-program WebGL presenter. Construct via createGLPresenter() (which
 * feature-detects + builds the GL objects ONCE); then call present(rgba, width, height) each
 * frame. All GPU objects are created once in the constructor; present() only uploads
 * (texSubImage2D) + draws — with a texImage2D re-allocation ONLY when geometry changes.
 */
export class GLPresenter {
  /**
   * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
   * @param {object} canvas the canvas-like object gl was acquired from (for sizing)
   * @param {boolean} isWebGL2
   * @param {string} label the active-path label ('offscreen-webgl2' etc.)
   */
  constructor(gl, canvas, isWebGL2, label) {
    this.gl = gl;
    this.canvas = canvas;
    this.isWebGL2 = !!isWebGL2;
    this.label = label;

    // The texture's currently-allocated storage size. -1 forces the first present() to
    // texImage2D-allocate. After that, a matching size uses texSubImage2D (no realloc).
    this._texW = -1;
    this._texH = -1;

    // Instrumentation (read by the bridge profiler + the created-once test): counts of the
    // one-time GPU-object creations vs the per-frame upload/draw calls.
    this.stats = { texAllocs: 0, texSubUploads: 0, draws: 0, programs: 0, textures: 0, buffers: 0 };

    this._buildOnce();
  }

  /** Build the ONE program + ONE quad buffer + ONE texture. Called exactly once. */
  _buildOnce() {
    const gl = this.gl;

    // --- shader program (created once) ---
    const vs = this._compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.bindAttribLocation(prog, 1, 'a_uv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      throw new Error(`GLPresenter: program link failed: ${info}`);
    }
    // Shaders can be deleted after link (the program retains what it needs).
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;
    this.stats.programs += 1;
    gl.useProgram(prog);
    this._uTex = gl.getUniformLocation(prog, 'u_tex');
    gl.uniform1i(this._uTex, 0); // sampler bound to texture unit 0

    // --- geometry (created once) ---
    // WebGL2 gets a VAO so per-frame we only bind it; WebGL1 sets the pointers once (single
    // buffer, single program, so state is stable across frames).
    this.buffer = gl.createBuffer();
    this.stats.buffers += 1;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

    const stride = 4 * 4; // 4 floats * 4 bytes
    if (this.isWebGL2 && typeof gl.createVertexArray === 'function') {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
    } else {
      this.vao = null;
    }
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);

    // --- texture (created once) ---
    this.texture = gl.createTexture();
    this.stats.textures += 1;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // NEAREST keeps the pixel-art crisp; CLAMP avoids edge sampling wrap. Set once.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Tightly-packed RGBA rows.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`GLPresenter: shader compile failed: ${info}`);
    }
    return sh;
  }

  /**
   * Present one decoded RGBA frame. Uploads into the SAME texture (texSubImage2D) and draws
   * the SAME quad — no per-frame GPU-object allocation. The texture storage is re-allocated
   * (texImage2D) ONLY when the frame geometry changes; that is the ONLY per-present branch
   * that touches texture STORAGE, and it fires just twice a session at most (256x224<->512x448).
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba tightly-packed RGBA8888, width*height*4 bytes
   * @param {number} width
   * @param {number} height
   */
  present(rgba, width, height) {
    const gl = this.gl;
    if (!width || !height) return;

    // Keep the drawing buffer SNES-native. Resize only on change (setting width/height clears
    // the buffer, so avoid doing it every frame).
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // The RGBA pixel source. WebGL wants a Uint8Array/ Uint8ClampedArray view.
    const pixels = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray
      ? rgba
      : new Uint8Array(rgba.buffer || rgba);
    const view = pixels.byteLength === width * height * 4 ? pixels : pixels.subarray(0, width * height * 4);

    if (this._texW !== width || this._texH !== height) {
      // Geometry changed (or first frame): (re)allocate texture storage. Rare.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
      this._texW = width;
      this._texH = height;
      this.stats.texAllocs += 1;
    } else {
      // Steady state: upload into the existing storage. NO allocation.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, view);
      this.stats.texSubUploads += 1;
    }

    gl.useProgram(this.program);
    if (this.vao) gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.stats.draws += 1;
  }

  /** Best-effort teardown of the GPU objects (core swap / dispose). */
  dispose() {
    const gl = this.gl;
    try {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.vao && typeof gl.deleteVertexArray === 'function') gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
    } catch (_err) {
      /* best-effort */
    }
    this.texture = null;
    this.buffer = null;
    this.vao = null;
    this.program = null;
  }
}

/**
 * Feature-detect WebGL on the given canvas-like object and, if available, build a GLPresenter
 * (creating all GPU objects ONCE). Returns null if WebGL is unavailable OR if GL-object
 * creation fails — the caller then falls back to its 2D putImageData path.
 *
 * @param {object} canvas a real <canvas> (main thread) or transferred OffscreenCanvas (worker)
 * @param {string} env 'offscreen' (worker) | 'main' (main thread) — only affects the label
 * @returns {GLPresenter|null}
 */
export function createGLPresenter(canvas, env = 'main') {
  const acquired = acquireGL(canvas);
  if (!acquired) return null;
  const { gl, isWebGL2 } = acquired;
  const label = `${env}-webgl${isWebGL2 ? '2' : '1'}`;
  try {
    return new GLPresenter(gl, canvas, isWebGL2, label);
  } catch (_err) {
    // GL object creation failed (driver quirk); let the caller use its 2D fallback.
    return null;
  }
}
