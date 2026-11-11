/* e2e-share.js — real Chrome + real MV3 extension + REAL share page, no manual install.
 *
 * Starts a throw-away Chrome profile, loads the extension via CDP
 * Extensions.loadUnpacked (session-scoped, never touches the daily profile),
 * opens a live share URL, triggers ARCHIVE from the popup and inspects the ZIP.
 *
 * This is the closest thing to clicking the toolbar button on a real page.
 * Usage: node test/e2e-share.js [shareUrl] [extensionDir]
 * extensionDir defaults to this repo; pass an unpacked distribution dir to
 * verify the shipped ZIP really is loadable.
 *
 * No real share_token is stored in this repository. Supply one of:
 *   1. positional argument, e.g. node test/e2e-share.js "https://r.qq.com/...?share_token=shr-..."
 *   2. SHARE_URL environment variable
 *   3. test/.local-share-url (git-ignored, local machine only)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_SHARE_FILE = path.join(__dirname, '.local-share-url');
function resolveShare() {
  if (process.argv[2]) return process.argv[2].trim();
  if (process.env.SHARE_URL) return process.env.SHARE_URL.trim();
  try { return fs.readFileSync(LOCAL_SHARE_FILE, 'utf8').trim(); } catch (e) { return ''; }
}
const SHARE = resolveShare();
const EXT_DIR = process.argv[3] ? path.resolve(process.argv[3]) : ROOT;
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

async function main() {
  if (!SHARE) {
    console.error('缺少分享链接。请传第一个参数、设置 SHARE_URL 环境变量，或创建 test/.local-share-url（已被 .gitignore 忽略）。');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-share-'));
  const profile = path.join(tmp, 'profile');
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  let chrome = null, conn = null;

  try {
    // port 0 = let Chrome pick a free port and write it to DevToolsActivePort;
    // a hardcoded random port can collide with a leftover Chrome instance and
    // make CDP silently attach to the wrong browser.
    const exe = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    chrome = spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', '--user-data-dir=' + profile,
      '--enable-unsafe-extension-debugging', '--window-size=1280,900', 'about:blank'
    ], { stdio: 'ignore' });

    let port = 0;
    for (let i = 0; i < 60 && !port; i++) {
      try { port = parseInt(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], 10); }
      catch (e) { await wait(200); }
    }
    if (!port) throw new Error('Chrome did not write DevToolsActivePort');
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); }
      catch (e) { await wait(200); }
    }
    if (!ver) throw new Error('Chrome debugging port did not come up');
    console.log('  Chrome : ' + ver.Browser);
    conn = await Conn.open(ver.webSocketDebuggerUrl);

    console.log('  ext dir: ' + EXT_DIR);
    const loaded = await conn.send('Extensions.loadUnpacked', { path: EXT_DIR });
    if (!loaded.result || !loaded.result.id) throw new Error('loadUnpacked failed: ' + JSON.stringify(loaded));
    const extId = loaded.result.id;
    console.log('  ext id : ' + extId);
    console.log('  share  : ' + SHARE.slice(0, 72) + '...');

    await conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    const t = await conn.send('Target.createTarget', { url: SHARE });
    const target = t.result.targetId;
    const at = await conn.send('Target.attachToTarget', { targetId: target, flatten: true });
    const sess = at.result.sessionId;

    // The body lives in a sandboxed same-origin iframe loaded from an API.
    // Wait for that frame to appear in the frame tree, then let it render.
    // The body lives in a sandboxed same-origin iframe loaded from an API.
    // CDP's frame tree does not list sandboxed OOPIFs on this session, so probe
    // the DOM instead; the ARCHIVE coverage check below proves the content was read.
    let frameUrl = '';
    for (let i = 0; i < 60; i++) {
      const st = await conn.send('Runtime.evaluate', {
        expression: '(function(){var f=document.querySelector("iframe.voiceRecorderFrame");return JSON.stringify({ready:document.readyState,title:document.title,src:f?(f.src||f.getAttribute("srcdoc")||""):""});})()',
        returnByValue: true
      }, sess);
      const v = JSON.parse((st.result && st.result.result && st.result.result.value) || '{}');
      if (/getVoiceRecorderFrame/i.test(v.src || '')) { frameUrl = v.src; break; }
      await wait(500);
    }
    check('share page exposed its content iframe', !!frameUrl, frameUrl.slice(0, 100));
    if (!frameUrl) return;
    await wait(5000); // allow the sandboxed iframe to finish rendering its content

    const p = await conn.send('Target.createTarget',
      { url: 'chrome-extension://' + extId + '/popup.html', background: true });
    const pt = await conn.send('Target.attachToTarget', { targetId: p.result.targetId, flatten: true });
    const popupSession = pt.result.sessionId;
    await conn.send('Target.activateTarget', { targetId: target });
    await wait(800);

    const expr = `new Promise(function(resolve){
      var timer=setTimeout(function(){resolve({ok:false,error:'service worker timeout'})},60000);
      chrome.runtime.sendMessage({type:'ARCHIVE',options:{}},function(r){
        clearTimeout(timer); resolve(r||{ok:false,error:'no response'});
      });
    })`;
    const msg = await conn.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, popupSession);
    const result = msg.result && msg.result.result && msg.result.result.value;
    console.log('  result : ' + JSON.stringify(result));
    check('ARCHIVE returned ok', !!(result && result.ok), result ? JSON.stringify(result.error) : 'no response');
    if (!result || !result.ok) return;

    const r = result.result || {};
    check('completeness self-check = 0 missing',
      !!(r.coverage && r.coverage.missing === 0 && r.coverage.checked > 50),
      JSON.stringify(r.coverage));
    check('site adapter identified the share page',
      /录音笔|wetype|voice/i.test(r.adapter || ''), 'adapter=' + r.adapter);

    // Chrome 156 + CDP may store data: URL downloads as a plain "download" file.
    let files = [];
    for (let i = 0; i < 50; i++) {
      files = fs.readdirSync(dlDir)
        .filter((f) => fs.statSync(path.join(dlDir, f)).isFile())
        .filter((f) => fs.statSync(path.join(dlDir, f)).size > 1000);
      if (files.length) break;
      await wait(300);
    }
    check('ZIP written to download directory', files.length === 1, files.join(',') || '(none)');
    if (files.length !== 1) return;

    const zipPath = path.join(dlDir, files[0]);
    const py = [
      'import zipfile,sys,json',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'n=z.namelist()',
      'md=z.read([x for x in n if x.endswith(".md")][0]).decode("utf-8")',
      'html=z.read([x for x in n if x.endswith(".html")][0]).decode("utf-8")',
      'meta=json.loads(z.read([x for x in n if x.endswith("_meta.json")][0]).decode("utf-8"))',
      'print(json.dumps({"names":n,"mdLen":len(md),"mdHead":md[:120],"htmlHead":html[:40],"meta":meta,"bytes":__import__("os").path.getsize(sys.argv[1])},ensure_ascii=False))'
    ].join(';');
    const parsed = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', py, zipPath],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

    console.log('  ZIP     : ' + parsed.bytes + ' B | ' + parsed.names.join(' | '));
    check('ZIP has 4 artifacts', parsed.names.length === 4, parsed.names.join(' | '));
    check('Markdown has real content', parsed.mdLen > 3000, parsed.mdLen + ' chars');
    check('archived HTML keeps DOCTYPE', /^<!DOCTYPE html>|^<!doctype html>/i.test(parsed.htmlHead), parsed.htmlHead);
    check('meta.json records the live share URL',
      /r\.qq\.com/.test(JSON.stringify(parsed.meta.sourceUrl || '')), JSON.stringify(parsed.meta.sourceUrl));
    check('meta.json records extension version 1.0.1',
      parsed.meta.extensionVersion === '1.0.1', JSON.stringify(parsed.meta.extensionVersion));
    if (parsed.meta.completeness) {
      check('meta.json completeness.missing = 0', parsed.meta.completeness.missing === 0,
        JSON.stringify(parsed.meta.completeness));
    }
    console.log('  notes   : ' + JSON.stringify(parsed.meta.archiveNotes || r.notes || []));
  } finally {
    if (conn) try { conn.ws.close(); } catch (e) {}
    if (chrome && chrome.pid) {
      try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch (e) { try { chrome.kill(); } catch (e2) {} }
    }
    try { if (path.basename(tmp).startsWith('archiver-share-')) fs.rmSync(tmp, { recursive: true, force: true }); }
    catch (e) { /* temp dir left behind; harmless */ }
  }
}

main().then(function () {
  console.log('\n' + (failed ? '*** ' + failed + ' SHARE CHECK(S) FAILED ***'
    : 'E2E PASS — real Chrome, real extension, real share page'));
}).catch(function (e) {
  console.error('ERROR:', e && e.stack || e);
  process.exit(1);
});
