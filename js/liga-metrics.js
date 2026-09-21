/* ============================================================
 * liga-metrics.js -- Liga-Kennzahlen einer gespeicherten Fahrt
 * ============================================================
 * Rechnet im Browser (der Server prueft nur, siehe api/rides.js) und baut den Upload:
 * Kennzahlen + kompakter Track + besuchte Kacheln.
 *
 * ALGO: Version dieser Berechnung. Wird ein Wert hier verbessert, ALGO erhoehen -- der Server
 * merkt sich die Version je Fahrt, und die App kann aeltere Fahrten neu berechnen.
 *
 * Nutzt vorhandene Bausteine: Track.stats (Strecke, Bewegungszeit, Hoehenmeter, Topspeed),
 * Segments.computeRecords (schnellste 10/20/40 km, beste Stunde) und die Gruppenauswertung
 * (Session) fuer Fuehrung, Antritte, Ausreisser und gemeinsames Fahren.
 * ============================================================ */

var LigaMetrics = (function () {
    'use strict';

    var ALGO = 1;
    var MAX_UPLOAD_POINTS = 39000;
    var VAM_WINDOW = 300000;          // 5 min
    var VAM_MIN_GAIN = 40;            // m
    var VAM_MIN_GRADE = 0.03;
    var VAM_MAX = 3000;               // darueber ist es Hoehenrauschen

    function two(n) { return (n < 10 ? '0' : '') + n; }
    function dayOf(t) { var d = new Date(t); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }

    /* Punkte mit strikt steigender Zeit; sehr lange Fahrten ausduennen (Server: max. 40000) */
    function clean(pts) {
        var out = [], last = -Infinity;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (!(p.t > last) || isNaN(p.lat) || isNaN(p.lon)) continue;
            out.push({ t: Math.round(p.t), lat: p.lat, lon: p.lon, ele: (p.ele === null || p.ele === undefined || isNaN(p.ele)) ? null : p.ele });
            last = p.t;
        }
        if (out.length > MAX_UPLOAD_POINTS) {
            var k = Math.ceil(out.length / MAX_UPLOAD_POINTS), thin = [];
            for (var j = 0; j < out.length; j += k) thin.push(out[j]);
            out = thin;
        }
        return out;
    }

    /* Beste Steigrate (Hoehenmeter je Stunde) ueber 5 Minuten mit >= 3 % Steigung.
       Hoehe wird ueber +-40 m Strecke gemittelt (rohe GPS-Hoehe rauscht um mehrere Meter). */
    function vam(pts) {
        var n = pts.length;
        if (n < 60) return null;
        for (var q = 0; q < n; q++) if (pts[q].ele === null) return null;
        var cum = Track.cumulative(pts), e = new Array(n), lo = 0, hi = 0, sum = 0;
        for (var i = 0; i < n; i++) {
            while (hi < n && cum[hi] <= cum[i] + 40) { sum += pts[hi].ele; hi++; }
            while (cum[lo] < cum[i] - 40) { sum -= pts[lo].ele; lo++; }
            e[i] = sum / (hi - lo);
        }
        var best = 0, j = 0;
        for (var a = 0; a < n; a += 3) {
            if (j < a) j = a;
            while (j < n - 1 && pts[j].t - pts[a].t < VAM_WINDOW) j++;
            if (pts[j].t - pts[a].t < VAM_WINDOW * 0.98) break;
            var gain = e[j] - e[a], d = cum[j] - cum[a];
            if (gain >= VAM_MIN_GAIN && d > 0 && gain / d >= VAM_MIN_GRADE) {
                var v = gain / ((pts[j].t - pts[a].t) / 3600000);
                if (v > best) best = v;
            }
        }
        return best > 0 && best <= VAM_MAX ? best : null;
    }

    /* Werte, die nur eine Gruppenfahrt hat. -> Promise<{front, attacks, escape, together}> */
    function groupValues(rec) {
        var g = Rides.getGroup(rec.id);
        if (!g) return Promise.resolve({});
        var data;
        try { data = Recorder.unpack(g); } catch (e) { return Promise.resolve({}); }
        if (!data || Object.keys(data.riders).length < 2 || !data.riders[data.me]) return Promise.resolve({});
        var sess = new Session(data);
        return sess.workAsync(sess.t1, 3000).then(function () {
            var an = sess.an, r = an.riders[data.me], out = {};
            if (!r) return out;
            out.front = Math.round(r.frontMs);
            out.attacks = an.events.filter(function (e) { return e.type === 'attack' && e.id === data.me; }).length;
            if (r.soloMax >= 20000) out.escape = Math.round(r.soloMax);
            if (r.togetherM > 0) out.together = Math.round(r.togetherM);
            return out;
        }, function () { return {}; });
    }

    /* Kaffeepausen: hoechstens eine je 15 Minuten (sonst gewinnt, wer am meisten tippt) */
    function coffee(rec) { return rec.x && rec.x.coffee > 0 ? Math.floor(rec.x.coffee) : 0; }
    function countCoffee(stamps) {
        var n = 0, last = -Infinity;
        stamps.slice().sort(function (a, b) { return a - b; }).forEach(function (t) { if (t - last >= 900000) { n++; last = t; } });
        return n;
    }

    /* Alle Werte ausser den Gruppenwerten. Rein synchron, fuer Tests gut zugaenglich. */
    function values(pts) {
        var st = Track.stats(pts), sm = Track.smooth(pts, 2), rc = Segments.computeRecords(sm), v = {};
        if (st.gain > 0) v.gain = Math.round(st.gain);
        if (rc.top > 0 && rc.top < 30) v.top = +rc.top.toFixed(2);
        if (st.dist >= 20000 && st.avg > 0) v.avg20 = +st.avg.toFixed(3);
        if (rc.d10000) v.t10k = Math.round(rc.d10000);
        if (rc.d20000) v.t20k = Math.round(rc.d20000);
        if (rc.d40000) v.t40k = Math.round(rc.d40000);
        if (rc.t3600000) v.avg1h = +(rc.t3600000 / 3600).toFixed(3);
        var va = vam(sm);
        if (va) v.vam = Math.round(va);
        return { stats: st, values: v };
    }

    /* Fahrt-ID auf dem Server: stabil je Konto und Startzeit, damit ein zweiter Upload harmlos ist */
    function sidOf(accountId, rec) {
        return LigaApi.sha256hex(new TextEncoder().encode(accountId + '|' + rec.start)).then(function (h) { return 'r' + h.slice(0, 23); });
    }

    /* rec: gespeicherte Fahrt (Rides.get) -> Promise<Upload-Koerper> */
    function build(rec, accountId) {
        var pts = clean(Rides.unpack(rec));
        if (pts.length < 40) return Promise.reject(new Error('Zu wenige Punkte.'));
        var m = values(pts);
        return Promise.all([sidOf(accountId, rec), groupValues(rec), LigaCodec.encode(pts)]).then(function (r) {
            var v = m.values, gv = r[1];
            for (var k in gv) if (gv[k] > 0) v[k] = gv[k];
            var c = coffee(rec); if (c > 0) v.coffee = c;
            return {
                id: r[0], name: rec.name, src: rec.src, day: dayOf(rec.start),
                dist: Math.round(m.stats.dist), moving: Math.max(1000, Math.round(m.stats.moving)),
                algo: ALGO, values: v, track: r[2],
                tiles: LigaCodec.toB64(LigaCodec.packTiles(LigaCodec.tilesOf(pts)))
            };
        });
    }

    /* Kopie fuer Mitglieder: Anfang und Ende (trim Meter) weg */
    function trimmed(rec, trim) {
        var pts = clean(Rides.unpack(rec)), cum = Track.cumulative(pts), tot = cum[cum.length - 1];
        var a = 0, b = pts.length - 1;
        while (a < b && cum[a] < trim) a++;
        while (b > a && tot - cum[b] < trim) b--;
        return pts.slice(a, b + 1);
    }

    return { ALGO: ALGO, countCoffee: countCoffee, values: values, build: build, clean: clean, trimmed: trimmed, sidOf: sidOf, dayOf: dayOf, vam: vam };
})();
