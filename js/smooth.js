/* ============================================================
 * smooth.js -- jerk-free display despite 1 Hz positions
 * ============================================================
 * Positions arrive only about once per second (those of the other riders
 * every two), but drawing happens at 30 frames per second. Without
 * smoothing, dots and pointers jump once a second -- at 10 m/s about
 * 9 m at a time. Two things against that:
 *
 *   1. Moving on ("dead reckoning"): a speed is estimated from the last
 *      two reports; the dot keeps gliding with it until the next report
 *      arrives -- for at most EXTRAP_MS, because without a report you
 *      cannot know whether the rider is still rolling.
 *   2. Following: when the report arrives, the dot does NOT jump there
 *      but approaches it exponentially (time constant TAU_POS). A
 *      small estimation error therefore never shows up as a jerk.
 *
 * The same for angles (heading), always by the shortest way --
 * going from 359 degrees to 1 degree the pointer must not run backwards
 * through the whole compass rose.
 *
 * This is purely presentation. The analysis (rank, gaps, overtaking)
 * keeps computing with the reported positions, never the smoothed ones.
 * A tracker belongs to one view (map, compass); each estimates on its
 * own, so they do not interfere with each other.
 * ============================================================ */

var Smooth = (function () {
    'use strict';

    var TAU_POS   = 0.22;     // s
    var TAU_HDG   = 0.35;     // s
    var EXTRAP_MS = 2600;
    var SNAP_M    = 60;       // do not blur larger jumps (first report, restart)
    /* A jump is not a ride: if the position jumps between two frames (seeking in the
       replay, restart, GPS jump), that would compute to an absurd speed -- and the
       dot would then shoot on for up to 2.6 s. Above this limit: no speed, just sit down.
       The limit is far above what the simulation's time lapse (x20 = ~190 m/s)
       produces. */
    var MAX_V     = 400;      // m/s

    var api = { enabled: true };   // "enabled = false": raw values, for comparing and debugging

    api.angDelta = function (from, to) { return ((to - from + 540) % 360) - 180; };

    /* frame: reference frame of the metres (if it changes, the tracker starts over) */
    api.create = function () { return { frame: null, r: {}, hd: null, hl: null }; };

    api.reset = function (trk, frame) {
        if (trk.frame !== frame) { trk.frame = frame; trk.r = {}; trk.hd = null; trk.hl = null; }
        return trk;
    };

    /* Smooth display position of a rider (metres in the reference frame).
       r: rider (id, heading), xy: last reported position, stale: no
       report any more -> do not keep moving. Returns {x, y, hd}. */
    api.follow = function (trk, r, xy, now, stale) {
        if (!api.enabled || trk.off) return { x: xy.x, y: xy.y, hd: r.heading === undefined ? null : r.heading };
        var st = trk.r[r.id];
        if (!st) {
            st = trk.r[r.id] = { fx: xy.x, fy: xy.y, tf: now, vx: 0, vy: 0, x: xy.x, y: xy.y, tl: now,
                                 hd: (r.heading === null || r.heading === undefined) ? null : r.heading };
        }
        // new report detected: estimate the speed from the distance since the last one
        if (Math.abs(xy.x - st.fx) > 1e-4 || Math.abs(xy.y - st.fy) > 1e-4) {
            var dtf = (now - st.tf) / 1000;
            var jumped = dtf > 0 && Math.hypot(xy.x - st.fx, xy.y - st.fy) / dtf > MAX_V;
            if (jumped) {
                st.vx = st.vy = 0; st.x = xy.x; st.y = xy.y;         // sit down, do not brake
            } else if (dtf > 0.05 && dtf < 8) {
                st.vx = 0.3 * st.vx + 0.7 * (xy.x - st.fx) / dtf;
                st.vy = 0.3 * st.vy + 0.7 * (xy.y - st.fy) / dtf;
            } else { st.vx = st.vy = 0; }
            st.fx = xy.x; st.fy = xy.y; st.tf = now;
        }
        var age = stale ? 0 : Math.min(now - st.tf, EXTRAP_MS) / 1000;
        var tx = st.fx + st.vx * age, ty = st.fy + st.vy * age;

        var dt = Math.min(0.25, Math.max(0, (now - st.tl) / 1000));
        st.tl = now;
        if (Math.hypot(tx - st.x, ty - st.y) > SNAP_M) { st.x = tx; st.y = ty; }
        else {
            var a = 1 - Math.exp(-dt / TAU_POS);
            st.x += (tx - st.x) * a; st.y += (ty - st.y) * a;
        }

        if (r.heading !== null && r.heading !== undefined) {
            if (st.hd === null) st.hd = r.heading;
            else st.hd += api.angDelta(st.hd, r.heading) * (1 - Math.exp(-dt / TAU_HDG));
        }
        return st;
    };

    /* Smooth own heading (degrees) for map rotation or compass.
       target = null -> no heading known (the tracker forgets it). */
    api.heading = function (trk, target, now) {
        if (target === null || target === undefined) { trk.hd = null; trk.hl = null; return null; }
        if (!api.enabled || trk.off || trk.hd === null) { trk.hd = target; trk.hl = now; return target; }
        var dt = Math.min(0.25, Math.max(0, (now - (trk.hl || now)) / 1000));
        trk.hd += api.angDelta(trk.hd, target) * (1 - Math.exp(-dt / TAU_HDG));
        trk.hl = now;
        return trk.hd;
    };

    // take riders that are gone out of the tracker
    api.prune = function (trk, seen) { for (var id in trk.r) if (!seen[id]) delete trk.r[id]; };

    return api;
})();
