/* converter.js — DOM -> Markdown, zero dependencies.
 * Runs in a browser page (isolated world), an offscreen document, or Node via UMD.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArchiverConverter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SKIP = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
  var T = { ELEMENT: 1, TEXT: 3 };

  function kids(n) { return Array.prototype.slice.call(n.childNodes || []); }
  function tag(n) { return (n.tagName || '').toUpperCase(); }
  function cls(n) {
    var c = n.getAttribute ? (n.getAttribute('class') || '') : '';
    return new Set(c.split(/\s+/).filter(Boolean));
  }
  function attr(n, k) { return n.getAttribute ? (n.getAttribute(k) || '') : ''; }
  function isEl(n) { return !!n && n.nodeType === T.ELEMENT; }
  /* data-ax is written by infer.js (structure-based); class names are a fallback. */
  function role(n, r) {
    if (!n || !n.getAttribute) return false;
    return n.getAttribute('data-ax') === r || cls(n).has(r);
  }

  function text(n) {
    if (!n) return '';
    if (n.nodeType === T.TEXT) return n.nodeValue || '';
    if (n.nodeType !== T.ELEMENT) return '';
    var s = '';
    for (var i = 0; i < (n.childNodes || []).length; i++) s += text(n.childNodes[i]);
    return s;
  }

  function find(n, pred) {
    if (!isEl(n)) return null;
    var ch = kids(n), i;
    for (i = 0; i < ch.length; i++) if (isEl(ch[i]) && pred(ch[i])) return ch[i];
    for (i = 0; i < ch.length; i++) {
      var r = find(ch[i], pred);
      if (r) return r;
    }
    return null;
  }

  function findAll(n, pred, out) {
    out = out || [];
    if (!isEl(n)) return out;
    var ch = kids(n);
    for (var i = 0; i < ch.length; i++) {
      if (isEl(ch[i])) {
        if (pred(ch[i])) out.push(ch[i]);
        findAll(ch[i], pred, out);
      }
    }
    return out;
  }

  function inline(n, skip) {
    if (!n) return '';
    if (n.nodeType === T.TEXT) return n.nodeValue || '';
    if (!isEl(n)) return '';
    if (skip && skip.has(n)) return '';
    var t = tag(n), c = cls(n);
    if (SKIP.has(t)) return '';
    if (t === 'BR') return ' ';
    var s = '';
    for (var i = 0; i < (n.childNodes || []).length; i++) s += inline(n.childNodes[i], skip);
    if (t === 'B' || t === 'STRONG' || c.has('hl') || c.has('rh')) return '**' + s.trim() + '**';
    if (t === 'EM' || t === 'I' || c.has('dim')) return '*' + s.trim() + '*';
    if (c.has('n') && t === 'SPAN') return s.trim() + '. ';
    if (t === 'CODE' && !c.has('hl')) return '`' + s.trim() + '`';
    if (t === 'A') {
      var href = attr(n, 'href');
      if (href && href.charAt(0) !== '#') return '[' + s.trim() + '](' + href + ')';
    }
    return s;
  }

  function clean(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\*\*\*\*/g, '').replace(/\*\*\s*\*\*/g, '');
    return s;
  }

  function svgTexts(n, acc) {
    var ch = kids(n);
    for (var i = 0; i < ch.length; i++) {
      var x = ch[i];
      if (x.nodeType === T.TEXT) { if (x.nodeValue && x.nodeValue.trim()) acc.push(x.nodeValue.trim()); }
      else svgTexts(x, acc);
    }
  }

  function listItem(n, headPred, prefix) {
    // An emphasised <b> inside a list item is part of the sentence, not a card title.
    var h = find(n, function (x) {
      return headPred(x) && !(x.closest && x.closest('li'));
    });
    if (!h) return '\n- ' + clean(inline(n)) + '\n';
    var ht = clean(text(h));
    var body = clean(inline(n, new Set([h])));
    return '\n' + (prefix || '- ') + (ht ? '**' + ht + '**' : '') + (body ? '：' + body : '') + '\n';
  }

  function render(n, ctx) {
    if (!n || n.nodeType === T.TEXT) return '';
    if (!isEl(n)) return '';
    var t = tag(n), c = cls(n), i, ch = kids(n);
    if (SKIP.has(t)) return '';

    if (t === 'SVG') {
      var acc = []; svgTexts(n, acc);
      return acc.length ? '\n\n（图解内文字：' + acc.join(' / ') + '）\n\n' : '';
    }
    if (t === 'BR') return '\n';
    if (t === 'BUTTON') return '\n\n〔交互按钮：' + clean(text(n)) + '〕\n\n';
    if (t === 'IMG') {
      var src = attr(n, 'src');
      return src ? '\n\n![' + clean(attr(n, 'alt') || '图片') + '](' + src + ')\n\n' : '';
    }

    var out = '';
    var recap = ctx.profile !== 'generic';

    /* ---- recap profile: structured long-form document ---- */
    if (recap && role(n, 'part') && /^(SECTION|DIV|HEADER|ARTICLE)$/.test(t)) {
      var ph = find(n, function (x) { return cls(x).has('part-head'); }) || n;
      var noEl = find(ph, function (x) { return role(x, 'part-no'); });
      var h2El = find(ph, function (x) { return tag(x) === 'H2' || role(x, 'part-title'); });
      var subEl = find(ph, function (x) { return role(x, 'part-sub'); });
      var no = noEl ? clean(text(noEl)).replace(/^PART\s*/i, '') : '';
      var h2 = h2El ? clean(text(h2El)) : '';
      var sub = subEl ? clean(text(subEl)) : '';
      out = '\n\n---\n\n## ' + (no ? no + '. ' : '') + h2 + '\n\n';
      if (sub) out += '*' + sub + '*\n\n';
      var used = new Set();
      if (ph !== n) used.add(ph);
      [noEl, h2El, subEl].forEach(function (e) { if (e) used.add(e); });
      for (i = 0; i < ch.length; i++) {
        if (isEl(ch[i]) && !used.has(ch[i])) out += render(ch[i], ctx);
      }
      return out;
    }
    if (recap && role(n, 'module') && /^(ARTICLE|SECTION|DIV)$/.test(t)) {
      var mt = find(n, function (x) { return cls(x).has('mod-top'); });
      var scope = mt || n;
      var tagEl = mt ? find(mt, function (x) { return cls(x).has('tag'); }) : null;
      var h3El = find(scope, function (x) { return tag(x) === 'H3' || role(x, 'module-title'); });
      var tg = tagEl ? clean(text(tagEl)) : '';
      var h3 = h3El ? clean(text(h3El)) : '';
      out = '\n\n### ' + (tg ? '〔' + tg + '〕' : '') + h3 + '\n\n';
      var used2 = new Set();
      if (mt) used2.add(mt);
      if (h3El) used2.add(h3El);
      for (i = 0; i < ch.length; i++) {
        if (isEl(ch[i]) && !used2.has(ch[i])) out += render(ch[i], ctx);
      }
      return out;
    }
    if (recap && t === 'FIGURE') {
      var title = attr(n, 'data-visual-title'), type = attr(n, 'data-visual-type');
      var rel = attr(n, 'data-visual-relation'), srcQ = attr(n, 'data-visual-source');
      if (title || rel || srcQ) {
        out = '\n\n> **图解 · ' + title + '**' + (type ? '（' + type + '）' : '') + '\n>\n';
        if (rel) out += '> 关系：' + rel + '\n>\n';
        if (srcQ) out += '> 直播原话：' + srcQ + '\n';
        out += '\n';
      }
    } else {
      out = '';
    }

    /* ---- headings & blocks ---- */
    if (/^H[1-6]$/.test(t)) {
      var lvl = Math.min(6, parseInt(t.charAt(1), 10) + (ctx.headingOffset || 0));
      return '\n\n' + new Array(lvl + 1).join('#') + ' ' + clean(inline(n)) + '\n\n';
    }
    if (t === 'P') return '\n\n' + clean(inline(n)) + '\n\n';
    if (t === 'BLOCKQUOTE') {
      var lines = [];
      for (i = 0; i < ch.length; i++) {
        if (isEl(ch[i]) && (tag(ch[i]) === 'P' || tag(ch[i]) === 'CITE')) lines.push('> ' + clean(inline(ch[i])));
      }
      if (!lines.length) lines.push('> ' + clean(inline(n)));
      return '\n\n' + lines.join('\n>\n') + '\n\n';
    }
    if (t === 'CITE') return '\n\n> ' + clean(inline(n)) + '\n\n';
    if (t === 'FIGCAPTION') return '\n\n*' + clean(inline(n)) + '*\n\n';
    if (t === 'PRE') return '\n\n```\n' + (text(n) || '').trim() + '\n```\n\n';
    if (c.has('chip')) return '\n- ' + clean(inline(n)) + '\n';
    if (c.has('part-head') || c.has('mod-top')) return out;
    if (c.has('toc')) {
      var items = [];
      for (i = 0; i < ch.length; i++) if (isEl(ch[i]) && tag(ch[i]) === 'A') items.push(clean(text(ch[i])));
      return '\n\n**本页导览**：' + items.join(' · ') + '\n\n';
    }

    /* ---- composite visual cards -> list items ---- */
    if (recap && role(n, 'step')) {
      var num = find(n, function (x) { return role(x, 'step-no') || (cls(x).has('n') && tag(x) === 'SPAN'); });
      var ttl = find(n, function (x) { return tag(x) === 'B' || cls(x).has('iname') || role(x, 'card-title'); });
      var sk = new Set(); if (num) sk.add(num); if (ttl) sk.add(ttl);
      var body = clean(inline(n, sk));
      if (!ttl) {
        var rest = clean(inline(n, num ? new Set([num]) : null));
        return '\n' + (num ? clean(text(num)) + '. ' : '- ') + rest + '\n';
      }
      return '\n' + (num ? clean(text(num)) : '') + '. **' + clean(text(ttl)) + '**' + (body ? '：' + body : '') + '\n';
    }
    if (recap && (c.has('tnode') || c.has('panel') || c.has('cp-row') || c.has('age'))) {
      return listItem(n, function (x) { return tag(x) === 'B' || tag(x) === 'H4'; });
    }
    if (recap && role(n, 'card')) {
      return listItem(n, function (x) { return role(x, 'card-title'); });
    }
    if (recap && c.has('tbar')) {
      var lab = find(n, function (x) { return tag(x) === 'SPAN'; });
      var val = find(n, function (x) { return tag(x) === 'EM'; });
      return '\n- ' + (lab ? clean(text(lab)) : '') + '：' + (val ? clean(text(val)) : '') + '\n';
    }
    if (recap && c.has('kv')) {
      var r = '';
      for (i = 0; i < ch.length; i++) {
        var d = ch[i];
        if (!isEl(d) || tag(d) !== 'DIV') continue;
        var h = find(d, function (x) { return tag(x) === 'B'; });
        r += h ? '\n- **' + clean(text(h)) + '**：' + clean(inline(d, new Set([h]))) + '\n'
               : '\n- ' + clean(inline(d)) + '\n';
      }
      return out + r;
    }
    if (recap && n.parentElement && cls(n.parentElement).has('kv') && t === 'DIV') {
      return listItem(n, function (x) { return tag(x) === 'B'; });
    }

    /* ---- generic HTML ---- */
    if (t === 'TABLE') {
      var rows = findAll(n, function (x) { return tag(x) === 'TR'; });
      var tbl = '\n\n';
      for (i = 0; i < rows.length; i++) {
        var cells = kids(rows[i]).filter(isEl);
        var line = '| ' + cells.map(function (x) { return clean(text(x)).replace(/\|/g, '\\|'); }).join(' | ') + ' |';
        tbl += line + '\n';
        if (i === 0) tbl += '| ' + cells.map(function () { return '---'; }).join(' | ') + ' |\n';
      }
      return tbl + '\n';
    }
    if (t === 'LI') {
      var p = n.parentElement, ordered = p && tag(p) === 'OL';
      var idx = ordered ? kids(p).filter(function (x) { return isEl(x) && tag(x) === 'LI'; }).indexOf(n) + 1 : 0;
      return '\n' + (ordered ? idx + '. ' : '- ') + clean(inline(n)) + '\n';
    }

    /* ---- generic container: preserve child order ---- */
    var parts = [];
    for (i = 0; i < ch.length; i++) {
      var x = ch[i];
      if (x.nodeType === T.TEXT) { if (x.nodeValue && x.nodeValue.trim()) parts.push(clean(x.nodeValue)); }
      else parts.push(render(x, ctx));
    }
    var body2 = parts.join('');
    return out + (body2.trim() ? '\n\n' + body2 + '\n\n' : '');
  }

  function finalize(md) {
    md = String(md || '');
    md = md.replace(/[ \t]+\n/g, '\n');
    md = md.replace(/\n{3,}/g, '\n\n');
    md = md.replace(/^ +| +$/gm, '');
    md = md.replace(/\*\s+\*\*/g, '**');
    return md.trim();
  }

  function toMarkdown(root, options) {
    options = options || {};
    var ctx = { profile: options.profile || 'recap', headingOffset: options.headingOffset || 0 };
    var body = (root.body) || (root.documentElement) || root;
    var md = '';
    var ch = kids(body);
    for (var i = 0; i < ch.length; i++) md += render(ch[i], ctx);
    return finalize(md);
  }

  function stats(root) {
    var body = (root.body) || (root.documentElement) || root;
    var parts = findAll(body, function (x) { return role(x, 'part'); }).length;
    var mods = findAll(body, function (x) { return role(x, 'module'); }).length;
    return {
      sections: parts,
      articles: mods,
      modules: mods,
      figures: findAll(body, function (x) { return tag(x) === 'FIGURE' && attr(x, 'data-visual-title'); }).length,
      svg: findAll(body, function (x) { return tag(x) === 'SVG'; }).length,
      headings: findAll(body, function (x) { return /^H[1-6]$/.test(tag(x)); }).length
    };
  }

  /* Smallest text blocks only. Composite containers are skipped: their text is a
   * concatenation of children that the Markdown output deliberately splits into
   * separate lines, so comparing a whole container would produce false "missing" hits.
   */
  function plainTextLines(root) {
    var body = (root.body) || (root.documentElement) || root;
    var out = [], seen = new Set();
    var BLOCKISH = /^(P|DIV|SECTION|ARTICLE|FIGURE|UL|OL|LI|H[1-6]|BLOCKQUOTE|TABLE|PRE|FIGURE|FIGCAPTION)$/;
    function walk(n) {
      if (!isEl(n)) return;
      var t = tag(n);
      if (SKIP.has(t) || t === 'SVG' || t === 'IMG') return;
      var els = kids(n).filter(isEl);
      var hasBlockChild = els.some(function (x) { return BLOCKISH.test(tag(x)) || tag(x) === 'BUTTON'; });
      var tx = clean(text(n));
      if (!hasBlockChild && tx.length >= 8) {
        if (!seen.has(tx)) { seen.add(tx); out.push(tx); }
        return;
      }
      for (var i = 0; i < els.length; i++) walk(els[i]);
    }
    walk(body);
    return out;
  }

  return { toMarkdown: toMarkdown, stats: stats, plainTextLines: plainTextLines, clean: clean, inline: inline, text: text };
});
