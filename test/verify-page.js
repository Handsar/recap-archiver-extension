/* verify-page.js — regression check for ANY recap page / ANY template.
 * Usage: node test/verify-page.js <frame.html> <shell.html> [output.md]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const framePath = process.argv[2];
const shellPath = process.argv[3];
const outMd = process.argv[4];

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }
if (!framePath || !shellPath || !fs.existsSync(framePath) || !fs.existsSync(shellPath)) {
  fail('usage: node test/verify-page.js <frame.html> <shell.html> [output.md]');
}

function chromePath() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  fail('Google Chrome not found; set CHROME_PATH');
}
function lit(s) { return JSON.stringify(s).replace(/<\/script/gi, '<\\/script'); }
function normalize(s) {
  return String(s || '').replace(/[\s*#>\[\]()（）〔〕「」“”‘’.,，。:：;；!！?？、·—|/\\-]/g, '');
}

const frame = fs.readFileSync(framePath, 'utf8');
const shell = fs.readFileSync(shellPath, 'utf8');
const token = /share_token=([A-Za-z0-9_-]+)/.exec(shell);
const share = token ? token[1] : 'shr-test';
const pageUrl = 'https://r.qq.com/wetype/voicerecorder?share_token=' + share;

const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script src="../lib/converter.js"></script>
<script src="../lib/infer.js"></script>
<script src="../lib/adapters.js"></script>
</head><body><pre id="out"></pre><script>
var FIXTURE=${lit(frame)}, SHELL=${lit(shell)};
var doc = new DOMParser().parseFromString(FIXTURE, 'text/html');
var C = window.ArchiverConverter, A = window.ArchiverAdapters;
var url = 'https://r.qq.com/wetype/api/getVoiceRecorderFrame?share_token=${share}';
var ctx = {pageUrl:'${pageUrl}', pageHtml:SHELL, pageTitle:doc.title || '', isFrame:true};
var adapter = A.pick(doc, url, ctx);
var template = adapter.normalize ? adapter.normalize(doc) : 'none';
var normAttr = doc.documentElement.getAttribute('data-archiver-normalized') || 'minimal:{}';
var inferred = JSON.parse(normAttr.slice(normAttr.indexOf(':') + 1) || '{}');
var md = C.toMarkdown(doc, {profile: adapter.profile});
var meta = adapter.meta(doc, Object.assign({}, ctx, {frameUrl:url}));
var payload = JSON.stringify({
  md:md, stats:C.stats(doc), plain:C.plainTextLines(doc),
  adapterId:adapter.id, template:template, inferred:inferred, meta:meta
});
var b=new TextEncoder().encode(payload), bin='';
for(var i=0;i<b.length;i+=8192) bin+=String.fromCharCode.apply(null,b.subarray(i,i+8192));
document.getElementById('out').textContent=btoa(bin);
</script></body></html>`;

const hpath = path.join(__dirname, 'harness-page.html');
fs.writeFileSync(hpath, harness, 'utf8');
const exe = process.env.CHROME_PATH || chromePath();
const args = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--user-data-dir=' + path.join(os.tmpdir(), 'archiver-page-' + Date.now()),
  '--virtual-time-budget=3000', '--dump-dom', 'file:///' + hpath.replace(/\\/g, '/')
];
const out = execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
const m = /<pre id="out">([A-Za-z0-9+/=]+)<\/pre>/.exec(out);
if (!m) fail('Chrome produced no converter output');
const r = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));

const md = r.md;
const M = normalize(md);
const parts = (md.match(/^## \d+\. /gm) || []).length;
const modules = (md.match(/^### /gm) || []).length;
const figures = (md.match(/图解 · /g) || []).length;
const checked = r.plain.filter(function (l) { return normalize(l).length >= 8; });
const miss = checked.filter(function (l) { return M.indexOf(normalize(l)) === -1; });

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!ok) process.exitCode = 1;
}

console.log('=== generic page verification ===');
console.log('  fixture : ' + path.basename(framePath));
console.log('  title   : ' + r.meta.title);
console.log('  adapter : ' + r.adapterId + '   template: ' + r.template);
console.log('  inferred: ' + JSON.stringify(r.inferred));
console.log('');
check('template inferred (not site-hardcoded)', r.template === 'inferred', r.template);
check('chapters: DOM == Markdown', r.stats.sections === parts && parts > 0, r.stats.sections + ' vs ' + parts);
check('modules : DOM == Markdown', r.stats.modules === modules && modules > 0, r.stats.modules + ' vs ' + modules);
check('figures : DOM == Markdown', r.stats.figures === figures && figures > 0, r.stats.figures + ' vs ' + figures);
check('text coverage', miss.length === 0, checked.length + ' checked, ' + miss.length + ' missing');
miss.slice(0, 5).forEach(function (x) { console.log('        MISS: ' + x.slice(0, 100)); });
check('markdown non-trivial', md.length > 3000, md.length + ' chars');

if (outMd) {
  const header = [
    '# ' + r.meta.title, '',
    '> **来源**：' + r.meta.contentType,
    '> **原始链接**：' + r.meta.sourceUrl,
    r.meta.date ? '> **日期**：' + r.meta.date : '',
    '> **归档方式**：纪要一键归档插件 · 结构推断模板 ' + r.template,
    '', '---', ''
  ].filter(function (x) { return x !== undefined; }).join('\n');
  fs.writeFileSync(outMd, header + '\n' + md + '\n', 'utf8');
  console.log('\n  saved  : ' + outMd);
}
console.log('\n' + (process.exitCode ? '*** FAILED ***' : 'OK — this layout is supported without any site-specific code.'));
