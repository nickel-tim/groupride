/* ============================================================
 * session.js -- run a recorded ride through the analysis once more
 * ============================================================
 * Feeds the recorded positions into the same Analytics as the
 * live ride: same route axis, same ranking, gaps, overtaking,
 * attacks, climbs. That makes the replay no re-enactment
 * but the real analysis at a different point in time.
 *
 * The 2 s recording is interpolated to a beat (default 1 s)
 * as real GPS delivers it -- the analytics is tuned for that.
 *
 * For segments, records and the summary the same runs through completely
 * once without a screen (workAsync).
 * ============================================================ */

var Session = (function () {
    'use strict';

    var GAP_MS = 30000;      // longer without a report = rider had a radio gap, do not interpolate

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

    /* Interpolated report of a rider at time t, or null (not started yet /
       already finished / radio gap). */
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
        // "Last seen" follows the replay time, not the clock: otherwise everybody counts after 15 s
        // of pause as "no signal", and when fast-forwarding nobody would ever disappear.
        for (var id in an.riders) an.riders[id].lastSeen = now - (t - an.riders[id].t);
    };

    /* Compute ahead to time target (ms), for budgetMs at most.
       Returns true = arrived. Going backwards only works via reset(). */
    S.prototype.work = function (target, step, budgetMs) {
        var start = performance.now(), st = step || 1000;
        while (this.tCur < target) {
            this.tCur = Math.min(target, this.tCur + st);
            this._feed(this.tCur);
            if (budgetMs && performance.now() - start > budgetMs) break;
        }
        return this.tCur >= target;
    };

    /* Jump to an arbitrary time. Going backwards rebuilds from scratch. */
    S.prototype.seek = function (t) {
        if (t < this.tCur) this.reset();
        return this;
    };

    /* Compute completely without blocking the interface. */
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
