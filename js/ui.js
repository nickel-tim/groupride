/* ============================================================
 * ui.js -- Darstellung
 * ============================================================
 * Am Lenker gilt: eine Zahl, die man bei 30 km/h in einem Blick
 * erfasst, ist mehr wert als fuenf, die man lesen muesste. Deshalb
 * gross, tabellarisch und ohne Animation an den Zahlen.
 * ============================================================ */

var UI = (function () {
    'use strict';

    /* Fahrerfarben: auf beiden Untergruenden unterscheidbar und auch
       bei Rot-Gruen-Schwaeche noch trennbar (Helligkeit variiert mit). */
    var COLORS = ['#f2b01e', '#3fa9f5', '#ff6b52', '#8bc34a',
                  '#b48ce8', '#26c6da', '#ec87b9', '#c9a227'];

    function $(id) { return document.getElementById(id); }
    function kmh(ms) { return ms * 3.6; }

    function fmtDur(ms) {
        var s = Math.round(ms / 1000);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
        return m + ':' + String(ss).padStart(2, '0');
    }
    function fmtDist(m) {
        var a = Math.abs(m);
        if (a < 1000) return Math.round(m) + ' m';
        return (m / 1000).toFixed(a < 10000 ? 2 : 1) + ' km';
    }
    function clock(t) {
        var d = new Date(t);
        return String(d.getHours()).padStart(2, '0') + ':' +
               String(d.getMinutes()).padStart(2, '0');
    }

    /* Distanz -> Radius auf dem Zifferblatt.
       Logarithmisch, weil die relevanten Abstaende von 5 m (Hinterrad)
       bis 500 m (abgerissen) reichen. Linear waere alles unter 50 m
       ein Punkt in der Mitte. */
    function radiusFor(d) {
        var R = 92, DMAX = 500, K = 30;
        var v = Math.log(1 + d / K) / Math.log(1 + DMAX / K);
        return Math.max(0, Math.min(1, v)) * R;
    }

    /* ---------------- Tacho ---------------- */
    function renderSpeed(speed, fresh) {
        var el = $('mySpeed');
        if (speed === null) { el.textContent = '--'; el.classList.add('stale'); return; }
        var v = kmh(speed);
        el.textContent = v < 10 ? v.toFixed(1) : String(Math.round(v));
        el.classList.toggle('stale', !fresh);
    }

    function renderRank(pos, total) {
        $('myRank').textContent = pos ? pos + '.' : '–';
        $('myRankLbl').textContent = total > 1 ? 'von ' + total : 'Position';
    }

    /* ---------------- Kompass ----------------
       Track-up: die eigene Fahrtrichtung zeigt immer nach oben, die
       Pfeile der anderen liegen relativ dazu. Das ist beim Fahren
       richtig -- eine nordfeste Rose muesste man erst umrechnen. */
    function renderCompass(me, peers, heading) {
        var g = $('cPeers');
        var parts = [];

        $('cCenter').textContent = heading === null ? 'kein Kurs' : 'DU';

        for (var i = 0; i < peers.length; i++) {
            var p = peers[i];
            if (p.dist === null || p.bearing === null) continue;

            // Ohne eigenen Kurs kann nur nordfest gezeichnet werden
            var rel = (heading === null) ? p.bearing : (p.bearing - heading);
            var a = (rel - 90) * Math.PI / 180;      // -90: 0 Grad = oben
            var r = radiusFor(p.dist);
            var x = Math.cos(a) * r, y = Math.sin(a) * r;

            var op = p.stale ? 0.4 : 1;
            parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
                       '" r="7" fill="' + p.color + '" opacity="' + op + '"></circle>');
            // Vorne/hinten kommt aus der Bogenlaenge, nicht aus der Peilung --
            // in einer Kurve liegt jemand seitlich und ist doch vorne.
            if (p.ahead !== null) {
                parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + 2.6).toFixed(1) +
                           '" text-anchor="middle" font-size="8" font-weight="700" ' +
                           'fill="rgba(0,0,0,.72)">' + (p.ahead ? '▲' : '▼') +
                           '</text>');
            }
            parts.push('<text x="' + x.toFixed(1) + '" y="' + (y - 10).toFixed(1) +
                       '" text-anchor="middle" font-size="7.5" fill="' + p.color +
                       '" opacity="' + op + '">' + escapeHtml(p.short) + '</text>');
        }
        g.innerHTML = parts.join('');
    }

    /* ---------------- Fahrerliste ---------------- */
    function renderRiders(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var tags = '';
            if (r.me) tags += '<span class="tag">DU</span>';
            if (r.ghost) tags += '<span class="tag ghost">GHOST</span>';
            if (r.dropped) tags += '<span class="tag drop">ABGERISSEN</span>';
            else if (r.stale) tags += '<span class="tag stale">KEIN SIGNAL</span>';

            var gap = '';
            if (r.me) {
                gap = '<i>&nbsp;</i>';
            } else if (r.gapM === null) {
                gap = '<i>ohne Bezug</i>';
            } else {
                var sign = r.gapM > 0 ? '+' : '−';
                gap = sign + fmtDist(Math.abs(r.gapM)) +
                      '<i>' + (r.gapS === null ? '' :
                               sign + Math.round(Math.abs(r.gapS)) + ' s') + '</i>';
            }

            out.push(
                '<div class="rrow' + (r.me ? ' me' : '') + (r.stale ? ' gone' : '') + '">' +
                  '<div class="rbar"></div>' +
                  '<div class="rdot" style="background:' + r.color + '"></div>' +
                  '<div class="rname">' + escapeHtml(r.name) + tags + '</div>' +
                  '<div class="rspd num">' + (r.speed === null ? '--' :
                        (kmh(r.speed) < 10 ? kmh(r.speed).toFixed(1)
                                           : Math.round(kmh(r.speed)))) + '</div>' +
                  '<div class="rgap num">' + gap + '</div>' +
                '</div>');
        }
        $('riderList').innerHTML = out.join('') ||
            '<div class="empty">Noch niemand verbunden.<br>' +
            'Teile den Link unter „Gruppe“ – wer ihn öffnet, erscheint hier.</div>';
    }

    /* ---------------- Führungsarbeit ---------------- */
    function renderFrontWork(rows) {
        if (!rows.length) { $('frontWork').innerHTML =
            '<div class="empty">Sobald gefahren wird, zählt hier mit, wer vorne war.</div>';
            return; }
        var max = 0;
        rows.forEach(function (r) { if (r.frontMs > max) max = r.frontMs; });
        var out = rows.map(function (r) {
            var w = max ? (100 * r.frontMs / max) : 0;
            return '<div style="padding:7px 0;border-bottom:1px solid var(--line)">' +
              '<div style="display:flex;justify-content:space-between;gap:8px;font-size:14px">' +
                '<span><span class="rdot" style="display:inline-block;width:9px;height:9px;' +
                'background:' + r.color + ';margin-right:6px"></span>' +
                escapeHtml(r.name) + '</span>' +
                '<span class="num">' + fmtDur(r.frontMs) +
                '  <span style="color:var(--ink3);font-size:11px">' +
                Math.round(r.share * 100) + ' %</span></span></div>' +
              '<div class="bar"><i style="width:' + w.toFixed(0) +
                '%;background:' + r.color + '"></i></div></div>';
        });
        $('frontWork').innerHTML = out.join('');
    }

    /* ---------------- Ereignisse ---------------- */
    var ICONS = { pass: '⇄', attack: '⚡', drop: '✂',
                  rejoin: '↻', lead: '⚑', msg: '✉' };

    function renderEvents(evs) {
        if (!evs.length) { $('eventList').innerHTML =
            '<div class="empty">Überholvorgänge, Antritte und Abrisse erscheinen hier, ' +
            'sobald die Streckenachse steht (etwa 150 m nach dem Start).</div>'; return; }
        var out = evs.slice().reverse().slice(0, 80).map(function (e) {
            return '<div class="ev ' + e.type + '">' +
                '<span class="tm num">' + clock(e.t) + '</span>' +
                '<span class="ic">' + (ICONS[e.type] || '•') + '</span>' +
                '<span>' + e.text + '</span></div>';
        });
        $('eventList').innerHTML = out.join('');
    }

    /* ---------------- Berge ---------------- */
    function renderClimbs(climbs) {
        if (!climbs.length) { $('climbList').innerHTML =
            '<div class="empty">Noch kein Anstieg erkannt.<br>' +
            'Erkannt werden Rampen ab etwa 200 m Länge und 12 Höhenmetern – ' +
            'kürzere gibt die GPS-Höhe nicht her.</div>'; return; }

        var out = climbs.map(function (c) {
            var rank = c.ranking.map(function (x, i) {
                return '<div class="crank' + (i === 0 ? ' win' : '') + '">' +
                    '<span class="pos num">' + (i + 1) + '.</span>' +
                    '<span class="nm"><span style="display:inline-block;width:9px;height:9px;' +
                    'border-radius:50%;background:' + x.color + ';margin-right:6px"></span>' +
                    escapeHtml(x.name) + '</span>' +
                    '<span class="tme num">' + fmtDur(x.ms) + '</span>' +
                    '<span class="vam num">' + Math.round(x.vam) + ' Hm/h</span></div>';
            }).join('') || '<div class="empty" style="padding:4px 0">Noch niemand oben.</div>';

            return '<div class="climb"><div class="hd">' +
                '<span class="ttl">Anstieg ' + c.no + '</span>' +
                '<span class="meta num">+' + c.gain.toFixed(0) + ' Hm &middot; ' +
                fmtDist(c.len) + ' &middot; ' + (c.grade * 100).toFixed(1) + ' %</span>' +
                '</div>' + rank + '</div>';
        });
        $('climbList').innerHTML = out.join('');
    }

    /* ---------------- Kopfzeile / Hinweise ---------------- */
    function renderNet(state, txt) {
        var d = $('netDot');
        d.className = state === 'online' ? 'on' : (state === 'off' ? '' : 'wait');
        $('netTxt').innerHTML = txt;
    }
    function renderHeadingSrc(h) {
        $('hdSrc').textContent = h.deg === null ? h.src
            : Math.round(h.deg) + '° ' + h.src;
    }

    function badge(id, n) {
        var el = $(id);
        el.hidden = !n;
        el.textContent = n;
    }

    /* Ereignis in Worte. Nimmt die Auswertung mit, damit dieselbe Formulierung
       fuer die Live-Fahrt und das Replay gilt. */
    function eventText(an, e) {
        function nm(id) { var r = an.riders[id]; return escapeHtml((r && r.name) || id); }
        switch (e.type) {
            case 'pass':   return nm(e.id) + ' überholt ' + nm(e.over);
            case 'attack': return nm(e.id) + ' tritt an – ' + e.gain + ' m gewonnen' +
                                  (e.surge ? ' (+' + e.surge + ' km/h)' : '');
            case 'drop':   return nm(e.id) + (e.standing ? ' steht' : ' ist abgerissen') +
                                  (e.gap ? ' – ' + fmtDist(e.gap) + ' zurück' : '');
            case 'rejoin': return nm(e.id) + ' ist wieder dran';
            case 'lead':   return nm(e.id) + ' übernimmt die Führung' + (e.from ? ' von ' + nm(e.from) : '');
            case 'msg':    return escapeHtml(e.name || nm(e.id)) + ': ' + escapeHtml(Msg.text(e.q));
            default:       return e.type;
        }
    }

    function escapeHtml(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return {
        COLORS: COLORS,
        renderSpeed: renderSpeed, renderRank: renderRank,
        renderCompass: renderCompass, renderRiders: renderRiders,
        renderFrontWork: renderFrontWork, renderEvents: renderEvents,
        renderClimbs: renderClimbs, renderNet: renderNet,
        renderHeadingSrc: renderHeadingSrc, badge: badge,
        fmtDur: fmtDur, fmtDist: fmtDist, escapeHtml: escapeHtml, kmh: kmh, eventText: eventText
    };
})();
