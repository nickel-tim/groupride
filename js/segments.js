/* ============================================================
 * segments.js -- Segmente, Bestzeiten und Rekorde ueber alle Fahrten
 * ============================================================
 * Ein Segment ist ein Stueck Strecke mit Anfang, Ende und Verlauf. Faehrt man
 * es erneut, wird die Zeit verglichen -- so entstehen Bestzeiten je Anstieg
 * oder je selbst angelegtem Abschnitt.
 *
 * Woher Segmente kommen
 *   - automatisch: jeder erkannte Anstieg (aus der Auswertung derselben Fahrt)
 *   - von Hand:    ein Abschnitt einer gespeicherten Fahrt
 * Zusaetzlich gibt es Rekorde ohne Ort: schnellste 1/5/10/20/40 km,
 * beste 5 und 20 Minuten, Spitzentempo, meiste Hoehenmeter, laengste Fahrt.
 *
 * Wiedererkennen: eine Fahrt zaehlt als "Segment gefahren", wenn sie in der
 * Naehe des Anfangs beginnt, in der Naehe des Endes ankommt, dazwischen dem
 * Verlauf folgt und die Strecke ungefaehr stimmt. Die Zeit wird aus dem
 * Punkt kuerzester Annaeherung an Anfang und Ende interpoliert -- bei
 * GPS-Rauschen (+-4 m) und 1-s-Takt bleibt sie auf etwa +-1-2 s genau.
 *
 * Simulation und echte Fahrten sind getrennte "Welten": eine erfundene Runde
 * soll keine echten Bestzeiten verdraengen.
 * ============================================================ */

var Segments = (function () {
    'use strict';

    var ENTRY   = 35;      // m: so nah muss man an Anfang bzw. Ende kommen
    var MAXDEV  = 32;      // m: mittlere Abweichung vom Verlauf
    var MAXPEAK = 90;      // m: groesste Abweichung vom Verlauf
    var MAX_EFFORTS = 60;
    var world = 'real';

    var RECORDS = [
        { key: 'd1000',   label: 'Schnellster Kilometer',   kind: 'time' },
        { key: 'd5000',   label: 'Schnellste 5 km',         kind: 'time' },
        { key: 'd10000',  label: 'Schnellste 10 km',        kind: 'time' },
        { key: 'd20000',  label: 'Schnellste 20 km',        kind: 'time' },
        { key: 'd40000',  label: 'Schnellste 40 km',        kind: 'time' },
        { key: 't300000', label: 'Beste 5 Minuten',         kind: 'dist', win: 300000 },
        { key: 't1200000',label: 'Beste 20 Minuten',        kind: 'dist', win: 1200000 },
        { key: 'top',     label: 'Spitzentempo (5 s)',      kind: 'speed' },
        { key: 'gain',    label: 'Meiste Höhenmeter',       kind: 'gain' },
        { key: 'dist',    label: 'Längste Fahrt',           kind: 'len' }
    ];

    function key(k) { return 'seg:' + world + ':' + k; }
    function read(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function write(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); return true; } catch (e) { return false; } }
    function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

    function use(w) { world = (w === 'sim') ? 'sim' : 'real'; }
    function current() { return world; }
    function worldOf(src) { return src === 'sim' ? 'sim' : 'real'; }

    function list() { return read(key('index')) || []; }
    function saveAll(l) { return write(key('index'), l); }
    function get(id) { return list().filter(function (s) { return s.id === id; })[0] || null; }
    function bests() { return read(key('bests')) || {}; }

    function remove(id) { saveAll(list().filter(function (s) { return s.id !== id; })); }
    function rename(id, name) {
        var l = list();
        l.forEach(function (s) { if (s.id === id) s.name = name; });
        saveAll(l);
    }

    /* ---------- Geometrie ---------- */
    function polyDist(px, py, poly) {
        var best = Infinity;
        for (var i = 0; i < poly.length - 1; i++) {
            var pr = Geo.projectOnSegment(px, py, poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y);
            if (pr.dist < best) best = pr.dist;
        }
        return best;
    }

    /* Zeit der kuerzesten Annaeherung an den Punkt P, zwischen den Spurpunkten
       um idx herum (xy: dieselbe Ebene wie P). */
    function timeAtClosest(pts, xy, idx, P) {
        var best = null;
        for (var i = Math.max(0, idx - 1); i <= Math.min(pts.length - 2, idx); i++) {
            var pr = Geo.projectOnSegment(P.x, P.y, xy[i].x, xy[i].y, xy[i + 1].x, xy[i + 1].y);
            var t = Math.max(0, Math.min(1, pr.t));
            if (best === null || pr.dist < best.dist) best = { dist: pr.dist, t: pts[i].t + t * (pts[i + 1].t - pts[i].t) };
        }
        return best ? best.t : pts[idx].t;
    }

    /* Segment aus einem Stueck einer Spur (Indizes iA..iB) */
    function fromSection(pts, iA, iB, name, kind, auto) {
        var sec = pts.slice(iA, iB + 1);
        var len = Track.cumulative(sec); len = len[len.length - 1];
        var thin = Track.thin(sec, Math.max(8, len / 40));
        var g = Track.gain(sec);
        return {
            id: newId(), name: name, kind: kind || 'custom', auto: !!auto,
            len: Math.round(len), gain: Math.round(g * 10) / 10, grade: len > 0 ? g / len : 0,
            a: { lat: sec[0].lat, lon: sec[0].lon }, b: { lat: sec[sec.length - 1].lat, lon: sec[sec.length - 1].lon },
            poly: thin.map(function (p) { return [+p.lat.toFixed(6), +p.lon.toFixed(6)]; }),
            efforts: [], created: Date.now()
        };
    }

    /* ---------- Wiedererkennen ---------- */
    /* Alle Durchfahrten von seg in der Spur pts. -> [{tStart, tEnd, ms, iA, iB, splits}] */
    function match(pts, seg, cum) {
        var n = pts.length;
        if (n < 3 || seg.len < 100) return [];
        cum = cum || Track.cumulative(pts);
        var fr = Geo.frame(seg.a.lat, seg.a.lon);
        var A = fr.toXY(seg.a.lat, seg.a.lon), B = fr.toXY(seg.b.lat, seg.b.lon);
        var poly = seg.poly.map(function (q) { return fr.toXY(q[0], q[1]); });
        var xy = pts.map(function (p) { return fr.toXY(p.lat, p.lon); });
        function dA(i) { return Math.hypot(xy[i].x - A.x, xy[i].y - A.y); }
        function dB(i) { return Math.hypot(xy[i].x - B.x, xy[i].y - B.y); }

        var out = [], i = 0;
        while (i < n) {
            if (dA(i) > ENTRY) { i++; continue; }
            // zusammenhaengende Naehe am Anfang: der Punkt kuerzester Annaeherung zaehlt
            var iMin = i, dMin = dA(i), k = i;
            while (k < n && dA(k) <= ENTRY) { var d = dA(k); if (d < dMin) { dMin = d; iMin = k; } k++; }

            // Ende suchen: hoechstens 1,6x so lang wie das Segment
            var jBest = -1, j = iMin + 1, maxLen = 1.6 * seg.len;
            while (j < n && cum[j] - cum[iMin] <= maxLen) {
                if (dB(j) <= ENTRY) {
                    var jm = j, dm = dB(j), q = j;
                    while (q < n && dB(q) <= ENTRY && cum[q] - cum[iMin] <= maxLen) { var e = dB(q); if (e < dm) { dm = e; jm = q; } q++; }
                    if (cum[jm] - cum[iMin] >= 0.7 * seg.len) { jBest = jm; break; }
                    j = q;
                } else j++;
            }
            if (jBest < 0) { i = k; continue; }

            // folgt die Fahrt dem Verlauf? (mittlere und groesste Abweichung)
            var step = Math.max(1, Math.floor((jBest - iMin) / 25)), sum = 0, cnt = 0, peak = 0, gapOk = true;
            for (var m = iMin; m <= jBest; m += step) {
                var dd = polyDist(xy[m].x, xy[m].y, poly); sum += dd; cnt++; if (dd > peak) peak = dd;
            }
            for (var g = iMin + 1; g <= jBest; g++) if (pts[g].t - pts[g - 1].t > 60000) { gapOk = false; break; }
            var ratio = (cum[jBest] - cum[iMin]) / seg.len;
            if (!gapOk || sum / cnt > MAXDEV || peak > MAXPEAK || ratio < 0.7 || ratio > 1.4) { i = k; continue; }

            var t0 = timeAtClosest(pts, xy, iMin, A), t1 = timeAtClosest(pts, xy, jBest, B), ms = t1 - t0;
            var avg = seg.len / (ms / 1000);
            if (ms > 1000 && avg >= 0.8 && avg <= 25) {
                var d0 = cum[iMin], tot = cum[jBest] - d0, splits = [];
                for (var f = 1; f <= 10; f++) splits.push(Math.round(Track.atDistance(pts, cum, d0 + tot * f / 10).t - t0));
                out.push({ tStart: t0, tEnd: t1, ms: ms, iA: iMin, iB: jBest, splits: splits });
            }
            i = jBest + 1;
        }
        return out;
    }

    /* Durchfahrt in die Liste der Bestzeiten eintragen; liefert Vergleich zur bisherigen Bestzeit. */
    function addEffort(seg, rideId, rideName, m, count) {
        var prev = seg.efforts.filter(function (e) { return e.ride !== rideId; });
        var prevBest = prev.length ? Math.min.apply(null, prev.map(function (e) { return e.ms; })) : null;
        var effort = { ride: rideId, rname: rideName, t: m.tStart, ms: Math.round(m.ms),
                       kmh: seg.len / (m.ms / 1000) * 3.6, vam: seg.gain > 0 ? seg.gain / (m.ms / 3600000) : 0,
                       splits: m.splits, n: count || 1 };
        seg.efforts = prev.concat([effort]).sort(function (a, b) { return a.t - b.t; }).slice(-MAX_EFFORTS);
        var rank = prev.filter(function (e) { return e.ms < effort.ms; }).length + 1;
        return { seg: seg, effort: effort, prevBest: prevBest, first: prevBest === null,
                 isPB: prevBest === null || effort.ms < prevBest, rank: rank, of: prev.length + 1,
                 delta: prevBest === null ? null : effort.ms - prevBest };
    }

    function bestOf(seg) {
        if (!seg.efforts.length) return null;
        return seg.efforts.reduce(function (a, b) { return b.ms < a.ms ? b : a; });
    }

    /* Ist "cand" dasselbe Stueck Strasse wie "seg"? Die Grenzen eines erkannten Anstiegs
       schwanken von Fahrt zu Fahrt um ein paar Dutzend Meter -- deshalb zaehlt nicht
       Anfang/Ende, sondern die Ueberlappung des Verlaufs, in derselben Fahrtrichtung. */
    function overlapFrac(p, q) {
        var fr = Geo.frame(q.poly[0][0], q.poly[0][1]);
        var qxy = q.poly.map(function (c) { return fr.toXY(c[0], c[1]); }), hit = 0;
        p.poly.forEach(function (c) {
            var xy = fr.toXY(c[0], c[1]);
            if (polyDist(xy.x, xy.y, qxy) <= 30) hit++;
        });
        return hit / p.poly.length;
    }
    function similar(cand, seg) {
        var dAA = Geo.distance(cand.a.lat, cand.a.lon, seg.a.lat, seg.a.lon);
        var dAB = Geo.distance(cand.a.lat, cand.a.lon, seg.b.lat, seg.b.lon);
        if (dAB < dAA) return false;                        // gegenlaeufig: die Abfahrt ist ein anderes Segment
        var f1 = overlapFrac(cand, seg), f2 = overlapFrac(seg, cand);
        // deckungsgleich, oder eines liegt (fast) ganz im anderen: dann kein neues Segment
        return (f1 >= 0.6 && f2 >= 0.6) || f1 >= 0.8 || f2 >= 0.8;
    }

    /* ---------- Rekorde ohne Ort ---------- */
    function cumAtTime(pts, cum, t) {
        var lo = 0, hi = pts.length - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (pts[m].t <= t) lo = m; else hi = m - 1; }
        var a = pts[lo], b = pts[Math.min(pts.length - 1, lo + 1)], span = b.t - a.t;
        return cum[lo] + (span > 0 ? (t - a.t) / span : 0) * (cum[Math.min(pts.length - 1, lo + 1)] - cum[lo]);
    }

    function computeRecords(pts) {
        var n = pts.length, cum = Track.cumulative(pts), dist = cum[n - 1], out = {};
        [1000, 5000, 10000, 20000, 40000].forEach(function (L) {
            if (dist < L) return;
            var best = Infinity;
            for (var i = 0; i < n; i++) {
                if (cum[i] + L > dist) break;
                var ms = Track.atDistance(pts, cum, cum[i] + L).t - pts[i].t;
                if (ms < best) best = ms;
            }
            if (best < Infinity) out['d' + L] = best;
        });
        [300000, 1200000].forEach(function (W) {
            var total = pts[n - 1].t - pts[0].t;
            if (total < W) return;
            var best = 0;
            for (var i = 0; i < n; i++) {
                if (pts[i].t + W > pts[n - 1].t) break;
                var d = cumAtTime(pts, cum, pts[i].t + W) - cum[i];
                if (d > best) best = d;
            }
            if (best > 0) out['t' + W] = best;
        });
        var top = Track.topSpeed(pts, cum, 5000);
        if (top > 0 && top < 30) out.top = top;                 // >108 km/h ist ein GPS-Fehler
        out.gain = Track.gain(pts);
        out.dist = dist;
        return out;
    }

    function better(kind, a, b) { return kind === 'time' ? a < b : a > b; }     // a besser als b?

    function updateRecords(pts, rec, store) {
        var vals = computeRecords(pts), changed = [];
        RECORDS.forEach(function (R) {
            var v = vals[R.key];
            if (v === undefined) return;
            var old = store[R.key];
            if (!old || better(R.kind, v, old.v)) {
                store[R.key] = { v: v, ride: rec.id, rname: rec.name, t: rec.start };
                changed.push({ key: R.key, label: R.label, kind: R.kind, now: v, before: old ? old.v : null });
            }
        });
        return changed;
    }

    // Gespeicherte Fahrt als geglaettete Spur (siehe Track.smooth: sonst waeren alle Wege ~25 % zu lang)
    function trackOf(rec) { return Track.smooth(Rides.unpack(rec), 2); }

    /* ---------- Auswertung einer Fahrt ---------- */
    /* Erkennt neue Anstiege, findet bekannte Segmente wieder, fuehrt Rekorde nach.
       Rueckgabe: { world, newSegments, efforts, records } */
    function processRide(rec, opts) {
        opts = opts || {};
        if (rec.src === 'plan') return Promise.resolve(null);
        use(worldOf(rec.src));
        var pts = trackOf(rec);
        if (pts.length < 20) return Promise.resolve(null);
        var cum = Track.cumulative(pts), report = { world: world, newSegments: [], efforts: [], records: [] };
        var segs = list();

        function finish() {
            segs.forEach(function (seg) {
                var ms = match(pts, seg, cum);
                if (!ms.length) return;
                var best = ms.reduce(function (a, b) { return b.ms < a.ms ? b : a; });
                report.efforts.push(addEffort(seg, rec.id, rec.name, best, ms.length));
            });
            saveAll(segs);
            var st = bests();
            report.records = updateRecords(pts, rec, st);
            write(key('bests'), st);
            return report;
        }

        if (opts.detect === false) return Promise.resolve(finish());

        // Anstiege dieser Fahrt: dieselbe Auswertung wie live, allein mit deiner Spur
        var sess = Session.solo(pts, 'me', 'Du');
        return sess.workAsync(sess.t1, 3000, opts.onProgress).then(function () {
            var climbs = sess.an.scanClimbs(), added = 0;
            climbs.forEach(function (c) {
                if ((c.len || 0) < 300 || (c.gain || 0) < 20) return;
                var ax = sess.route.pts.filter(function (p) { return p.s >= c.sStart && p.s <= c.sEnd; });
                if (ax.length < 4) return;
                var cand = fromSection(ax.map(function (p) { return { lat: p.lat, lon: p.lon, ele: p.ele, t: 0 }; }),
                                       0, ax.length - 1, '', 'climb', true);
                if (segs.some(function (s) { return similar(cand, s); })) return;
                added++;
                cand.name = 'Anstieg ' + (segs.filter(function (s) { return s.kind === 'climb'; }).length + 1) +
                            ' (+' + Math.round(cand.gain) + ' Hm)';
                segs.push(cand); report.newSegments.push(cand);
            });
            return finish();
        });
    }

    /* Nach dem Anlegen eines Segments: in allen gespeicherten Fahrten dieser Welt suchen. */
    function backfill(seg) {
        var found = 0;
        Rides.list().forEach(function (r) {
            if (r.src === 'plan' || worldOf(r.src) !== world) return;
            var rec = Rides.get(r.id); if (!rec) return;
            var pts = trackOf(rec), ms = match(pts, seg);
            if (!ms.length) return;
            var best = ms.reduce(function (a, b) { return b.ms < a.ms ? b : a; });
            addEffort(seg, rec.id, rec.name, best, ms.length); found++;
        });
        return found;
    }

    function addSegment(seg) {
        var l = list(); l.push(seg); saveAll(l);
        var found = backfill(seg);
        var l2 = list().map(function (s) { return s.id === seg.id ? seg : s; }); saveAll(l2);
        return found;
    }

    /* Eine Fahrt wurde geloescht: ihre Durchfahrten weg, Rekorde neu bestimmen. */
    function forgetRide(id, srcOfRide) {
        use(worldOf(srcOfRide));
        var l = list();
        l.forEach(function (s) { s.efforts = s.efforts.filter(function (e) { return e.ride !== id; }); });
        saveAll(l);
        var st = bests(), stale = false;
        for (var k in st) if (st[k].ride === id) stale = true;
        if (!stale) return;
        var fresh = {};
        Rides.list().forEach(function (r) {
            if (r.id === id || r.src === 'plan' || worldOf(r.src) !== world) return;
            var rec = Rides.get(r.id); if (!rec) return;
            updateRecords(trackOf(rec), rec, fresh);
        });
        write(key('bests'), fresh);
    }

    /* Fortschritt entlang des Segmentverlaufs (Meter). Die rohe Wegstrecke taugt dafuer nicht:
       GPS-Rauschen (+-4 m je Fix) addiert bei langsamer Fahrt bergauf ein Vielfaches der echten
       Strecke -- das Segment wirkte dann schon nach der Haelfte "fast fertig". Die Projektion
       der Position auf den Verlauf ist davon unabhaengig. */
    function polyInfo(seg) {
        var fr = Geo.frame(seg.a.lat, seg.a.lon);
        var xy = seg.poly.map(function (q) { return fr.toXY(q[0], q[1]); }), cum = [0];
        for (var i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
        return { fr: fr, xy: xy, cum: cum, len: cum[cum.length - 1] || seg.len };
    }
    function progressOn(pi, lat, lon) {
        var p = pi.fr.toXY(lat, lon), best = null;
        for (var i = 0; i < pi.xy.length - 1; i++) {
            var pr = Geo.projectOnSegment(p.x, p.y, pi.xy[i].x, pi.xy[i].y, pi.xy[i + 1].x, pi.xy[i + 1].y);
            var t = Math.max(0, Math.min(1, pr.t));
            if (!best || pr.dist < best.dist) best = { dist: pr.dist, s: pi.cum[i] + t * (pi.cum[i + 1] - pi.cum[i]) };
        }
        return best;
    }

    /* ---------- Live: Zeit auf dem Segment waehrend der Fahrt ---------- */
    /* update({lat, lon, t}) -> Ereignisse. Der Live-Wert ist vorlaeufig (+-1-3 s):
       er startet beim ersten Fix nahe am Anfang. Massgeblich ist die Auswertung
       nach der Fahrt (processRide), die den Punkt kuerzester Annaeherung nutzt. */
    function live(w) {
        var st = {}, lastFix = null, ended = {}, lw = (w === 'sim') ? 'sim' : 'real';
        return {
            update: function (fix) {
                var prevWorld = world;          // die Ansicht darf inzwischen eine andere Welt zeigen
                use(lw);
                try { return step(fix); } finally { use(prevWorld); }
            }
        };
        function step(fix) {
            var ev = [], segs = list();
            segs.forEach(function (seg) {
                if (seg.len < 100) return;
                var s = st[seg.id];
                var dA = Geo.distance(fix.lat, fix.lon, seg.a.lat, seg.a.lon);
                var dB = Geo.distance(fix.lat, fix.lon, seg.b.lat, seg.b.lon);
                if (!s) {
                    if (dA <= ENTRY && !(ended[seg.id] && fix.t - ended[seg.id] < 90000)) {
                        st[seg.id] = { t0: fix.t, prog: 0, off: 0, min: dA, pi: polyInfo(seg) };
                        ev.push({ type: 'start', seg: seg, elapsed: 0, frac: 0, left: seg.len, delta: null, best: (bestOf(seg) || {}).ms || null });
                    }
                    return;
                }
                var pi = s.pi, pr = progressOn(pi, fix.lat, fix.lon);
                if (pr.dist <= 60) s.prog = Math.max(s.prog, pr.s);
                if (s.prog < 30 && dA < s.min) { s.t0 = fix.t; s.min = dA; }    // noch am Start: naeher dran = spaeter loslegen
                var fr = Math.min(1, s.prog / pi.len), elapsed = fix.t - s.t0;
                var best = bestOf(seg), delta = null;
                if (best && best.splits && fr > 0.05) {
                    var pos = fr * 10, lo = Math.min(9, Math.floor(pos)), a = lo === 0 ? 0 : best.splits[lo - 1], b = best.splits[lo];
                    delta = elapsed - (a + (pos - lo) * (b - a));
                }
                if (dB <= ENTRY && s.prog >= 0.8 * pi.len) {
                    var ms = fix.t - s.t0;
                    ended[seg.id] = fix.t; delete st[seg.id];
                    ev.push({ type: 'finish', seg: seg, ms: ms, best: best ? best.ms : null,
                              isPB: !best || ms < best.ms, delta: best ? ms - best.ms : null });
                    return;
                }
                s.off = pr.dist > 150 ? s.off + 1 : 0;
                if (s.off >= 5 || elapsed > 3 * 3600 * 1000) { delete st[seg.id]; ev.push({ type: 'abort', seg: seg }); return; }
                ev.push({ type: 'progress', seg: seg, elapsed: elapsed, frac: fr, left: Math.max(0, pi.len - s.prog),
                          delta: delta, best: best ? best.ms : null });
            });
            lastFix = fix;
            return ev;
        }
    }

    return {
        RECORDS: RECORDS,
        use: use, current: current, worldOf: worldOf,
        list: list, get: get, remove: remove, rename: rename, bests: bests,
        fromSection: fromSection, addSegment: addSegment, bestOf: bestOf,
        match: match, processRide: processRide, forgetRide: forgetRide, live: live, trackOf: trackOf,
        computeRecords: computeRecords
    };
})();
