/* ============================================================
 * analytics.js -- what really counts on a group ride
 * ============================================================
 * Everything here builds on the arc length s from route.js.
 * Without a shared axis none of these numbers would exist.
 *
 *   order            sort by s
 *   front work       time as order[0], plus individual hand-overs
 *   overtaking       sign change of (sA - sB), debounced
 *   attack           somebody gains >15 m on the group in <20 s
 *   climb sprint     gradient interval of the axis + time per rider in it
 *   dropped          gap to the front above a threshold / standing still
 *
 * Debouncing is not cosmetics here: GPS noise of +-3 m otherwise
 * produces phantom overtaking manoeuvres every second between two
 * riders rolling side by side.
 * ============================================================ */

var Analytics = (function () {
    'use strict';

    // --- Overtaking ---
    var PASS_DEADBAND = 8;       // m, within this counts as: level
    var PASS_SUSTAIN  = 3000;    // ms, the new situation has to hold this long

    // --- Attack ---
    var ATTACK_GAIN   = 15;      // m of lead gained on the average
    var ATTACK_WIN    = 20000;   // ms window
    var ATTACK_COOLDOWN = 45000; // ms, do not report again permanently

    // --- Climbs ---
    var CLIMB_START   = 0.030;   // 3 % gradient starts
    var CLIMB_END     = 0.010;   // below 1 % ends
    /* CLIMB_END_RUN is hysteresis IN SPACE: a short noise dip in the
       gradient must not end a climb, otherwise a
       mountain falls apart into a dozen fragments. */
    var CLIMB_END_RUN = 120;     // m, it has to stay flat this long
    var CLIMB_MIN_GAIN= 12;      // m of elevation gain
    var CLIMB_MIN_LEN = 200;     // m of length
    var GRADE_WIN     = 150;     // m, window for the gradient measurement

    // --- Dropped ---
    var DROP_GAP      = 200;     // m to the front
    var STOP_SPEED    = 1.5;     // m/s
    var STOP_TIME     = 30000;   // ms

    // --- League metrics ---
    var SOLO_GAP      = 50;      // m of lead on the second rider: that counts as an "escape"
    var TOGETHER_GAP  = 100;     // m: this close to another rider counts as "riding together"

    var STALE_MS      = 15000;   // without an update a rider counts as stale
    var GONE_MS       = 180000;  // after that, out completely

    /* Position smoothing. Raw fixes wobble by +-4 m; exactly this
       wobble produces the phantom overtaking manoeuvres. The delay
       (about 20 m at 10 m/s) hits ALL riders equally and therefore does not change the
       order -- it merely shifts the axis as a whole
       a little backwards. */
    var POS_TAU       = 2.0;     // s

    /* Attack: not "is permanently stronger" but "is accelerating
       now". Hence two conditions at the same time. */
    var ATTACK_SURGE  = 1.5;     // m/s speed gain compared to own average
    var ATTACK_REF    = 30000;   // ms reference window for this average

    /* Dropped with hysteresis, otherwise it flickers every second. */
    var REJOIN_GAP    = 120;     // m, only below this does one count as back

    /* Route setter change: only when somebody is clearly in front, otherwise
       responsibility flips back and forth in the GPS noise -- and
       exactly that produces the zigzag the setter is meant to prevent. */
    var HANDOVER      = 25;      // m lead over the end of the route
    var SETTER_TIMEOUT= 10000;   // ms without a report -> take over the axis

    function A(route) {
        this.route   = route;
        this.riders  = {};
        this.events  = [];
        this.stints  = [];      // hand-overs: {id, tStart, tEnd, ms, meters}
        this.climbs  = [];
        this.pairs   = {};
        this.setterId = null;
        this.leader  = null;
        this.leaderSince = null;
        this.leaderStartS = null;
        this.lastTick = null;
        this.lastClimbScan = 0;
        this.startedAt = null;
    }

    A.prototype.rider = function (id) {
        if (!this.riders[id]) {
            this.riders[id] = {
                id: id, name: null, color: null, emoji: null,
                lat: null, lon: null, ele: null, acc: null,
                fLat: null, fLon: null,   // smoothed position
                s: null, offset: null, speed: 0, heading: null,
                t: 0, lastSeen: 0,
                frontMs: 0, maxSpeed: 0,
                soloRun: 0, soloMax: 0,   // time at the front with >= SOLO_GAP lead: running / longest
                togetherM: 0,             // metres during which another rider was nearby
                hist: [],                 // {t, s} for climb times
                vHist: [],                // {t, v} for attack detection
                stoppedSince: null,
                dropped: false,
                lastAttack: 0,
                self: false
            };
        }
        return this.riders[id];
    };

    /* ---- Taking a position in ------------------------------------ */
    A.prototype.ingest = function (id, p) {
        var r = this.rider(id);
        if (this.startedAt === null) this.startedAt = p.t;
        if (p.name) r.name = p.name;
        if (p.color) r.color = p.color;
        if (p.emoji !== undefined) r.emoji = p.emoji;       // number from UI.EMOJIS or null

        var dtS = (r.t && p.t > r.t) ? (p.t - r.t) / 1000 : 0;

        r.lat = p.lat; r.lon = p.lon;
        r.ele = (p.ele === undefined ? null : p.ele);
        r.acc = (p.acc === undefined ? null : p.acc);
        r.speed = p.speed || 0;
        if (p.heading !== undefined && p.heading !== null) r.heading = p.heading;
        r.t = p.t;
        r.lastSeen = Date.now();
        if (r.speed > r.maxSpeed) r.maxSpeed = r.speed;

        // --- Smooth the position ---
        if (r.fLat === null || dtS === 0 || dtS > 10) {
            r.fLat = p.lat; r.fLon = p.lon;
        } else {
            var k = POS_TAU / (POS_TAU + dtS);
            r.fLat = k * r.fLat + (1 - k) * p.lat;
            r.fLon = k * r.fLon + (1 - k) * p.lon;
        }

        /* --- Determine the route setter ---
           Only ONE rider extends the axis (see route.js: otherwise it
           folds up). It is taken over when somebody is clearly
           in front, or when the previous setter no longer transmits
           (phone empty, radio gap) -- otherwise the axis would stand still. */
        if (this.route.pts.length === 0) {
            this.setterId = id;
        } else if (this.setterId !== id) {
            var setter = this.riders[this.setterId];
            var setterGone = !setter || (p.t - setter.t) > SETTER_TIMEOUT;
            var probe = this.route.project(r.fLat, r.fLon, r.s);
            if (setterGone || (probe && probe.s > this.route.length() + HANDOVER)) {
                this.setterId = id;
            }
        }

        // Maintain the axis or project onto it -- with the smoothed
        // position, otherwise the polyline zigzags and the segment direction
        // becomes useless.
        var pr = this.route.consider(r.fLat, r.fLon, r.ele, r.s,
                                     this.setterId === id, id);
        if (pr) {
            r.s = pr.s;
            r.offset = pr.offset;
        }

        // Speed history for attack detection
        r.vHist.push({ t: p.t, v: r.speed });
        if (r.vHist.length > 600) r.vHist.splice(0, 200);

        // History for climb times -- thinned out so that it does not run wild
        if (r.s !== null) {
            var h = r.hist;
            var lastH = h.length ? h[h.length - 1] : null;
            if (!lastH || Math.abs(r.s - lastH.s) > 3 || p.t - lastH.t > 2000) {
                h.push({ t: p.t, s: r.s });
                if (h.length > 20000) h.splice(0, 5000);
            }
        }

        // Standstill
        if (r.speed < STOP_SPEED) {
            if (r.stoppedSince === null) r.stoppedSince = p.t;
        } else {
            r.stoppedSince = null;
        }
    };

    /* ---- active riders, sorted from front to back ----------- */
    A.prototype.order = function () {
        var now = Date.now();
        var out = [];
        for (var id in this.riders) {
            var r = this.riders[id];
            if (r.s === null) continue;
            if (now - r.lastSeen > GONE_MS) continue;
            out.push(r);
        }
        out.sort(function (a, b) { return b.s - a.s; });
        return out;
    };

    A.prototype.isStale = function (r) {
        return Date.now() - r.lastSeen > STALE_MS;
    };

    /* ---- periodic evaluation --------------------------------- */
    A.prototype.tick = function (now) {
        now = now || Date.now();
        var dt = this.lastTick === null ? 0 : now - this.lastTick;
        this.lastTick = now;
        if (dt < 0 || dt > 30000) dt = 0;

        var ord = this.order();
        if (!ord.length) return ord;

        // --- Front work + hand-overs ---
        var lead = ord[0];
        if (dt) lead.frontMs += dt;
        // Escape and riding together: only once the axis is long enough (as with overtaking)
        if (dt && this.route.length() > 150) {
            var solo = ord.length > 1 && lead.s - ord[1].s >= SOLO_GAP;
            for (var q = 0; q < ord.length; q++) {
                var rq = ord[q];
                if (q === 0 && solo) { rq.soloRun += dt; if (rq.soloRun > rq.soloMax) rq.soloMax = rq.soloRun; }
                else rq.soloRun = 0;
                var near = (q > 0 && ord[q - 1].s - rq.s < TOGETHER_GAP) ||
                           (q < ord.length - 1 && rq.s - ord[q + 1].s < TOGETHER_GAP);
                if (near && !this.isStale(rq)) rq.togetherM += rq.speed * dt / 1000;
            }
        }

        if (this.leader !== lead.id) {
            if (this.leader !== null) {
                var prev = this.riders[this.leader];
                this.stints.push({
                    id: this.leader,
                    tStart: this.leaderSince,
                    tEnd: now,
                    ms: now - this.leaderSince,
                    meters: (prev && prev.s !== null && this.leaderStartS !== null)
                                ? Math.max(0, prev.s - this.leaderStartS) : 0
                });
                this._event(now, 'lead', { id: lead.id, from: this.leader });
            }
            this.leader = lead.id;
            this.leaderSince = now;
            this.leaderStartS = lead.s;
        }

        /* Warm-up phase: as long as the axis is still short, the
           s values are not reliable. Whoever reports overtaking here
           produces pure start-up artefacts. */
        var warm = this.route.length() > 150;

        // --- Overtaking ---
        if (warm) this._detectPasses(ord, now);

        // --- Attacks ---
        if (warm) this._detectAttacks(ord, now);

        // --- Dropped ---
        for (var i = 0; i < ord.length; i++) {
            var r = ord[i];
            var gapToLead = lead.s - r.s;
            var standing = r.stoppedSince !== null && (r.t - r.stoppedSince) > STOP_TIME;
            /* Hysteresis: dropped from DROP_GAP, back only below
               REJOIN_GAP. With a single threshold the
               state flickers every second as soon as somebody hovers exactly there. */
            var nowDropped = r.dropped
                ? (gapToLead > REJOIN_GAP || (standing && r !== lead))
                : ((gapToLead > DROP_GAP) || (standing && ord.length > 1 && r !== lead));
            if (nowDropped && !r.dropped) {
                this._event(now, 'drop', { id: r.id, gap: Math.round(gapToLead),
                                           standing: standing });
            }
            if (!nowDropped && r.dropped) {
                this._event(now, 'rejoin', { id: r.id });
            }
            r.dropped = nowDropped;
        }

        // --- Climbs (not every round, that costs) ---
        if (now - this.lastClimbScan > 8000) {
            this.lastClimbScan = now;
            this._scanClimbs();
            this._scoreClimbs();
        }

        return ord;
    };

    A.prototype._event = function (t, type, data) {
        data = data || {};
        data.t = t; data.type = type;
        this.events.push(data);
        if (this.events.length > 500) this.events.splice(0, 100);
        return data;
    };

    /* ---- Overtaking, debounced ---------------------------------- */
    A.prototype._detectPasses = function (ord, now) {
        for (var i = 0; i < ord.length; i++) {
            for (var j = i + 1; j < ord.length; j++) {
                var a = ord[i], b = ord[j];
                // canonical pair order so that the sign is stable
                var first = a.id < b.id ? a : b;
                var second = a.id < b.id ? b : a;
                var key = first.id + '|' + second.id;
                var diff = first.s - second.s;

                var st = this.pairs[key];
                if (!st) { st = this.pairs[key] = { sign: 0, cand: 0, since: now }; }

                var sign = 0;
                if (diff > PASS_DEADBAND) sign = 1;
                else if (diff < -PASS_DEADBAND) sign = -1;

                if (sign === 0) continue;          // level: decide nothing

                if (sign !== st.cand) {
                    st.cand = sign;
                    st.since = now;
                    continue;
                }
                // Does the candidate hold long enough?
                if (now - st.since < PASS_SUSTAIN) continue;

                if (st.sign !== 0 && st.sign !== sign) {
                    var passer = sign === 1 ? first : second;
                    var passed = sign === 1 ? second : first;
                    this._event(now, 'pass', { id: passer.id, over: passed.id });
                }
                st.sign = sign;
            }
        }
    };

    /* ---- Attack: lead gain on the group average -------- */
    A.prototype._detectAttacks = function (ord, now) {
        if (ord.length < 2) return;
        var mean = 0;
        for (var i = 0; i < ord.length; i++) mean += ord[i].s;
        mean /= ord.length;

        for (var k = 0; k < ord.length; k++) {
            var r = ord[k];
            if (now - r.lastAttack < ATTACK_COOLDOWN) continue;
            // s relative to the average, before ATTACK_WIN and now
            var relNow = r.s - mean;
            var past = this._sAt(r, r.t - ATTACK_WIN);
            if (past === null) continue;
            var meanPast = 0, cnt = 0;
            for (var m = 0; m < ord.length; m++) {
                var sp = this._sAt(ord[m], ord[m].t - ATTACK_WIN);
                if (sp !== null) { meanPast += sp; cnt++; }
            }
            if (!cnt) continue;
            meanPast /= cnt;
            var relPast = past - meanPast;
            if (relNow - relPast < ATTACK_GAIN) continue;

            /* Second condition: the rider has to be faster NOW than
               he himself was recently. Without it every climber
               permanently reports an "attack" on every gradient, just because he is
               consistently stronger -- that is not an attack. */
            var vNow = this._vMean(r, r.t - 8000, r.t);
            var vRef = this._vMean(r, r.t - ATTACK_REF, r.t - 10000);
            if (vNow === null || vRef === null) continue;
            if (vNow - vRef < ATTACK_SURGE) continue;

            r.lastAttack = now;
            this._event(now, 'attack', {
                id: r.id,
                gain: Math.round(relNow - relPast),
                surge: Math.round((vNow - vRef) * 36) / 10   // km/h
            });
        }
    };

    /* Mean speed of a rider in the time window [t0, t1]. */
    A.prototype._vMean = function (r, t0, t1) {
        var sum = 0, cnt = 0;
        for (var i = r.vHist.length - 1; i >= 0; i--) {
            var e = r.vHist[i];
            if (e.t < t0) break;
            if (e.t <= t1) { sum += e.v; cnt++; }
        }
        return cnt ? sum / cnt : null;
    };

    /* Arc length of a rider at time t, linearly interpolated. */
    A.prototype._sAt = function (r, t) {
        var h = r.hist;
        if (!h.length) return null;
        if (t <= h[0].t) return null;
        if (t >= h[h.length - 1].t) return h[h.length - 1].s;
        var lo = 0, hi = h.length - 1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (h[mid].t <= t) lo = mid; else hi = mid - 1;
        }
        var p = h[lo], q = h[Math.min(h.length - 1, lo + 1)];
        if (q.t === p.t) return p.s;
        var f = (t - p.t) / (q.t - p.t);
        return p.s + f * (q.s - p.s);
    };

    /* Time at which a rider passed the arc length sTarget going up
       -- the LAST such crossing before beforeT.

       Deliberately the last, not the first: as long as the axis is still
       growing, project() extrapolates beyond the end of the route and
       may briefly overshoot. The first crossing is then an
       artefact of the warm-up phase -- with it the weakest
       rider "wins" the climb in 30 seconds. The last crossing is the
       real ascent (and with two laps over the same climb the
       current one). */
    A.prototype._tCross = function (r, sTarget, beforeT) {
        var h = r.hist, res = null;
        for (var i = 1; i < h.length; i++) {
            if (beforeT !== null && h[i].t > beforeT) break;
            if (h[i - 1].s <= sTarget && h[i].s >= sTarget) {
                var span = h[i].s - h[i - 1].s;
                var f = span < 1e-6 ? 0 : (sTarget - h[i - 1].s) / span;
                res = h[i - 1].t + f * (h[i].t - h[i - 1].t);
            }
        }
        return res;
    };

    /* ---- Finding gradients on the axis ------------------------ */
    A.prototype._scanClimbs = function () {
        var rt = this.route;
        rt.smoothElevation();
        var pts = rt.pts;
        if (pts.length < 10) return;

        var found = [];
        var cur = null;
        var flatRun = 0;

        for (var i = 0; i < pts.length; i++) {
            var s0 = pts[i].s;
            var e0 = rt.eleAt(s0);
            var e1 = rt.eleAt(s0 + GRADE_WIN);
            if (e0 === null || e1 === null) continue;
            var grade = (e1 - e0) / GRADE_WIN;

            if (cur === null) {
                if (grade >= CLIMB_START) {
                    cur = { sStart: s0, eStart: e0, sEnd: s0, eEnd: e0 };
                    flatRun = 0;
                }
            } else {
                if (grade >= CLIMB_END) {
                    cur.sEnd = s0 + GRADE_WIN;
                    cur.eEnd = e1;
                    flatRun = 0;
                } else {
                    flatRun += (i > 0 ? (pts[i].s - pts[i - 1].s) : 0);
                    if (flatRun >= CLIMB_END_RUN) {
                        var gain = cur.eEnd - cur.eStart;
                        var len = cur.sEnd - cur.sStart;
                        if (gain >= CLIMB_MIN_GAIN && len >= CLIMB_MIN_LEN) found.push(cur);
                        cur = null;
                    }
                }
            }
        }
        if (cur !== null) {
            var g2 = cur.eEnd - cur.eStart, l2 = cur.sEnd - cur.sStart;
            if (g2 >= CLIMB_MIN_GAIN && l2 >= CLIMB_MIN_LEN) found.push(cur);
        }

        // Recognise existing climbs by sStart so that the
        // measured times are not lost on every scan.
        var merged = [];
        for (var f = 0; f < found.length; f++) {
            var nf = found[f];
            var old = null;
            for (var o = 0; o < this.climbs.length; o++) {
                if (Math.abs(this.climbs[o].sStart - nf.sStart) < 80) { old = this.climbs[o]; break; }
            }
            if (old) {
                old.sEnd = nf.sEnd; old.eStart = nf.eStart; old.eEnd = nf.eEnd;
                merged.push(old);
            } else {
                merged.push({
                    sStart: nf.sStart, sEnd: nf.sEnd,
                    eStart: nf.eStart, eEnd: nf.eEnd,
                    times: {}, no: merged.length + 1
                });
            }
        }
        merged.forEach(function (c, i) { c.no = i + 1; });
        this.climbs = merged;
    };

    /* ---- Riders' times on each climb ----------------------- */
    /* Find the climbs of a finished axis (without riders), e.g. of a
       planned route: length, elevation gain and gradient are set afterwards. */
    A.prototype.scanClimbs = function () {
        this._scanClimbs();
        this._scoreClimbs();
        return this.climbs;
    };

    A.prototype._scoreClimbs = function () {
        for (var c = 0; c < this.climbs.length; c++) {
            var cl = this.climbs[c];
            cl.gain = cl.eEnd - cl.eStart;
            cl.len  = cl.sEnd - cl.sStart;
            cl.grade = cl.len > 0 ? cl.gain / cl.len : 0;

            for (var id in this.riders) {
                var r = this.riders[id];
                if (r.s === null || r.s < cl.sEnd) continue;   // not at the top yet
                if (cl.times[id] && cl.times[id].done) continue;
                var tOut = this._tCross(r, cl.sEnd, null);
                if (tOut === null) continue;
                var tIn  = this._tCross(r, cl.sStart, tOut);
                if (tIn === null || tOut <= tIn) continue;
                var dur = tOut - tIn;
                /* Plausibility: nobody climbs at 20 m/s
                   and nobody slower than pushing. */
                var avgMs = cl.len / (dur / 1000);
                if (avgMs > 20 || avgMs < 0.5) continue;
                cl.times[id] = {
                    ms: dur,
                    vam: cl.gain / (dur / 3600000),        // metres of elevation per hour
                    avg: cl.len / (dur / 1000),            // m/s
                    done: true
                };
            }
        }
    };

    /* ---- Ranking of a climb --------------------------------- */
    A.prototype.climbRanking = function (climb) {
        var out = [];
        for (var id in climb.times) {
            out.push({ id: id, name: (this.riders[id] && this.riders[id].name) || id,
                       ms: climb.times[id].ms, vam: climb.times[id].vam });
        }
        out.sort(function (a, b) { return a.ms - b.ms; });
        return out;
    };

    /* ---- Gaps between neighbouring riders ------------------ */
    A.prototype.gaps = function (ord) {
        var out = [];
        for (var i = 1; i < ord.length; i++) {
            var front = ord[i - 1], back = ord[i];
            var m = front.s - back.s;
            out.push({ front: front.id, back: back.id, meters: m,
                       seconds: m / Math.max(2, back.speed) });
        }
        return out;
    };

    /* ---- Summary for the export ------------------------ */
    A.prototype.summary = function () {
        var self = this;
        var ord = this.order();
        var totalFront = 0;
        ord.forEach(function (r) { totalFront += r.frontMs; });

        return {
            startedAt: this.startedAt,
            endedAt: Date.now(),
            routeLength: Math.round(this.route.length()),
            riders: ord.map(function (r) {
                return {
                    id: r.id, name: r.name || r.id,
                    frontMs: Math.round(r.frontMs),
                    frontShare: totalFront ? r.frontMs / totalFront : 0,
                    maxSpeed: r.maxSpeed,
                    finalS: Math.round(r.s)
                };
            }),
            stints: this.stints.map(function (s) {
                return { id: s.id, name: (self.riders[s.id] && self.riders[s.id].name) || s.id,
                         tStart: s.tStart, ms: Math.round(s.ms),
                         meters: Math.round(s.meters) };
            }),
            climbs: this.climbs.map(function (c) {
                return {
                    no: c.no,
                    startS: Math.round(c.sStart), length: Math.round(c.len),
                    gain: Math.round(c.gain * 10) / 10,
                    gradePct: Math.round(c.grade * 1000) / 10,
                    ranking: self.climbRanking(c).map(function (x) {
                        return { name: x.name, seconds: Math.round(x.ms / 100) / 10,
                                 vam: Math.round(x.vam) };
                    })
                };
            }),
            events: this.events.map(function (e) {
                var o = { t: e.t, type: e.type };
                if (e.id)   o.who  = (self.riders[e.id]   && self.riders[e.id].name)   || e.id;
                if (e.over) o.whom = (self.riders[e.over] && self.riders[e.over].name) || e.over;
                if (e.from) o.from = (self.riders[e.from] && self.riders[e.from].name) || e.from;
                if (e.gain !== undefined) o.gain = e.gain;
                if (e.gap  !== undefined) o.gap  = e.gap;
                return o;
            })
        };
    };

    A.PASS_DEADBAND = PASS_DEADBAND;
    A.PASS_SUSTAIN  = PASS_SUSTAIN;
    A.DROP_GAP      = DROP_GAP;
    A.STALE_MS      = STALE_MS;
    return A;
})();

if (typeof module !== 'undefined') module.exports = Analytics;
