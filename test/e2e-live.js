/* e2e-live.js — drive the INSTALLED extension inside a real Chrome via CDP.
 * Requires a Chrome instance with --remote-debugging-port and the extension loaded.
 * Usage: node test/e2e-live.js [port] [shareUrl] [extensionId]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.argv[2] || '9333';
// No real credentials are stored in this repository.
function resolveShare() {
  if (process.argv[3]) return process.argv[3].trim();
  if (process.env.SHARE_URL) return process.env.SHARE_URL.trim();
  try { return fs.readFileSync(path.join(__dirname, '.local-share-url'), 'utf8').trim(); } catch (e) { return ''; }
}
const SHARE = resolveShare();
const EXT = process.argv[4] || process.env.EXT_ID || '';
const BASE = 'http://127.0.0.1:' + PORT;

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!SHARE || !EXT) {
    console.error('缺少分享链接或扩展 ID。用法：node test/e2e-live.js [port] [shareUrl] [extensionId]，'
      + '或设置 SHARE_URL / EXT_ID 环境变量。');
    process.exit(1);
  }
  const ver = await (await fetch(BASE + '/json/version')).json();
  const c = await Conn.open(ver.webSocketDebuggerUrl);
  console.log('Chrome:', ver.Browser);
  const DL = path.join(__dirname, '_downloads');
  fs.mkdirSync(DL, { recursive: true });
  await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  const before = listZips(DL);
  const a = await c.send('Target.createTarget', { url: SHARE });
  const targetA = a.result.targetId;
  const at = await c.send('Target.attachToTarget', { targetId: targetA, flatten: true });
  const sessA = at.result.sessionId;
  console.log('opened share page:', targetA);

  let title = '';
  for (let i = 0; i < 25; i++) {
    await wait(600);
    const r = await c.send('Runtime.evaluate', { expression: 'document.title + "|" + document.readyState', returnByValue: true }, sessA);
    const v = r.result && r.result.result && r.result.result.value;
    if (v) { title = v; if (v.indexOf('|complete') !== -1 && v.length > 12) break; }
  }
  console.log('page state:', title);

  const popupUrl = 'chrome-extension://' + EXT + '/popup.html';
  const b = await c.send('Target.createTarget', { url: popupUrl, background: true });
  const bt = await c.send('Target.attachToTarget', { targetId: b.result.targetId, flatten: true });
  const sessB = bt.result.sessionId;
  await wait(800);

  const expr = `new Promise(function(resolve){
    var timer=setTimeout(function(){resolve({ok:false,error:'service worker timeout'})},25000);
    chrome.runtime.sendMessage({type:'ARCHIVE',options:{}}, function(r){
      clearTimeout(timer); resolve(r||{ok:false,error:'no response'});
    });
  })`;
  const msg = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessB);
  const result = msg.result && msg.result.result && msg.result.result.value;
  console.log('\nARCHIVE RESPONSE:', JSON.stringify(result, null, 2));

  await wait(2500);
  const after = listZips(DL);
  const fresh = after.filter((x) => !before.some((b) => b.name === x.name));
  console.log('\nNEW DOWNLOADS:', fresh.length ? fresh.map((x) => x.name + ' (' + x.size + ' B)').join(', ') : '(none)');

  const ok = result && result.ok && result.result && result.result.coverage && result.result.coverage.missing === 0;
  console.log('\n' + (ok ? 'E2E PASS — real Chrome, real extension, real page' : 'E2E INCOMPLETE — see response above'));
  if (!ok) process.exitCode = 1;
  c.ws.close();

  function listZips(dir) {
    try {
      return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip'))
        .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
    } catch (e) { return []; }
  }
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
