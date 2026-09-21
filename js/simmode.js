/* ============================================================
 * simmode.js -- simulation for trying things out, without a phone on the bike
 * ============================================================
 * Four virtual fellow riders on a test lap (bends, two
 * hairpins, three climbs), you are the fifth. Everything runs
 * locally: no GPS, no network, nothing is sent.
 *
 * The positions go through the SAME path as real reports
 * (Analytics.ingest), including GPS noise of about 4 m. So the
 * speedometer, map, log and climbs show exactly what they would show on a
 * real ride -- including the errors the noise causes.
 *
 * To play: regulate your power, press "Attack" (overtake, open
 * a gap, get dropped), turn up the time lapse.
 * The lap is the same as in test/sim.js, where it is checked with ground truth
 * against the analysis.
 * ============================================================ */

var SimMode = (function () {
    'use strict';

    var LAT0 = 47.8021, LON0 = 11.0912;      // somewhere in the Alpine foothills
    var END  = 6000;                         // m, finish
    var HP1  = 1200, HP2 = 3700, HP_LEN = 94;

    /* Elevation profile: three climbs (+60 m / 10 %, +48 m / 6 %, +40 m / 8 %) */
    function eleAt(s) {
        if (s < 1000) return 100;
        if (s < 1600) return 100 + (s - 1000) * 0.10;
        if (s < 2200) return 160;
        if (s < 3000) return 160 + (s - 2200) * 0.06;
        if (s < 4200) return 208 - (s - 3000) * 0.04;
        if (s < 4600) return 160;
        if (s < 5100) return 160 + (s - 4600) * 0.08;
        return 200 - (s - 5100) * 0.05;
    }

    /* Hairpins as real bends: 180 degrees over an arc with 30 m
       radius. A reversal of direction WITHOUT lateral offset would be congruent
       road -- an unsolvable problem, not a test case. */
    function headingAt(s) {
        var h = 40 + 25 * Math.sin(s / 700);
        var turn = 0;
        [HP1, HP2].forEach(function (a) {
            if (s >= a + HP_LEN) turn += 180;
            else if (s > a) turn += 180 * (s - a) / HP_LEN;
        });
        return h + turn;
    }

    var center = null;
    function buildCenter() {
        center = [];
        var lat = LAT0, lon = LON0, s = 0, step = 2;
        while (s <= END + 20) {
            center.push({ s: s, lat: lat, lon: lon, ele: eleAt(s) });
            var h = headingAt(s) * Geo.D2R;
            lat += step * Math.cos(h) / Geo.metersPerDegLat(lat);
            lon += step * Math.sin(h) / Geo.metersPerDegLon(lat);
            s += step;
        }
    }

    function atS(s) {
        if (s <= 0) return center[0];
        var last = center[center.length - 1];
        if (s >= last.s) return last;
        var lo = 0, hi = center.length - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (center[m].s <= s) lo = m; else hi = m - 1; }
        var p = center[lo], q = center[Math.min(center.length - 1, lo + 1)];
        var f = (q.s - p.s) > 0 ? (s - p.s) / (q.s - p.s) : 0;
        return { s: s, lat: p.lat + f * (q.lat - p.lat), lon: p.lon + f * (q.lon - p.lon),
                 ele: p.ele + f * (q.ele - p.ele) };
    }

    function gauss(sd) {
        return sd * Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) *
               Math.cos(2 * Math.PI * Math.random());
    }

    function grade(s) { return (eleAt(s + 25) - eleAt(s - 25)) / 50; }

    /* Everyone has their own strengths: Anna climbs, Ben is the flatland
       engine (and attacks before the first climb), Dirk cracks at some point. */
    function speedOf(r, s, t) {
        var g = grade(s);
        var v = r.flat;
        if (g > 0.005) v = r.flat * r.climb * Math.max(0.3, 1 - g * 7);
        else if (g < -0.005) v = r.flat * (1 - g * 4);
        if (r.key === 'ben'  && s > 900 && s < 1100) v *= 1.5;
        if (r.key === 'dirk' && t > 260) v *= 0.55;
        return Math.max(1.5, v);
    }

    /* opts: { meId, meName, meColor, colors: [4 colours for the others] } */
    function create(opts) {
        if (!center) buildCenter();
        var colors = opts.colors;
        var riders = [
            { key: 'me',   id: opts.meId, name: opts.meName, color: opts.meColor, emoji: opts.meEmoji === undefined ? null : opts.meEmoji,
              flat: 9.4,  climb: 1.02, s: 25, me: true },
            { key: 'anna', id: 'sim-anna',  name: 'Anna',  color: colors[0], emoji: 1,  flat: 9.2,  climb: 1.35, s: 40 },
            { key: 'ben',  id: 'sim-ben',   name: 'Ben',   color: colors[1], emoji: 2,  flat: 10.4, climb: 0.78, s: 20 },
            { key: 'carla',id: 'sim-carla', name: 'Carla', color: colors[2], emoji: 12, flat: 9.4,  climb: 1.02, s: 30 },
            { key: 'dirk', id: 'sim-dirk',  name: 'Dirk',  color: colors[3], emoji: 14, flat: 8.2,  climb: 0.70, s: 10 }
        ];
        var sim = {
            t: 0,                 // simulated seconds
            t0: Date.now(),
            effort: 1.0,          // factor on YOUR speed
            boostUntil: 0,        // simulated second until which the attack lasts
            done: false,
            length: END
        };

        sim.now = function () { return sim.t0 + sim.t * 1000; };

        /* A few short messages from the fellow riders so that you can try out the display. */
        var script = [ { at: 40,  who: 'sim-ben',   n: 'Ben',   j: 2,  q: 'ok' },
                       { at: 110, who: 'sim-dirk',  n: 'Dirk',  j: 14, q: 'wait' },
                       { at: 190, who: 'sim-anna',  n: 'Anna',  j: 1,  q: 'coffee' },
                       { at: 270, who: 'sim-carla', n: 'Carla', j: 12, q: 'danger' } ];
        var sentIdx = 0;
        /* Messages that have become due since the last call (time lapse jumps over several). */
        sim.dueMessages = function () {
            var out = [];
            while (sentIdx < script.length && script[sentIdx].at <= sim.t) {
                var m = script[sentIdx++];
                out.push({ i: m.who, n: m.n, q: m.q, j: m.j, mid: 'sim' + m.at + '-' + sim.t0, t: Date.now() });
            }
            return out;
        };

        sim.attack = function () { sim.boostUntil = sim.t + 15; };
        sim.boosting = function () { return sim.t < sim.boostUntil; };

        /* Advance one second; returns the reports of all riders. */
        sim.step = function () {
            if (sim.done) return [];
            sim.t += 1;
            var out = [];
            riders.forEach(function (r) {
                var v = speedOf(r, r.s, sim.t);
                if (r.me) v *= (sim.boosting() ? Math.max(1.5, sim.effort) : sim.effort);
                if (r.s < END) r.s = Math.min(END, r.s + v);
                else v = 0;
                var c = atS(r.s);
                var hd = headingAt(r.s);
                var h = hd * Geo.D2R;
                var along = gauss(4), cross = gauss(4);      // GPS noise
                out.push({
                    id: r.id, name: r.name, color: r.color, emoji: r.emoji, me: !!r.me,
                    lat: c.lat + (along * Math.cos(h) - cross * Math.sin(h)) / Geo.metersPerDegLat(c.lat),
                    lon: c.lon + (along * Math.sin(h) + cross * Math.cos(h)) / Geo.metersPerDegLon(c.lat),
                    ele: c.ele + gauss(6),
                    speed: Math.max(0, v + gauss(0.2)),
                    heading: ((hd % 360) + 360) % 360,
                    acc: 6, t: sim.now()
                });
            });
            if (riders.some(function (r) { return r.s >= END; })) sim.done = true;   // leader at the finish
            return out;
        };

        sim.meS = function () { return riders[0].s; };
        return sim;
    }

    return { create: create, LENGTH: END };
})();
