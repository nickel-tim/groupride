/* ============================================================
 * summary.js -- summary of a ride, for viewing and as an image to share
 * ============================================================
 * Computed from the saved ride -- not from the live state.
 * The ride runs through once with the same analysis as in the replay, after which
 * front work, climbs, attacks and drops are fixed. Your
 * own numbers (distance, speed, elevation gain) come from your track,
 * freed from GPS noise (Track.smooth). Best times and records are
 * already in Segments; here only those of this ride are picked out.
 *
 * The image is an SVG that is painted onto a canvas and shared as a PNG
 * (Web Share with file, otherwise download). It contains no map in the background,
 * only the ridden lines -- so it reveals nothing about the place except
 * the shape of the route.
 * ============================================================ */

var Summary = (function () {
    'use strict';

    function esc(s) { return UI.escapeHtml(s); }
    function fmtDate(t) {
        var d = new Date(t);
        return d.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' +
               String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function kmhOf(ms) { return (ms * 3.6).toFixed(1).replace('.', I18n.sep()); }

    /* ---------- compute ---------- */
    function forRide(rideId, onProgress) {
        var rec = Rides.get(rideId);
        if (!rec) return Promise.reject(new Error(T('Ausfahrt nicht gefunden.')));
        var g = Rides.getGroup(rideId), data = g ? Recorder.unpack(g) : null;
        var meId = data ? data.me : 'me';
        if (!data) { data = { me: 'me', riders: { me: { name: T('Du'), color: UI.COLORS[0], pts: Rides.unpack(rec) } } }; }
        var sess = new Session(data);
        return sess.workAsync(sess.t1, 3000, onProgress).then(function () {
            var an = sess.an;
            an.scanClimbs();
            var ord = an.order();
            var mine = data.riders[meId] || data.riders[Object.keys(data.riders)[0]];
            var own = Track.stats(Track.smooth(mine ? mine.pts : Rides.unpack(rec), 2));

            var total = 0;
            ord.forEach(function (r) { total += r.frontMs; });
            var riders = ord.map(function (r, i) {
                return { id: r.id, name: r.name || r.id, color: r.color || '#93a7af', emoji: UI.emojiOf(r.emoji), me: r.id === meId, rank: i + 1,
                         frontMs: r.frontMs, share: total ? r.frontMs / total : 0, max: r.maxSpeed || 0 };
            });

            var ev = { pass: 0, attack: 0, drop: 0, lead: 0 }, bigAttack = null;
            an.events.forEach(function (e) {
                if (ev[e.type] !== undefined) ev[e.type]++;
                if (e.type === 'attack' && (!bigAttack || e.gain > bigAttack.gain)) bigAttack = e;
            });
            var longest = null;
            an.stints.forEach(function (s) { if (!longest || s.ms > longest.ms) longest = s; });
            function nm(id) { var r = an.riders[id]; return (r && r.name) || id; }

            var climbs = an.climbs.map(function (c) {
                return { no: c.no, len: c.len, gain: c.gain, grade: c.grade,
                         ranking: an.climbRanking(c).slice(0, 3).map(function (x) {
                             var rr = an.riders[x.id]; return { name: x.name, ms: x.ms, vam: x.vam, color: (rr && rr.color) || '#93a7af', me: x.id === meId }; }) };
            });

            // Best times and records of this ride (from storage, not recomputed)
            Segments.use(Segments.worldOf(rec.src));
            var efforts = [];
            Segments.list().forEach(function (seg) {
                var e = seg.efforts.filter(function (x) { return x.ride === rideId; })[0];
                if (!e) return;
                var best = Segments.bestOf(seg);
                efforts.push({ name: seg.name, ms: e.ms, isPB: best && best.ride === rideId, rank: seg.efforts.filter(function (x) { return x.ms < e.ms; }).length + 1, of: seg.efforts.length });
            });
            var recs = [], st = Segments.bests();
            Segments.RECORDS.forEach(function (R) { if (st[R.key] && st[R.key].ride === rideId) recs.push(R.label); });

            // Lines for the image: all riders, thinned out
            var tracks = sess.list.map(function (r) {
                return { color: r.color || '#93a7af', me: r.id === meId, pts: Track.thin(r.pts, 12).map(function (p) { return [p.lat, p.lon]; }) };
            });

            return {
                rideId: rideId, name: rec.name, src: rec.src, start: rec.start, world: Segments.worldOf(rec.src),
                own: own, group: riders.length > 1, riders: riders, events: ev,
                longest: longest ? { name: nm(longest.id), ms: longest.ms } : null,
                bigAttack: bigAttack ? { name: nm(bigAttack.id), gain: bigAttack.gain } : null,
                topSpeed: riders.reduce(function (a, r) { return r.max > a.v ? { v: r.max, name: r.name } : a; }, { v: 0, name: '' }),
                climbs: climbs, efforts: efforts, records: recs, tracks: tracks
            };
        });
    }

    /* ---------- Display (HTML) ---------- */
    function tile(v, l) { return '<div class="sumtile"><b class="num">' + v + '</b><span>' + l + '</span></div>'; }

    function html(d) {
        var o = d.own, out = [];
        out.push('<div class="sumttl">' + esc(d.name) + '</div><div class="sumsub">' + fmtDate(d.start) +
                 (d.src === 'sim' ? ' · ' + T('Simulation') : '') + '</div>');
        out.push('<div class="sumgrid">' + tile(UI.fmtDist(o.dist), T('Strecke')) + tile(UI.fmtDur(o.moving || o.dur), T('Fahrzeit')) +
                 tile(kmhOf(o.avg), T('Ø km/h')) + tile('+' + Math.round(o.gain), T('Höhenmeter')) +
                 tile(kmhOf(o.max), T('Spitze km/h')) + tile(UI.fmtDur(o.dur), T('Gesamtzeit')) + '</div>');
        out.push('<div class="sumsvg" id="sumThumb"></div>');

        if (d.group) {
            out.push('<h2>' + T('Führungsarbeit') + '</h2>');
            var max = Math.max.apply(null, d.riders.map(function (r) { return r.frontMs; })) || 1;
            d.riders.filter(function (r) { return r.frontMs > 0; }).sort(function (a, b) { return b.frontMs - a.frontMs; }).forEach(function (r) {
                out.push('<div class="sumbar">' + (r.emoji ? '<span class="rdot em" style="background:' + r.color + '">' + Emo.img(r.emoji) + '</span>'
                                                              : '<span class="rdot" style="background:' + r.color + '"></span>') + '<span class="nm">' + esc(r.name) +
                         (r.me ? ' (' + T('du') + ')' : '') + '</span><span class="num">' + UI.fmtDur(r.frontMs) + ' · ' + Math.round(r.share * 100) +
                         ' %</span><i style="width:' + Math.round(100 * r.frontMs / max) + '%;background:' + r.color + '"></i></div>');
            });
        }

        var hl = [];
        if (d.group && d.riders.length) {
            var top = d.riders.slice().sort(function (a, b) { return b.frontMs - a.frontMs; })[0];
            if (top && top.frontMs > 0) hl.push(T('<b>Meiste Führungsarbeit:</b> {n} ({p} %)', { n: esc(top.name), p: Math.round(top.share * 100) }));
        }
        if (d.longest && d.group) hl.push(T('<b>Längste Führung:</b> {n} · {t}', { n: esc(d.longest.name), t: UI.fmtDur(d.longest.ms) }));
        if (d.bigAttack) hl.push(T('<b>Größter Antritt:</b> {n} · +{g} m', { n: esc(d.bigAttack.name), g: d.bigAttack.gain }));
        if (d.topSpeed.v > 0 && d.group) hl.push(T('<b>Höchstes Tempo:</b> {n} · {v} km/h', { n: esc(d.topSpeed.name), v: kmhOf(d.topSpeed.v) }));
        if (d.group) hl.push(T('<b>Überholmanöver:</b> {a} · <b>Antritte:</b> {b} · <b>Abrisse:</b> {c}', { a: d.events.pass, b: d.events.attack, c: d.events.drop }));
        if (hl.length) { out.push('<h2>' + T('Highlights') + '</h2>'); hl.forEach(function (h) { out.push('<div class="sumhl">' + h + '</div>'); }); }

        if (d.climbs.length) {
            out.push('<h2>' + T('Anstiege') + '</h2>');
            d.climbs.forEach(function (c) {
                out.push('<div class="sumclimb"><b>' + T('Anstieg {n}', { n: c.no }) + '</b> <span class="sm">' + UI.fmtDist(c.len) + ' · +' + Math.round(c.gain) +
                         ' ' + T('Hm') + ' · ' + (c.grade * 100).toFixed(1).replace('.', I18n.sep()) + ' %</span>' +
                         c.ranking.map(function (r, i) {
                             return '<div class="sumrk' + (r.me ? ' me' : '') + '"><span>' + (i + 1) + '.</span><span class="rdot" style="background:' + r.color + '"></span><span class="nm">' +
                                    esc(r.name) + '</span><span class="num">' + UI.fmtDur(r.ms) + '</span></div>'; }).join('') + '</div>');
            });
        }

        if (d.efforts.length || d.records.length) {
            out.push('<h2>' + T('Bestzeiten &amp; Rekorde') + '</h2>');
            d.efforts.forEach(function (e) {
                out.push('<div class="sumhl">' + (e.isPB ? Emo.img('🏆') + ' ' : '') + '<b>' + esc(e.name) + '</b> · ' + UI.fmtDur(e.ms) +
                         (e.isPB ? ' – ' + T('neue Bestzeit') : ' – ' + T('Platz {r} von {n}', { r: e.rank, n: e.of })) + '</div>');
            });
            d.records.forEach(function (r) { out.push('<div class="sumhl">' + Emo.img('🏆') + ' ' + T('Rekord:') + ' <b>' + esc(T(r)) + '</b></div>'); });
        }
        return out.join('');
    }

    /* Small map of the ridden lines (SVG), for display and image */
    function thumbSvg(d, W, H) {
        var all = [];
        d.tracks.forEach(function (t) { t.pts.forEach(function (p) { all.push(p); }); });
        if (!all.length) return '';
        var fr = Geo.frame(all[0][0], all[0][1]), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        var xy = d.tracks.map(function (t) {
            return t.pts.map(function (p) { var q = fr.toXY(p[0], p[1]); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); return q; });
        });
        var pad = 14, k = Math.min((W - 2 * pad) / Math.max(40, x1 - x0), (H - 2 * pad) / Math.max(40, y1 - y0));
        var ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 + y1 * k, parts = [];
        // draw you last so that your line is on top
        var order = d.tracks.map(function (t, i) { return i; }).sort(function (a, b) { return (d.tracks[a].me ? 1 : 0) - (d.tracks[b].me ? 1 : 0); });
        order.forEach(function (i) {
            var t = d.tracks[i], path = xy[i].map(function (q, j) { return (j ? 'L' : 'M') + (q.x * k + ox).toFixed(1) + ' ' + (oy - q.y * k).toFixed(1); }).join('');
            parts.push('<path d="' + path + '" fill="none" stroke="' + t.color + '" stroke-width="' + (t.me ? 3.5 : 2) + '" stroke-linecap="round" stroke-linejoin="round" opacity="' + (t.me ? 1 : 0.8) + '"/>');
        });
        var s = xy[order[order.length - 1]][0], e = xy[order[order.length - 1]][xy[order[order.length - 1]].length - 1];
        parts.push('<circle cx="' + (s.x * k + ox).toFixed(1) + '" cy="' + (oy - s.y * k).toFixed(1) + '" r="5" fill="#0d1214" stroke="#e8f0f2" stroke-width="2.5"/>');
        parts.push('<rect x="' + (e.x * k + ox - 5).toFixed(1) + '" y="' + (oy - e.y * k - 5).toFixed(1) + '" width="10" height="10" fill="#e8f0f2"/>');
        return parts.join('');
    }

    /* ---------- Image (SVG -> PNG) ---------- */
    function cardSvg(d) {
        var W = 720, o = d.own, y = 0, p = [];
        var FONT = 'Barlow, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
        function svgText(x, yy, txt, size, fill, weight, anchor) {
            return '<text x="' + x + '" y="' + yy + '" font-family="' + FONT + '" font-size="' + size + '" fill="' + fill + '" font-weight="' + (weight || 400) +
                   '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(txt) + '</text>';
        }
        p.push(svgText(40, 70, d.name, 40, '#e8f0f2', 600));
        p.push(svgText(40, 104, fmtDate(d.start) + (d.src === 'sim' ? ' · ' + T('Simulation') : ''), 22, '#93a7af'));
        var tiles = [[UI.fmtDist(o.dist), T('Strecke')], [UI.fmtDur(o.moving || o.dur), T('Fahrzeit')], [kmhOf(o.avg), T('Ø km/h')], ['+' + Math.round(o.gain), T('Höhenmeter')]];
        tiles.forEach(function (t, i) {
            var x = 40 + i * 165;
            p.push('<rect x="' + x + '" y="136" width="153" height="96" rx="12" fill="#151d21"/>');
            p.push(svgText(x + 76, 190, t[0], 34, '#ffffff', 300, 'middle'));
            p.push(svgText(x + 76, 218, t[1], 17, '#93a7af', 400, 'middle'));
        });
        p.push('<rect x="40" y="252" width="640" height="330" rx="14" fill="#151d21"/>');
        p.push('<g transform="translate(40 252)">' + thumbSvg(d, 640, 330) + '</g>');
        y = 626;
        if (d.group) {
            p.push(svgText(40, y, T('FÜHRUNGSARBEIT'), 18, '#5f7379', 600)); y += 14;
            var max = Math.max.apply(null, d.riders.map(function (r) { return r.frontMs; })) || 1;
            d.riders.filter(function (r) { return r.frontMs > 0; }).sort(function (a, b) { return b.frontMs - a.frontMs; }).slice(0, 5).forEach(function (r) {
                y += 34;
                p.push('<circle cx="52" cy="' + (y - 8) + '" r="' + (r.emoji ? 11 : 7) + '" fill="' + r.color + '"/>');
                if (r.emoji) p.push(Emo.svg(r.emoji, 52, y - 8, 17));      // data URI in the SVG: also works in the image export
                p.push(svgText(r.emoji ? 74 : 70, y, r.name + (r.me ? ' (' + T('du') + ')' : ''), 22, '#e8f0f2'));
                p.push(svgText(680, y, Math.round(r.share * 100) + ' %', 22, '#93a7af', 400, 'end'));
                p.push('<rect x="70" y="' + (y + 6) + '" width="' + (610 * r.frontMs / max) + '" height="6" rx="3" fill="' + r.color + '"/>');
                y += 12;
            });
            y += 46;
        }
        /* Symbols as drawn shapes: emoji need a font, which is not reliably there
           in the SVG image -- they appeared as empty boxes. */
        function icon(kind, cx, cy, col) {
            if (kind === 'star') {
                var pts = [];
                for (var i = 0; i < 10; i++) { var r = i % 2 ? 5 : 11, a = -Math.PI / 2 + i * Math.PI / 5; pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1)); }
                return '<polygon points="' + pts.join(' ') + '" fill="' + col + '"/>';
            }
            if (kind === 'bolt') return '<polygon points="' + [cx + 3, cy - 12, cx - 7, cy + 2, cx - 1, cy + 2, cx - 4, cy + 12, cx + 8, cy - 3, cx + 2, cy - 3].join(',') + '" fill="' + col + '"/>';
            return '<polygon points="' + [cx - 10, cy + 9, cx, cy - 10, cx + 10, cy + 9].join(',') + '" fill="' + col + '"/>';     // climb
        }
        var lines = [];
        d.efforts.filter(function (e) { return e.isPB; }).slice(0, 3).forEach(function (e) { lines.push({ k: 'star', c: '#f2b01e', t: e.name + ' · ' + UI.fmtDur(e.ms) + ' – ' + T('Bestzeit') }); });
        d.records.slice(0, 2).forEach(function (r) { lines.push({ k: 'star', c: '#f2b01e', t: T('Rekord:') + ' ' + T(r) }); });
        if (d.bigAttack) lines.push({ k: 'bolt', c: '#ffb02e', t: T('Größter Antritt:') + ' ' + d.bigAttack.name + ' +' + d.bigAttack.gain + ' m' });
        if (d.climbs.length && d.climbs[0].ranking.length) lines.push({ k: 'tri', c: '#7ed957', t: T('Anstieg {n}', { n: d.climbs[0].no }) + ': ' + d.climbs[0].ranking[0].name + ' ' + UI.fmtDur(d.climbs[0].ranking[0].ms) });
        if (lines.length) {
            p.push(svgText(40, y, T('HIGHLIGHTS'), 18, '#5f7379', 600)); y += 14;
            lines.slice(0, 5).forEach(function (l) { y += 36; p.push(icon(l.k, 52, y - 8, l.c)); p.push(svgText(76, y, l.t, 22, '#e8f0f2')); });
            y += 16;
        }
        p.push(svgText(40, y + 40, 'Gruppenausfahrt', 18, '#5f7379', 600));
        var H = y + 64;
        return { W: W, H: H, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
                 '<rect width="' + W + '" height="' + H + '" fill="#0d1214"/>' + p.join('') + '</svg>' };
    }

    function toPng(card) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () {
                var c = document.createElement('canvas'), s = 2;
                c.width = card.W * s; c.height = card.H * s;
                var x = c.getContext('2d'); x.scale(s, s); x.drawImage(img, 0, 0);
                c.toBlob(function (b) { b ? resolve(b) : reject(new Error(T('Bild konnte nicht erzeugt werden.'))); }, 'image/png');
            };
            img.onerror = function () { reject(new Error(T('Bild konnte nicht erzeugt werden.'))); };
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(card.svg);
        });
    }

    /* Share: Web Share with file (phone), otherwise download. */
    function share(d) {
        return toPng(cardSvg(d)).then(function (blob) {
            var name = 'ausfahrt_' + new Date(d.start).toISOString().slice(0, 10) + '.png';
            var file = new File([blob], name, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                return navigator.share({ files: [file], title: d.name }).catch(function (e) { if (e && e.name !== 'AbortError') throw e; });
            }
            var a = document.createElement('a'), u = URL.createObjectURL(blob);
            a.href = u; a.download = name; document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1500);
        });
    }

    return { forRide: forRide, html: html, thumbSvg: thumbSvg, cardSvg: cardSvg, toPng: toPng, share: share };
})();
