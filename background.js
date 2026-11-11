/* background.js — MV3 service worker: orchestrate capture, package, download. */
import { makeZip, bytesToBase64, utf8 } from './lib/zip.js';

const INJECT_FILES = ['lib/converter.js', 'lib/infer.js', 'lib/adapters.js', 'capture.js'];

const DEFAULTS = {
  includeHtml: true,
  includeMarkdown: true,
  includeMeta: true,
  includeCover: true,
  includeShell: false,
  packZip: true
};

/* Chrome's GURL cap is ~2 MB. A base64 data: URL therefore tops out around
 * 1.3 MB of binary payload; beyond that downloads.download() fails with a
 * cryptic "Invalid url". Fail early with an actionable message instead. */
const MAX_DATA_URL = 1800000;

function safeName(s) {
  var name = String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = '_' + name;
  return name || 'archived-page';
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function normalize(s) {
  return String(s || '').replace(/[\s*#>\[\]()（）〔〕「」“”‘’.,，。:：;；!！?？、·—|/\\-]/g, '');
}

function coverage(plainLines, md) {
  const M = normalize(md);
  let checked = 0; const missing = [];
  for (const line of (plainLines || [])) {
    const n = normalize(line);
    if (n.length < 8) continue;
    checked++;
    if (M.indexOf(n) === -1) missing.push(line);
  }
  return { checked, missing: missing.length, samples: missing.slice(0, 5) };
}

function markdownHeader(meta, cov) {
  const lines = [
    '# ' + oneLine(meta.title || '未命名'),
    '',
    '> **来源**：' + oneLine(meta.adapterName || '') + (meta.contentType ? ' · ' + oneLine(meta.contentType) : ''),
    '> **原始链接**：' + oneLine(meta.sourceUrl || ''),
    meta.contentFrameUrl ? '> **内容地址**：' + oneLine(meta.contentFrameUrl) : '',
    meta.date ? '> **日期**：' + oneLine(meta.date) : '',
    meta.createdAt ? '> **创建时间**：' + oneLine(meta.createdAt) : '',
    meta.author ? '> **主讲 / 作者**：' + oneLine(meta.author) : '',
    '> **本地归档**：' + new Date().toLocaleString('zh-CN'),
    '',
    meta.lede ? '> ' + oneLine(meta.lede) : '',
    '',
    '---',
    '',
    '## 归档说明',
    '',
    '- 本文件由「纪要一键归档」插件生成，正文来自页面内容文档，未做删节。',
    '- 结构：`' + JSON.stringify(meta.stats || {}) + '`。',
    '- 完整性自检：比对 ' + cov.checked + ' 行原文，缺失 ' + cov.missing + ' 行。',
    '- 图解的视觉排版与交互效果请用同包内的 HTML 原件查看。',
    ''
  ];
  if (meta.archiveNotes && meta.archiveNotes.length) {
    lines.push('> **归档提示**：' + oneLine(meta.archiveNotes.join('；')), '');
  }
  lines.push('---', '');
  return lines.filter(function (x) { return x !== undefined; }).join('\n');
}

async function inject(tabId, frameIds) {
  await chrome.scripting.executeScript({ target: { tabId: tabId, frameIds: frameIds }, files: INJECT_FILES });
}

async function captureTop(tabId) {
  await inject(tabId, [0]);
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId, frameIds: [0] },
    func: function () { return window.__ArchiverCapture.run(); }
  });
  const r = res && res[0] && res[0].result;
  if (!r) throw new Error('页面采集失败：未取到内容（可能是浏览器保留页或没有注入权限）');
  return r;
}

/* Inject frame-by-frame: one unreachable frame must not kill the whole fallback.
 * The top-level shell context is forwarded so iframe metadata stays correct. */
async function captureFrames(tabId, shell) {
  const out = { candidates: [], errors: [] };
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
  } catch (e) {
    out.errors.push('无法枚举子框架：' + String(e && e.message || e));
    return out;
  }
  const ids = (frames || []).filter(function (f) {
    if (!f || f.frameId === 0) return false;
    return !/^(about|data|javascript|chrome|chrome-extension|file):/i.test(f.url || '');
  }).map(function (f) { return f.frameId; });

  for (const id of ids) {
    try {
      await inject(tabId, [id]);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tabId, frameIds: [id] },
        func: function (s) { return window.__ArchiverCapture.frameCapture(s); },
        args: [shell]
      });
      const r = res && res[0] && res[0].result;
      if (r) out.candidates.push(r);
    } catch (e) {
      out.errors.push('子框架 ' + id + '：' + String(e && e.message || e));
    }
  }
  return out;
}

function imageExt(url, type) {
  const m = /^image\/(png|jpeg|webp|gif|bmp|svg\+xml|x-icon)/i.exec(type || '');
  if (m) {
    const t = m[1].toLowerCase();
    return t === 'jpeg' ? 'jpg' : t === 'svg+xml' ? 'svg' : t === 'x-icon' ? 'ico' : t;
  }
  const p = /\.(png|jpe?g|webp|gif|bmp|svg|ico)(?:[?#]|$)/i.exec(String(url || ''));
  if (!p) return 'png';
  const e = p[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

async function tryFetchBinary(url) {
  if (!/^https?:/i.test(String(url || ''))) return null;
  try {
    const opts = {};
    // Service worker: an unreachable image host must not hang the whole archive.
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000);
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    const type = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
    if (type && !/^image\//i.test(type)) return null;   // do not save an HTML error page as .png
    const b = new Uint8Array(await r.arrayBuffer());
    return b.length > 0 && b.length < 8000000 ? { data: b, ext: imageExt(url, type) } : null;
  } catch (e) { return null; }
}

async function downloadBytes(filename, bytes) {
  const url = 'data:application/octet-stream;base64,' + bytesToBase64(bytes);
  if (url.length > MAX_DATA_URL) {
    throw new Error('归档内容 ' + (bytes.length / 1048576).toFixed(1) +
      ' MB，超出 Chrome data: URL 下载上限；请关闭「内容 HTML 原件」或减小页面后重试');
  }
  return chrome.downloads.download({ url: url, filename: filename, saveAs: false, conflictAction: 'uniquify' });
}

async function archive(options) {
  const opt = Object.assign({}, DEFAULTS, options || {});
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) throw new Error('没有可用的活动标签页');
  if (tab.url && !/^https?:/.test(tab.url)) throw new Error('当前页面不是 http(s) 网页，无法注入采集');

  const cap = await captureTop(tab.id);
  let candidates = (cap.candidates || []).slice();
  const notes = [];
  const shell = { pageUrl: cap.pageUrl, pageTitle: cap.pageTitle, pageHtml: cap.pageHtml };
  const goodFrames = candidates.filter(function (c) {
    return c.isFrame && c.markdown && c.markdown.length > 200;
  }).length;
  const needFallback = (cap.failedFrames && cap.failedFrames.length > 0) ||
    ((cap.frameAttempts || 0) > goodFrames);
  let fallbackErrors = [];

  if (needFallback) {
    const fb = await captureFrames(tab.id, shell);
    candidates = candidates.concat(fb.candidates);
    fallbackErrors = fb.errors;
    if (fb.candidates.length) notes.push('已用子框架注入补全内容（' + fb.candidates.length + ' 个）');
    if (fb.errors.length) notes.push('部分子框架无法采集：' + fb.errors.slice(0, 2).join('；'));
  }

  const winner = candidates.sort(function (a, b) { return b.score - a.score; })[0];
  if (!winner || !winner.markdown || winner.markdown.trim().length < 30) {
    throw new Error('未找到可归档的正文：页面可能只有外壳、需要登录，或正文尚未渲染完成。' +
      (fallbackErrors.length ? '（' + fallbackErrors[0] + '）' : ''));
  }

  const cov = coverage(winner.plainLines, winner.markdown);
  const meta = Object.assign({}, winner.meta, {
    completeness: cov,
    shellUrl: cap.pageUrl,
    failedFrames: cap.failedFrames || [],
    fallbackErrors: fallbackErrors,
    extensionVersion: chrome.runtime.getManifest().version
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const base = safeName(oneLine(meta.title));
  const prefix = base + '_' + stamp;
  const entries = [];

  if (opt.includeCover && meta.coverUrl) {
    const img = await tryFetchBinary(meta.coverUrl);
    if (img) entries.push({ name: prefix + '_封面.' + img.ext, data: img.data });
    else notes.push('封面图下载失败（跨域、超时或非图片响应），已跳过');
  }
  meta.archiveNotes = notes.slice();

  if (opt.includeMarkdown) {
    entries.push({ name: prefix + '.md', data: utf8(markdownHeader(meta, cov) + '\n' + winner.markdown + '\n') });
  }
  if (opt.includeHtml) {
    entries.push({ name: prefix + '.html', data: utf8(winner.html) });
  }
  if (opt.includeShell && cap.pageHtml) {
    entries.push({ name: prefix + '_外层页面.html', data: utf8(cap.pageHtml) });
  }
  if (opt.includeMeta) {
    entries.push({ name: prefix + '_meta.json', data: utf8(JSON.stringify(meta, null, 2)) });
  }
  if (!entries.length) throw new Error('没有勾选任何输出内容');

  let files;
  if (opt.packZip) {
    files = [{ name: prefix + '.zip', data: makeZip(entries) }];
  } else {
    files = entries;
  }
  for (const f of files) await downloadBytes(f.name, f.data);

  return {
    title: meta.title,
    adapter: meta.adapterName,
    stats: meta.stats,
    coverage: cov,
    files: files.map(function (f) { return f.name; }),
    entryCount: entries.length,
    bytes: files.reduce(function (a, b) { return a + b.data.length; }, 0),
    notes: notes
  };
}

let archiving = false;
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ARCHIVE') return;
  if (archiving) {
    sendResponse({ ok: false, error: '正在归档中，请等待上一次完成' });
    return true;
  }
  archiving = true;
  function reply(x) { try { sendResponse(x); } catch (e) { /* popup already closed */ } }
  archive(msg.options)
    .then(function (r) { reply({ ok: true, result: r }); },
      function (e) { reply({ ok: false, error: String(e && e.message || e) }); })
    .finally(function () { archiving = false; });
  return true;
});

chrome.runtime.onInstalled.addListener(function () {
  // onInstalled also fires on every update. Never clobber the user's saved options.
  Promise.resolve(chrome.storage.local.get('archiverOptions'))
    .then(function (cur) {
      if (cur && cur.archiverOptions) return;
      return chrome.storage.local.set({ archiverOptions: DEFAULTS });
    })
    .catch(function () { /* storage unavailable: popup still falls back to DEFAULTS */ });
});
