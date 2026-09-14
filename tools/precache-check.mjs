// tools/precache-check.mjs — verify sw.js precaches the full shell and excludes the ROM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

const need = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'app.js',
  'tas-engine.js',
  'piano-roll.js',
  'input-log.js',
  'live-input.js',
  'memory-watch.js',
  'core/core-loader.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

let ok = true;
for (const f of need) {
  const present = sw.includes(`'${f}'`);
  if (!present) {
    console.log('MISSING from precache:', f);
    ok = false;
  }
}

const version = (sw.match(/CACHE_VERSION\s*=\s*'([^']+)'/) || [])[1];
const appShellBlock = sw.split('APP_SHELL')[1].split(']')[0];
const noRomInShell = !/\.(sfc|smc)/i.test(appShellBlock);
const hasRomGuard = /isRomRequest/.test(sw) && /assets\//.test(sw);

// Both selectable ASYNCIFY cores (accuracy + performance, .js + .wasm) must be listed in
// OPTIONAL_CORE_FILES so either can be chosen from the dropdown and still work offline. The
// ROM must NEVER appear there.
const optionalBlock = (sw.split('OPTIONAL_CORE_FILES')[1] || '').split(']')[0];
const bothCores = [
  'cores/bsnes_mercury_accuracy_libretro.js',
  'cores/bsnes_mercury_accuracy_libretro.wasm',
  'cores/bsnes_mercury_performance_libretro.js',
  'cores/bsnes_mercury_performance_libretro.wasm',
];
let coresOk = true;
for (const c of bothCores) {
  if (!optionalBlock.includes(`'${c}'`)) {
    console.log('MISSING from OPTIONAL_CORE_FILES:', c);
    coresOk = false;
  }
}
const noRomInOptional = !/\.(sfc|smc)/i.test(optionalBlock);

console.log('cache version:', version);
console.log('ROM guard present (isRomRequest + assets/):', hasRomGuard);
console.log('APP_SHELL contains no ROM (.sfc/.smc):', noRomInShell);
console.log('OPTIONAL_CORE_FILES has both cores (accuracy + performance, .js + .wasm):', coresOk);
console.log('OPTIONAL_CORE_FILES contains no ROM:', noRomInOptional);
const pass = ok && noRomInShell && hasRomGuard && coresOk && noRomInOptional;
console.log(pass ? 'PRECACHE OK' : 'PRECACHE FAIL');
process.exit(pass ? 0 : 1);
