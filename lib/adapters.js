/* adapters.js — site detection + metadata + optional fine-tuning.
 * Generic structure recognition lives in infer.js; an adapter only needs to supply
 * identity, metadata and (optionally) small site-specific tweaks.
 */
(function (root) {
  'use strict';
  var C = root.ArchiverConverter;

  function metaTag(doc, key) {
    var m = doc.querySelector('meta[property="' + key + '"], meta[name="' + key + '"]');
    return m ? (m.getAttribute('content') || '') : '';
  }
  function firstText(doc, sel) {
    var e = doc.querySelector(sel);
    return e ? C.clean(C.text(e)) : '';
  }

  /* Nuxt/SSR payloads escape slashes and non-ASCII as \uXXXX. Using such a string
   * verbatim yields a broken cover URL and garbled titles. */
  function unescapeJs(s) {
    return String(s || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/\\\//g, '/')
      .replace(/\\n/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /* Runs on a detached copy of the document, never on the live page. */
  function normalize(doc) {
    if (!doc || !doc.documentElement) return 'none';
    var rootEl = doc.documentElement;
    var done = rootEl.getAttribute('data-archiver-normalized');
    if (done) return done;
    var I = root.ArchiverInfer;
    var stat = I ? I.infer(doc) : { parts: 0, modules: 0, figures: 0, steps: 0, cards: 0 };

    // Site-level tweaks only. Structure is NOT described here.
    Array.prototype.slice.call(doc.querySelectorAll('.chip.mini')).forEach(function (el) {
      el.classList.remove('chip');           // keep inline chips inside their sentence
    });
    var hasParts = stat.parts > 0 || doc.querySelectorAll('.part').length > 0;
    var hasModules = stat.modules > 0 || doc.querySelectorAll('.module').length > 0;
    var tpl = (hasParts && hasModules) ? 'inferred' : 'minimal';
    rootEl.setAttribute('data-archiver-normalized', tpl + ':' + JSON.stringify(stat));
    return tpl;
  }

  var ADAPTERS = [
    {
      id: 'wetype-voicerecorder',
      name: '微信输入法 · AI 录音笔',
      score: 100,
      profile: 'recap',
      normalize: normalize,
      matchUrl: /r\.qq\.com\/wetype\/voicerecorder|getVoiceRecorderFrame/i,
      isContentFrame: function (url, doc) {
        return /getVoiceRecorderFrame/i.test(url) ||
          (doc.documentElement && doc.documentElement.getAttribute('data-recap-state') === 'ok');
      },
      matchDoc: function (doc) {
        return !!doc.querySelector('figure[data-visual-title]') ||
          !!doc.querySelector('.part') || !!doc.querySelector('section.card');
      },
      meta: function (doc, ctx) {
        var pageHtml = ctx.pageHtml || '';
        var ms = /createTimeMs:"?(\d{10,})"?/.exec(pageHtml);
        var cover = /coverUrl:"([^"]+)"/.exec(pageHtml);
        var apiTitle = /recapTitle:"([^"]+)"/.exec(pageHtml);
        var created = ms ? new Date(Number(ms[1])).toISOString() : '';
        var chips = Array.prototype.slice.call(doc.querySelectorAll('.chip, .meta .chip')).map(function (x) { return C.clean(C.text(x)); });
        return {
          title: (apiTitle ? unescapeJs(apiTitle[1]) : '') || firstText(doc, 'h1') || ctx.pageTitle || '未命名纪要',
          eyebrow: firstText(doc, '.eyebrow') || firstText(doc, '.kicker'),
          lede: firstText(doc, '.lede') || firstText(doc, '.hero p'),
          author: chips[0] || '',
          keywords: chips.slice(1),
          date: created ? created.slice(0, 10) : '',
          createdAt: created,
          createTimeMs: ms ? Number(ms[1]) : null,
          coverUrl: cover ? unescapeJs(cover[1]) : '',
          contentType: 'AI 录音笔智能转写 · 图文纪要（非逐字稿）',
          sourceUrl: ctx.pageUrl || '',
          contentFrameUrl: ctx.frameUrl || ''
        };
      }
    },
    {
      id: 'generic',
      name: '通用网页',
      score: 0,
      profile: 'generic',
      normalize: normalize,
      matchUrl: /.*/,
      isContentFrame: function () { return false; },
      matchDoc: function () { return true; },
      meta: function (doc, ctx) {
        return {
          title: metaTag(doc, 'og:title') || ctx.pageTitle || firstText(doc, 'h1') || '未命名页面',
          eyebrow: '',
          lede: metaTag(doc, 'description') || metaTag(doc, 'og:description') || '',
          author: metaTag(doc, 'author'),
          keywords: [],
          date: metaTag(doc, 'article:published_time') || '',
          createdAt: '',
          createTimeMs: null,
          coverUrl: metaTag(doc, 'og:image'),
          contentType: '通用网页正文',
          sourceUrl: ctx.pageUrl || '',
          contentFrameUrl: ctx.frameUrl || ''
        };
      }
    }
  ];

  function pick(doc, url, ctx) {
    var best = ADAPTERS[ADAPTERS.length - 1], bestScore = -1;
    for (var i = 0; i < ADAPTERS.length; i++) {
      var a = ADAPTERS[i];
      var urlHit = !!(a.matchUrl && a.matchUrl.test(url));
      var frameHit = !!(a.matchFrame && a.matchFrame.test(url));
      var docHit = !!(a.matchDoc && a.matchDoc(doc));
      var contentHit = !!(a.isContentFrame && a.isContentFrame(url, doc));
      /* A site adapter has a high base score. Without this guard it beats the
       * generic adapter on EVERY page, even on an unrelated domain whose only
       * "evidence" is a CSS class. Require a site-level signal (URL / frame /
       * content marker) before considering a site-specific adapter. */
      if (a.id !== 'generic' && !(urlHit || frameHit || contentHit)) continue;
      var s = (a.score || 0) + (urlHit ? 30 : 0) + (frameHit ? 30 : 0) +
        (docHit ? 40 : 0) + (contentHit ? 20 : 0);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  root.ArchiverAdapters = { list: ADAPTERS, pick: pick, metaTag: metaTag, normalize: normalize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
