/* infer.js — structural role inference, independent of class names.
 * Any page / any template: detect chapter bars, content cards, figures and
 * numbered steps from the shape of the DOM, then tag them with data-ax.
 * Site adapters may override, but do not have to.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ArchiverInfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function tag(n) { return (n.tagName || '').toUpperCase(); }
  function cls(n) { return new Set((((n && n.getAttribute && n.getAttribute('class')) || '')).split(/\s+/).filter(Boolean)); }
  function txt(n) {
    if (!n) return '';
    if (n.nodeType === 3) return n.nodeValue || '';
    if (n.nodeType !== 1) return '';
    var s = '';
    for (var i = 0; i < (n.childNodes || []).length; i++) s += txt(n.childNodes[i]);
    return s;
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function kids(n) {
    return Array.prototype.slice.call((n && n.children) || []).filter(function (x) { return x.nodeType === 1; });
  }
  function direct(n, t) { return kids(n).filter(function (x) { return tag(x) === t; }); }
  function mark(n, r) {
    if (n && n.setAttribute && !n.getAttribute('data-ax')) n.setAttribute('data-ax', r);
  }
  function role(n, r) {
    if (!n || !n.getAttribute) return false;
    return n.getAttribute('data-ax') === r || cls(n).has(r);
  }
  function hasAncestorRole(el, selector) {
    var p = el && el.parentElement;
    if (!p || !p.closest) return false;
    return !!p.closest(selector);
  }

  function infer(doc) {
    var body = doc && (doc.body || doc.documentElement);
    var count = { parts: 0, modules: 0, figures: 0, steps: 0, cards: 0 };
    if (!body) return count;
    var all = Array.prototype.slice.call(body.querySelectorAll('*'));

    /* 1. Chapter bars: a shallow DIV/SECTION with exactly one direct H2 and little text. */
    var partEls = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!/^(DIV|SECTION|HEADER|ARTICLE)$/.test(tag(el))) continue;
      if (hasAncestorRole(el, '.part, [data-ax="part"]')) continue;
      var h2 = direct(el, 'H2');
      if (h2.length !== 1) continue;
      var t = clean(txt(el));
      if (t.length > 200) continue;
      var ks = kids(el).filter(function (x) { return !/^(SCRIPT|STYLE|SVG|FIGURE)$/.test(tag(x)); });
      if (ks.length > 6) continue;
      mark(el, 'part'); partEls.push(el); count.parts++;
      mark(h2[0], 'part-title');
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j];
        if (k === h2[0]) continue;
        var kt = clean(txt(k));
        if (kt.length <= 16 && /^(?:PART|part|第|章|节|Section|SECTION)?\s*0?\d{1,2}\.?$/.test(kt)) mark(k, 'part-no');
        else if (cls(k).has('part-sub') || cls(k).has('sub')) mark(k, 'part-sub');
      }
    }

    /* 2. Content cards: SECTION/ARTICLE/DIV with exactly one direct H3. */
    for (var a = 0; a < all.length; a++) {
      var m = all[a];
      if (!/^(SECTION|ARTICLE|DIV)$/.test(tag(m))) continue;
      if (partEls.indexOf(m) !== -1) continue;
      if (hasAncestorRole(m, '.part, [data-ax="part"], .module, [data-ax="module"]')) continue;
      var h3 = direct(m, 'H3');
      if (h3.length !== 1) continue;
      if (m.querySelectorAll('h3').length > 1) continue;
      mark(m, 'module'); count.modules++;
      mark(h3[0], 'module-title');
    }

    /* 3. Figures: any FIGURE with a caption or visual metadata. */
    var figs = body.querySelectorAll('figure');
    for (var f = 0; f < figs.length; f++) {
      if (figs[f].getAttribute('data-visual-title') || figs[f].querySelector('figcaption')) {
        mark(figs[f], 'figure'); count.figures++;
      }
    }

    /* 4. Numbered steps: >=2 sibling blocks that each start with a short numeric marker. */
    var groups = new Map();
    for (var s = 0; s < all.length; s++) {
      var b = all[s];
      if (!/^(DIV|LI|SECTION)$/.test(tag(b))) continue;
      var num = kids(b).filter(function (x) {
        var xt = clean(txt(x));
        return xt.length <= 4 && /^0?\d{1,2}\.?$/.test(xt);
      })[0];
      if (!num) continue;
      var p = b.parentElement;
      if (!p) continue;
      var key = (p.getAttribute('data-ax') || p.className || '') + '|' + (b.className || '') + '|' + tag(b) + '|' + tag(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ el: b, num: num });
    }
    groups.forEach(function (g) {
      if (g.length < 2) return;
      for (var q = 0; q < g.length; q++) {
        if (role(g[q].el, 'card')) continue;
        mark(g[q].el, 'step'); mark(g[q].num, 'step-no'); count.steps++;
      }
    });

    /* 5. Comparison cards: >=2 sibling DIVs each starting with H4 / a short B title. */
    var cg = new Map();
    for (var c = 0; c < all.length; c++) {
      var d = all[c];
      if (tag(d) !== 'DIV' || role(d, 'step') || role(d, 'part') || role(d, 'module')) continue;
      // Only an explicit H4 is a card title. Treating any inline <b> as a title
      // would tear apart ordinary sentences that merely contain emphasis.
      var head = direct(d, 'H4')[0];
      if (!head) continue;
      var dp = d.parentElement;
      if (!dp) continue;
      var ck = (dp.className || '') + '|' + (d.className || '');
      if (!cg.has(ck)) cg.set(ck, []);
      cg.get(ck).push({ el: d, head: head });
    }
    cg.forEach(function (g) {
      if (g.length < 2) return;
      for (var q = 0; q < g.length; q++) {
        mark(g[q].el, 'card'); mark(g[q].head, 'card-title'); count.cards++;
      }
    });

    return count;
  }

  return { infer: infer, role: role, mark: mark, clean: clean, txt: txt, tag: tag, cls: cls };
});
