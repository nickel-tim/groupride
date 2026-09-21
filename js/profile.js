/* ============================================================
 * profile.js -- elevation profile with the riders on it
 * ============================================================
 * The route axis "unrolled": distance horizontally, elevation
 * vertically, climbs shaded in colour, every rider as a dot at his
 * position. At a glance: how far is the next climb, how steep,
 * and how spread out is the group right now.
 *
 * With a planned route (overlay) the profile shows the whole
 * route, also AHEAD of the leader. Without it, it ends at the leader,
 * because the live axis only comes into being while riding.
 *
 *   Profile.render(svg, {
 *     route, riders: [{id, name, color, s, self, ghost, stale}], climbs,
 *     meS, mode: 'all' | 'ahead', cursor: s (metres) or null
 *   })  ->  { from, to, next: {dist, gain, len, grade, no, inside} | null }
 * ============================================================ */

var Profile = (function () {
    'use strict';

    var PAD_L = 34, PAD_R = 8, PAD_T = 12, PAD_B = 20;
    var AHEAD_BACK = 400, AHEAD_FWD = 4000;         // window in "Ahead" mode, metres
    var STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

    function f(n) { return n.toFixed(1); }
    function esc(s) { return UI.escapeHtml(s); }

    /* Next (or current) climb from position s */
    function nextClimb(climbs, s) {
        var best = null;
        (climbs || []).forEach(function (c) {
            if (c.sEnd < s) return;
            var inside = s >= c.sStart;
            var dist = inside ? 0 : c.sStart - s;
            if (!best || dist < best.dist) {
                best = { dist: dist, inside: inside, no: c.no, gain: c.gain || (c.eEnd - c.eStart),
                         len: c.len || (c.sEnd - c.sStart), grade: c.grade || 0,
                         left: inside ? c.sEnd - s : c.sEnd - c.sStart };
            }
        });
        return best;
    }

    function render(svg, d) {
        var W = svg.clientWidth, H = svg.clientHeight;
        if (!W || !H) return null;
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        var route = d.route, len = route ? route.length() : 0;

        if (!route || len < 60 || route.pts.length < 3) {
            svg.innerHTML = '<text class="mempty" x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">' +
                            T('Das Profil entsteht, sobald eine Strecke da ist.') + '</text>';
            return { from: 0, to: 0, next: null };
        }

        // Window
        var from = 0, to = len;
        var meS = (d.meS === null || d.meS === undefined) ? null : d.meS;
        if (d.mode === 'ahead' && meS !== null) {
            from = Math.max(0, meS - AHEAD_BACK);
            to = Math.min(len, Math.max(from + 1500, meS + AHEAD_FWD));
            from = Math.max(0, Math.min(from, to - 1500));
        }
        var pw = W - PAD_L - PAD_R, ph = H - PAD_T - PAD_B;
        function X(s) { return PAD_L + (s - from) / (to - from) * pw; }

        // Elevation line
        var n = Math.max(20, Math.min(240, Math.floor(pw / 2))), xs = [], es = [], emin = Infinity, emax = -Infinity;
        for (var i = 0; i <= n; i++) {
            var s = from + (to - from) * i / n, e = route.eleAt(s);
            xs.push(s); es.push(e);
            if (e !== null && e !== undefined) { if (e < emin) emin = e; if (e > emax) emax = e; }
        }
        if (emin === Infinity) {
            svg.innerHTML = '<text class="mempty" x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">' + T('Keine Höhendaten.') + '</text>';
            return { from: from, to: to, next: null };
        }
        // At least 40 m of range, otherwise every farm track becomes a mountain range
        var span = Math.max(40, emax - emin), mid = (emax + emin) / 2;
        var lo = mid - span * 0.56, hi = mid + span * 0.62;
        function Y(e) { return PAD_T + (1 - (e - lo) / (hi - lo)) * ph; }

        var parts = [];
        // Background lines and axis labels
        var yTop = Math.round(emax), yBot = Math.round(emin);
        parts.push('<line class="pgrid" x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + f(Y(emax)) + '" y2="' + f(Y(emax)) + '"/>');
        parts.push('<line class="pgrid" x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + f(Y(emin)) + '" y2="' + f(Y(emin)) + '"/>');
        parts.push('<text class="plbl" x="' + (PAD_L - 4) + '" y="' + f(Y(emax) + 3) + '" text-anchor="end">' + yTop + '</text>');
        parts.push('<text class="plbl" x="' + (PAD_L - 4) + '" y="' + f(Y(emin) + 3) + '" text-anchor="end">' + yBot + '</text>');
        parts.push('<text class="plbl" x="' + (PAD_L - 4) + '" y="' + (PAD_T - 2) + '" text-anchor="end">m</text>');

        var stepM = STEPS[STEPS.length - 1];
        for (var k = 0; k < STEPS.length; k++) if ((to - from) / STEPS[k] <= 6) { stepM = STEPS[k]; break; }
        for (var t = Math.ceil(from / stepM) * stepM; t <= to; t += stepM) {
            parts.push('<line class="ptick" x1="' + f(X(t)) + '" x2="' + f(X(t)) + '" y1="' + (H - PAD_B) + '" y2="' + (H - PAD_B + 3) + '"/>');
            parts.push('<text class="plbl" x="' + f(X(t)) + '" y="' + (H - 5) + '" text-anchor="middle">' +
                       (stepM >= 1000 ? (t / 1000) + ' km' : t + ' m') + '</text>');
        }

        // Area and line
        var line = '', firstOk = -1;
        for (var j = 0; j <= n; j++) {
            if (es[j] === null || es[j] === undefined) continue;
            if (firstOk < 0) firstOk = j;
            line += (line ? 'L' : 'M') + f(X(xs[j])) + ' ' + f(Y(es[j]));
        }
        parts.push('<path class="parea" d="' + line + 'L' + f(X(xs[n])) + ' ' + (H - PAD_B) + 'L' + f(X(xs[Math.max(0, firstOk)])) + ' ' + (H - PAD_B) + 'Z"/>');

        // Climbs
        (d.climbs || []).forEach(function (c) {
            if (c.sEnd < from || c.sStart > to) return;
            var a = Math.max(c.sStart, from), b = Math.min(c.sEnd, to), seg = '', first = null, lastX = null;
            for (var q = 0; q <= n; q++) {
                if (xs[q] < a || xs[q] > b || es[q] === null) continue;
                if (first === null) first = X(xs[q]);
                seg += (seg ? 'L' : 'M') + f(X(xs[q])) + ' ' + f(Y(es[q])); lastX = X(xs[q]);
            }
            if (!seg || first === null) return;
            parts.push('<path class="pclimbfill" d="' + seg + 'L' + f(lastX) + ' ' + (H - PAD_B) + 'L' + f(first) + ' ' + (H - PAD_B) + 'Z"/>');
            parts.push('<path class="pclimb" d="' + seg + '"/>');
            parts.push('<text class="pclimbno" x="' + f((first + lastX) / 2) + '" y="' + (PAD_T + 8) + '" text-anchor="middle">' + c.no + '</text>');
        });
        parts.push('<path class="pline" d="' + line + '"/>');

        // Cursor (replay/segment selection)
        if (d.cursor !== null && d.cursor !== undefined && d.cursor >= from && d.cursor <= to) {
            parts.push('<line class="pcursor" x1="' + f(X(d.cursor)) + '" x2="' + f(X(d.cursor)) + '" y1="' + PAD_T + '" y2="' + (H - PAD_B) + '"/>');
        }
        (d.marks || []).forEach(function (m) {              // e.g. start/end of a segment
            if (m.s < from || m.s > to) return;
            parts.push('<line class="pmark" x1="' + f(X(m.s)) + '" x2="' + f(X(m.s)) + '" y1="' + PAD_T + '" y2="' + (H - PAD_B) + '"/>');
        });

        // Riders: you last, so that you are on top
        var riders = (d.riders || []).filter(function (r) { return r.s !== null && r.s !== undefined; })
                     .sort(function (a, b) { return (a.self ? 1 : 0) - (b.self ? 1 : 0); });
        riders.forEach(function (r) {
            var col = r.color || '#93a7af', op = r.stale ? 0.4 : 1, ini = esc(((r.name || r.id) + '').charAt(0).toUpperCase());
            var emo = (r.emoji && !r.ghost) ? r.emoji : '';    // symbol instead of the initial letter
            if (r.s < from || r.s > to) {                     // outside: arrow at the edge
                var left = r.s < from, ex = left ? PAD_L + 6 : W - PAD_R - 6, ey = PAD_T + ph / 2;
                parts.push('<g opacity="' + op + '"><polygon points="' + (left ? '0,-6 -7,0 0,6' : '0,-6 7,0 0,6') +
                           '" fill="' + col + '" transform="translate(' + f(ex) + ' ' + f(ey) + ')"/>' +
                           (emo ? Emo.svg(emo, ex + (left ? 14 : -14), ey, 12)
                                : '<text class="pini" x="' + f(ex + (left ? 9 : -9)) + '" y="' + f(ey + 3) + '" text-anchor="middle" fill="' + col + '">' + ini + '</text>') +
                           '</g>');
                return;
            }
            var e = route.eleAt(r.s);
            if (e === null || e === undefined) return;
            var x = X(r.s), y = Y(e);
            parts.push('<g opacity="' + op + '">' +
                '<line class="prl" x1="' + f(x) + '" x2="' + f(x) + '" y1="' + f(y) + '" y2="' + (H - PAD_B) + '" stroke="' + col + '"/>' +
                '<circle class="pdot' + (r.self ? ' me' : '') + (r.ghost ? ' ghost' : '') + '" cx="' + f(x) + '" cy="' + f(y) + '" r="' + (r.self ? 6 : 4.5) + '" fill="' + col + '"/>' +
                (emo ? Emo.svg(emo, x, y - 14, 13)
                     : '<text class="pini" x="' + f(x) + '" y="' + f(y - 9) + '" text-anchor="middle" fill="' + col + '">' + (r.ghost ? 'G' : ini) + '</text>') + '</g>');
        });

        svg.innerHTML = parts.join('');
        return { from: from, to: to, next: nextClimb(d.climbs, meS === null ? 0 : meS) };
    }

    /* Text below the profile: the next climb, in words */
    function describe(next) {
        if (!next) return '';
        var g = Math.round(next.gain), pct = I18n.num(next.grade * 100, 1);
        if (next.inside) return T('Im Anstieg {n} · noch {d} · +{g} Hm · {p} %', { n: next.no, d: UI.fmtDist(next.left), g: g, p: pct });
        return T('Nächster Anstieg {n} in {d} · {l} · +{g} Hm · {p} %', { n: next.no, d: UI.fmtDist(next.dist), l: UI.fmtDist(next.len), g: g, p: pct });
    }

    return { render: render, nextClimb: nextClimb, describe: describe };
})();
