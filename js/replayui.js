/* ============================================================
 * replayui.js -- Gruppenfahrt noch einmal abspielen
 * ============================================================
 * Vollbild: Karte, Hoehenprofil, Zeitleiste und die Rangliste zu jedem
 * Zeitpunkt. Die Fahrt laeuft durch dieselbe Auswertung wie live
 * (session.js) -- Rang, Luecken, Ueberholvorgaenge und Antritte sind
 * also nicht nachgestellt, sondern zum jeweiligen Zeitpunkt berechnet.
 *
 * Vor- und Zurueckspulen: Vorwaerts wird die Auswertung einfach weiter-
 * gerechnet; rueckwaerts muss sie von vorn neu aufgebaut werden (die
 * Achse und die Anstiege entstehen ja erst beim Fahren). Bei langen
 * Fahrten dauert das einen Moment, deshalb rechnet sie in kleinen
 * Happen im Hintergrund und zeigt "berechne ..." solange.
 * ============================================================ */

var ReplayUI = (function () {
    'use strict';

    var sess = null, ctl = null, ride = null;
    var playing = false, speed = 10, target = null, lastTs = 0, lastList = 0, raf = 0;
    var el = {};
    var events = [];

    function $(id) { return document.getElementById(id); }

    function isOpen() { return !!$('replay') && !$('replay').hidden; }

    function fmtClock(ms) { return UI.fmtDur(Math.max(0, ms)); }

    function build(rideId) {
        var rec = Rides.get(rideId);
        if (!rec) return null;
        var g = Rides.getGroup(rideId);
        if (g) return { rec: rec, session: new Session(Recorder.unpack(g)) };
        // keine Gruppe aufgezeichnet: nur die eigene Fahrt
        return { rec: rec, session: Session.solo(Rides.unpack(rec), 'me', 'Du', UI.COLORS[0]) };
    }

    function open(rideId) {
        var b = build(rideId);
        if (!b) return false;
        ride = b.rec; sess = b.session;
        if (!ctl) {
            ctl = MapCtl.mount($('rpMap'), {
                prefix: 'rp', persist: false,
                isActive: isOpen,
                hasRoute: function () { return true; },          // "Route" = die ganze Strecke im Bild
                getData: function () {
                    if (!sess) return null;
                    var mine = sess.an.riders[sess.meId];
                    return { route: sess.route, riders: sess.an.order(), meId: sess.meId,
                             climbs: sess.an.climbs, heading: mine ? mine.heading : null,
                             overlay: null, axisFit: true,
                             /* Glaetten nur, solange abgespielt wird: Bleibt das Replay stehen
                                (Pause, Ende, Spulen), waere weiterschieben falsch -- der Punkt
                                schoebe sich bis zu 2,6 s ueber die echte Position hinaus. */
                             smooth: playing };
                }
            });
        }
        $('replay').hidden = false;
        $('rpTitle').textContent = ride.name;
        playing = false; target = null; events = [];
        sess.reset();
        speed = 10; syncSpeed(); syncPlay();
        $('rpSlider').value = 0;
        // erst bis kurz nach dem Start vorrechnen, damit die Karte nicht leer ist
        target = sess.t0 + 15000;
        ctl.reset(); ctl.opt.follow = false; ctl.opt.fitRoute = true; ctl.sync();      // erst die ganze Strecke zeigen
        ctl.ensureLoop();
        loop(performance.now());
        return true;
    }

    function close() {
        $('replay').hidden = true;
        playing = false;
        cancelAnimationFrame(raf); raf = 0;
    }

    function syncPlay() {
        $('rpPlay').textContent = playing ? '⏸' : '▶';
        $('rpPlay').classList.toggle('go', !playing);
    }
    function syncSpeed() {
        document.querySelectorAll('[data-rs]').forEach(function (b) { b.classList.toggle('on', +b.dataset.rs === speed); });
    }

    /* Zeit t (ms) ansteuern: vorwaerts weiterrechnen, rueckwaerts neu aufbauen. */
    function seekTo(t) {
        t = Math.max(sess.t0, Math.min(sess.t1, t));
        if (t < sess.tCur) { sess.reset(); events = []; }
        target = t;
    }

    function loop(ts) {
        raf = 0;
        if (!isOpen() || !sess) return;
        var dt = lastTs ? Math.min(100, ts - lastTs) : 16;
        lastTs = ts;

        // Abspielen: die Ziel-Zeit laeuft mit der gewaehlten Geschwindigkeit weiter
        if (playing && target === null) {
            var nt = sess.tCur + dt * speed;
            if (nt >= sess.t1) { nt = sess.t1; playing = false; syncPlay(); }
            target = nt;
        }
        var busy = false;
        if (target !== null) {
            var big = target - sess.tCur > 5000;
            var reached = sess.work(target, big ? 2000 : 1000, 10);
            if (reached) target = null; else busy = true;
        }
        $('rpBusy').hidden = !busy;

        // Anzeige: Schieberegler, Zeit, Liste (5x pro Sekunde reicht)
        var total = Math.max(1, sess.t1 - sess.t0), frac = (sess.tCur - sess.t0) / total;
        if (!$('rpSlider').dragging) $('rpSlider').value = Math.round(Math.max(0, Math.min(1, frac)) * 1000);
        $('rpTime').textContent = fmtClock(sess.tCur - sess.t0) + ' / ' + fmtClock(total);
        if (ts - lastList > 200) { lastList = ts; renderList(); }

        raf = requestAnimationFrame(loop);
    }

    function renderList() {
        var an = sess.an, ord = an.order(), lead = ord[0], mine = an.riders[sess.meId];
        var rows = ord.map(function (r, i) {
            var gap = (lead && r !== lead) ? lead.s - r.s : null;
            return '<div class="rprow' + (r.id === sess.meId ? ' me' : '') + '">' +
                '<span class="rk num">' + (i + 1) + '</span>' +
                (UI.emojiOf(r.emoji) ? '<span class="rdot em" style="background:' + (r.color || '#93a7af') + '">' + Emo.img(UI.emojiOf(r.emoji)) + '</span>'
                                     : '<span class="rdot" style="background:' + (r.color || '#93a7af') + '"></span>') +
                '<span class="rn">' + UI.escapeHtml(r.name || r.id) + (r.dropped ? ' <i class="tag drop">ABGERISSEN</i>' : '') + '</span>' +
                '<span class="rs num">' + (r.speed > 0.3 ? Math.round(UI.kmh(r.speed)) : '–') + '</span>' +
                '<span class="rg num">' + (gap === null ? '' : '−' + UI.fmtDist(gap)) + '</span></div>';
        });
        $('rpRiders').innerHTML = rows.join('') || '<div class="empty">Noch niemand unterwegs.</div>';

        // letztes Ereignis in Worten
        var ev = an.events[an.events.length - 1];
        $('rpEvent').innerHTML = ev ? '<span class="tm num">' + UI.fmtDur(ev.t - sess.t0) + '</span> ' + UI.eventText(an, ev) : '';

        // Profil (Live-Achse der Session)
        var riders = ord.map(function (r) {
            return { id: r.id, name: r.name, color: r.color, emoji: UI.emojiOf(r.emoji), s: r.s, self: r.id === sess.meId, stale: an.isStale(r) };
        });
        var pi = Profile.render($('rpProfSvg'), { route: sess.route, riders: riders, climbs: an.climbs,
                                                   meS: mine ? mine.s : null, mode: 'all' });
        if (pi) $('rpProfInfo').textContent = Profile.describe(pi.next);
    }

    function wire() {
        $('rpClose').addEventListener('click', close);
        $('rpPlay').addEventListener('click', function () {
            if (!sess) return;
            if (!playing && sess.tCur >= sess.t1) seekTo(sess.t0);      // am Ende: von vorn
            playing = !playing; syncPlay();
        });
        document.querySelectorAll('[data-rs]').forEach(function (b) {
            b.addEventListener('click', function () { speed = +b.dataset.rs; syncSpeed(); });
        });
        var sl = $('rpSlider');
        sl.addEventListener('input', function () {
            if (!sess) return;
            sl.dragging = true;
            var t = sess.t0 + (sl.value / 1000) * (sess.t1 - sess.t0);
            $('rpTime').textContent = fmtClock(t - sess.t0) + ' / ' + fmtClock(sess.t1 - sess.t0);
            seekTo(t);
        });
        sl.addEventListener('change', function () { sl.dragging = false; });
        document.addEventListener('keydown', function (e) {
            if (!isOpen()) return;
            if (e.key === 'Escape') close();
            if (e.key === ' ') { e.preventDefault(); $('rpPlay').click(); }
        });
    }

    return { open: open, close: close, wire: wire, isOpen: isOpen,
             _state: function () { return { sess: sess, playing: playing, target: target, speed: speed }; } };
})();
