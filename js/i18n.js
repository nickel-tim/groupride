/* ============================================================
 * i18n.js -- language mode (German / English)
 * ============================================================
 * The German text IS the key. The code writes T('Nicht verbunden'); in German mode that comes
 * back unchanged, in English mode the entry of the dictionary (js/i18n-en.js) is used, and a
 * missing entry falls back to the German text -- so nothing can break, an untranslated
 * text merely stays German. test/i18n_check.py finds such gaps.
 *
 *   T('noch {n} Tage', { n: 3 })   placeholders in braces; the translation keeps them
 *   I18n.num(12.345, 1)            decimal separator by language ("12,3" / "12.3")
 *   .replace('.', I18n.sep())      the same for an already formatted number
 *   I18n.locale()                  'de-DE' / 'en-GB' for toLocale*String
 *   I18n.set('en')                 switch, remember, re-translate, notify the app
 *   I18n.onChange(fn)              the app re-renders its dynamic parts in fn
 *
 * Static text in index.html is not marked up: scanStatic() collects it once at start
 * (before any script has changed it) and later re-translates exactly those elements whose
 * content was not modified by a script in the meantime. What scripts produce at run time
 * goes through T() at the point where it is produced.
 *
 * Server messages (api/) arrive in German and are translated here with the same dictionary;
 * messages with a variable part are matched by the patterns (addPatterns).
 * ============================================================ */

var I18n = (function () {
    'use strict';

    var LANGS = ['de', 'en'];
    var KEY = 'lang';
    var dict = { en: {} }, pats = { en: [] };
    var lang = 'de', listeners = [], managed = [], missed = {};
    var INLINE = { A: 1, B: 1, I: 1, EM: 1, STRONG: 1, CODE: 1, BR: 1, SMALL: 1, U: 1 };
    var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];

    function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
    function fill(s, v) {
        return v ? s.replace(/\{(\w+)\}/g, function (m, k) { return v[k] !== undefined ? v[k] : m; }) : s;
    }

    function has(key) { return Object.prototype.hasOwnProperty.call(dict.en, key); }

    /* German key -> text in the current language */
    function t(key, vars) {
        var s = key;
        if (lang !== 'de') {
            var d = dict[lang];
            if (d && Object.prototype.hasOwnProperty.call(d, key)) s = d[key];
            else {
                var p = pats[lang] || [], hit = false;
                for (var i = 0; i < p.length; i++) {
                    var m = p[i][0].exec(key);
                    if (m) { s = p[i][1].apply(null, m); hit = true; break; }
                }
                if (!hit && /[A-Za-zÄÖÜäöüß]{2}/.test(key)) missed[key] = true;      // no translation: stays German (test/i18n_check.py reads this)
            }
        }
        return fill(s, vars);
    }

    function add(l, entries) { dict[l] = dict[l] || {}; for (var k in entries) dict[l][k] = entries[k]; }
    function addPatterns(l, list) { pats[l] = (pats[l] || []).concat(list); }

    function lang_() { return lang; }
    function locale() { return lang === 'en' ? 'en-GB' : 'de-DE'; }
    function sep() { return lang === 'de' ? ',' : '.'; }
    function num(x, d) {
        var s = Number(x).toFixed(d === undefined ? 0 : d);
        return lang === 'de' ? s.replace('.', ',') : s;
    }

    /* ---- static text of the page ---- */
    function hasLetters(s) { return /[A-Za-zÄÖÜäöüß]{2}/.test(s); }

    function scanStatic(root) {
        managed = [];
        var all = (root || document.body).getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) {
            var el = all[i], tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || el.closest('svg')) continue;
            var nested = false;
            for (var pe = el.parentElement; pe; pe = pe.parentElement) if (pe.__i18nOwned) { nested = true; break; }
            if (nested) continue;                              // its parent is translated as a whole
            for (var a = 0; a < ATTRS.length; a++) {
                var v = el.getAttribute(ATTRS[a]);
                if (v && hasLetters(v)) managed.push({ kind: 'attr', el: el, attr: ATTRS[a], de: norm(v), orig: v, last: v });
            }
            var leaf = true, c;
            for (c = 0; c < el.children.length; c++) if (!INLINE[el.children[c].tagName]) { leaf = false; break; }
            if (leaf) {
                if (hasLetters(el.textContent)) { el.__i18nOwned = true; managed.push({ kind: 'html', el: el, de: norm(el.innerHTML), orig: el.innerHTML, last: el.innerHTML }); }
            } else {
                for (c = 0; c < el.childNodes.length; c++) {
                    var n = el.childNodes[c];
                    if (n.nodeType === 3 && hasLetters(n.nodeValue)) managed.push({ kind: 'text', node: n, de: norm(n.nodeValue), orig: n.nodeValue, last: n.nodeValue });
                }
            }
        }
    }

    /* German texts of the static page (for the dictionary check) */
    function staticKeys() { return managed.map(function (m) { return m.de; }); }

    /* The value an element should have in the current language (German original if there is no translation) */
    function valueFor(m) {
        if (lang === 'de') return m.orig;
        var d = dict[lang];
        if (!d || !Object.prototype.hasOwnProperty.call(d, m.de)) return m.orig;
        var tr = d[m.de];
        return m.kind === 'text' ? m.orig.replace(m.orig.trim(), function () { return tr; }) : tr;
    }

    function applyStatic() {
        managed.forEach(function (m) {
            var now = m.kind === 'html' ? m.el.innerHTML : m.kind === 'attr' ? m.el.getAttribute(m.attr) : m.node.nodeValue;
            if (now !== m.last) return;                      // a script has taken this over: it translates itself
            var val = valueFor(m);
            if (m.kind === 'html') m.el.innerHTML = val;
            else if (m.kind === 'attr') m.el.setAttribute(m.attr, val);
            else m.node.nodeValue = val;
            m.last = m.kind === 'html' ? m.el.innerHTML : val;    // innerHTML is re-serialised by the browser
        });
    }

    function set(l) {
        if (LANGS.indexOf(l) < 0) return;
        lang = l;
        try { localStorage.setItem(KEY, l); } catch (e) {}
        document.documentElement.lang = l;
        applyStatic();
        listeners.forEach(function (f) { try { f(l); } catch (e) { if (window.console) console.error(e); } });
    }

    function onChange(f) { listeners.push(f); }

    /* Language at start: ?lang=en|de (also remembered), otherwise the remembered one, otherwise German. */
    function detect() {
        var q = null;
        try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
        if (q && LANGS.indexOf(q) >= 0) { try { localStorage.setItem(KEY, q); } catch (e) {} return q; }
        try { var s = localStorage.getItem(KEY); if (s && LANGS.indexOf(s) >= 0) return s; } catch (e) {}
        return 'de';
    }
    lang = detect();
    try { document.documentElement.lang = lang; } catch (e) {}

    return { t: t, add: add, addPatterns: addPatterns, has: has, lang: lang_, locale: locale, num: num, sep: sep, set: set,
             onChange: onChange, scanStatic: scanStatic, applyStatic: applyStatic, staticKeys: staticKeys, norm: norm,
             dictionary: function () { return dict.en; }, missing: function () { return Object.keys(missed); } };
})();

function T(key, vars) { return I18n.t(key, vars); }

if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
