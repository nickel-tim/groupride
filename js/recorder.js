/* ============================================================
 * recorder.js -- die ganze Gruppe mitschreiben (fuer Replay, Zusammenfassung)
 * ============================================================
 * Zeichnet jeden Fahrer auf, den die App sieht: dich selbst und alle, deren
 * Meldungen ankommen. Ohne diese Aufzeichnung gaebe es nachher nur DEINE
 * Spur -- und keine Gruppenfahrt zum Abspielen.
 *
 * Kompakt, weil localStorage klein ist (~5 MB): eine Meldung alle 2 s,
 * Position auf ~1 m gerundet, alles als Differenz zur vorigen Meldung in
 * ganzen Zahlen. Rund 12 Byte je Punkt statt 35: drei Stunden mit fuenf
 * Fahrern sind etwa 170 KB. Der Ghost wird nicht aufgezeichnet.
 *
 * Format: { v:1, me, riders: [ { id, n, c, t0, d:[dt, dlat, dlon, dele, ...] } ] }
 *   dt   in Zehntelsekunden, dlat/dlon in 1e-5 Grad (~1,1 m), dele in Dezimetern
 *   Der erste Punkt steht ausgeschrieben in t0/la0/lo0/e0.
 * ============================================================ */

var Recorder = (function () {
    'use strict';

    var MIN_GAP = 1800;                 // ms zwischen zwei gespeicherten Punkten je Fahrer
    var data = {};                      // id -> { n, c, pts: [{t, lat, lon, ele}] }
    var meId = null;

    function reset(me) { data = {}; meId = me || null; }

    function add(id, name, color, t, lat, lon, ele, emoji) {
        var r = data[id];
        if (!r) r = data[id] = { n: name || id, c: color || null, j: null, pts: [] };
        if (name) r.n = name;
        if (color) r.c = color;
        if (emoji !== undefined) r.j = emoji;
        var last = r.pts[r.pts.length - 1];
        if (last && t - last.t < MIN_GAP) return;
        if (last && t <= last.t) return;            // Zeit muss weiterlaufen
        r.pts.push({ t: t, lat: lat, lon: lon, ele: (ele === null || ele === undefined || isNaN(ele)) ? null : ele });
    }

    function riderCount() {
        var n = 0;
        for (var id in data) if (data[id].pts.length >= 2) n++;
        return n;
    }

    function pack() {
        var out = { v: 1, me: meId, riders: [] };
        for (var id in data) {
            var r = data[id], p = r.pts;
            if (p.length < 2) continue;
            var d = [], q = { lat: Math.round(p[0].lat * 1e5), lon: Math.round(p[0].lon * 1e5),
                              ele: Math.round((p[0].ele || 0) * 10), t: p[0].t }, hasEle = p[0].ele !== null;
            var e0 = { id: id, n: r.n, c: r.c, j: r.j, t0: p[0].t, la0: q.lat, lo0: q.lon, e0: q.ele, ne: hasEle ? 1 : 0, d: d };
            for (var i = 1; i < p.length; i++) {
                var lat = Math.round(p[i].lat * 1e5), lon = Math.round(p[i].lon * 1e5);
                var ele = Math.round((p[i].ele === null ? (q.ele / 10) : p[i].ele) * 10);
                d.push(Math.max(1, Math.round((p[i].t - q.t) / 100)), lat - q.lat, lon - q.lon, ele - q.ele);
                q = { lat: lat, lon: lon, ele: ele, t: q.t + Math.max(1, Math.round((p[i].t - q.t) / 100)) * 100 };
            }
            out.riders.push(e0);
        }
        return out;
    }

    /* -> { me, riders: { id: { name, color, pts: [{t, lat, lon, ele}] } } } */
    function unpack(g) {
        var out = { me: g.me, riders: {} };
        g.riders.forEach(function (r) {
            var lat = r.la0, lon = r.lo0, ele = r.e0, t = r.t0, d = r.d;
            var pts = [{ t: t, lat: lat / 1e5, lon: lon / 1e5, ele: r.ne ? ele / 10 : null }];
            for (var i = 0; i < d.length; i += 4) {
                t += d[i] * 100; lat += d[i + 1]; lon += d[i + 2]; ele += d[i + 3];
                pts.push({ t: t, lat: lat / 1e5, lon: lon / 1e5, ele: r.ne ? ele / 10 : null });
            }
            out.riders[r.id] = { name: r.n, color: r.c, emoji: r.j === undefined ? null : r.j, pts: pts };
        });
        return out;
    }

    return { reset: reset, add: add, pack: pack, unpack: unpack, riderCount: riderCount };
})();
