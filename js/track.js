/* ============================================================
 * track.js -- Werkzeuge fuer eine Spur: [{t (ms), lat, lon, ele|null}]
 * ============================================================
 * Gemeinsame Grundlage fuer Segmente, Rekorde, Zusammenfassung und
 * Replay: Strecke, Tempo und Hoehenmeter einer Fahrt, alles aus den
 * Positionen mit Zeit. Nichts davon haengt an der Live-Auswertung.
 * ============================================================ */

var Track = (function () {
    'use strict';

    /* Rauschen aus der Spur nehmen, bevor man ihre Laenge misst. Ein GPS-Fix
       springt um +-4 m; bei 1 Hz addieren diese Zacken rund 20-25 % Weg dazu
       (eine 6-km-Runde "ist" dann 7,4 km lang) -- das verfaelscht Distanz-
       Rekorde, Segmentlaengen und Tempo. Gleitender Mittelwert ueber
       2*half+1 Punkte auf Lat/Lon; Zeit und Hoehe bleiben unberuehrt.
       Am Rand wird das Fenster kleiner, damit Anfang und Ende stehen bleiben. */
    function smooth(pts, half) {
        var h = half === undefined ? 2 : half, n = pts.length, out = new Array(n);
        for (var i = 0; i < n; i++) {
            var w = Math.min(h, i, n - 1 - i), sl = 0, sn = 0;
            for (var j = i - w; j <= i + w; j++) { sl += pts[j].lat; sn += pts[j].lon; }
            out[i] = { t: pts[i].t, lat: sl / (2 * w + 1), lon: sn / (2 * w + 1), ele: pts[i].ele };
        }
        return out;
    }

    /* Kumulierte Strecke in Metern; cum[i] gehoert zu pts[i]. */
    function cumulative(pts) {
        var c = new Array(pts.length), d = 0;
        for (var i = 0; i < pts.length; i++) {
            if (i) d += Geo.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
            c[i] = d;
        }
        return c;
    }

    /* Index i mit cum[i] <= d < cum[i+1] */
    function idxAt(cum, d) {
        var lo = 0, hi = cum.length - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (cum[m] <= d) lo = m; else hi = m - 1; }
        return lo;
    }

    /* Zeit (ms) und Ort bei der Strecke d, linear zwischen den Punkten. */
    function atDistance(pts, cum, d) {
        var n = pts.length;
        if (d <= 0) return { t: pts[0].t, lat: pts[0].lat, lon: pts[0].lon, ele: pts[0].ele };
        if (d >= cum[n - 1]) { var l = pts[n - 1]; return { t: l.t, lat: l.lat, lon: l.lon, ele: l.ele }; }
        var i = idxAt(cum, d), a = pts[i], b = pts[i + 1], span = cum[i + 1] - cum[i];
        var f = span > 0 ? (d - cum[i]) / span : 0;
        return { t: a.t + f * (b.t - a.t), lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon),
                 ele: (a.ele !== null && b.ele !== null) ? a.ele + f * (b.ele - a.ele) : a.ele };
    }

    /* Ort zur Zeit t (ms), linear; null ausserhalb der Spur. */
    function atTime(pts, t) {
        var n = pts.length;
        if (!n || t < pts[0].t || t > pts[n - 1].t) return null;
        var lo = 0, hi = n - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (pts[m].t <= t) lo = m; else hi = m - 1; }
        var a = pts[lo], b = pts[Math.min(n - 1, lo + 1)], span = b.t - a.t, f = span > 0 ? (t - a.t) / span : 0;
        return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon),
                 ele: (a.ele !== null && b.ele !== null) ? a.ele + f * (b.ele - a.ele) : a.ele, i: lo };
    }

    /* Hoehenmeter: Achse aufbauen, Hoehe ueber 100 m glaetten (die rohe GPS-Hoehe
       rauscht um mehrere Meter -- ohne Glaettung "steigt" jede Fahrt auf ebener
       Strecke), dann nur die Anstiege summieren. */
    function gain(pts) {
        var r = Route.fromPoints(pts, 10);
        if (r.pts.length < 3) return 0;
        r.smoothElevation();
        var g = 0, prev = null;
        for (var i = 0; i < r.pts.length; i++) {
            var e = r.pts[i].eleS;
            if (e === null || e === undefined) continue;
            if (prev !== null && e > prev) g += e - prev;
            prev = e;
        }
        return g;
    }

    /* Tempo ueber ein Zeitfenster (m/s), damit ein einzelner Ausreisser-Fix keine
       Spitzengeschwindigkeit vortaeuscht. */
    function topSpeed(pts, cum, windowMs) {
        var w = windowMs || 5000, best = 0, j = 0;
        for (var i = 0; i < pts.length; i++) {
            while (j < pts.length - 1 && pts[j + 1].t - pts[i].t <= w) j++;
            var dt = pts[j].t - pts[i].t;
            if (dt >= w * 0.6) best = Math.max(best, (cum[j] - cum[i]) / (dt / 1000));
        }
        return best;
    }

    /* Bewegungszeit: Abschnitte unter 1 m/s (Ampel, Café) zaehlen nicht. */
    function movingMs(pts) {
        var ms = 0;
        for (var i = 1; i < pts.length; i++) {
            var dt = pts[i].t - pts[i - 1].t;
            if (dt <= 0 || dt > 20000) continue;
            var d = Geo.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
            if (d / (dt / 1000) >= 1) ms += dt;
        }
        return ms;
    }

    function stats(pts) {
        if (!pts || pts.length < 2) return { dist: 0, dur: 0, moving: 0, avg: 0, max: 0, gain: 0 };
        pts = smooth(pts, 2);
        var cum = cumulative(pts), dist = cum[cum.length - 1];
        var dur = pts[pts.length - 1].t - pts[0].t, moving = movingMs(pts);
        return { dist: dist, dur: dur, moving: moving, avg: moving ? dist / (moving / 1000) : 0,
                 max: topSpeed(pts, cum), gain: gain(pts) };
    }

    /* Punkte mit mindestens minM Abstand (Anfang und Ende bleiben). */
    function thin(pts, minM) {
        var out = [], last = null;
        for (var i = 0; i < pts.length; i++) {
            if (!last || i === pts.length - 1 || Geo.distance(last.lat, last.lon, pts[i].lat, pts[i].lon) >= minM) {
                out.push(pts[i]); last = pts[i];
            }
        }
        return out;
    }

    return { smooth: smooth, cumulative: cumulative, idxAt: idxAt, atDistance: atDistance, atTime: atTime,
             gain: gain, topSpeed: topSpeed, movingMs: movingMs, stats: stats, thin: thin };
})();
