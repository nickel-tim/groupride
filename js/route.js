/* ============================================================
 * route.js -- the shared route axis
 * ============================================================
 * The heart of it. Without it there is no order:
 * pairwise distances do NOT tell you who is in front.
 *
 * The axis is a polyline that organises itself: whoever is currently
 * furthest ahead extends it. Everybody else is projected onto it and
 * gets a position as arc length s (metres since the start of the route).
 *
 * Everything else follows from that:
 *   - order            = sort by s
 *   - gap in metres    = difference of the s values
 *   - overtaking       = sign change of an s difference
 *   - climb sprint     = s interval with a gradient, time per rider inside it
 *
 * And switchbacks do not destroy the logic, because the search is
 * limited to a window around the last known position -- otherwise
 * a rider on the hairpin below would wrongly snap onto it
 * up there.
 *
 * Accuracy: s is summed up with haversine between the support points
 * (exact), the local projection geometry runs in a fixed tangent
 * plane (distortion at group-ride scale far below GPS accuracy).
 * ============================================================ */

var Route = (function () {
    'use strict';

    /* Support point spacing: cannot be chosen arbitrarily small. With 8 m spacing
       and +-4 m GPS noise the segment direction is undetermined to +-27 degrees
       -- the extrapolation beyond the end of the route then points
       anywhere. 20 m brings that down to a good +-5 degrees. */
    var MIN_SPACING  = 20;    // m, support point spacing
    var MAX_OFFSET   = 45;    // m, further away -> do NOT extend the route
                              //    (protects against a parallel road / cycle path)
    var SEARCH_WIN   = 400;   // m, search window around the last position
    /* A jump of more than MAX_STEP per report would be >250 m/s -- that is
       a GPS outlier, not a rider. Otherwise such points stay behind
       permanently as a kink in the axis. */
    var MAX_STEP     = 250;   // m, largest accepted support point jump
    var MAX_TURN     = 100;   // degrees, a sharper kink = outlier
    /* Reconnection. The axis only extends when the setter is "in front and close
       to the axis" and the kink is not too sharp. At a roundabout, tight hairpin,
       figure of eight or out-and-back this is temporarily NOT the case -- and then
       the axis would never extend again ("spline lost"). Therefore: */
    var NEAR_END     = 60;    // m: this close to the axis end = the setter simply continues it,
                              //    no matter where the projection currently snaps to (loops!)
    var TURN_FREE    = 30;    // m: with such a short step a sharp kink is not an outlier
    var TURN_PATIENCE= 2;     // this often the kink guard may reject, then it counts as a real bend
    var DETACH_FIXES = 5;     // this many reports off the axis, then a fresh start (with a gap)
    /* Tight bends. With 20 m point spacing a roundabout of 20 m radius is a rough
       hexagon: the arc length everybody is projected onto becomes inaccurate.
       In a bend the axis may therefore get denser -- but only if the direction
       really tips (the noise is about +-4 m and would otherwise produce a zigzag; the
       positions are already smoothed, though). */
    var CURVE_SPACING = 8;    // m: shortest point spacing in a bend
    var CURVE_ANGLE   = 40;   // degrees: by this much the direction must turn since the last segment
    /* Crossings and overlaps. Where the route crosses itself (figure of eight, roundabout,
       second lap, return on the same road) two axis pieces are equally close.
       The "nearest" would then be chance -- and a rider would jump to the wrong piece, his
       position by hundreds of metres, rank and gaps would flicker, and the search would afterwards
       continue around the wrong spot. Therefore all pieces count that are not clearly further
       away than the nearest, and among them the one that fits the previous position wins. */
    var AHEAD_MAX    = 40;    // m: this far before the axis end the lateral distance still counts
    var TIE_DIST     = 10;    // m: pieces up to this much further away than the nearest are equivalent
    var TIE_WIDE     = 25;    // m: ... and up to here if the chosen piece is otherwise far from the
                              //    previous position (turning point: the axis end lags behind)
    var PLAUSIBLE_S  = 80;    // m: this much a rider can advance between two reports at most
    var TAIL_SMOOTH  = 0.30;  // Laplace factor for the route tail
    /* GPS elevation jitters by several metres and is thereby the worst
   quantity the device delivers. A narrow smoothing window leaves so much
   of it that the gradient computation becomes useless.
   100 m is the compromise: ramps shorter than ~200 m can no longer
   be resolved -- a barometer could have done that, but
   the browser gives no access to one. */
    var ELE_SMOOTH   = 100;   // m, window width of the elevation smoothing

    function R() {
        this.pts   = [];      // {lat, lon, ele, x, y, s}
        this.frame = null;
        this.eleSmoothed = false;
    }

    R.prototype.length = function () {
        return this.pts.length ? this.pts[this.pts.length - 1].s : 0;
    };

    R.prototype._push = function (lat, lon, ele, gap) {
        if (!this.frame) this.frame = Geo.frame(lat, lon);
        var xy = this.frame.toXY(lat, lon);
        var s = 0;
        if (this.pts.length) {
            var last = this.pts[this.pts.length - 1];
            s = last.s + Geo.distance(last.lat, last.lon, lat, lon);
        }
        this.pts.push({ lat: lat, lon: lon, ele: (ele === undefined ? null : ele),
                        x: xy.x, y: xy.y, s: s, gap: !!gap });
        this.eleSmoothed = false;
    };

    /* Binary search: largest index with pts[i].s <= s */
    R.prototype._idxAtS = function (s) {
        var lo = 0, hi = this.pts.length - 1;
        if (hi < 0) return -1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (this.pts[mid].s <= s) lo = mid; else hi = mid - 1;
        }
        return lo;
    };

    /* ---- Projection ---------------------------------------------
       hintS: last known arc length of this rider, or null.
       Returns: {s, offset, ahead} or null for an empty route.
         offset = lateral distance to the axis
         ahead  = true if extrapolated beyond the end of the route  */
    R.prototype.project = function (lat, lon, hintS) {
        var n = this.pts.length;
        if (n === 0) return null;
        if (n === 1) {
            return { s: 0, offset: Geo.distance(this.pts[0].lat, this.pts[0].lon, lat, lon),
                     ahead: false };
        }

        var xy = this.frame.toXY(lat, lon);
        var i0 = 0, i1 = n - 2;
        if (hintS !== null && hintS !== undefined) {
            var a = this._idxAtS(Math.max(0, hintS - SEARCH_WIN));
            var b = this._idxAtS(Math.min(this.length(), hintS + SEARCH_WIN));
            if (a >= 0) i0 = a;
            if (b >= 0) i1 = Math.min(n - 2, b);
            if (i1 < i0) i1 = i0;
        }

        var best = null, cands = [];
        for (var i = i0; i <= i1; i++) {
            var p = this.pts[i], q = this.pts[i + 1];
            if (q.gap) continue;              // a connection across a gap is not a road
            var pr = Geo.projectOnSegment(xy.x, xy.y, p.x, p.y, q.x, q.y);
            /* At the axis end the rider is usually a bit BEFORE it (the axis only grows every
               20 m). His distance to the last point would then be up to 20 m -- and thereby further
               than a piece of an older lap that he happens to cross. For candidates
               at the end the lateral distance to the extended line counts instead (up to 40 m
               ahead), just as the axis does for "offset". */
            var d = pr.dist;
            if (i === n - 2 && pr.t > 1 && (pr.t - 1) * pr.len <= AHEAD_MAX) d = pr.perp;
            var cand = { dist: d, perp: pr.perp, t: pr.t, i: i, len: pr.len };
            cands.push(cand);
            if (best === null || pr.dist < best.dist) best = cand;
        }
        // Continuity: among the (almost) equally close pieces choose the one that fits the previous s
        if (best !== null && hintS !== null && hintS !== undefined) {
            var self = this, nearest = best;
            function gapOf(c) {
                var tc = c.t < 0 ? 0 : (c.t > 1 ? 1 : c.t);
                return Math.abs(self.pts[c.i].s + tc * (self.pts[c.i + 1].s - self.pts[c.i].s) - hintS);
            }
            function pick(limit) {
                var bg = Infinity, bc = null;
                cands.forEach(function (c) { if (c.dist <= limit) { var g = gapOf(c); if (g < bg) { bg = g; bc = c; } } });
                return { c: bc, gap: bg };
            }
            var tight = pick(nearest.dist + TIE_DIST);
            best = tight.c;
            /* If the result is nevertheless far from the previous position, there may be a
               piece slightly further away that fits it (e.g. the axis end at a
               turning point: the rider has fallen back there while he is just crossing an older
               piece). Then it may win. */
            if (tight.gap > PLAUSIBLE_S) {
                var wide = pick(nearest.dist + TIE_WIDE);
                if (wide.c && wide.gap <= PLAUSIBLE_S) best = wide.c;
            }
        }
        if (best === null) return null;

        var segS = this.pts[best.i + 1].s - this.pts[best.i].s;
        var tc = best.t < 0 ? 0 : (best.t > 1 ? 1 : best.t);
        var s = this.pts[best.i].s + tc * segS;
        var offset = best.dist;
        var ahead = false;

        // Beyond the end: extrapolate along the last direction
        if (best.i === n - 2 && best.t > 1) {
            s = this.pts[n - 1].s + (best.t - 1) * segS;
            offset = best.perp;
            ahead = true;
        }
        // Before the start: negative s (rider behind the route start)
        if (best.i === 0 && best.t < 0) {
            s = best.t * segS;
            offset = best.perp;
        }

        return { s: s, offset: offset, ahead: ahead };
    };

    /* ---- Maintaining the route -----------------------------------
       mayExtend: only the current "route setter" may extend.

       This is not an optimisation but a necessity. If different riders
       set support points alternately, their positions differ laterally
       by several metres with only 20 m of longitudinal progress. The polyline
       then zigzags, the segment directions become wrong, and at some point the
       axis folds back onto itself -- from then on the arc lengths run
       backwards and the order is broken for ALL riders.  */
    R.prototype.consider = function (lat, lon, ele, hintS, mayExtend, who) {
        if (this.pts.length === 0) {
            this._push(lat, lon, ele);
            this._owner = who;
            return { s: 0, offset: 0, ahead: false };
        }

        var pr = this.project(lat, lon, hintS);
        var last = this.pts[this.pts.length - 1];
        var dLast = Geo.distance(last.lat, last.lon, lat, lon);

        if (mayExtend && (dLast >= MIN_SPACING || (dLast >= CURVE_SPACING && this._curved(lat, lon)))) {
            var atFront = !!pr && (pr.ahead || pr.s >= this.length() - MIN_SPACING);

            /* The sideways guard only applies INSIDE the route. Beyond
               the end "offset" is the distance to the extended line
               of the last segment -- in a bend that inevitably grows.
               If it applied here, a death spiral would result: the
               leader could no longer get into the route, would thereby run further
               ahead, whereby the distance grows further. That is exactly where
               the axis then collapses for everybody. */
            var onAxis = !!pr && (pr.ahead ? true : (pr.offset <= MAX_OFFSET));

            /* Continuation. The rider who has built the axis so far ("owner") continues it
               with his own track -- without asking the projection. That would
               be exactly wrong here: at a crossing, in a roundabout, on the second
               lap or on the way back he is ON old axis pieces and is thereby considered
               "not in front" -- although he is only following his track. The axis is by definition
               the setter's path; wherever he goes, it goes. Whoever becomes the setter NEWLY
               (handover), on the other hand, has to be in front and close to the axis, otherwise it folds
               back onto itself (see below). */
            var continues = (who === this._owner) || dLast <= NEAR_END || (atFront && onAxis);

            if (continues && dLast <= MAX_STEP) {
                /* Outlier guard: a fix that tips the direction by >100 degrees AND
                   lies far away is suspicious. With a short step (tight hairpin,
                   roundabout with 15 m radius) a sharp kink is real, though; and
                   if it persists it is no longer a single exception. */
                var turnOk = dLast <= TURN_FREE || this._turnOk(lat, lon);
                if (turnOk || (this._rej || 0) >= TURN_PATIENCE) {
                    this._push(lat, lon, ele);
                    this._smoothTail();
                    this._rej = 0; this._detach = 0; this._owner = who;
                    return { s: this.length(), offset: 0, ahead: false };
                }
                this._rej = (this._rej || 0) + 1;
                return pr;
            }

            /* Cut off: the owner is further from the axis end than a plausible step
               (radio gap, tunnel, GPS jump). A single outlier must not bend the axis --
               but if it persists over a few reports it is real, and the axis
               starts afresh there: a point with "gap" begins a new piece; the connection to the
               old end is neither drawn nor used for projection. Only the owner
               may do that: otherwise a new setter on a parallel road (handover) would
               interrupt the axis in the middle of nowhere and falsify the group's order. */
            var away = dLast > MAX_STEP;
            if (who === this._owner && away) {
                this._detach = (this._detach || 0) + 1;
                if (this._detach >= DETACH_FIXES) {
                    this._push(lat, lon, ele, true);
                    this._rej = 0; this._detach = 0;
                    return { s: this.length(), offset: 0, ahead: false };
                }
            } else {
                this._detach = 0;
            }
        }
        return pr;
    };

    // Does the direction from the last segment to the candidate tip by at least CURVE_ANGLE?
    R.prototype._curved = function (lat, lon) {
        var n = this.pts.length;
        if (n < 2) return false;
        var a = this.pts[n - 2], b = this.pts[n - 1];
        if (b.gap) return false;
        var prev = Geo.bearing(a.lat, a.lon, b.lat, b.lon), next = Geo.bearing(b.lat, b.lon, lat, lon);
        return Math.abs(Geo.angleDelta(prev, next)) >= CURVE_ANGLE;
    };

    /* Folding guard: a support point that tips the direction by more than
       MAX_TURN is an outlier. A real hairpin spreads
       its 180 degrees over several segments (at 20 m spacing about 40 degrees
       per segment) and never comes into conflict here. */
    R.prototype._turnOk = function (lat, lon) {
        var n = this.pts.length;
        if (n < 2) return true;
        var a = this.pts[n - 2], b = this.pts[n - 1];
        if (b.gap) return true;              // after a gap there is no "previous direction"
        var prev = Geo.bearing(a.lat, a.lon, b.lat, b.lon);
        var next = Geo.bearing(b.lat, b.lon, lat, lon);
        return Math.abs(Geo.angleDelta(prev, next)) <= MAX_TURN;
    };

    /* Laplace smoothing of the second-to-last point: takes the residual zigzag
       out without shifting the course. Afterwards recompute the arc lengths
       of the tail. */
    R.prototype._smoothTail = function () {
        var n = this.pts.length;
        if (n < 3) return;
        var a = this.pts[n - 3], b = this.pts[n - 2], c = this.pts[n - 1];
        if (b.gap || c.gap) return;          // do not smooth across a gap
        b.lat += TAIL_SMOOTH * (a.lat + c.lat - 2 * b.lat);
        b.lon += TAIL_SMOOTH * (a.lon + c.lon - 2 * b.lon);
        var xy = this.frame.toXY(b.lat, b.lon);
        b.x = xy.x; b.y = xy.y;
        b.s = a.s + Geo.distance(a.lat, a.lon, b.lat, b.lon);
        c.s = b.s + Geo.distance(b.lat, b.lon, c.lat, c.lon);
        this.eleSmoothed = false;
    };

    /* ---- Elevation profile ------------------------------------------
       Moving average over ELE_SMOOTH metres of route length.
       Raw GPS elevation is useless for gradients -- without this
       smoothing you "find" ramps that do not exist.          */
    R.prototype.smoothElevation = function () {
        var n = this.pts.length;
        if (n < 3 || this.eleSmoothed) return;
        var half = ELE_SMOOTH / 2;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var s0 = this.pts[i].s - half, s1 = this.pts[i].s + half;
            var sum = 0, cnt = 0;
            for (var j = i; j >= 0 && this.pts[j].s >= s0; j--) {
                if (this.pts[j].ele !== null) { sum += this.pts[j].ele; cnt++; }
            }
            for (var k = i + 1; k < n && this.pts[k].s <= s1; k++) {
                if (this.pts[k].ele !== null) { sum += this.pts[k].ele; cnt++; }
            }
            out[i] = cnt ? sum / cnt : null;
        }
        for (var m = 0; m < n; m++) this.pts[m].eleS = out[m];
        this.eleSmoothed = true;
    };

    /* Smoothed elevation at any arc length, linearly interpolated. */
    R.prototype.eleAt = function (s) {
        this.smoothElevation();
        var n = this.pts.length;
        if (n === 0) return null;
        var i = this._idxAtS(s);
        if (i < 0) return null;
        if (i >= n - 1) return this.pts[n - 1].eleS;
        var p = this.pts[i], q = this.pts[i + 1];
        if (p.eleS === null || q.eleS === null) return p.eleS !== null ? p.eleS : q.eleS;
        var span = q.s - p.s;
        if (span < 1e-6) return p.eleS;
        var f = (s - p.s) / span;
        return p.eleS + f * (q.eleS - p.eleS);
    };

    /* Heading (degrees) of the axis at position s -- for "where does it continue". */
    R.prototype.courseAt = function (s) {
        var n = this.pts.length;
        if (n < 2) return null;
        var i = this._idxAtS(s);
        if (i < 0) i = 0;
        if (i > n - 2) i = n - 2;
        var p = this.pts[i], q = this.pts[i + 1];
        return Geo.bearing(p.lat, p.lon, q.lat, q.lon);
    };

    R.prototype.toJSON = function () {
        return this.pts.map(function (p) {
            return { lat: p.lat, lon: p.lon, ele: p.ele, s: p.s };
        });
    };

    /* Finished route (planned route, imported GPX file) as an axis.
       minSpacing thins out points that are too dense (1 Hz recordings have
       one every 3 m) -- the axis needs no more than ~10 m. */
    R.fromPoints = function (pts, minSpacing) {
        var r = new R(), gap = minSpacing || 10, last = null;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (last && i < pts.length - 1 && Geo.distance(last.lat, last.lon, p.lat, p.lon) < gap) continue;
            r._push(p.lat, p.lon, (p.ele === undefined || isNaN(p.ele)) ? null : p.ele);
            last = p;
        }
        return r;
    };

    R.MIN_SPACING = MIN_SPACING;
    R.MAX_OFFSET  = MAX_OFFSET;
    R.SEARCH_WIN  = SEARCH_WIN;
    return R;
})();

if (typeof module !== 'undefined') module.exports = Route;
