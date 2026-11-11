/* verify-fixes.js — regression tests for the defects found in the 2026-11-11 review.
 * Usage: node test/verify-fixes.js
 * Requires: Google Chrome (headless), Node 18+. Python 3 for ZIP inspection (optional).
 *
 * Part A runs capture.js in a real browser DOM (iframes / srcdoc / fetch / DOCTYPE).
 * Part B runs background.js against mocked Chrome APIs (fallback / metadata / downloads).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'second-brain_frame.html');

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!ok) { failed++; process.exitCode = 1; }
}
function chromePath() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  throw new Error('Google Chrome not found; set CHROME_PATH');
}
function lit(s) { return JSON.stringify(s).replace(/<\/script/gi, '<\\/script'); }

/* Same escaped Nuxt payload that the real shell page embeds in a <script>. */
const SHELL = '<!doctype html><html><head><script>window.__NUXT__={' +
  'recapTitle:"\\u5916\\u58f3\\u6807\\u9898",createTimeMs:1762473600000,' +
  'coverUrl:"https:\\u002F\\u002Fdownload.z.weixin.qq.com\\u002Fa.png"};' +
  '</script></head><body><iframe src="/wetype/api/getVoiceRecorderFrame?share_token=shr-test"></iframe></body></html>';
const SHARE_URL = 'https://r.qq.com/wetype/voicerecorder?share_token=shr-test';
const FRAME_URL = 'https://r.qq.com/wetype/api/getVoiceRecorderFrame?share_token=shr-test';

async function partA() {
  console.log('\n[A] capture.js in a real browser DOM');
  const frameHtml = fs.readFileSync(FIXTURE, 'utf8');
  const nuxt = '<script type="text/plain" id="nuxt">' + SHELL.match(/<script>([\s\S]*?)<\/script>/)[1] + '</script>';
  const srcdoc = '<html><body><h1>Srcdoc 正文</h1><p>这是一段用于验证 srcdoc 采集是否生效的足够长的示例文本。</p></body></html>';

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Harness 外壳</title>
<script src="../lib/converter.js"></script>
<script src="../lib/infer.js"></script>
<script src="../lib/adapters.js"></script>
<script src="../capture.js"></script>
${nuxt}
</head><body>
<iframe id="real"></iframe>
<iframe id="doc" srcdoc="${srcdoc.replace(/"/g, '&quot;')}"></iframe>
<iframe id="blank"></iframe>
<iframe id="broken"></iframe>
<pre id="out"></pre>
<script>
var FRAME = ${lit(frameHtml)}, SHELL = ${lit(SHELL)};
/* Override the .src property only (no src attribute) so Chrome never actually
 * navigates these frames out to the network during the headless test. */
[['real', ${lit(FRAME_URL)}], ['blank', 'about:blank'], ['broken', 'https://r.qq.com/broken']]
  .forEach(function (p) {
    Object.defineProperty(document.getElementById(p[0]), 'src', { value: p[1], configurable: true });
  });
var creds = [], attempts = [];
window.fetch = function (url, opts) {
  creds.push(opts && opts.credentials);
  attempts.push(url);
  if (/broken/.test(url)) return Promise.resolve({ ok: false, status: 500 });
  var bytes = new TextEncoder().encode(FRAME);
  return Promise.resolve({
    ok: true, status: 200,
    headers: { get: function (k) { return /content-type/i.test(k) ? 'text/html; charset=utf-8' : ''; } },
    arrayBuffer: function () { return Promise.resolve(bytes.buffer); }
  });
};
(function () {
  var A = window.ArchiverAdapters, cap = window.__ArchiverCapture;
  Promise.resolve(cap.run()).then(function (r) {
    var frame = r.candidates.filter(function (c) { return /getVoiceRecorderFrame/.test(c.url); })[0];
    var shell = { pageUrl: ${lit(SHARE_URL)}, pageTitle: '外壳页标题', pageHtml: SHELL };
    var fc = cap.frameCapture(shell);
    var doc2 = new DOMParser().parseFromString(FRAME, 'text/html');
    var ad = A.pick(doc2, ${lit(FRAME_URL)}, { pageHtml: SHELL });
    var m2 = ad.meta(doc2, { pageHtml: SHELL, pageUrl: ${lit(SHARE_URL)}, pageTitle: 'x', frameUrl: ${lit(FRAME_URL)} });
    var genericDoc = new DOMParser().parseFromString(
      '<html><body><h1>普通网页</h1><section class="part"><h2>章节</h2><p>一段普通网页正文内容。</p></section></body></html>',
      'text/html');
    var genericAdapter = A.pick(genericDoc, 'https://example.com/article', {});
    var payload = {
      genericAdapter: genericAdapter.id,
      topDoctype: r.pageHtml.slice(0, 15),
      frameDoctype: frame ? frame.html.slice(0, 15) : '',
      frameTitle: frame ? frame.meta.title : '',
      frameCover: frame ? frame.meta.coverUrl : '',
      frameSource: frame ? frame.meta.sourceUrl : '',
      srcdoc: r.candidates.some(function (c) { return /#srcdoc-/.test(c.url); }),
      attempts: r.frameAttempts,
      failed: r.failedFrames,
      urls: attempts,
      creds: creds,
      fcDoctype: fc.html.slice(0, 15),
      fcTitle: fc.meta.title,
      fcSource: fc.meta.sourceUrl,
      adapterTitle: m2.title,
      adapterCover: m2.coverUrl
    };
    var b = new TextEncoder().encode(JSON.stringify(payload)), bin = '';
    for (var i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    document.getElementById('out').textContent = btoa(bin);
  }).catch(function (e) { document.getElementById('out').textContent = 'ERR:' + e; });
})();
</script></body></html>`;

  const hpath = path.join(__dirname, 'harness-fixes.html');
  fs.writeFileSync(hpath, html, 'utf8');
  const out = execFileSync(process.env.CHROME_PATH || chromePath(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--user-data-dir=' + path.join(os.tmpdir(), 'archiver-fixes-' + Date.now()),
    '--virtual-time-budget=4000', '--dump-dom', 'file:///' + hpath.replace(/\\/g, '/')
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  const m = /<pre id="out">([A-Za-z0-9+/=]+)<\/pre>/.exec(out);
  if (!m) throw new Error('harness failed: ' + (/(<pre id="out">ERR:[^<]*)/.exec(out) || [''])[1]);
  const r = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));

  check('top HTML keeps DOCTYPE (no quirks mode)', /^<!DOCTYPE html>/i.test(r.topDoctype), JSON.stringify(r.topDoctype));
  check('fetched frame HTML keeps DOCTYPE', /^<!DOCTYPE html>/i.test(r.frameDoctype), JSON.stringify(r.frameDoctype));
  check('srcdoc iframe is captured', r.srcdoc === true);
  check('about:blank iframe skipped, broken one attempted', r.attempts === 3 && r.urls.length === 2,
    'attempts=' + r.attempts + ' fetch=' + r.urls.length);
  check('failed frame recorded for fallback', r.failed.length === 1 && /broken/.test(r.failed[0].src),
    JSON.stringify(r.failed));
  check('same-origin cookies are not dropped', r.creds.length === 2 && r.creds.every((x) => x === 'same-origin'),
    JSON.stringify(r.creds));
  check('shell metadata inherited by fetched frame', r.frameTitle === '外壳标题' &&
    r.frameCover === 'https://download.z.weixin.qq.com/a.png' && /^file:/.test(r.frameSource),
    'title=' + r.frameTitle + ' cover=' + r.frameCover + ' source=' + r.frameSource);
  check('frameCapture keeps DOCTYPE', /^<!DOCTYPE html>/i.test(r.fcDoctype), JSON.stringify(r.fcDoctype));
  check('frameCapture uses shell title / share URL', r.fcTitle === '外壳页标题' && r.fcSource === SHARE_URL,
    r.fcTitle + ' | ' + r.fcSource);
  check('adapter unescapes \\uXXXX title and cover URL',
    r.adapterTitle === '外壳标题' && r.adapterCover === 'https://download.z.weixin.qq.com/a.png',
    r.adapterTitle + ' | ' + r.adapterCover);
  check('unrelated page with .part class stays generic', r.genericAdapter === 'generic', r.genericAdapter);
}

/* ---------- Part B: background.js with mocked Chrome APIs ---------- */
async function zipModule() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'zip.js'), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
}

function loadBackground(chromeMock, zipMod) {
  let src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  src = src.replace(/^import[\s\S]*?from '\.\/lib\/zip\.js';/m,
    'const { makeZip, bytesToBase64, utf8 } = globalThis.__ZIP__;');
  const sandbox = {
    chrome: chromeMock, console: console, __ZIP__: zipMod,
    fetch: async function () {
      return {
        ok: true,
        headers: { get: function () { return 'image/webp'; } },
        arrayBuffer: async function () { return Uint8Array.from([1, 2, 3, 4]).buffer; }
      };
    }
  };
  vm.runInNewContext(src, sandbox, { filename: 'background.js' });
}

function makeCap(overrides) {
  return Object.assign({
    candidates: [{ isFrame: false, markdown: '外壳', plainLines: [], score: 10,
      html: '<html></html>', meta: { title: '外壳' }, stats: {} }],
    failedFrames: [], frameAttempts: 1,
    pageHtml: SHELL, pageUrl: SHARE_URL, pageTitle: '外壳'
  }, overrides || {});
}

function makeFrameCandidate() {
  return {
    isFrame: true,
    url: FRAME_URL,
    html: '<!DOCTYPE html><html><body>正文</body></html>',
    markdown: '正文内容'.repeat(60),
    plainLines: [],
    score: 999999,
    stats: { sections: 1, articles: 1, figures: 0 },
    meta: {
      title: 'CON..',            // Windows reserved device name + trailing dots
      adapterName: '通用网页',
      sourceUrl: SHARE_URL,
      contentFrameUrl: FRAME_URL,
      coverUrl: 'https://download.z.weixin.qq.com/cover.webp?x=1',
      date: '2026-11-11'
    }
  };
}

async function partB() {
  console.log('\n[B] background.js orchestration');
  const zipMod = await zipModule();
  const downloads = [], injected = [], frameArgs = [];
  let handler = null, installed = null, getAllFramesCalls = 0;
  const frame = makeFrameCandidate();
  const cap = makeCap({ failedFrames: [{ src: FRAME_URL, error: 'CORS' }] });
  const storage = { saved: { archiverOptions: { packZip: false } }, sets: [] };

  const chromeMock = {
    tabs: { query: async function () { return [{ id: 7, url: SHARE_URL }]; } },
    scripting: {
      executeScript: async function (o) {
        if (o.files) { injected.push(o.target.frameIds.slice()); return []; }
        if (/frameCapture/.test(o.func.toString())) {
          frameArgs.push(o.args[0]);
          const id = o.target.frameIds[0];
          if (id === 3) throw new Error('Cannot access a chrome-error:// frame');
          return [{ result: frame }];
        }
        return [{ result: cap }];
      }
    },
    webNavigation: {
      getAllFrames: async function () {
        getAllFramesCalls++;
        return [
          { frameId: 0, url: SHARE_URL },
          { frameId: 1, url: 'about:blank' },
          { frameId: 2, url: FRAME_URL },
          { frameId: 3, url: 'https://r.qq.com/dead' }
        ];
      }
    },
    downloads: { download: async function (o) { downloads.push(o); return downloads.length; } },
    runtime: {
      onMessage: { addListener: function (fn) { handler = fn; } },
      onInstalled: { addListener: function (fn) { installed = fn; } },
      getManifest: function () { return { version: '1.0.1' }; }
    },
    storage: { local: {
      get: async function () { return storage.saved; },
      set: async function (o) { storage.sets.push(o); }
    } }
  };
  loadBackground(chromeMock, zipMod);

  const resp = await new Promise(function (resolve) {
    handler({ type: 'ARCHIVE', options: {} }, {}, resolve);
  });
  check('fallback archive succeeded', !!(resp && resp.ok), resp && resp.ok ? '' : JSON.stringify(resp));
  if (!resp || !resp.ok) return;
  check('one unreachable frame does not kill the whole fallback',
    getAllFramesCalls === 1 && injected.some((a) => a.length === 1 && a[0] === 2) &&
    injected.some((a) => a.length === 1 && a[0] === 3), 'injections=' + JSON.stringify(injected));
  check('about:blank frame skipped', !injected.some((a) => a.length === 1 && a[0] === 1));
  check('shell context forwarded to frames',
    frameArgs.length === 2 && frameArgs.every((s) => s.pageUrl === SHARE_URL && /recapTitle/.test(s.pageHtml)));
  check('winner is the real content frame', resp.result.title === 'CON..', resp.result.title);
  check('reserved Windows filename sanitized', /^_CON_\d{4}-\d{2}-\d{2}\.zip$/.test(downloads[0].filename),
    downloads[0].filename);
  check('fallback error surfaced in result notes',
    (resp.result.notes || []).some((n) => /部分子框架无法采集/.test(n)), JSON.stringify(resp.result.notes));

  const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(downloads[0].url);
  const zipPath = path.join(__dirname, '_fixes.zip');
  fs.writeFileSync(zipPath, Buffer.from(b64[1], 'base64'));
  let names = [];
  try {
    names = execFileSync(process.env.PYTHON || 'python', ['-c',
      'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()))',
      zipPath], { encoding: 'utf8' }).trim().split('|');
  } catch (e) { /* Python missing: skip independent ZIP check */ }
  if (names.length) {
    check('ZIP contains webp cover + meta.json (no hardcoded .png)',
      names.some((n) => /_封面\.webp$/.test(n)) && names.some((n) => /_meta\.json$/.test(n)) &&
      !names.some((n) => /_封面\.png$/.test(n)), names.join(', '));
    const metaEntry = names.find((n) => /_meta\.json$/.test(n));
    const metaTxt = execFileSync(process.env.PYTHON || 'python', ['-c',
      'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"))',
      zipPath, metaEntry], { encoding: 'utf8' });
    const meta = JSON.parse(metaTxt);
    check('meta.json records fallbackErrors + archiveNotes + version',
      meta.fallbackErrors.length === 1 && meta.archiveNotes.length >= 2 && meta.extensionVersion === '1.0.1',
      JSON.stringify({ e: meta.fallbackErrors, n: meta.archiveNotes.length, v: meta.extensionVersion }));
  }

  /* onInstalled must not clobber saved options on update. */
  check('onInstalled listener registered', typeof installed === 'function');
  installed({ reason: 'update' });
  await new Promise((r) => setImmediate(r));
  check('saved options preserved on extension update', storage.sets.length === 0,
    JSON.stringify(storage.sets));
  storage.saved = {};
  installed({ reason: 'install' });
  await new Promise((r) => setImmediate(r));
  check('defaults written on fresh install', storage.sets.length === 1 && storage.sets[0].archiverOptions.packZip === true);

  /* oversized payload: clear error instead of a cryptic Chrome "Invalid url". */
  const bigCap = makeCap({
    failedFrames: [], frameAttempts: 0,
    candidates: [Object.assign({}, frame, {
      html: 'x'.repeat(1450000), markdown: '正文内容'.repeat(60),
      meta: Object.assign({}, frame.meta, { coverUrl: '' })
    })]
  });
  cap.candidates = bigCap.candidates;
  cap.failedFrames = [];
  cap.frameAttempts = 0;
  downloads.length = 0;
  const big = await new Promise(function (resolve) {
    handler({ type: 'ARCHIVE', options: { includeCover: false } }, {}, resolve);
  });
  check('oversized data: URL fails with an actionable message',
    !big.ok && /超出 Chrome data: URL 下载上限/.test(big.error || '') && downloads.length === 0,
    big.error);

  /* concurrent ARCHIVE requests are rejected instead of racing two downloads. */
  cap.frameAttempts = 1;
  cap.failedFrames = [];
  cap.candidates = [Object.assign({}, frame, { markdown: 'x' })];
  let release;
  const gate = new Promise((r) => { release = r; });
  chromeMock.scripting.executeScript = async function (o) {
    if (o.files) return [];
    if (/frameCapture/.test(o.func.toString())) { await gate; return [{ result: frame }]; }
    return [{ result: cap }];
  };
  const first = new Promise((resolve) => handler({ type: 'ARCHIVE', options: {} }, {}, resolve));
  const second = await new Promise((resolve) => handler({ type: 'ARCHIVE', options: {} }, {}, resolve));
  check('concurrent archive rejected', second.ok === false && /正在归档中/.test(second.error), second.error);
  release();
  await first;
}

(async function () {
  console.log('=== Recap Archiver — defect regression suite ===');
  await partA();
  await partB();
  console.log('\n' + (failed ? '*** ' + failed + ' CHECK(S) FAILED ***' : 'All defect checks passed.'));
})().catch(function (e) {
  console.error('ERROR:', e && e.stack || e);
  process.exit(1);
});
