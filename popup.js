'use strict';

const KEYS = ['includeHtml', 'includeMarkdown', 'includeMeta', 'includeCover', 'includeShell', 'packZip'];
const DEFAULTS = {
  includeHtml: true, includeMarkdown: true, includeMeta: true,
  includeCover: true, includeShell: false, packZip: true
};

const $ = function (id) { return document.getElementById(id); };

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind || 'idle');
}

function readOptions() {
  const o = {};
  KEYS.forEach(function (k) { o[k] = $(k).checked; });
  return o;
}

function writeOptions(o) {
  KEYS.forEach(function (k) { $(k).checked = !!o[k]; });
}

function showResult(r) {
  const el = $('result');
  const st = r.stats || {};
  const cov = r.coverage || {};
  const files = Array.isArray(r.files) ? r.files : [];
  const rows = [
    '<div><b>' + escapeHtml(r.title || '') + '</b> · ' + escapeHtml(r.adapter || '') + '</div>',
    '<div>结构：' + (st.sections || 0) + ' 章节 / ' + (st.articles || 0) + ' 模块 / ' + (st.figures || 0) + ' 图解</div>',
    '<div>完整性：比对 ' + (cov.checked || 0) + ' 行，缺失 <b>' + (cov.missing || 0) + '</b> 行</div>',
    '<div>文件：' + files.map(escapeHtml).join('、') + '</div>',
    '<div>共 ' + r.entryCount + ' 个条目 / ' + (r.bytes / 1024).toFixed(1) + ' KB</div>'
  ];
  if (cov.missing && cov.samples && cov.samples.length) {
    rows.push('<div class="warn">缺失示例：' + escapeHtml(cov.samples[0].slice(0, 60)) + '</div>');
  }
  (r.notes || []).forEach(function (n) { rows.push('<div class="warn">' + escapeHtml(n) + '</div>'); });
  el.innerHTML = rows.join('');
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

document.addEventListener('DOMContentLoaded', async function () {
  try {
    const saved = await chrome.storage.local.get('archiverOptions');
    writeOptions(Object.assign({}, DEFAULTS, saved.archiverOptions || {}));
  } catch (e) {
    writeOptions(DEFAULTS);   // storage blocked / unavailable: still usable
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tabs[0] && tabs[0].url) || '';
    $('targetUrl').textContent = url ? new URL(url).hostname + (new URL(url).pathname || '') : '当前活动标签页';
    if (url && !/^https?:/.test(url)) setStatus('当前标签不是普通网页，请切换到分享页。', 'err');
  } catch (e) {
    $('targetUrl').textContent = '无法读取标签页';
  }

  KEYS.forEach(function (k) {
    $(k).addEventListener('change', function () {
      Promise.resolve(chrome.storage.local.set({ archiverOptions: readOptions() })).catch(function () {});
    });
  });

  $('reset').addEventListener('click', function (e) {
    e.preventDefault();
    writeOptions(DEFAULTS);
    Promise.resolve(chrome.storage.local.set({ archiverOptions: DEFAULTS })).catch(function () {});
    setStatus('已恢复默认选项。', 'idle');
  });

  $('go').addEventListener('click', async function () {
    const btn = $('go');
    btn.disabled = true;
    $('result').hidden = true;
    setStatus('正在采集页面、转换并打包…', 'busy');
    try {
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: 'ARCHIVE', options: readOptions() }),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('后台超时（60 秒），请重试或刷新页面')); }, 60000);
        })
      ]);
      if (!resp) throw new Error('后台无响应，请重新打开弹窗');
      if (!resp.ok) throw new Error(resp.error || '未知错误');
      setStatus('归档完成，文件已保存到浏览器下载目录。', 'ok');
      showResult(resp.result);
    } catch (e) {
      setStatus('失败：' + String(e && e.message || e), 'err');
    } finally {
      btn.disabled = false;
    }
  });
});
