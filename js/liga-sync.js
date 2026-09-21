/* ============================================================
 * liga-sync.js -- upload rides, match segments, fetch the speedometer standing
 * ============================================================
 * Runs in the background and must never disturb the ride:
 *   - Uploads wait in a queue (localStorage) and are made up for when there is a network.
 *   - Only counts if you are logged in and in at least one league (otherwise nothing is sent).
 *   - What has been uploaded is in liga:up { local ride ID: { state, sid, reason } }.
 *       state: wait (in the queue) | ok | rej (server refuses, reason in reason)
 * ============================================================ */

var LigaSync = (function () {
    'use strict';

    var K_UP = 'liga:up', K_LEAGUES = 'liga:leagues', K_AUTO = 'liga:auto', K_TACHO = 'liga:tacho', K_ST = 'liga:st', K_SEG = 'liga:seg';
    var MAX_AGE = 395 * 86400000;
    var listeners = [], flushing = false;

    function read(k, d) { var v = LigaApi.read(k); return v === null || v === undefined ? d : v; }
    function write(k, v) { LigaApi.write(k, v); }
    function onChange(f) { listeners.push(f); }
    function changed() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

    function up() { return read(K_UP, {}); }
    function setUp(id, o) { var u = up(); if (o === null) delete u[id]; else u[id] = o; write(K_UP, u); }
    function status(id) { return up()[id] || null; }

    function leagues() { return read(K_LEAGUES, []); }
    function setLeagues(l) { write(K_LEAGUES, l); }
    function auto() { return read(K_AUTO, '1') !== '0'; }
    function setAuto(on) { write(K_AUTO, on ? '1' : '0'); }
    function active() { return !!LigaApi.account() && leagues().length > 0; }

    function eligible(rec) {
        return !!rec && (rec.src === 'ride' || rec.src === 'gpx') && rec.dur >= 120000 && rec.dist >= 500 &&
               rec.n >= 40 && Date.now() - rec.start < MAX_AGE;
    }

    /* ---- Uploads ---- */
    function enqueue(id) {
        var rec = Rides.get(id);
        if (!eligible(rec)) return false;
        var s = status(id);
        if (s && (s.state === 'ok' || s.state === 'rej')) return false;
        setUp(id, { state: 'wait' });
        return true;
    }

    /* After saving a ride: queue it and send it off */
    function rideSaved(rec) {
        if (!active() || !auto() || !rec) return Promise.resolve();
        if (enqueue(rec.id)) { changed(); return flush(); }
        return Promise.resolve();
    }

    /* Queue all previous rides that have not been sent yet */
    function backfill() {
        var n = 0;
        Rides.list().forEach(function (r) { if (enqueue(r.id)) n++; });
        changed();
        return n;
    }

    function pending() { var u = up(), n = 0; for (var k in u) if (u[k].state === 'wait') n++; return n; }

    function flush() {
        if (flushing || !LigaApi.account()) return Promise.resolve();
        flushing = true;
        var ids = Object.keys(up()).filter(function (k) { return up()[k].state === 'wait'; });
        function next() {
            var id = ids.shift();
            if (!id) return Promise.resolve();
            var rec = Rides.get(id);
            if (!rec) { setUp(id, null); return next(); }
            return LigaMetrics.build(rec, LigaApi.account().id).then(function (body) {
                return LigaApi.call('POST', '/api/rides', body).then(function (r) {
                    if (r.status === 200) { setUp(id, { state: 'ok', sid: body.id, dropped: r.dropped || [] }); changed(); return next(); }
                    if (r.status === 409 && r.reason === 'overlap') { setUp(id, { state: 'rej', reason: 'Zu dieser Zeit gibt es schon eine Fahrt.' }); changed(); return next(); }
                    if (r.status === 422) { setUp(id, { state: 'rej', reason: r.error }); changed(); return next(); }
                    return null;                                     // offline, 429, 401 ...: try again later
                });
            }, function (e) { setUp(id, { state: 'rej', reason: e.message || 'Auswertung fehlgeschlagen.' }); changed(); return next(); });
        }
        return next().then(function () { flushing = false; changed(); }, function () { flushing = false; });
    }

    /* Fetch the leagues of the account from the server and remember them */
    function loadLeagues() {
        if (!LigaApi.account()) { setLeagues([]); return Promise.resolve([]); }
        return LigaApi.call('GET', '/api/leagues').then(function (r) {
            if (r.status === 200) { setLeagues(r.leagues); changed(); return r.leagues; }
            return leagues();
        });
    }

    /* ---- League segments: match own rides against them and report the times ---- */
    function decodeSeg(s) {
        return LigaCodec.decode(s.poly, 3000).then(function (tr) {
            var p = tr.pts;
            return { id: s.id, len: s.len, a: { lat: p[0].lat, lon: p[0].lon }, b: { lat: p[p.length - 1].lat, lon: p[p.length - 1].lon },
                     poly: p.map(function (q) { return [q.lat, q.lon]; }) };
        });
    }
    function syncSegments(leagueId, segs) {
        var done = read(K_SEG, {}), u = up();
        var rides = Object.keys(u).filter(function (id) { return u[id].state === 'ok' && Rides.get(id); });
        function forSeg(i) {
            if (i >= segs.length) return Promise.resolve();
            var s = segs[i], key = leagueId + ':' + s.id, seen = done[key] || [];
            var todo = rides.filter(function (id) { return seen.indexOf(id) < 0; });
            if (!todo.length) return forSeg(i + 1);
            return decodeSeg(s).then(function (seg) {
                var efforts = [];
                todo.forEach(function (id) {
                    var rec = Rides.get(id), pts = Track.smooth(Rides.unpack(rec), 2), m = Segments.match(pts, seg);
                    if (m.length) efforts.push({ ride: u[id].sid, ms: Math.round(Math.min.apply(null, m.map(function (x) { return x.ms; }))) });
                });
                var send = efforts.length ? LigaApi.call('PUT', '/api/leagues/' + leagueId + '/segments/' + s.id + '/efforts', { efforts: efforts }) : Promise.resolve({ status: 200 });
                return send.then(function (r) {
                    if (r.status === 200) { done[key] = seen.concat(todo); write(K_SEG, done); return forSeg(i + 1); }
                });
            });
        }
        return forSeg(0);
    }

    /* ---- Speedometer line: chosen league and category ---- */
    function tacho() { return read(K_TACHO, null); }
    function setTacho(t) { write(K_TACHO, t); write(K_ST, null); changed(); }
    function standing() { return read(K_ST, null); }
    function fetchStanding() {
        var t = tacho();
        if (!t || !LigaApi.account()) return Promise.resolve(null);
        return LigaApi.call('GET', '/api/leagues/' + t.league + '/standing?cat=' + encodeURIComponent(t.cat)).then(function (r) {
            if (r.status === 200 && r.standing) {
                var s = { t: Date.now(), league: t.league, cat: t.cat, standing: r.standing, period: r.period };
                write(K_ST, s); return s;
            }
            if (r.status === 404) setTacho(null);                    // the league no longer exists
            return standing();
        });
    }

    return {
        eligible: eligible, status: status, up: up, enqueue: enqueue, rideSaved: rideSaved, backfill: backfill,
        pending: pending, flush: flush, auto: auto, setAuto: setAuto, active: active,
        leagues: leagues, loadLeagues: loadLeagues, onChange: onChange, syncSegments: syncSegments,
        tacho: tacho, setTacho: setTacho, standing: standing, fetchStanding: fetchStanding, setUp: setUp
    };
})();
