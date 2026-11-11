/* verify.js — end-to-end check of the converter against the real archived page.
 * Usage: node test/verify.js
 * Requires: Google Chrome (headless) + Python 3 (only for ZIP validation).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXDIR = path.join(__dirname, 'fixtures');
const FIXTURE = process.env.ARCHIVER_FIXTURE || path.join(FIXDIR, 'second-brain_frame.html');
const SHELL = process.env.ARCHIVER_SHELL || path.join(FIXDIR, 'second-brain_shell.html');
const REFERENCE_MD = path.resolve(ROOT, '..', '录音笔分享-搭建家庭的第二大脑', '搭建家庭的第二大脑.md');

function chromePath() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ];
  for (const p of c) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  throw new Error('Google Chrome not found; set CHROME_PATH env var');
}

function jsLiteral(s) {
  return JSON.stringify(s).replace(/<\/script/gi, '<\\/script');
}

function buildHarness() {
  const fixture = fs.readFileSync(FIXTURE, 'utf8');
  const shell = fs.readFileSync(SHELL, 'utf8');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script src="../lib/converter.js"></script>
<script src="../lib/infer.js"></script>
<script src="../lib/adapters.js"></script>
</head><body><pre id="out"></pre><script>
var FIXTURE=${jsLiteral(fixture)};
var SHELL=${jsLiteral(shell)};
var doc = new DOMParser().parseFromString(FIXTURE, 'text/html');
var C = window.ArchiverConverter, A = window.ArchiverAdapters;
var url = 'https://r.qq.com/wetype/api/getVoiceRecorderFrame?share_token=shr-test';
var ctx = {pageUrl:'https://r.qq.com/wetype/voicerecorder?share_token=shr-test', pageHtml:SHELL, pageTitle:'搭建家庭的第二大脑', isFrame:true};
var adapter = A.pick(doc, url, ctx);
var template = adapter.normalize ? adapter.normalize(doc) : 'none';
var md = C.toMarkdown(doc, {profile: adapter.profile});
var meta = adapter.meta(doc, Object.assign({}, ctx, {frameUrl:url}));
var payload = JSON.stringify({
  md: md, stats: C.stats(doc), plain: C.plainTextLines(doc),
  adapterId: adapter.id, template: template, meta: meta, htmlLen: FIXTURE.length
});
var bytes = new TextEncoder().encode(payload), bin = '';
for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
document.getElementById('out').textContent = btoa(bin);
</script></body></html>`;
  const p = path.join(__dirname, 'harness.html');
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

function runChrome(harness) {
  const exe = process.env.CHROME_PATH || chromePath();
  const profile = path.join(os.tmpdir(), 'archiver-verify-' + Date.now());
  const fileUrl = 'file:///' + harness.replace(/\\/g, '/');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--user-data-dir=' + profile,
    '--virtual-time-budget=3000', '--dump-dom', fileUrl
  ];
  const out = execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  const m = /<pre id="out">([A-Za-z0-9+/=]+)<\/pre>/.exec(out);
  if (!m) throw new Error('Chrome produced no converter output (harness failed to run)');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

function normalize(s) {
  return String(s || '').replace(/[\s*#>\[\]()（）〔〕「」“”‘’.,，。:：;；!！?？、·—|/\\-]/g, '');
}

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!ok) process.exitCode = 1;
}

async function checkZip() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'zip.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const entries = [
    { name: '中文文件名.md', data: mod.utf8('hello 中文\n第二行') },
    { name: 'meta.json', data: mod.utf8('{"a":1}') }
  ];
  const bytes = mod.makeZip(entries);
  const p = path.join(__dirname, '_sample.zip');
  fs.writeFileSync(p, bytes);
  const py = [
    'import zipfile,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'assert z.namelist()==["中文文件名.md","meta.json"]',
    'assert z.read("中文文件名.md").decode("utf-8")=="hello 中文\\n第二行"',
    'print("zip entries ok")'
  ].join(';');
  execFileSync(process.env.PYTHON || 'python', ['-c', py, p], { encoding: 'utf8' });
  return bytes.length;
}

async function main() {
  console.log('=== Recap Archiver — verification ===\n');
  if (!fs.existsSync(FIXTURE) || !fs.existsSync(SHELL)) {
    throw new Error('Fixture missing: expected test/fixtures/second-brain_frame.html');
  }
  const harness = buildHarness();
  const r = runChrome(harness);
  const md = r.md;
  fs.writeFileSync(path.join(__dirname, '_legacy.md'), md, 'utf8');

  console.log('[1] DOM capture');
  check('adapter = wetype-voicerecorder', r.adapterId === 'wetype-voicerecorder', r.adapterId);
  check('source HTML length', r.htmlLen > 50000, r.htmlLen + ' chars');
  console.log('        DOM stats: ' + JSON.stringify(r.stats));

  console.log('\n[2] structure counts (source vs Markdown)');
  const got = {
    sections: (md.match(/^## \d+\. /gm) || []).length,
    modules: (md.match(/^### /gm) || []).length,
    figures: (md.match(/图解 · /g) || []).length,
    svgText: (md.match(/（图解内文字：/g) || []).length
  };
  check('sections 6', r.stats.sections === 6 && got.sections === 6, JSON.stringify(got));
  check('modules 23', r.stats.articles === 23 && got.modules === 23);
  check('figures 21', r.stats.figures === 21 && got.figures === 21);
  // <template> content lives in .content, not childNodes, so the share-cover SVG is not counted.
  check('visible svg >= 5', r.stats.svg >= 5, 'visible=' + r.stats.svg + ', with-text-labels=' + got.svgText);

  console.log('\n[3] text coverage');
  const M = normalize(md);
  const miss = r.plain.filter(function (l) { return normalize(l).length >= 8 && M.indexOf(normalize(l)) === -1; });
  const checked = r.plain.filter(function (l) { return normalize(l).length >= 8; }).length;
  check('all source text lines present', miss.length === 0, checked + ' checked, ' + miss.length + ' missing');
  if (miss.length) miss.slice(0, 5).forEach(function (m) { console.log('        MISS: ' + m.slice(0, 90)); });

  console.log('\n[4] metadata');
  check('title', r.meta.title === '搭建家庭的第二大脑', r.meta.title);
  check('date from createTimeMs', /^2026-11-07/.test(r.meta.date), r.meta.date);
  check('coverUrl extracted', /\.png$/.test(r.meta.coverUrl), r.meta.coverUrl.slice(-40));
  check('markdown length', md.length > 9000, md.length + ' chars');

  console.log('\n[5] ZIP writer');
  const zipLen = await checkZip();
  check('zip built & readable by Python', zipLen > 100, zipLen + ' bytes');

  if (fs.existsSync(REFERENCE_MD)) {
    console.log('\n[6] cross-check with previous manual archive');
    const ref = fs.readFileSync(REFERENCE_MD, 'utf8');
    const refLines = ref.split('\n');
    const heads = refLines.filter(function (x) { return /^### /.test(x); }).map(normalize);
    const missingHeads = heads.filter(function (l) { return M.indexOf(l) === -1; });
    check('23 module titles reproduced', heads.length === 23 && missingHeads.length === 0,
      heads.length + ' titles, ' + missingHeads.length + ' missing');
    // Skip the manual archive's front-matter; compare body paragraphs only.
    const bodyStart = refLines.findIndex(function (x, i) { return i > 10 && /^\*\*AI × 家庭教育/.test(x); });
    const body = refLines.slice(bodyStart + 1).filter(function (x) {
      const t = x.trim();
      return t.length >= 30 && !/^[#>|\-*]/.test(t);
    });
    const bodyNorm = body.map(normalize).filter(function (x) { return x.length >= 25; });
    const missingBody = bodyNorm.filter(function (l) { return M.indexOf(l) === -1; });
    check('body paragraphs reproduced', missingBody.length <= 2,
      bodyNorm.length + ' checked, ' + missingBody.length + ' differing');
    if (missingBody.length) console.log('        first diff: ' + missingBody[0].slice(0, 100));
  }

  console.log('\n[7] background orchestration (Chrome APIs mocked)');
  await checkBackground(r, fs.readFileSync(FIXTURE, 'utf8'), fs.readFileSync(SHELL, 'utf8'));

  console.log('\n' + (process.exitCode ? '*** VERIFICATION FAILED ***' : 'All checks passed.'));
}

async function checkBackground(r, fixtureHtml, shellHtml) {
  const vm = require('vm');
  const zipSrc = fs.readFileSync(path.join(ROOT, 'lib', 'zip.js'), 'utf8');
  const zipMod = await import('data:text/javascript;base64,' + Buffer.from(zipSrc).toString('base64'));
  let src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  src = src.replace(/^import[\s\S]*?from '\.\/lib\/zip\.js';/m,
    'const { makeZip, bytesToBase64, utf8 } = globalThis.__ZIP__;');

  const winner = {
    url: 'https://r.qq.com/wetype/api/getVoiceRecorderFrame?share_token=shr-test',
    isFrame: true,
    html: fixtureHtml,
    markdown: r.md,
    meta: r.meta,
    stats: r.stats,
    plainLines: r.plain,
    score: 999999
  };
  const cap = {
    candidates: [winner], best: winner, failedFrames: [],
    pageHtml: shellHtml,
    pageUrl: 'https://r.qq.com/wetype/voicerecorder?share_token=shr-test',
    pageTitle: '搭建家庭的第二大脑'
  };
  const downloads = [];
  let handler = null;
  const chromeMock = {
    tabs: { query: async function () { return [{ id: 7, url: cap.pageUrl }]; } },
    scripting: {
      executeScript: async function (o) {
        if (o.files) return [];
        return [{ result: cap }];
      }
    },
    downloads: {
      download: async function (o) { downloads.push(o); return downloads.length; }
    },
    runtime: {
      onMessage: { addListener: function (fn) { handler = fn; } },
      onInstalled: { addListener: function () {} },
      getManifest: function () { return { version: '1.0.0' }; }
    },
    storage: { local: { set: async function () {}, get: async function () { return {}; } } }
  };
  const sandbox = {
    chrome: chromeMock,
    console: console,
    __ZIP__: zipMod,
    fetch: async function () {
      return { ok: true, arrayBuffer: async function () { return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer; } };
    }
  };
  vm.runInNewContext(src, sandbox, { filename: 'background.js' });
  check('message listener registered', typeof handler === 'function');

  let resp = null;
  await new Promise(function (resolve) {
    handler({ type: 'ARCHIVE', options: {} }, {}, function (x) { resp = x; resolve(); });
  });
  check('archive() resolved ok', !!(resp && resp.ok), resp && resp.ok ? '' : JSON.stringify(resp));
  if (!resp || !resp.ok) return;
  check('single ZIP download triggered', downloads.length === 1 && /\.zip$/.test(downloads[0].filename),
    downloads.map(function (d) { return d.filename; }).join(','));
  check('completeness self-check = 0 missing', resp.result.coverage.missing === 0,
    JSON.stringify(resp.result.coverage));
  check('4 entries packaged', resp.result.entryCount === 4, String(resp.result.entryCount));

  const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(downloads[0].url);
  const outZip = path.join(__dirname, '_download.zip');
  fs.writeFileSync(outZip, Buffer.from(b64[1], 'base64'));
  const py = [
    'import zipfile,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'n=z.namelist()',
    'assert len(n)==4, n',
    'assert any(x.endswith(".md") for x in n)',
    'assert any(x.endswith(".html") for x in n)',
    'assert any(x.endswith("_meta.json") for x in n)',
    'assert any("封面.png" in x for x in n)',
    'print(" | ".join(n))'
  ].join(';');
  const listed = execFileSync(process.env.PYTHON || 'python', ['-c', py, outZip], { encoding: 'utf8' }).trim();
  check('ZIP readable by Python with all 4 artifacts', true, listed);
}

main().catch(function (e) {
  console.error('ERROR:', e && e.stack || e);
  process.exit(1);
});
