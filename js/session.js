/* ============================================================
 * session.js -- eine aufgezeichnete Fahrt noch einmal durch die Auswertung laufen lassen
 * ============================================================
 * Fuettert die aufgezeichneten Positionen in dieselbe Analytics wie die
 * Live-Fahrt: gleiche Streckenachse, gleiche Rangfolge, Luecken, Ueberhol-
 * vorgaenge, Antritte, Anstiege. Damit ist das Replay keine Nachbildung,
 * sondern die echte Auswertung zu einem anderen Zeitpunkt.
 *
 * Die 2-s-Aufzeichnung wird dabei auf einen Takt (Standard 1 s) interpoliert,
 * wie ihn echtes GPS liefert -- die Analytics ist darauf abgestimmt.
 *
 * Fuer Segmente, Rekorde und die Zusammenfassung laeuft dasselbe ohne
 * Bildschirm einmal komplett durch (workAsync).
 * ============================================================ */

var Session = (function () {
    'use strict';

    var GAP_MS = 30000;      // laenger ohne Meldung = Fahrer hatte Funkloch, nicht interpolieren

    /* data: { me, riders: { id: { name, color, pts:[{t,lat,lon,ele}] } } } */
    function S(data) {
        this.meId = data.me || null;
        this.list = [];
        for (var id in data.riders) {
            var r = data.riders[id];
            if (r.pts && r.pts.length >= 2) this.list.push({ id: id, name: r.name || id, color: r.color || null,
                                                            emoji: r.emoji === undefined ? null : r.emoji, pts: r.pts });
        }
        var t0 = Infinity, t1 = -Infinity;
        this.list.forEach(function (r) {
            if (r.pts[0].t < t0) t0 = r.pts[0].t;
            if (r.pts[r.pts.length - 1].t > t1) t1 = r.pts[r.pts.length - 1].t;
        });
        this.t0 = t0; this.t1 = t1;
        this.reset();
    }

    S.solo = function (pts, id, name, color) {
        var o = { me: id || 'me', riders: {} };
        o.riders[o.me] = { name: name || 'Du', color: color || null, pts: pts };
        return new S(o);
    };

    S.prototype.reset = function () {
        this.route = new Route();
        this.an = new Analytics(this.route);
        this.tCur = this.t0 - 1000;
    };

    S.prototype.duration = function () { return this.t1 - this.t0; };

    /* Interpolierte Meldung eines Fahrers zur Zeit t, oder null (noch nicht gestartet /
       schon fertig / Funkloch). */
    S.prototype.sample = function (rd, t) {
        var p = rd.pts, n = p.length;
        if (t < p[0].t || t > p[n - 1].t) return null;
        var lo = 0, hi = n - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (p[m].t <= t) lo = m; else hi = m - 1; }
        var a = p[lo], b = p[Math.min(n - 1, lo + 1)], gap = b.t - a.t;
        if (gap > GAP_MS && (t - a.t) > 8000 && (b.t - t) > 8000) return null;
        var f = gap > 0 ? (t - a.t) / gap : 0;
        var d = Geo.distance(a.lat, a.lon, b.lat, b.lon);
        return {
            lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon),
            ele: (a.ele !== null && b.ele !== null) ? a.ele + f * (b.ele - a.ele) : a.ele,
            speed: gap > 0 ? d / (gap / 1000) : 0,
            heading: d > 0.5 ? Geo.bearing(a.lat, a.lon, b.lat, b.lon) : null
        };
    };

    S.prototype._feed = function (t) {
        var an = this.an, now = Date.now();
        for (var i = 0; i < this.list.length; i++) {
            var rd = this.list[i], s = this.sample(rd, t);
            if (!s) continue;
            an.ingest(rd.id, { lat: s.lat, lon: s.lon, ele: s.ele, speed: s.speed, heading: s.heading,
                               acc: 5, t: t, name: rd.name, color: rd.color, emoji: rd.emoji });
            if (rd.id === this.meId) an.riders[rd.id].self = true;
        }
        an.tick(t);
        // "Zuletzt gesehen" folgt der Replay-Zeit, nicht der Uhr: sonst gelten alle nach 15 s
        // Pause als "kein Signal", und beim Vorspulen wuerde niemand je verschwinden.
        for (var id in an.riders) an.riders[id].lastSeen = now - (t - an.riders[id].t);
    };

    /* Bis zum Zeitpunkt target (ms) vorrechnen, hoechstens budgetMs lang.
       Rueckgabe true = angekommen. Rueckwaerts geht nur ueber reset(). */
    S.prototype.work = function (target, step, budgetMs) {
        var start = performance.now(), st = step || 1000;
        while (this.tCur < target) {
            this.tCur = Math.min(target, this.tCur + st);
            this._feed(this.tCur);
            if (budgetMs && performance.now() - start > budgetMs) break;
        }
        return this.tCur >= target;
    };

    /* An eine beliebige Zeit springen. Rueckwaerts wird neu aufgebaut. */
    S.prototype.seek = function (t) {
        if (t < this.tCur) this.reset();
        return this;
    };

    /* Komplett durchrechnen, ohne die Oberflaeche zu blockieren. */
    S.prototype.workAsync = function (target, step, onProgress) {
        var self = this;
        return new Promise(function (resolve) {
            (function chunk() {
                var done = self.work(target, step, 12);
                if (onProgress) onProgress((self.tCur - self.t0) / Math.max(1, target - self.t0));
                if (done) resolve(self); else setTimeout(chunk, 0);
            })();
        });
    };

    return S;
})();
