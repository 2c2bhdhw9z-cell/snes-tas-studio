// tools/core-url-resolve.test.mjs
//
// Focused test for the BROWSER-SPECIFIC module-loading bug fix in core/core-loader.js.
//
// Background — the live production bug:
//   The deployed site threw a FATAL
//     `SyntaxError: import.meta is only valid inside modules.
//        @ https://.../cores/bsnes_mercury_accuracy_libretro.js:88`
//   Root cause: core-loader passed a PAGE-RELATIVE specifier ('cores/...js', no leading
//   './' or '/') straight to dynamic import(). The browser treated that as a BARE module
//   specifier and threw "Failed to resolve module specifier"; that error was swallowed and
//   execution fell through to injecting the SAME ES6-module file as a CLASSIC <script>,
//   which then hit `import.meta` and died with the SyntaxError above.
//
// This test proves the two halves of the fix WITHOUT needing a real browser:
//   (1) resolveCoreUrl() turns a page-relative corePath into an ABSOLUTE, importable URL
//       against a given base (so import() gets an absolute URL, never a bare specifier).
//   (2) core-loader.js NO LONGER injects the core via a classic non-module <script>
//       (the `document.createElement('script')` + `script.src = url` path is gone), so it
//       can never re-trigger the import.meta SyntaxError.
//
// Run: node tools/core-url-resolve.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message }); }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_SRC = fs.readFileSync(path.join(ROOT, 'core', 'core-loader.js'), 'utf8');

const { resolveCoreUrl, DEFAULT_CORE_PATHS, CORE_CATALOG } = await import('../core/core-loader.js');

// --- (1) URL resolution: page-relative corePath + fake base -> absolute importable URL ---

check('resolveCoreUrl turns a page-relative corePath into the expected absolute URL', () => {
  const out = resolveCoreUrl(
    'cores/bsnes_mercury_accuracy_libretro.js',
    'https://example.netlify.app/'
  );
  assert.strictEqual(out, 'https://example.netlify.app/cores/bsnes_mercury_accuracy_libretro.js');
});

check('resolveCoreUrl result is NOT a bare specifier (it parses as an absolute URL)', () => {
  const out = resolveCoreUrl('cores/bsnes_mercury_accuracy_libretro.js', 'https://example.netlify.app/');
  // A bare specifier like 'cores/..' has no scheme; an absolute URL does. new URL(out) must
  // succeed with no base, which it only does for an absolute URL.
  const parsed = new URL(out);
  assert.strictEqual(parsed.protocol, 'https:');
  assert.strictEqual(parsed.host, 'example.netlify.app');
  assert.ok(!out.startsWith('cores/'), 'must not remain a bare page-relative specifier');
});

check('resolveCoreUrl resolves relative to a sub-path base (not just the origin)', () => {
  const out = resolveCoreUrl('cores/bsnes_mercury_accuracy_libretro.js', 'https://host.example/app/index.html');
  assert.strictEqual(out, 'https://host.example/app/cores/bsnes_mercury_accuracy_libretro.js');
});

check('resolveCoreUrl handles the performance core path too', () => {
  const out = resolveCoreUrl('cores/bsnes_mercury_performance_libretro.js', 'https://example.netlify.app/');
  assert.strictEqual(out, 'https://example.netlify.app/cores/bsnes_mercury_performance_libretro.js');
});

check('resolveCoreUrl leaves an already-absolute URL absolute', () => {
  const abs = 'https://cdn.example/cores/bsnes_mercury_accuracy_libretro.js';
  assert.strictEqual(resolveCoreUrl(abs, 'https://example.netlify.app/'), abs);
});

check('the .wasm sibling also resolves to an absolute URL under the same base', () => {
  const out = resolveCoreUrl('cores/bsnes_mercury_accuracy_libretro.wasm', 'https://example.netlify.app/');
  assert.strictEqual(out, 'https://example.netlify.app/cores/bsnes_mercury_accuracy_libretro.wasm');
});

check('DEFAULT_CORE_PATHS + catalog paths all resolve to absolute URLs (no bare specifiers)', () => {
  const paths = [...DEFAULT_CORE_PATHS, ...CORE_CATALOG.map((c) => c.path)];
  for (const p of paths) {
    const out = resolveCoreUrl(p, 'https://example.netlify.app/');
    assert.ok(/^https:\/\//.test(out), `expected absolute URL for ${p}, got ${out}`);
    assert.ok(!out.startsWith('cores/'), `${p} must not remain a bare specifier`);
  }
});

// --- (2) The harmful classic-<script> injection must be GONE ---

check('core-loader source no longer injects the core via a classic <script src=url>', () => {
  // The old harmful path built a <script> element and set script.src = url (no type=module),
  // which parsed the ES6-module core as a classic script and threw the import.meta SyntaxError.
  assert.ok(
    !/document\.createElement\(\s*['"]script['"]\s*\)/.test(LOADER_SRC),
    'core-loader must not create a <script> element to load the core'
  );
  assert.ok(
    !/script\.src\s*=/.test(LOADER_SRC),
    'core-loader must not set script.src to inject the core file'
  );
});

check('core-loader loads the core via dynamic import() of the resolved URL', () => {
  assert.ok(/await import\(/.test(LOADER_SRC), 'core-loader must use dynamic import()');
  assert.ok(/resolveCoreUrl\(/.test(LOADER_SRC), 'core-loader must resolve the path before importing');
});

check('core-loader reads the ES6 default export as the factory', () => {
  assert.ok(/mod\s*&&\s*mod\.default|mod\.default/.test(LOADER_SRC), 'must read mod.default');
});

check('core-loader surfaces import errors (does not silently swallow them)', () => {
  // The old code had `catch (_esErr) { /* swallow */ }`. The fix logs via console.error and
  // returns the error so loadCore can report 'core-load-failed'.
  assert.ok(/console\.error\(/.test(LOADER_SRC), 'import failure must be logged, not swallowed');
  assert.ok(/core-load-failed/.test(LOADER_SRC), 'a present-but-failing core must be reported distinctly');
});

// --- report ---
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
  if (!r.ok) failed++;
}
console.log('-'.repeat(60));
console.log(`${failed === 0 ? 'ALL ASSERTIONS PASSED' : failed + ' ASSERTION(S) FAILED'} (${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
