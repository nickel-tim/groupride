/* ============================================================
 * ghost.js -- a saved ride as a virtual fellow rider
 * ============================================================
 * The ghost is not a special case in the analysis: it is fed in like
 * any other rider (Analytics.ingest). Rank, gap in metres and
 * seconds, compass, map, overtaking -- everything comes with it
 * without extra logic. Nothing is sent to anyone else.
 *
 * Time: the ghost rides with ITS recorded time from the moment
 * it starts. "factor" stretches or compresses it (1.05 = five
 * percent faster than back then) -- that way you can train against
 * your own best with a small margin.
 * ============================================================ */

var Ghost = (function () {
    'use strict';

    /* rec: saved ride (Rides.get), factor: speed factor */
    function make(rec, factor) {
        var p = rec.p, n = p.length;
        factor = factor > 0 ? factor : 1;
        var end = p[n - 1][0];

        function idx(tr) {
            var lo = 0, hi = n - 1;
            while (lo < hi) { var m = (lo + hi + 1) >> 1; if (p[m][0] <= tr) lo = m; else hi = m - 1; }
            return lo;
        }
        function pos(tr) {
            tr = Math.max(0, Math.min(end, tr));
            var i = idx(tr), a = p[i], b = p[Math.min(n - 1, i + 1)];
            var span = b[0] - a[0], f = span > 0 ? (tr - a[0]) / span : 0;
            return { lat: a[1] + f * (b[1] - a[1]), lon: a[2] + f * (b[2] - a[2]),
                     ele: (a[3] !== null && b[3] !== null) ? a[3] + f * (b[3] - a[3]) : a[3] };
        }

        var g = {
            id: rec.id, name: rec.name,
            start: { lat: p[0][1], lon: p[0][2] },
            dur: end / factor,                    // seconds, with factor
            factor: factor
        };

        /* Position and speed at ghost time tSec (seconds since start).
           done = true as soon as the recorded ride is over. */
        g.at = function (tSec) {
            var tr = tSec * factor;
            var a = pos(tr);
            var done = tr >= end;
            var t0 = Math.max(0, tr - 1.5), t1 = Math.min(end, tr + 3);
            var pa = pos(t0), pb = pos(t1);
            var d = Geo.distance(pa.lat, pa.lon, pb.lat, pb.lon);
            var speed = (!done && t1 > t0) ? d / (t1 - t0) * factor : 0;
            return {
                lat: a.lat, lon: a.lon, ele: a.ele, done: done, speed: speed,
                heading: d > 2 ? Geo.bearing(pa.lat, pa.lon, pb.lat, pb.lon) : null
            };
        };

        return g;
    }

    return { make: make };
})();
