/* e2e-headless.js — real Chrome, real MV3 extension, no manual installation.
 *
 * Copies the extension to a temp dir (adding local test origins), loads it via
 * CDP Extensions.loadUnpacked into a throw-away profile, serves a shell + a
 * CROSS-ORIGIN iframe from two local ports, triggers ARCHIVE and inspects the ZIP.
 * This exercises the fallback injection path, shell context forwarding and
 * chrome.downloads.download — things the mocked tests cannot prove.
 *
 * Usage: node test/e2e-headless.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!ok) { failed++; process.exitCode = 1; }
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.n = 0; this.waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m); this.waiting.delete(m.id); }
    };
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Conn(ws);
  }
  send(method, params, sessionId) {
    return new Promise((resolve) => {
      const id = ++this.n;
      this.waiting.set(id, resolve);
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-e2e-'));
  const extDir = path.join(tmp, 'ext');
  const profile = path.join(tmp, 'profile');
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  fs.cpSync(ROOT, extDir, { recursive: true, filter: (p) => !/node_modules|\.workbuddy/.test(p) });
  const mf = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), 'utf8');

  const shellSrv = await startServer((req, res) => res.end());
  const frameSrv = await startServer((req, res) => res.end());

  const shellHtml = `<!DOCTYPE html><html lang="zh-CN"><head><title>E2E 外壳页面</title>
<script>window.__NUXT__={recapTitle:"E2E 归档测试",createTimeMs:1762473600000,coverUrl:"http://127.0.0.1:${shellSrv.port}/cover.png"};</script>
</head><body><p>这里只有外壳，没有正文。</p>
<iframe src="http://127.0.0.1:${frameSrv.port}/frame.html"></iframe></body></html>`;
  const frameHtml = `<!DOCTYPE html><html lang="zh-CN"><head><title>内容框架标题</title>
<meta property="og:image" content="http://127.0.0.1:${shellSrv.port}/cover.png"></head><body>
<h1>E2E 归档测试</h1>
<section class="part"><h2>第一章 结构</h2></section>
<article class="module"><h3>模块一 正文</h3>
<p>这是一段足够长的正文内容，用来证明归档结果确实来自跨域子框架而不是外壳页面。</p>
<p>第二段内容同样需要完整出现在 Markdown 里，不能被降级链路丢掉。</p></article>
<figure data-visual-title="示意图" data-visual-relation="A 到 B"><figcaption>关系图注</figcaption></figure>
</body></html>`;
  shellSrv.server.removeAllListeners('request');
  shellSrv.server.on('request', (req, res) => {
    if (req.url.startsWith('/cover.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(TINY_PNG); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(shellHtml);
  });
  frameSrv.server.removeAllListeners('request');
  frameSrv.server.on('request', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(frameHtml);
  });

  let chrome = null, conn = null;
  try {
    const port = 9400 + Math.floor(Math.random() * 300);
    const exe = process.env.CHROME_PATH ||
      'C:/Program Files/Google/Chrome/Application/chrome.exe';
    chrome = spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
      '--enable-unsafe-extension-debugging', 'about:blank'
    ], { stdio: 'ignore' });

    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); }
      catch (e) { await wait(200); }
    }
    if (!ver) throw new Error('Chrome debugging port did not come up');
    console.log('  Chrome : ' + ver.Browser);
    conn = await Conn.open(ver.webSocketDebuggerUrl);

    const loaded = await conn.send('Extensions.loadUnpacked', { path: extDir });
    if (!loaded.result || !loaded.result.id) throw new Error('loadUnpacked failed: ' + JSON.stringify(loaded));
    const extId = loaded.result.id;
    console.log('  ext id : ' + extId);

    await conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    const t = await conn.send('Target.createTarget', { url: 'http://127.0.0.1:' + shellSrv.port + '/shell.html' });
    const shellTarget = t.result.targetId;
    const at = await conn.send('Target.attachToTarget', { targetId: shellTarget, flatten: true });
    const shellSession = at.result.sessionId;
    for (let i = 0; i < 40; i++) {
      const r = await conn.send('Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true }, shellSession);
      if (r.result && r.result.result && r.result.result.value === 'complete') break;
      await wait(150);
    }

    const p = await conn.send('Target.createTarget',
      { url: 'chrome-extension://' + extId + '/popup.html', background: true });
    const pt = await conn.send('Target.attachToTarget', { targetId: p.result.targetId, flatten: true });
    const popupSession = pt.result.sessionId;
    await conn.send('Target.activateTarget', { targetId: shellTarget });
    await wait(700);

    const expr = `new Promise(function(resolve){
      var timer=setTimeout(function(){resolve({ok:false,error:'service worker timeout'})},30000);
      chrome.runtime.sendMessage({type:'ARCHIVE',options:{}},function(r){
        clearTimeout(timer); resolve(r||{ok:false,error:'no response'});
      });
    })`;
    const msg = await conn.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, popupSession);
    const result = msg.result && msg.result.result && msg.result.result.value;
    console.log('  result : ' + JSON.stringify(result));

    const dlInfo = await conn.send('Runtime.evaluate', {
      expression: `new Promise(function(resolve){
        chrome.downloads.search({orderBy:['-startTime'],limit:5},function(items){
          resolve(items.map(function(i){return {filename:i.filename,state:i.state,error:i.error,bytes:i.bytesReceived};}));
        });
      })`,
      awaitPromise: true, returnByValue: true
    }, popupSession);
    console.log('  downloads.search : ' + JSON.stringify(dlInfo.result && dlInfo.result.result && dlInfo.result.result.value));
    check('ARCHIVE returned ok', !!(result && result.ok), result ? JSON.stringify(result.error) : 'no response');
    if (!result || !result.ok) return;

    // Chrome 156 + CDP setDownloadBehavior may store data: URL downloads under a
    // generic name ("download") without the .zip suffix. Take the single largest
    // file in the test download dir; zipfile checks the magic bytes, not the name.
    let zips = [];
    for (let i = 0; i < 40; i++) {
      zips = fs.readdirSync(dlDir)
        .filter((f) => fs.statSync(path.join(dlDir, f)).isFile())
        .filter((f) => fs.statSync(path.join(dlDir, f)).size > 100);
      if (zips.length) break;
      await wait(200);
    }
    check('ZIP written to download directory', zips.length === 1, zips.join(','));
    if (zips.length !== 1) return;

    const zipPath = path.join(dlDir, zips[0]);
    const py = [
      'import zipfile,sys,json',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'n=z.namelist()',
      'md=[x for x in n if x.endswith(".md")][0]',
      'html=[x for x in n if x.endswith(".html")][0]',
      'meta=json.loads(z.read([x for x in n if x.endswith("_meta.json")][0]).decode("utf-8"))',
      'print(json.dumps({"names":n,"md":z.read(md).decode("utf-8"),"htmlHead":z.read(html).decode("utf-8")[:40],"meta":meta},ensure_ascii=False))'
    ].join(';');
    const parsed = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', py, zipPath],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));

    check('ZIP has 4 artifacts', parsed.names.length === 4, parsed.names.join(' | '));
    check('content came from the cross-origin iframe',
      /这是一段足够长的正文内容/.test(parsed.md) && /第二段内容同样需要/.test(parsed.md));
    check('archived HTML keeps DOCTYPE', /^<!DOCTYPE html>/i.test(parsed.htmlHead), parsed.htmlHead);
    check('shell URL forwarded into frame metadata',
      /127\.0\.0\.1/.test(parsed.meta.sourceUrl || '') && !!parsed.meta.archiveNotes,
      parsed.meta.sourceUrl + ' | notes=' + JSON.stringify(parsed.meta.archiveNotes));
    check('fallback injection actually used',
      (parsed.meta.archiveNotes || []).some((n) => /子框架注入补全/.test(n)),
      JSON.stringify(parsed.meta.archiveNotes));
  } finally {
    if (conn) try { conn.ws.close(); } catch (e) {}
    shellSrv.server.close(); frameSrv.server.close();
    if (chrome && chrome.pid) {
      try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch (e) { try { chrome.kill(); } catch (e2) {} }
    }
    try { if (path.basename(tmp).startsWith('archiver-e2e-')) fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (e) { /* temp dir left behind; harmless */ }
  }
}

main().then(function () {
  console.log('\n' + (failed ? '*** ' + failed + ' E2E CHECK(S) FAILED ***' : 'E2E PASS — real Chrome, real extension, cross-origin iframe fallback'));
}).catch(function (e) {
  console.error('ERROR:', e && e.stack || e);
  process.exit(1);
});
