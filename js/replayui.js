/* ============================================================
 * replayui.js -- play a group ride back once more
 * ============================================================
 * Full screen: map, elevation profile, timeline and the ranking at every
 * point in time. The ride runs through the same analysis as live
 * (session.js) -- rank, gaps, overtaking and attacks are
 * therefore not re-enacted but computed at the respective point in time.
 *
 * Seeking forward and backward: going forward the analysis simply keeps
 * computing; going backward it has to be rebuilt from the start (the
 * axis and the climbs only come into being while riding). For long
 * rides that takes a moment, so it computes in small chunks
 * in the background and shows "computing ..." meanwhile.
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
        // no group recorded: only your own ride
        return { rec: rec, session: Session.solo(Rides.unpack(rec), 'me', T('Du'), UI.COLORS[0]) };
    }

    function open(rideId) {
        var b = build(rideId);
        if (!b) return false;
        ride = b.rec; sess = b.session;
        if (!ctl) {
            ctl = MapCtl.mount($('rpMap'), {
                prefix: 'rp', persist: false,
                isActive: isOpen,
                hasRoute: function () { return true; },          // "Route" = the whole route in the picture
                getData: function () {
                    if (!sess) return null;
                    var mine = sess.an.riders[sess.meId];
                    return { route: sess.route, riders: sess.an.order(), meId: sess.meId,
                             climbs: sess.an.climbs, heading: mine ? mine.heading : null,
                             overlay: null, axisFit: true,
                             /* Smooth only while playing: if the replay stands still
                                (pause, end, seeking), moving on would be wrong -- the dot
                                would push up to 2.6 s beyond the real position. */
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
        // first compute only up to shortly after the start, so that the map is not empty
        target = sess.t0 + 15000;
        ctl.reset(); ctl.opt.follow = false; ctl.opt.fitRoute = true; ctl.sync();      // first show the whole route
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

    /* Steer to time t (ms): going forward keep computing, going backward rebuild. */
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

        // Playing: the target time keeps running at the chosen speed
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

        // Display: slider, time, list (5x per second is enough)
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
                '<span class="rn">' + UI.escapeHtml(r.name || r.id) + (r.dropped ? ' <i class="tag drop">' + T('ABGERISSEN') + '</i>' : '') + '</span>' +
                '<span class="rs num">' + (r.speed > 0.3 ? Math.round(UI.kmh(r.speed)) : '–') + '</span>' +
                '<span class="rg num">' + (gap === null ? '' : '−' + UI.fmtDist(gap)) + '</span></div>';
        });
        $('rpRiders').innerHTML = rows.join('') || '<div class="empty">' + T('Noch niemand unterwegs.') + '</div>';

        // last event in words
        var ev = an.events[an.events.length - 1];
        $('rpEvent').innerHTML = ev ? '<span class="tm num">' + UI.fmtDur(ev.t - sess.t0) + '</span> ' + UI.eventText(an, ev) : '';

        // Profile (live axis of the session)
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
            if (!playing && sess.tCur >= sess.t1) seekTo(sess.t0);      // at the end: from the start
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

    /* Language switch: the toolbar of the replay map is built once */
    function relang() { if (ctl && ctl.relabel) ctl.relabel(); }

    return { open: open, close: close, wire: wire, isOpen: isOpen, relang: relang,
             _state: function () { return { sess: sess, playing: playing, target: target, speed: speed }; } };
})();
