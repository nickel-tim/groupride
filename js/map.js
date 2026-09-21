/* ============================================================
 * map.js -- map: route axis as a spline, riders on it
 * ============================================================
 * The map works without any background: route axis (as a
 * smooth curve through the support points), every rider with rank, the
 * gap in metres relative to you, climbs coloured on the axis.
 * That also works in a radio gap and without data volume.
 *
 * OPTIONALLY an open map (OpenStreetMap) can be put underneath.
 * This is deliberately OFF until you switch it on: whoever loads tiles reveals
 * their IP address and the approximate section to the tile server.
 * Name, group and key it does not learn -- the request contains
 * only z/x/y, and the fragment with the key never goes to a server.
 * The tiles lie in a separate <svg> BEHIND the map so that
 * they can be darkened via CSS in the dark theme.
 *
 * Positions only arrive ~1x per second; the dots are therefore
 * drawn smoothed (see smooth.js).
 *
 * Everything is computed in metres in a tangent plane (that
 * of the route, see Geo.frame) and only at the very end mapped
 * to pixels. Optionally the plane is rotated so that the own
 * direction of travel is up.
 * ============================================================ */

var MapView = (function () {
    'use strict';

    // Radius around you in "Me" mode, in metres
    var ZOOMS = [80, 150, 300, 600, 1500];
    var PAD_X = 30, PAD_TOP = 34, PAD_BOT = 56;
    var MIN_EXTENT = 60;          // m, in "All" mode it zooms in this far at most
    var K_MIN = 0.004, K_MAX = 30;   // px per metre: ~250 m/px (region) to ~3 cm/px (detail)
    var PX_STEP = 2.5;            // support points closer than this (in pixels) are dropped
    var SCALE_STEPS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

    function f(n) { return n.toFixed(1); }

    /* ---- Tiles (Web Mercator, "slippy map") --------------------
       A tile is a square in the Mercator grid, in our local
       plane (metres, possibly rotated) a slightly distorted quadrilateral. Via
       three corners (NW, NE, SW) every tile can be placed exactly as an affine
       mapping onto the screen -- so the background rotates along
       in "Heading" mode without a special case.            */
    var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    var MAX_TILES = 30;           // at most this many tiles per frame (spares the server)

    function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
    function lat2y(lat, z) {
        var r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
    }
    function x2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
    function y2lat(y, z) {
        var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    function clearTiles(tsvg) {
        if (!tsvg) return;
        if (tsvg.__tiles) { tsvg.__tiles = null; }
        if (tsvg.firstChild) tsvg.innerHTML = '';
    }

    /* c: { W, H, k (px per metre), toScreen(lat,lon), fromScreen(X,Y), tpl } */
    function drawTiles(tsvg, c) {
        var NS = 'http://www.w3.org/2000/svg';
        tsvg.setAttribute('viewBox', '0 0 ' + c.W + ' ' + c.H);
        var els = tsvg.__tiles || (tsvg.__tiles = {});

        // visible area in lat/lon (four corners, because the section may be rotated)
        var cs = [c.fromScreen(0, 0), c.fromScreen(c.W, 0), c.fromScreen(0, c.H), c.fromScreen(c.W, c.H)];
        var lat0 = Infinity, lat1 = -Infinity, lon0 = Infinity, lon1 = -Infinity;
        cs.forEach(function (q) {
            if (q.lat < lat0) lat0 = q.lat; if (q.lat > lat1) lat1 = q.lat;
            if (q.lon < lon0) lon0 = q.lon; if (q.lon > lon1) lon1 = q.lon;
        });
        var latC = (lat0 + lat1) / 2;

        // Zoom level: one tile pixel ~ one screen pixel
        var z = Math.ceil(Math.log(156543.03392 * Math.cos(latC * Math.PI / 180) * c.k) / Math.LN2 - 0.35);
        z = Math.max(2, Math.min(19, z));
        var x0, x1, y0, y1, n;
        for (;;) {
            n = Math.pow(2, z);
            x0 = Math.max(0, Math.floor(lon2x(lon0, z))); x1 = Math.min(n - 1, Math.floor(lon2x(lon1, z)));
            y0 = Math.max(0, Math.floor(lat2y(Math.min(85, lat1), z))); y1 = Math.min(n - 1, Math.floor(lat2y(Math.max(-85, lat0), z)));
            if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES || z <= 2) break;
            z--;
        }

        function matrixFor(zz, xx, yy) {
            var nw = c.toScreen(y2lat(yy, zz), x2lon(xx, zz));
            var ne = c.toScreen(y2lat(yy, zz), x2lon(xx + 1, zz));
            var sw = c.toScreen(y2lat(yy + 1, zz), x2lon(xx, zz));
            return 'matrix(' + [(ne.x - nw.x) / 256, (ne.y - nw.y) / 256,
                                (sw.x - nw.x) / 256, (sw.y - nw.y) / 256, nw.x, nw.y]
                                .map(function (v) { return v.toFixed(4); }).join(' ') + ')';
        }

        var now = Date.now(), keep = {};
        for (var ty = y0; ty <= y1; ty++) {
            for (var tx = x0; tx <= x1; tx++) {
                var key = z + '/' + tx + '/' + ty;
                keep[key] = true;
                var el = els[key];
                if (!el) {
                    el = document.createElementNS(NS, 'image');
                    // 256.7 instead of 256: minimal overlap, otherwise hairlines flash between the tiles
                    el.setAttribute('width', '256.7'); el.setAttribute('height', '256.7');
                    el.setAttribute('decoding', 'async');
                    el.addEventListener('error', function () { this.style.display = 'none'; });   // offline: no broken image
                    el.setAttribute('href', c.tpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
                    el.__zxy = [z, tx, ty];
                    tsvg.appendChild(el);
                    els[key] = el;
                }
                el.__seen = now;
            }
        }
        /* Tiles of the previous zoom level stay briefly UNDER the new ones
           (and keep being moved along) until the new ones are loaded. Otherwise
           the empty background flashes when zooming and dragging. */
        var n2 = 0;
        for (var k2 in els) {
            var e2 = els[k2];
            if (!keep[k2] && now - e2.__seen > 900) {
                if (e2.parentNode) e2.parentNode.removeChild(e2);
                delete els[k2];
                continue;
            }
            n2++;
            e2.setAttribute('transform', matrixFor(e2.__zxy[0], e2.__zxy[1], e2.__zxy[2]));
        }
    }

    /* ---- Catmull-Rom spline as cubic Bezier segments ---------
       The curve runs through every support point and has the same
       tangent there as the connection of the neighbours -- the axis then looks
       like a road course and not like a zigzag,
       without any point being moved.                        */
    function spline(p) {
        if (p.length < 2) return '';
        var d = 'M' + f(p[0].x) + ' ' + f(p[0].y);
        for (var i = 0; i < p.length - 1; i++) {
            var p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
            d += 'C' + f(p1.x + (p2.x - p0.x) / 6) + ' ' + f(p1.y + (p2.y - p0.y) / 6) + ' ' +
                       f(p2.x - (p3.x - p1.x) / 6) + ' ' + f(p2.y - (p3.y - p1.y) / 6) + ' ' +
                       f(p2.x) + ' ' + f(p2.y);
        }
        return d;
    }

    /* Only draw what is in the picture (plus one neighbour each so that the
       curve does not break off at the edge), and thin out support points that are
       closer together than PX_STEP. On a long
       ride that would otherwise be thousands of points per frame. */
    function runs(sp, W, H) {
        var m = 160, n = sp.length, inside = new Array(n), out = [], cur = null;
        for (var i = 0; i < n; i++) {
            inside[i] = sp[i].x > -m && sp[i].x < W + m && sp[i].y > -m && sp[i].y < H + m;
        }
        for (var j = 0; j < n; j++) {
            var keep = inside[j] || (j > 0 && inside[j - 1]) || (j < n - 1 && inside[j + 1]);
            if (!keep) { cur = null; continue; }
            if (sp[j].gap) cur = null;         // gap (radio gap, fresh start): no line across nothing
            if (!cur) { cur = []; out.push(cur); }
            var last = cur[cur.length - 1];
            var isEdge = (j === n - 1) || !(inside[j + 1] || inside[j]);
            if (!last || isEdge || Math.hypot(sp[j].x - last.x, sp[j].y - last.y) >= PX_STEP) {
                cur.push(sp[j]);
            }
        }
        return out.filter(function (r) { return r.length > 1; });
    }

    function pathOf(sp, W, H) {
        return runs(sp, W, H).map(spline).join('');
    }

    function niceScale(k) {
        // largest length that becomes ~110 px wide at most
        var best = SCALE_STEPS[0];
        for (var i = 0; i < SCALE_STEPS.length; i++) {
            if (SCALE_STEPS[i] * k <= 110) best = SCALE_STEPS[i];
        }
        return best;
    }

    function gapText(g) {
        return (g > 0 ? '+' : '−') + UI.fmtDist(Math.abs(g));
    }

    /* The planned route is available in lat/lon; the conversion into metres of the
       map plane is done once per reference frame and remembered. */
    function ovXY(ov, frame) {
        if (ov.__frame !== frame) {
            ov.__frame = frame;
            ov.__xy = ov.pts.map(function (q) { return frame.toXY(q.lat, q.lon); });
        }
        return ov.__xy;
    }

    /* d = { route, riders (sorted, front first), meId, climbs,
             follow, zoom, trackUp, heading } */
    function render(svg, d) {
        var W = svg.clientWidth, H = svg.clientHeight;
        if (!W || !H) return null;
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        if (!d.tiles) clearTiles(d.tileSvg);

        var placed = d.riders.filter(function (r) { return r.fLat !== null && r.lat !== null; });
        var ov = d.overlay || null;
        if (!placed.length && !ov) {
            clearTiles(d.tileSvg);
            svg.innerHTML = '<text class="mempty" x="' + (W / 2) + '" y="' + (H / 2) +
                '" text-anchor="middle">' + T('Noch keine Positionen.') + '</text>' +
                '<text class="mempty" x="' + (W / 2) + '" y="' + (H / 2 + 20) +
                '" text-anchor="middle">' + T('Sobald GPS und Mitfahrer da sind, erscheinen sie hier.') + '</text>';
            return { riders: 0, length: 0 };
        }

        var route = d.route;
        var frame = route.frame || (placed.length ? Geo.frame(placed[0].fLat, placed[0].fLon) : ov.route.frame);
        var me = null;
        placed.forEach(function (r) { if (r.id === d.meId) me = r; });

        var now = performance.now();
        var trk = Smooth.reset(svg.__trk || (svg.__trk = Smooth.create()), frame);
        trk.off = d.smooth === false;      // the replay computes intermediate values itself

        // --- Rotation: direction of travel up, or north up (softly followed) ---
        var hs = d.trackUp ? Smooth.heading(trk, d.heading, now) : Smooth.heading(trk, null, now);
        var hDeg = hs === null ? 0 : hs;
        var ct = Math.cos(hDeg * Math.PI / 180), st = Math.sin(hDeg * Math.PI / 180);
        // u = to the right, v = up (metres)
        function tr(x, y) { return { u: x * ct - y * st, v: x * st + y * ct }; }

        var seen = {};
        var pos = placed.map(function (r) {
            var xy = frame.toXY(r.fLat, r.fLon);
            var sm = Smooth.follow(trk, r, xy, now, !r.ghost && (Date.now() - r.lastSeen) > 15000);
            seen[r.id] = true;
            var t = tr(sm.x, sm.y);
            return { r: r, u: t.u, v: t.v, hd: sm.hd };
        });
        Smooth.prune(trk, seen);       // clean up riders that have gone away

        // --- Section ---
        var cu, cv, k;
        var meP = null;
        pos.forEach(function (p) { if (p.r === me) meP = p; });

        if (d.follow && meP) {
            cu = meP.u; cv = meP.v;
            var R = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, d.zoom | 0))];
            k = (Math.min(W - 2 * PAD_X, H - PAD_TOP - PAD_BOT) / 2) / R;
            // The centre of the picture is the centre of the usable area
        } else {
            var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            if (!d.fitOverlay) pos.forEach(function (p) {
                if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u;
                if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v;
            });
            var fitPts = null;
            if (ov && (d.fitOverlay || !pos.length)) fitPts = ovXY(ov, frame);
            else if (d.fitOverlay && route.frame && route.pts.length) fitPts = route.pts;     // no route loaded: the live axis
            if (fitPts) {
                fitPts.forEach(function (q) {
                    var t = tr(q.x, q.y);
                    if (t.u < u0) u0 = t.u; if (t.u > u1) u1 = t.u;
                    if (t.v < v0) v0 = t.v; if (t.v > v1) v1 = t.v;
                });
            }
            cu = (u0 + u1) / 2; cv = (v0 + v1) / 2;
            var bw = Math.max(u1 - u0, MIN_EXTENT), bh = Math.max(v1 - v0, MIN_EXTENT);
            k = Math.min((W - 2 * PAD_X) / bw, (H - PAD_TOP - PAD_BOT) / bh);
        }
        /* From the user: shift in metres (in the rotated plane, i.e. as it
           lies on the screen) and a zoom factor on the automatic section.
           "All" and "Me" remain base settings: they determine where the
           section points without intervention. */
        k = Math.max(K_MIN, Math.min(K_MAX, k * (d.zoomMul || 1)));
        cu += d.panU || 0; cv += d.panV || 0;

        var oy = (PAD_TOP - PAD_BOT) / 2;      // picture centre slightly upwards: captions lie at the bottom
        function sx(u) { return W / 2 + (u - cu) * k; }
        function sy(v) { return H / 2 + oy - (v - cv) * k; }

        // --- Map background (optional) ---
        if (d.tiles && d.tileSvg) {
            drawTiles(d.tileSvg, {
                W: W, H: H, k: k, tpl: d.tileUrl || TILE_URL,
                toScreen: function (lat, lon) {
                    var xy = frame.toXY(lat, lon), t = tr(xy.x, xy.y);
                    return { x: sx(t.u), y: sy(t.v) };
                },
                fromScreen: function (X, Y) {
                    var u = cu + (X - W / 2) / k, v = cv - (Y - (H / 2 + oy)) / k;
                    return frame.toLatLon(u * ct + v * st, -u * st + v * ct);   // rotation back
                }
            });
        }

        var parts = [];

        // --- planned route (overlay), below everything else ---
        if (ov) {
            var oxy = ovXY(ov, frame), osp = new Array(oxy.length);
            for (var oi = 0; oi < oxy.length; oi++) {
                var ot = tr(oxy[oi].x, oxy[oi].y);
                osp[oi] = { x: sx(ot.u), y: sy(ot.v), s: ov.pts[oi].s };
            }
            var dPlan = pathOf(osp, W, H);
            parts.push('<path class="mplanc" d="' + dPlan + '"/>');
            parts.push('<path class="mplan" d="' + dPlan + '"/>');
            if (osp.length) {
                parts.push('<circle class="mplanS" cx="' + f(osp[0].x) + '" cy="' + f(osp[0].y) + '" r="5"/>');
                var oe = osp[osp.length - 1];
                parts.push('<rect class="mplanE" x="' + f(oe.x - 5) + '" y="' + f(oe.y - 5) + '" width="10" height="10"/>');
            }
        }

        // --- Route axis ---
        var nRoute = route.pts.length;
        if (nRoute > 1 && route.frame) {
            var sp = new Array(nRoute);
            for (var i = 0; i < nRoute; i++) {
                var t = tr(route.pts[i].x, route.pts[i].y);
                sp[i] = { x: sx(t.u), y: sy(t.v), s: route.pts[i].s, gap: !!route.pts[i].gap };
            }
            var dRoute = pathOf(sp, W, H);
            parts.push('<path class="mcase" d="' + dRoute + '"/>');
            parts.push('<path class="mroute" d="' + dRoute + '"/>');

            // Climbs
            (d.climbs || []).forEach(function (c) {
                var sub = sp.filter(function (q) { return q.s >= c.sStart && q.s <= c.sEnd; });
                if (sub.length > 1) parts.push('<path class="mclimb" d="' + pathOf(sub, W, H) + '"/>');
            });

            /* The axis only grows by one support point every 20 m (and the
               position is additionally smoothed): the leader therefore
               is usually a bit ahead of its end. Connect with a dashed
               line so that no gap yawns in the picture. */
            var lead = null;
            pos.forEach(function (q) { if (q.r === d.riders[0]) lead = q; });
            if (lead) {
                var e = sp[nRoute - 1], lx2 = sx(lead.u), ly2 = sy(lead.v);
                if (Math.hypot(lx2 - e.x, ly2 - e.y) > 6) {
                    parts.push('<path class="mtail" d="M' + f(e.x) + ' ' + f(e.y) + 'L' + f(lx2) + ' ' + f(ly2) + '"/>');
                }
            }

            // Start
            parts.push('<circle class="mstart" cx="' + f(sp[0].x) + '" cy="' + f(sp[0].y) + '" r="4"/>');
        }

        // --- Riders: the others first, you last (on top) ---
        var order = pos.slice().sort(function (a, b) {
            return (a.r === me ? 1 : 0) - (b.r === me ? 1 : 0);
        });
        var rankOf = {};
        d.riders.forEach(function (r, i) { rankOf[r.id] = i + 1; });

        var edgeParts = [], labels = [], boxes = [];
        order.forEach(function (p) {
            var r = p.r, x = sx(p.u), y = sy(p.v);
            var color = r.color || '#93a7af';
            var stale = !r.ghost && (Date.now() - r.lastSeen) > 15000;
            var isMe = (r === me);
            var gap = (me && me.s !== null && r.s !== null && !isMe) ? (r.s - me.s) : null;
            var op = stale ? 0.4 : 1;

            var inView = x > 14 && x < W - 14 && y > 14 && y < H - 14;
            if (inView) {
                var g = '<g transform="translate(' + f(x) + ' ' + f(y) + ')" opacity="' + op + '">';
                if (p.hd !== null && p.hd !== undefined && r.speed > 1) {
                    g += '<polygon class="mhead" fill="' + color + '" points="0,-17 -6,-9 6,-9" ' +
                         'transform="rotate(' + f(p.hd - hDeg) + ')"/>';
                }
                /* With a symbol: the symbol sits in the (somewhat larger) dot, the rank moves in front of the
                   name ("2 Anna") -- you should not lose the ranking. */
                var emo = r.ghost ? '' : UI.emojiOf(r.emoji), rr = emo ? 12 : 9;
                g += '<circle class="mdot' + (isMe ? ' me' : '') + (r.dropped ? ' drop' : '') + (r.ghost ? ' ghost' : '') +
                     '" r="' + rr + '" fill="' + color + '"/>' +
                     (emo ? Emo.svg(emo, 0, 0, 18)
                          : '<text class="mrank" y="3.4" text-anchor="middle">' + (r.ghost ? 'G' : rankOf[r.id]) + '</text>') + '</g>';
                parts.push(g);
                boxes.push({ x: x - rr - 2, y: y - rr - 2, w: 2 * rr + 4, h: 2 * rr + 4 });     // the dot itself is an obstacle
                labels.push({ x: x, y: y, r: r, color: color, op: op, gap: gap, isMe: isMe, emo: !!emo, rr: rr });
            } else if (me && !isMe) {
                // outside the picture: arrow at the edge in the direction of the rider
                var dx = x - W / 2, dy = y - (H / 2 + oy);
                var len = Math.hypot(dx, dy) || 1;
                var ux = dx / len, uy = dy / len;
                var tx = (W / 2 - 18) / (Math.abs(ux) || 1e-6);
                var ty = (H / 2 - 30) / (Math.abs(uy) || 1e-6);
                var tt = Math.min(tx, ty);
                var ex = W / 2 + ux * tt, ey = H / 2 + uy * tt;
                var ang = Math.atan2(ux, -uy) * 180 / Math.PI;
                var lx = ex - ux * 22, ly = ey - uy * 22;
                edgeParts.push(
                    '<g opacity="' + op + '">' +
                    '<polygon points="0,-9 -7,6 7,6" fill="' + color + '" ' +
                    'transform="translate(' + f(ex) + ' ' + f(ey) + ') rotate(' + f(ang) + ')"/>' +
                    '<text class="mname" x="' + f(lx) + '" y="' + f(ly) + '" text-anchor="middle" fill="' +
                    color + '">' + UI.escapeHtml((r.name || r.id).slice(0, 9)) +
                    (gap !== null ? ' ' + gapText(gap) : '') + '</text></g>');
            }
        });

        /* Labels: if several ride close together (that is the
           normal case, 2 to 3 m apart), the names would lie
           on top of each other. Each name therefore tries in turn
           bottom, top, right, left -- you first, then by rank. If
           no free space is found, only the rank number in the dot remains; it
           corresponds to the order in the list on the speedometer. */
        function hit(b) {
            if (b.x < 2 || b.y < 2 || b.x + b.w > W - 2 || b.y + b.h > H - 2) return true;
            for (var i = 0; i < boxes.length; i++) {
                var o = boxes[i];
                if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true;
            }
            return false;
        }
        labels.sort(function (a, b) {
            return (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0) || rankOf[a.r.id] - rankOf[b.r.id];
        });
        labels.forEach(function (l) {
            var name = UI.escapeHtml((l.r.name || l.r.id).slice(0, 9));
            if (l.emo) name = rankOf[l.r.id] + ' ' + name;
            var gtxt = l.gap !== null ? gapText(l.gap) : null;
            var w = Math.max(name.length * 6.2, gtxt ? gtxt.length * 5.6 : 0) + 6;
            var h = gtxt ? 23 : 12;
            var cands = [
                { x: l.x - w / 2, y: l.y + l.rr + 4,     a: 'middle', tx: l.x },
                { x: l.x - w / 2, y: l.y - l.rr - 4 - h, a: 'middle', tx: l.x },
                { x: l.x + l.rr + 3,    y: l.y - h / 2,  a: 'start',  tx: l.x + l.rr + 4 },
                { x: l.x - l.rr - 3 - w, y: l.y - h / 2, a: 'end',    tx: l.x - l.rr - 4 }
            ];
            for (var i = 0; i < cands.length; i++) {
                var c = cands[i], box = { x: c.x, y: c.y, w: w, h: h };
                if (hit(box)) continue;
                boxes.push(box);
                parts.push('<g opacity="' + l.op + '"><text class="mname" x="' + f(c.tx) + '" y="' + f(c.y + 9) +
                           '" text-anchor="' + c.a + '" fill="' + l.color + '">' + name + '</text>' +
                           (gtxt ? '<text class="mgap" x="' + f(c.tx) + '" y="' + f(c.y + 20) +
                                   '" text-anchor="' + c.a + '">' + gtxt + '</text>' : '') + '</g>');
                return;
            }
        });
        parts.push(edgeParts.join(''));

        // --- Scale ---
        var L = niceScale(k), px = L * k;
        var bx = 16, by = H - 16;
        parts.push('<g class="mscale"><path d="M' + bx + ' ' + (by - 5) + 'V' + by + 'H' + f(bx + px) +
                   'V' + (by - 5) + '"/><text x="' + bx + '" y="' + (by - 9) + '">' +
                   (L >= 1000 ? (L / 1000) + ' km' : L + ' m') + '</text></g>');

        // --- North arrow ---
        var na = -hDeg * Math.PI / 180;
        parts.push('<g class="mnorth" transform="translate(' + (W - 28) + ' 32)">' +
                   '<circle r="17"/>' +
                   '<polygon points="0,-13 -5,3 5,3" transform="rotate(' + f(-hDeg) + ')"/>' +
                   '<text x="' + f(Math.sin(na) * 25) + '" y="' + f(-Math.cos(na) * 25 + 3.5) +
                   '" text-anchor="middle">N</text></g>');

        svg.innerHTML = parts.join('');
        // k and the picture centre go back so that gestures (zoom around a point) can compute
        return { riders: placed.length, length: route.length(), k: k, cx: W / 2, cy: H / 2 + oy };
    }

    return { render: render, ZOOMS: ZOOMS, TILE_URL: TILE_URL };
})();
