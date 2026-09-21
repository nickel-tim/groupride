/* ============================================================
 * messages.js -- Kurznachrichten per Emoji-Knopf, ohne Tippen
 * ============================================================
 * Auf dem Rad tippt niemand. Deshalb gibt es feste Nachrichten als grosse
 * Knoepfe: eine Reihe im Tacho (die vier wichtigsten) und ein Panel mit
 * allen. Ein Tipp sendet; beim Empfaenger erscheint oben ein Banner mit
 * Emoji und Name, dazu Vibration (Android) und ein Eintrag im Verlauf.
 *
 * Auf der Leitung steht nur ein CODE ("flat"), kein Text und kein Emoji:
 * Absender und Empfaenger ordnen ihn selbst zu. Das haelt die Nachricht
 * klein, sie laesst sich nicht fuer Unsinn missbrauchen, und eine neuere App
 * mit zusaetzlichen Codes stoert eine aeltere nicht (unbekannte Codes werden
 * verworfen). Die Nachricht geht durch denselben verschluesselten Kanal wie die
 * Positionen -- Broker/Relay sehen nur Zufallsbytes.
 *
 * Zuverlaessigkeit: der Kanal ist "einmal senden, keine Bestaetigung" (QoS 0).
 * Ein verlorenes "Halt!" waere schlimm, deshalb wird jede Nachricht nach 1,5 s
 * noch einmal gesendet; eine Nachrichten-ID sorgt dafuer, dass sie beim
 * Empfaenger nur einmal zaehlt.
 *
 * Schutz vor Fehlbedienung: Nach dem Senden 2,5 s Pause; "Hilfe" braucht zwei
 * Tipps kurz hintereinander.
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
    function text(code) { return known(code) ? CODES[code].e + ' ' + CODES[code].t : code; }

    /* ---------------- Banner ---------------- */
    function banner(o) {
        var box = $('msgBanner');
        if (!box) return;
        var el = document.createElement('div');
        el.className = 'msgi' + (o.urgent ? ' urgent' : '') + (o.warn ? ' warn' : '') + (o.mine ? ' mine' : '');
        el.setAttribute('role', 'alert');
        el.innerHTML = '<span class="me">' + o.e + '</span><span class="mt"><b>' + esc(o.who) + '</b>' +
                       '<span>' + esc(o.t) + '</span></span>';
        function close() { if (el.parentNode) el.parentNode.removeChild(el); }
        el.addEventListener('click', close);
        box.appendChild(el);
        while (box.children.length > 3) box.removeChild(box.firstChild);
        setTimeout(close, o.urgent ? SHOW_URGENT_MS : SHOW_MS);
    }

    /* ---------------- Empfangen ---------------- */
    /* m: { i, n, q, mid, t } aus dem entschluesselten Kanal */
    function receive(m) {
        if (!m || !known(m.q) || !m.i) return false;
        var now = Date.now();
        if (typeof m.t === 'number' && Math.abs(now - m.t) > MAX_AGE_MS) return false;    // alt (Wiederholung, Uhr falsch)
        if (m.mid) { if (seen[m.mid]) return false; seen[m.mid] = now; }                   // Wiederholung derselben Nachricht
        // dieselbe Nachricht vom selben Absender nicht dauernd anzeigen (wildes Tippen)
        var k = m.i + '|' + m.q;
        if (lastFrom[k] && now - lastFrom[k] < 4000) return false;
        lastFrom[k] = now;
        var keys = Object.keys(seen);
        if (keys.length > 200) keys.slice(0, 100).forEach(function (x) { delete seen[x]; });

        var c = CODES[m.q], name = (typeof m.n === 'string' && m.n) ? m.n.slice(0, 14) : 'Mitfahrer';
        banner({ e: c.e, who: name, t: c.t, urgent: !!c.urgent });
        if (cfg && cfg.log) cfg.log(m.i, name, m.q, now);
        if (navigator.vibrate) { try { navigator.vibrate(c.urgent ? [200, 80, 200, 80, 200] : [90]); } catch (x) {} }
        return true;
    }

    /* ---------------- Senden ---------------- */
    function newMid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

    function disarm() {
        armed = null; clearTimeout(armTimer);
        document.querySelectorAll('[data-msg].armed').forEach(function (b) { b.classList.remove('armed'); });
    }

    function send(code) {
        if (!known(code)) return;
        var c = CODES[code], now = Date.now();
        if (now < cooldownUntil) return;
        if (c.confirm && armed !== code) {                       // erster Tipp: nur scharf machen
            disarm(); armed = code;
            document.querySelectorAll('[data-msg="' + code + '"]').forEach(function (b) { b.classList.add('armed'); });
            armTimer = setTimeout(disarm, ARM_MS);
            banner({ e: c.e, who: 'Nochmal tippen', t: c.t + ' an alle senden?', warn: true });
            return;
        }
        disarm();
        cooldownUntil = now + COOLDOWN_MS;
        var res = cfg.send(code, newMid());                      // 'sent' | 'sim' | 'offline'
        if (res === 'offline') {
            banner({ e: '📵', who: 'Nicht gesendet', t: 'Kein Netz oder Ausfahrt nicht gestartet', warn: true });
            return;
        }
        banner({ e: c.e, who: 'Du', t: c.t + (res === 'sim' ? ' (Simulation)' : ' · gesendet'), urgent: false, mine: true });
        if (cfg.log) cfg.log(cfg.meId(), cfg.meName(), code, now);
    }

    /* ---------------- Oberflaeche ---------------- */
    function btn(code, big) {
        var c = CODES[code];
        return '<button data-msg="' + code + '" aria-label="' + c.t + '"' + (c.urgent ? ' class="urg"' : '') + '>' +
               '<span class="mem">' + c.e + '</span>' + (big ? '<span class="mlb">' + c.t + '</span>' : '') + '</button>';
    }

    function init(c) {
        cfg = c;
        $('quickRow').innerHTML = QUICK.map(function (k) { return btn(k, false); }).join('') +
            '<button id="msgMore" aria-label="Alle Nachrichten"><span class="mem">💬</span></button>';
        $('msgGrid').innerHTML = ORDER.map(function (k) { return btn(k, true); }).join('');

        document.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('[data-msg]');
            if (!b) return;
            send(b.dataset.msg);
            if (b.closest('#msgPanel') && !CODES[b.dataset.msg].confirm) $('msgPanel').hidden = true;   // Panel schliesst nach dem Senden
            else if (b.closest('#msgPanel') && armed === null) $('msgPanel').hidden = true;
        });
        $('msgMore').addEventListener('click', function () { $('msgPanel').hidden = false; });
        $('msgClose').addEventListener('click', function () { $('msgPanel').hidden = true; disarm(); });
        $('msgPanel').addEventListener('click', function (e) { if (e.target === this) { this.hidden = true; disarm(); } });
    }

    return { init: init, send: send, receive: receive, label: label, text: text, CODES: CODES,
             _reset: function () { seen = {}; lastFrom = {}; cooldownUntil = 0; disarm(); } };
})();
