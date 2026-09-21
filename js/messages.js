/* ============================================================
 * messages.js -- short messages by emoji button, without typing
 * ============================================================
 * Nobody types on the bike. That is why there are fixed messages as large
 * buttons: a row on the speedometer (the four most important) and a panel with
 * all of them. One tap sends; at the receiver a banner appears at the top with
 * emoji and name, plus vibration (Android) and an entry in the log.
 *
 * On the wire there is only a CODE ("flat"), no text and no emoji:
 * sender and receiver map it themselves. That keeps the message
 * small, it cannot be abused for nonsense, and a newer app
 * with additional codes does not disturb an older one (unknown codes are
 * discarded). The message goes through the same encrypted channel as the
 * positions -- broker/relay see only random bytes.
 *
 * Reliability: the channel is "send once, no confirmation" (QoS 0).
 * A lost "Stop!" would be bad, so every message is sent once more
 * after 1.5 s; a message ID makes sure it only counts once at the
 * receiver.
 *
 * Protection against mis-operation: after sending a 2.5 s pause; "Help" needs two
 * taps in quick succession.
 * ============================================================ */

var Msg = (function () {
    'use strict';

    var CODES = {
        stop:   { e: '🛑', t: 'Halt!',          urgent: true },
        wait:   { e: '⏳', t: 'Bitte warten' },
        flat:   { e: '🔧', t: 'Panne',          urgent: true },
        danger: { e: '⚠️', t: 'Vorsicht!',      urgent: true },
        help:   { e: '🚨', t: 'Hilfe!',         urgent: true, confirm: true },
        slow:   { e: '🐢', t: 'Langsamer' },
        fast:   { e: '🚀', t: 'Schneller' },
        coffee: { e: '☕', t: 'Pause?' },
        ok:     { e: '👍', t: 'Alles klar' }
    };
    var ORDER = ['stop', 'wait', 'flat', 'danger', 'help', 'slow', 'fast', 'coffee', 'ok'];
    var QUICK = ['stop', 'wait', 'flat', 'danger'];

    var COOLDOWN_MS = 2500, ARM_MS = 3000, MAX_AGE_MS = 90000, SHOW_MS = 8000, SHOW_URGENT_MS = 20000;

    var cfg = null, seen = {}, lastFrom = {}, cooldownUntil = 0, armed = null, armTimer = null;

    function $(id) { return document.getElementById(id); }
    function esc(s) { return UI.escapeHtml(s); }
    function known(code) { return Object.prototype.hasOwnProperty.call(CODES, code); }
    function label(code) { return known(code) ? CODES[code] : null; }
    function text(code) { return known(code) ? CODES[code].e + ' ' + T(CODES[code].t) : code; }
    // the same as HTML with the bundled image (log)
    function html(code) { return known(code) ? Emo.img(CODES[code].e) + ' ' + esc(T(CODES[code].t)) : esc(code); }

    /* ---------------- Banner ---------------- */
    function banner(o) {
        var box = $('msgBanner');
        if (!box) return;
        var el = document.createElement('div');
        el.className = 'msgi' + (o.urgent ? ' urgent' : '') + (o.warn ? ' warn' : '') + (o.mine ? ' mine' : '');
        el.setAttribute('role', 'alert');
        el.innerHTML = '<span class="me">' + Emo.img(o.e) + '</span><span class="mt"><b>' + (o.whoHtml || esc(o.who)) + '</b>' +
                       '<span>' + esc(o.t) + '</span></span>';
        function close() { if (el.parentNode) el.parentNode.removeChild(el); }
        el.addEventListener('click', close);
        box.appendChild(el);
        while (box.children.length > 3) box.removeChild(box.firstChild);
        setTimeout(close, o.urgent ? SHOW_URGENT_MS : SHOW_MS);
    }

    /* ---------------- Receiving ---------------- */
    /* m: { i, n, q, mid, t } from the decrypted channel */
    function receive(m) {
        if (!m || !known(m.q) || !m.i) return false;
        var now = Date.now();
        if (typeof m.t === 'number' && Math.abs(now - m.t) > MAX_AGE_MS) return false;    // old (repetition, clock wrong)
        if (m.mid) { if (seen[m.mid]) return false; seen[m.mid] = now; }                   // repetition of the same message
        // do not show the same message from the same sender continuously (wild tapping)
        var k = m.i + '|' + m.q;
        if (lastFrom[k] && now - lastFrom[k] < 4000) return false;
        lastFrom[k] = now;
        var keys = Object.keys(seen);
        if (keys.length > 200) keys.slice(0, 100).forEach(function (x) { delete seen[x]; });

        var c = CODES[m.q], name = (typeof m.n === 'string' && m.n) ? m.n.slice(0, 14) : T('Mitfahrer');
        var emo = UI.emojiOf(m.j);
        banner({ e: c.e, whoHtml: (emo ? Emo.img(emo) + ' ' : '') + esc(name), t: T(c.t), urgent: !!c.urgent });
        if (cfg && cfg.log) cfg.log(m.i, name, m.q, now);
        if (navigator.vibrate) { try { navigator.vibrate(c.urgent ? [200, 80, 200, 80, 200] : [90]); } catch (x) {} }
        return true;
    }

    /* ---------------- Sending ---------------- */
    function newMid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

    function disarm() {
        armed = null; clearTimeout(armTimer);
        document.querySelectorAll('[data-msg].armed').forEach(function (b) { b.classList.remove('armed'); });
    }

    function send(code) {
        if (!known(code)) return;
        var c = CODES[code], now = Date.now();
        if (now < cooldownUntil) return;
        if (c.confirm && armed !== code) {                       // first tap: only arm it
            disarm(); armed = code;
            document.querySelectorAll('[data-msg="' + code + '"]').forEach(function (b) { b.classList.add('armed'); });
            armTimer = setTimeout(disarm, ARM_MS);
            banner({ e: c.e, who: T('Nochmal tippen'), t: T('{m} an alle senden?', { m: T(c.t) }), warn: true });
            return;
        }
        disarm();
        cooldownUntil = now + COOLDOWN_MS;
        var res = cfg.send(code, newMid());                      // 'sent' | 'sim' | 'offline'
        if (res === 'offline') {
            banner({ e: '📵', who: T('Nicht gesendet'), t: T('Kein Netz oder Ausfahrt nicht gestartet'), warn: true });
            return;
        }
        banner({ e: c.e, who: T('Du'), t: T(c.t) + (res === 'sim' ? ' (' + T('Simulation') + ')' : ' · ' + T('gesendet')), urgent: false, mine: true });
        if (cfg.log) cfg.log(cfg.meId(), cfg.meName(), code, now);
    }

    /* ---------------- Interface ---------------- */
    function btn(code, big) {
        var c = CODES[code];
        return '<button data-msg="' + code + '" aria-label="' + esc(T(c.t)) + '"' + (c.urgent ? ' class="urg"' : '') + '>' +
               '<span class="mem">' + Emo.img(c.e) + '</span>' + (big ? '<span class="mlb">' + esc(T(c.t)) + '</span>' : '') + '</button>';
    }

    /* Draw the buttons (again after a language switch) */
    function renderButtons() {
        $('quickRow').innerHTML = QUICK.map(function (k) { return btn(k, false); }).join('') +
            '<button id="msgMore" aria-label="' + esc(T('Alle Nachrichten')) + '"><span class="mem">' + Emo.img('💬') + '</span></button>';
        $('msgGrid').innerHTML = ORDER.map(function (k) { return btn(k, true); }).join('');
    }

    function init(c) {
        cfg = c;
        renderButtons();

        document.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('[data-msg]');
            if (!b) return;
            send(b.dataset.msg);
            if (b.closest('#msgPanel') && !CODES[b.dataset.msg].confirm) $('msgPanel').hidden = true;   // panel closes after sending
            else if (b.closest('#msgPanel') && armed === null) $('msgPanel').hidden = true;
        });
        $('quickRow').addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#msgMore')) $('msgPanel').hidden = false; });
        $('msgClose').addEventListener('click', function () { $('msgPanel').hidden = true; disarm(); });
        $('msgPanel').addEventListener('click', function (e) { if (e.target === this) { this.hidden = true; disarm(); } });
    }

    return { init: init, render: renderButtons, send: send, receive: receive, label: label, text: text, html: html, CODES: CODES,
             _reset: function () { seen = {}; lastFrom = {}; cooldownUntil = 0; disarm(); } };
})();
