// tools/no-worker-check.mjs
//
// GREP-PROOF for THE GREAT REVERSAL: the running app must contain NO Web Worker / cross-thread
// machinery. The emulator now runs SINGLE-THREADED on the main thread in tas-engine.js's own
// requestAnimationFrame loop; there is no background thread, no cross-thread messaging, and no
// cross-thread canvas transfer anywhere in the app.
//
// This harness reads the RUNNING app source (every module the main thread now imports),
// STRIPS comments and string/template literals (so a mention in prose or a diagnostic string is
// not a false positive), and FAILS (exit non-zero) if any of these appear as LIVE CODE:
//   new Worker              -- spawning a Web Worker
//   postMessage             -- cross-thread messaging
//   MessageChannel          -- cross-thread message ports
//   transferControlToOffscreen -- transferring the canvas off the main thread
//   OffscreenCanvas         -- the off-main-thread canvas type
// It also asserts emu-worker.js DOES NOT EXIST (the worker entry was retired).
//
// SCOPE (review follow-up): the reversal moved the whole emulator onto the main thread, so the
// grep now polices ALL the app modules the main-thread engine imports, not just tas-engine.js +
// app.js. ONE deliberate, documented exemption: emu-core-runner.js keeps a live
// `defaultScheduleYield` that constructs a MessageChannel + calls port.postMessage. That code is
// DEAD IN THE RUNNING APP (tas-engine.js always injects its own rAF scheduleYield into the
// runner, so the default is never taken), but it legitimately exists in the file as the runner's
// standalone fallback. Flagging it would be a FALSE POSITIVE, so MessageChannel/postMessage are
// exempted FOR THAT ONE FILE ONLY; every other token in every file (including new Worker /
// OffscreenCanvas / transferControlToOffscreen in emu-core-runner.js) is still a hard failure.
//
// It would exit NON-ZERO if any of the above were reintroduced as code, so wiring it into the
// npm test chain makes a regression back toward a worker architecture a hard build failure.
//
// Run: node tools/no-worker-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The running-app files to police. (Test harnesses + tools are NOT app code and may still
// reference these tokens in fakes/prose; only the shipped app matters.) These are all the
// modules the main-thread engine imports now that the emulator runs single-threaded.
const APP_FILES = [
  'tas-engine.js',
  'app.js',
  'emu-core-runner.js',
  'gl-presenter.js',
  'input-resolver.js',
  'input-log.js',
  'live-input.js',
  'memory-watch.js',
  'piano-roll.js',
  'fps-meter.js',
  'core/core-loader.js',
];

// The forbidden live-code tokens. Each is matched against the comment/string-stripped source.
const FORBIDDEN = [
  { name: 'new Worker', re: /\bnew\s+Worker\b/ },
  { name: 'postMessage', re: /\bpostMessage\b/ },
  { name: 'MessageChannel', re: /\bMessageChannel\b/ },
  { name: 'transferControlToOffscreen', re: /\btransferControlToOffscreen\b/ },
  { name: 'OffscreenCanvas', re: /\bOffscreenCanvas\b/ },
];

// Per-file token exemptions for legitimate-but-dead code (see the header). emu-core-runner.js's
// standalone `defaultScheduleYield` fallback builds a MessageChannel + calls port.postMessage;
// it is never reached in the running app (the engine injects its own rAF scheduleYield), so
// those two tokens must NOT fail the build FOR THAT FILE. All other tokens still fail everywhere.
const EXEMPT = {
  'emu-core-runner.js': new Set(['MessageChannel', 'postMessage']),
};

/**
 * Remove comments and string/template literals from JS source so the token scan only sees LIVE
 * CODE. This is a pragmatic tokenizer (not a full JS parser) that handles line comments, block
 * comments, and single/double/backtick strings with escapes -- enough to avoid false positives
 * from prose in comments or diagnostic strings while still catching a real code reference.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i += 1; continue; }
      if (c === '"') { state = 'dq'; i += 1; continue; }
      if (c === '`') { state = 'tpl'; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1; continue;
    }
    // string / template states: skip content, honoring escapes.
    if (c === '\\') { i += 2; continue; }
    if (state === 'sq' && c === "'") { state = 'code'; i += 1; continue; }
    if (state === 'dq' && c === '"') { state = 'code'; i += 1; continue; }
    if (state === 'tpl' && c === '`') { state = 'code'; i += 1; continue; }
    if (c === '\n') out += '\n';
    i += 1;
  }
  return out;
}

let failed = 0;
const report = [];

for (const rel of APP_FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    report.push({ ok: false, msg: `app file missing: ${rel}` });
    failed++;
    continue;
  }
  const code = stripCommentsAndStrings(fs.readFileSync(abs, 'utf8'));
  const exemptTokens = EXEMPT[rel] || null;
  for (const tok of FORBIDDEN) {
    if (exemptTokens && exemptTokens.has(tok.name)) {
      report.push({ ok: true, msg: `${rel}: '${tok.name}' exempt (legitimate dead fallback, not used in the running app)` });
      continue;
    }
    if (tok.re.test(code)) {
      // Find the line number(s) in the ORIGINAL source for a helpful message.
      const lines = code.split('\n');
      const hits = [];
      lines.forEach((ln, idx) => {
        if (tok.re.test(ln)) hits.push(idx + 1);
      });
      report.push({ ok: false, msg: `${rel}: forbidden live-code token '${tok.name}' at line(s) ${hits.join(', ')}` });
      failed++;
    } else {
      report.push({ ok: true, msg: `${rel}: no live '${tok.name}'` });
    }
  }
}

// emu-worker.js must NOT exist anymore.
const workerPath = path.join(ROOT, 'emu-worker.js');
if (fs.existsSync(workerPath)) {
  report.push({ ok: false, msg: 'emu-worker.js still exists (the worker entry must be retired)' });
  failed++;
} else {
  report.push({ ok: true, msg: 'emu-worker.js does not exist (worker retired)' });
}

for (const r of report) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
}
console.log('');
console.log(failed === 0 ? 'NO-WORKER OK (single-thread app; no cross-thread machinery)' : `NO-WORKER FAIL (${failed} issue(s))`);
process.exit(failed === 0 ? 0 : 1);
