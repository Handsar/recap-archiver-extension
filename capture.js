/* capture.js — injected into the page (isolated world).
 * Locates the real content document, serialises the original HTML, converts to Markdown.
 */
(function (root) {
  'use strict';
  var C = root.ArchiverConverter;
  var A = root.ArchiverAdapters;

  /* documentElement.outerHTML does NOT include the DOCTYPE. Saving it as-is puts the
   * archived page into quirks mode and breaks its layout offline. */
  function serializeDoc(doc) {
    var dt = doc.doctype;
    var prefix = '';
    if (dt) {
      prefix = '<!DOCTYPE ' + dt.name;
      if (dt.publicId) prefix += ' PUBLIC "' + dt.publicId + '"';
      if (dt.systemId) prefix += (dt.publicId ? '' : ' SYSTEM') + ' "' + dt.systemId + '"';
      prefix += '>\n';
    }
    return prefix + doc.documentElement.outerHTML;
  }

  /* Response.text() is always UTF-8. Non-UTF-8 (GBK / Big5) pages turn into mojibake. */
  function decodeBody(res, buf) {
    var type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    var m = /charset\s*=\s*["']?([\w-]+)/i.exec(type);
    var charset = (m && !/^utf-?8$/i.test(m[1])) ? m[1] : 'utf-8';
    try { return new TextDecoder(charset).decode(buf); }
    catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }

  function buildCandidate(url, originalHtml, ctx) {
    // Always work on a detached copy: template normalisation must never mutate the live page.
    var work = new DOMParser().parseFromString(originalHtml, 'text/html');
    var adapter = A.pick(work, url, ctx);
    var template = adapter.normalize ? adapter.normalize(work) : 'none';
    var st = C.stats(work);
    var md = C.toMarkdown(work, { profile: adapter.profile });
    var meta = adapter.meta(work, Object.assign({}, ctx, { frameUrl: url }));
    meta.adapterId = adapter.id;
    meta.adapterName = adapter.name;
    meta.profile = adapter.profile;
    meta.template = template;
    meta.stats = st;
    meta.archivedAt = new Date().toISOString();
    var contentScore = (adapter.id !== 'generic' ? 100000 : 0) +
      (ctx.isFrame ? 50000 : 0) + md.length + st.sections * 200 + st.figures * 50;
    return {
      url: url,
      isFrame: !!ctx.isFrame,
      html: originalHtml,
      markdown: md,
      meta: meta,
      stats: st,
      plainLines: C.plainTextLines(work),
      score: contentScore
    };
  }

  function best(cands) {
    return cands.filter(Boolean).sort(function (a, b) { return b.score - a.score; })[0] || null;
  }

  /* Main path: run in the TOP frame, fetch same-origin iframes, parse with DOMParser. */
  async function run() {
    var topHtml = serializeDoc(document);
    var ctx = { pageUrl: location.href, pageHtml: topHtml, pageTitle: document.title, isFrame: false };
    var cands = [buildCandidate(location.href, topHtml, ctx)];
    var failedFrames = [];
    var frameAttempts = 0;

    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var srcdoc = f.getAttribute('srcdoc');
      if (srcdoc) {
        frameAttempts++;
        try {
          var docUrl = new URL('#srcdoc-' + i, location.href).href;
          cands.push(buildCandidate(docUrl, srcdoc, Object.assign({}, ctx, { isFrame: true })));
        } catch (e) {
          failedFrames.push({ src: 'srcdoc', error: String(e && e.message || e) });
        }
        continue;
      }

      var src = f.src || f.getAttribute('src') || '';
      if (!src || src.charAt(0) === '#') continue;
      var abs;
      try { abs = new URL(src, location.href).href; } catch (e) { continue; }
      // about: / data: / javascript: / chrome: frames cannot be fetched. Skip them
      // instead of generating a bogus failure that forces a pointless frame injection.
      if (!/^https?:/i.test(abs)) continue;

      frameAttempts++;
      try {
        var res = await fetch(abs, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var html = (typeof res.arrayBuffer === 'function')
          ? decodeBody(res, await res.arrayBuffer())
          : await res.text();
        if (!html || !/<html|<!doctype/i.test(html)) throw new Error('响应不是 HTML（可能是登录页或接口错误）');
        cands.push(buildCandidate(abs, html, Object.assign({}, ctx, { isFrame: true })));
      } catch (e) {
        failedFrames.push({ src: abs, error: String(e && e.message || e) });
      }
    }
    return {
      candidates: cands,
      best: best(cands),
      failedFrames: failedFrames,
      frameAttempts: frameAttempts,
      pageHtml: topHtml,
      pageUrl: location.href,
      pageTitle: document.title
    };
  }

  /* Fallback path: run inside EACH frame (used when cross-origin iframe fetch failed).
   * `shell` carries the top-level page context, otherwise title / date / cover URL /
   * original share link are all lost when the real content lives in an iframe. */
  function frameCapture(shell) {
    var html = serializeDoc(document);
    var hasShell = !!(shell && shell.pageUrl && shell.pageUrl !== location.href);
    var ctx = {
      pageUrl: hasShell ? shell.pageUrl : location.href,
      pageHtml: hasShell ? (shell.pageHtml || html) : html,
      pageTitle: hasShell ? (shell.pageTitle || document.title) : document.title,
      isFrame: window.top !== window.self
    };
    return buildCandidate(location.href, html, ctx);
  }

  root.__ArchiverCapture = {
    run: run,
    frameCapture: frameCapture,
    best: best,
    serializeDoc: serializeDoc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
