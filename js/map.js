/* ============================================================
 * map.js -- Karte: Streckenachse als Spline, Fahrer darauf
 * ============================================================
 * Bewusst OHNE Kartenkacheln. Eine Kachel-Anfrage verraet dem
 * Kartenserver, wo die Gruppe faehrt -- das wuerde die
 * Ende-zu-Ende-Verschluesselung der Positionen unterlaufen. Auch
 * im Funkloch und ohne Datenvolumen funktioniert die Karte so.
 *
 * Was man stattdessen sieht, ist genau das, worauf es beim Fahren
 * ankommt: die Streckenachse (als glatte Kurve durch die
 * Stuetzpunkte), jeden Fahrer mit Rang, und die Luecke in Metern
 * relativ zu dir. Anstiege liegen farbig auf der Achse.
 *
 * Alles wird in Metern in einer Tangentialebene gerechnet (die
 * der Route, siehe Geo.frame) und erst zuletzt auf Pixel
 * abgebildet. Optional wird die Ebene so gedreht, dass die eigene
 * Fahrtrichtung oben liegt.
 * ============================================================ */

var MapView = (function () {
    'use strict';

    // Radius um dich im Modus "Ich", in Metern
    var ZOOMS = [80, 150, 300, 600, 1500];
    var PAD_X = 30, PAD_TOP = 34, PAD_BOT = 56;
    var MIN_EXTENT = 60;          // m, so weit wird im Modus "Alle" hoechstens hineingezoomt
    var PX_STEP = 2.5;            // Stuetzpunkte dichter als das (in Pixeln) entfallen
    var SCALE_STEPS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

    function f(n) { return n.toFixed(1); }

    /* ---- Catmull-Rom-Spline als kubische Bezier-Segmente ---------
       Die Kurve laeuft durch jeden Stuetzpunkt und hat dort dieselbe
       Tangente wie die Verbindung der Nachbarn -- die Achse sieht
       damit aus wie ein Strassenverlauf und nicht wie ein Zickzack,
       ohne dass ein Punkt verschoben wird.                        */
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

    /* Nur zeichnen, was im Bild liegt (plus je ein Nachbar, damit die
       Kurve am Rand nicht abreisst), und Stuetzpunkte ausduennen, die
       naeher als PX_STEP beieinander liegen. Bei einer langen
       Ausfahrt sind das sonst tausende Punkte pro Bild. */
    function runs(sp, W, H) {
        var m = 160, n = sp.length, inside = new Array(n), out = [], cur = null;
        for (var i = 0; i < n; i++) {
            inside[i] = sp[i].x > -m && sp[i].x < W + m && sp[i].y > -m && sp[i].y < H + m;
        }
        for (var j = 0; j < n; j++) {
            var keep = inside[j] || (j > 0 && inside[j - 1]) || (j < n - 1 && inside[j + 1]);
            if (!keep) { cur = null; continue; }
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
        // groesste Laenge, die hoechstens ~110 px breit wird
        var best = SCALE_STEPS[0];
        for (var i = 0; i < SCALE_STEPS.length; i++) {
            if (SCALE_STEPS[i] * k <= 110) best = SCALE_STEPS[i];
        }
        return best;
    }

    function gapText(g) {
        return (g > 0 ? '+' : '−') + UI.fmtDist(Math.abs(g));
    }

    /* d = { route, riders (sortiert, vorne zuerst), meId, climbs,
             follow, zoom, trackUp, heading } */
    function render(svg, d) {
        var W = svg.clientWidth, H = svg.clientHeight;
        if (!W || !H) return null;
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

        var placed = d.riders.filter(function (r) { return r.fLat !== null && r.lat !== null; });
        if (!placed.length) {
            svg.innerHTML = '<text class="mempty" x="' + (W / 2) + '" y="' + (H / 2) +
                '" text-anchor="middle">Noch keine Positionen.</text>' +
                '<text class="mempty" x="' + (W / 2) + '" y="' + (H / 2 + 20) +
                '" text-anchor="middle">Unter „Gruppe“ die Ausfahrt starten.</text>';
            return { riders: 0, length: 0 };
        }

        var route = d.route;
        var frame = route.frame || Geo.frame(placed[0].fLat, placed[0].fLon);
        var me = null;
        placed.forEach(function (r) { if (r.id === d.meId) me = r; });

        // --- Drehung: Fahrtrichtung nach oben, oder Norden oben ---
        var hDeg = (d.trackUp && d.heading !== null && d.heading !== undefined) ? d.heading : 0;
        var ct = Math.cos(hDeg * Math.PI / 180), st = Math.sin(hDeg * Math.PI / 180);
        // u = nach rechts, v = nach oben (Meter)
        function tr(x, y) { return { u: x * ct - y * st, v: x * st + y * ct }; }

        var pos = placed.map(function (r) {
            var xy = frame.toXY(r.fLat, r.fLon);
            var t = tr(xy.x, xy.y);
            return { r: r, u: t.u, v: t.v };
        });

        // --- Ausschnitt ---
        var cu, cv, k;
        var meP = null;
        pos.forEach(function (p) { if (p.r === me) meP = p; });

        if (d.follow && meP) {
            cu = meP.u; cv = meP.v;
            var R = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, d.zoom | 0))];
            k = (Math.min(W - 2 * PAD_X, H - PAD_TOP - PAD_BOT) / 2) / R;
            // Mitte des Bildes ist die Mitte der nutzbaren Flaeche
        } else {
            var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            pos.forEach(function (p) {
                if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u;
                if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v;
            });
            cu = (u0 + u1) / 2; cv = (v0 + v1) / 2;
            var bw = Math.max(u1 - u0, MIN_EXTENT), bh = Math.max(v1 - v0, MIN_EXTENT);
            k = Math.min((W - 2 * PAD_X) / bw, (H - PAD_TOP - PAD_BOT) / bh);
        }
        var oy = (PAD_TOP - PAD_BOT) / 2;      // Bildmitte etwas nach oben: unten liegen Beschriftungen
        function sx(u) { return W / 2 + (u - cu) * k; }
        function sy(v) { return H / 2 + oy - (v - cv) * k; }

        var parts = [];

        // --- Streckenachse ---
        var nRoute = route.pts.length;
        if (nRoute > 1 && route.frame) {
            var sp = new Array(nRoute);
            for (var i = 0; i < nRoute; i++) {
                var t = tr(route.pts[i].x, route.pts[i].y);
                sp[i] = { x: sx(t.u), y: sy(t.v), s: route.pts[i].s };
            }
            var dRoute = pathOf(sp, W, H);
            parts.push('<path class="mcase" d="' + dRoute + '"/>');
            parts.push('<path class="mroute" d="' + dRoute + '"/>');

            // Anstiege
            (d.climbs || []).forEach(function (c) {
                var sub = sp.filter(function (q) { return q.s >= c.sStart && q.s <= c.sEnd; });
                if (sub.length > 1) parts.push('<path class="mclimb" d="' + pathOf(sub, W, H) + '"/>');
            });

            /* Die Achse waechst nur alle 20 m um einen Stuetzpunkt (und die
               Position ist zusaetzlich geglaettet): der Fuehrende liegt
               deshalb meist ein Stueck vor ihrem Ende. Gestrichelt
               verbinden, damit keine Luecke im Bild klafft. */
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

        // --- Fahrer: zuerst die anderen, du zuletzt (liegst oben) ---
        var order = pos.slice().sort(function (a, b) {
            return (a.r === me ? 1 : 0) - (b.r === me ? 1 : 0);
        });
        var rankOf = {};
        d.riders.forEach(function (r, i) { rankOf[r.id] = i + 1; });

        var edgeParts = [], labels = [], boxes = [];
        order.forEach(function (p) {
            var r = p.r, x = sx(p.u), y = sy(p.v);
            var color = r.color || '#93a7af';
            var stale = (Date.now() - r.lastSeen) > 15000;
            var isMe = (r === me);
            var gap = (me && me.s !== null && r.s !== null && !isMe) ? (r.s - me.s) : null;
            var op = stale ? 0.4 : 1;

            var inView = x > 14 && x < W - 14 && y > 14 && y < H - 14;
            if (inView) {
                var g = '<g transform="translate(' + f(x) + ' ' + f(y) + ')" opacity="' + op + '">';
                if (r.heading !== null && r.speed > 1) {
                    g += '<polygon class="mhead" fill="' + color + '" points="0,-17 -6,-9 6,-9" ' +
                         'transform="rotate(' + f(r.heading - hDeg) + ')"/>';
                }
                g += '<circle class="mdot' + (isMe ? ' me' : '') + (r.dropped ? ' drop' : '') +
                     '" r="9" fill="' + color + '"/>' +
                     '<text class="mrank" y="3.4" text-anchor="middle">' + rankOf[r.id] + '</text></g>';
                parts.push(g);
                boxes.push({ x: x - 11, y: y - 11, w: 22, h: 22 });     // Punkt selbst ist Hindernis
                labels.push({ x: x, y: y, r: r, color: color, op: op, gap: gap, isMe: isMe });
            } else if (me && !isMe) {
                // ausserhalb des Bildes: Pfeil am Rand in Richtung des Fahrers
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

        /* Beschriftungen: Fahren mehrere dicht beieinander (das ist der
           Normalfall, 2 bis 3 m Abstand), wuerden sich die Namen
           uebereinanderlegen. Jeder Name probiert deshalb nacheinander
           unten, oben, rechts, links -- du zuerst, dann nach Rang. Findet
           sich kein freier Platz, bleibt nur die Rangzahl im Punkt; die
           entspricht der Reihenfolge in der Liste auf dem Tacho. */
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
            var gtxt = l.gap !== null ? gapText(l.gap) : null;
            var w = Math.max(name.length * 6.2, gtxt ? gtxt.length * 5.6 : 0) + 6;
            var h = gtxt ? 23 : 12;
            var cands = [
                { x: l.x - w / 2, y: l.y + 13,     a: 'middle', tx: l.x },
                { x: l.x - w / 2, y: l.y - 13 - h, a: 'middle', tx: l.x },
                { x: l.x + 12,    y: l.y - h / 2,  a: 'start',  tx: l.x + 13 },
                { x: l.x - 12 - w, y: l.y - h / 2, a: 'end',    tx: l.x - 13 }
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

        // --- Massstab ---
        var L = niceScale(k), px = L * k;
        var bx = 16, by = H - 16;
        parts.push('<g class="mscale"><path d="M' + bx + ' ' + (by - 5) + 'V' + by + 'H' + f(bx + px) +
                   'V' + (by - 5) + '"/><text x="' + bx + '" y="' + (by - 9) + '">' +
                   (L >= 1000 ? (L / 1000) + ' km' : L + ' m') + '</text></g>');

        // --- Nordpfeil ---
        var na = -hDeg * Math.PI / 180;
        parts.push('<g class="mnorth" transform="translate(' + (W - 28) + ' 32)">' +
                   '<circle r="17"/>' +
                   '<polygon points="0,-13 -5,3 5,3" transform="rotate(' + f(-hDeg) + ')"/>' +
                   '<text x="' + f(Math.sin(na) * 25) + '" y="' + f(-Math.cos(na) * 25 + 3.5) +
                   '" text-anchor="middle">N</text></g>');

        svg.innerHTML = parts.join('');
        return { riders: placed.length, length: route.length() };
    }

    return { render: render, ZOOMS: ZOOMS };
})();
