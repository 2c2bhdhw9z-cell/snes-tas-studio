// tools/dom-smoke.test.js
// Headless DOM smoke test using jsdom. Verifies the app shell boots, renders graceful
// 'ROM not found' / 'core not found' notices when neither is present, registers a service
// worker, and contains NO file input. Run: node tools/dom-smoke.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const assertions = [];
function check(name, cond) {
  assertions.push({ name, ok: !!cond });
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Track service worker registration attempts.
  const swRegistrations = [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {}); // module resolution warnings are expected

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole,
    beforeParse(window) {
      // Stub service worker so registration is observable.
      window.navigator.serviceWorker = {
        register: (url) => {
          swRegistrations.push(url);
          return Promise.resolve({ scope: '/' });
        },
      };
      // requestAnimationFrame stub.
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      // fetch stub: ROM and core both 404 -> exercise graceful degradation.
      window.fetch = () => Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    },
  });

  const { window } = dom;
  const { document } = window;

  // Fire load + DOMContentLoaded so bootstrap runs.
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  window.dispatchEvent(new window.Event('load'));

  // Let async init() settle.
  await new Promise((r) => setTimeout(r, 300));

  // --- Structural assertions ---
  check('canvas#screen exists', document.getElementById('screen'));
  check('#hud exists', document.getElementById('hud'));
  check('#piano-roll exists', document.getElementById('piano-roll'));
  check('#frame-controls exists', document.getElementById('frame-controls'));
  check('#savestate-tree exists', document.getElementById('savestate-tree'));
  check('#touch-controls exists', document.getElementById('touch-controls'));
  check('#notice exists', document.getElementById('notice'));

  // --- HARD RULE: no file input anywhere ---
  const fileInputs = document.querySelectorAll('input[type="file"]');
  check('NO file input in DOM', fileInputs.length === 0);

  // --- iOS PWA meta tags ---
  const metaCapable = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
  check('apple-mobile-web-app-capable meta present', metaCapable && metaCapable.content === 'yes');
  const viewport = document.querySelector('meta[name="viewport"]');
  check('viewport disables user-scaling', viewport && /user-scalable=no/.test(viewport.content) && /viewport-fit=cover/.test(viewport.content));
  check('manifest link present', document.querySelector('link[rel="manifest"]'));
  check('apple-touch-icon present', document.querySelector('link[rel="apple-touch-icon"]'));

  // --- Service worker registration attempted ---
  check('service worker registered (sw.js)', swRegistrations.some((u) => String(u).includes('sw.js')));

  // --- Graceful notices rendered (ROM + core missing) ---
  const noticeText = (document.getElementById('notice') || {}).textContent || '';
  check('ROM-missing notice rendered', /ROM not found at assets\/Super Mario All-Stars \(USA\)\.sfc/.test(noticeText));
  check('core-missing notice rendered', /core not found|Emulator core not found/i.test(noticeText));

  // --- Report ---
  let failed = 0;
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'}  ${a.name}`);
    if (!a.ok) failed++;
  }
  console.log(`\n${assertions.length - failed}/${assertions.length} passed`);
  dom.window.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
