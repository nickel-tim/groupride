/* ============================================================
 * ui.js -- presentation
 * ============================================================
 * On the handlebars: a number you grasp at a glance at 30 km/h
 * is worth more than five you would have to read. Hence
 * large, tabular and without animation on the numbers.
 * ============================================================ */

var UI = (function () {
    'use strict';

    /* Rider colours: distinguishable on both backgrounds and still
       separable with red-green colour blindness (brightness varies too). */
    var COLORS = ['#f2b01e', '#3fa9f5', '#ff6b52', '#8bc34a',
                  '#b48ce8', '#26c6da', '#ec87b9', '#c9a227'];

    /* Symbols to choose from. Only the NUMBER from this list goes over the wire (no text):
       that way nobody can smuggle in arbitrary content, and the report stays tiny. The list
       may only grow at the end -- otherwise older apps show a wrong symbol. All single
       emoji characters (no zero-width-joiner sequences) that are rendered the same everywhere. */
    var EMOJIS = ['🚴', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🦄', '🐺', '🦅', '🐝',
                  '🦉', '🐧', '🐢', '🐇', '🔥', '⚡', '⭐', '🍀', '🚀', '🍕', '☕', '🎸'];
    function emojiOf(i) { return (typeof i === 'number' && i >= 0 && i < EMOJIS.length && i % 1 === 0) ? EMOJIS[i] : ''; }
    function validEmoji(i) { return emojiOf(i) ? i : null; }

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

    /* Distance -> radius on the dial.
       Logarithmic, because the relevant distances range from 5 m (rear wheel)
       to 500 m (dropped). With a linear scale everything below 50 m
       would be one dot in the centre. */
    function radiusFor(d) {
        var R = 92, DMAX = 500, K = 30;
        var v = Math.log(1 + d / K) / Math.log(1 + DMAX / K);
        return Math.max(0, Math.min(1, v)) * R;
    }

    /* ---------------- Speedometer ---------------- */
    function renderSpeed(speed, fresh) {
        var el = $('mySpeed');
        if (speed === null) { el.textContent = '--'; el.classList.add('stale'); return; }
        var v = kmh(speed);
        el.textContent = v < 10 ? v.toFixed(1) : String(Math.round(v));
        el.classList.toggle('stale', !fresh);
    }

    function renderRank(pos, total) {
        $('myRank').textContent = pos ? pos + '.' : '–';
        $('myRankLbl').textContent = total > 1 ? T('von {n}', { n: total }) : T('Position');
    }

    /* ---------------- Compass ----------------
       Track-up: your own direction of travel always points up, the
       arrows of the others lie relative to it. That is right while
       riding -- a north-fixed rose would first have to be converted. */
    function renderCompass(me, peers, heading) {
        var g = $('cPeers');
        var parts = [];

        $('cCenter').textContent = heading === null ? T('kein Kurs') : T('DU');

        for (var i = 0; i < peers.length; i++) {
            var p = peers[i];
            if (p.dist === null || p.bearing === null) continue;

            // Without an own heading it can only be drawn north-fixed
            var rel = (heading === null) ? p.bearing : (p.bearing - heading);
            var a = (rel - 90) * Math.PI / 180;      // -90: 0 degrees = up
            var r = radiusFor(p.dist);
            var x = Math.cos(a) * r, y = Math.sin(a) * r;

            var op = p.stale ? 0.4 : 1;
            parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
                       '" r="' + (p.emoji ? 8.5 : 7) + '" fill="' + p.color + '" opacity="' + op + '"></circle>');
            if (p.emoji) {
                // Symbol in the dot; front/back as a small triangle beside it so that it does not get lost
                parts.push('<g opacity="' + op + '">' + Emo.svg(p.emoji, x, y, 13) + '</g>');
                if (p.ahead !== null) {
                    parts.push('<text x="' + (x + 11.5).toFixed(1) + '" y="' + (y + 2.6).toFixed(1) +
                               '" text-anchor="middle" font-size="7" font-weight="700" fill="' + p.color +
                               '" opacity="' + op + '">' + (p.ahead ? '▲' : '▼') + '</text>');
                }
            }
            // Front/back comes from the arc length, not from the bearing --
            // in a bend somebody lies to the side and is still in front.
            else if (p.ahead !== null) {
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

    /* ---------------- Rider list ---------------- */
    function renderRiders(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var tags = '';
            if (r.me) tags += '<span class="tag">' + T('DU') + '</span>';
            if (r.ghost) tags += '<span class="tag ghost">' + T('GHOST') + '</span>';
            if (r.dropped) tags += '<span class="tag drop">' + T('ABGERISSEN') + '</span>';
            else if (r.stale) tags += '<span class="tag stale">' + T('KEIN SIGNAL') + '</span>';

            var gap = '';
            if (r.me) {
                gap = '<i>&nbsp;</i>';
            } else if (r.gapM === null) {
                gap = '<i>' + T('ohne Bezug') + '</i>';
            } else {
                var sign = r.gapM > 0 ? '+' : '−';
                gap = sign + fmtDist(Math.abs(r.gapM)) +
                      '<i>' + (r.gapS === null ? '' :
                               sign + Math.round(Math.abs(r.gapS)) + ' s') + '</i>';
            }

            out.push(
                '<div class="rrow' + (r.me ? ' me' : '') + (r.stale ? ' gone' : '') + '">' +
                  '<div class="rbar"></div>' +
                  (r.emoji ? '<div class="rdot em" style="background:' + r.color + '">' + Emo.img(r.emoji) + '</div>'
                           : '<div class="rdot" style="background:' + r.color + '"></div>') +
                  '<div class="rname">' + escapeHtml(r.name) + tags + '</div>' +
                  '<div class="rspd num">' + (r.speed === null ? '--' :
                        (kmh(r.speed) < 10 ? kmh(r.speed).toFixed(1)
                                           : Math.round(kmh(r.speed)))) + '</div>' +
                  '<div class="rgap num">' + gap + '</div>' +
                '</div>');
        }
        $('riderList').innerHTML = out.join('') ||
            '<div class="empty">' + T('Noch niemand verbunden.') + '<br>' +
            T('Teile den Link unter „Gruppe“ – wer ihn öffnet, erscheint hier.') + '</div>';
    }

    /* ---------------- Front work ---------------- */
    function renderFrontWork(rows) {
        if (!rows.length) { $('frontWork').innerHTML =
            '<div class="empty">' + T('Sobald gefahren wird, zählt hier mit, wer vorne war.') + '</div>';
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

    /* ---------------- Events ---------------- */
    var ICONS = { pass: '⇄', attack: Emo.img('⚡'), drop: '✂',
                  rejoin: '↻', lead: '⚑', msg: '✉' };

    function renderEvents(evs) {
        if (!evs.length) { $('eventList').innerHTML =
            '<div class="empty">' + T('Überholvorgänge, Antritte und Abrisse erscheinen hier, sobald die Streckenachse steht (etwa 150 m nach dem Start).') + '</div>'; return; }
        var out = evs.slice().reverse().slice(0, 80).map(function (e) {
            return '<div class="ev ' + e.type + '">' +
                '<span class="tm num">' + clock(e.t) + '</span>' +
                '<span class="ic">' + (ICONS[e.type] || '•') + '</span>' +
                '<span>' + e.text + '</span></div>';
        });
        $('eventList').innerHTML = out.join('');
    }

    /* ---------------- Climbs ---------------- */
    function renderClimbs(climbs) {
        if (!climbs.length) { $('climbList').innerHTML =
            '<div class="empty">' + T('Noch kein Anstieg erkannt.') + '<br>' +
            T('Erkannt werden Rampen ab etwa 200 m Länge und 12 Höhenmetern – kürzere gibt die GPS-Höhe nicht her.') + '</div>'; return; }

        var out = climbs.map(function (c) {
            var rank = c.ranking.map(function (x, i) {
                return '<div class="crank' + (i === 0 ? ' win' : '') + '">' +
                    '<span class="pos num">' + (i + 1) + '.</span>' +
                    '<span class="nm"><span style="display:inline-block;width:9px;height:9px;' +
                    'border-radius:50%;background:' + x.color + ';margin-right:6px"></span>' +
                    escapeHtml(x.name) + '</span>' +
                    '<span class="tme num">' + fmtDur(x.ms) + '</span>' +
                    '<span class="vam num">' + Math.round(x.vam) + ' ' + T('Hm/h') + '</span></div>';
            }).join('') || '<div class="empty" style="padding:4px 0">' + T('Noch niemand oben.') + '</div>';

            return '<div class="climb"><div class="hd">' +
                '<span class="ttl">' + T('Anstieg {n}', { n: c.no }) + '</span>' +
                '<span class="meta num">+' + c.gain.toFixed(0) + ' ' + T('Hm') + ' &middot; ' +
                fmtDist(c.len) + ' &middot; ' + (c.grade * 100).toFixed(1) + ' %</span>' +
                '</div>' + rank + '</div>';
        });
        $('climbList').innerHTML = out.join('');
    }

    /* ---------------- Header / hints ---------------- */
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

    /* Event in words. Takes the analysis along so that the same wording
       applies to the live ride and the replay. */
    function eventText(an, e) {
        function nm(id) { var r = an.riders[id]; return escapeHtml((r && r.name) || id); }
        switch (e.type) {
            case 'pass':   return T('{a} überholt {b}', { a: nm(e.id), b: nm(e.over) });
            case 'attack': return T('{a} tritt an – {m} m gewonnen', { a: nm(e.id), m: e.gain }) +
                                  (e.surge ? ' (+' + e.surge + ' km/h)' : '');
            case 'drop':   return (e.standing ? T('{a} steht', { a: nm(e.id) }) : T('{a} ist abgerissen', { a: nm(e.id) })) +
                                  (e.gap ? ' – ' + T('{d} zurück', { d: fmtDist(e.gap) }) : '');
            case 'rejoin': return T('{a} ist wieder dran', { a: nm(e.id) });
            case 'lead':   return e.from ? T('{a} übernimmt die Führung von {b}', { a: nm(e.id), b: nm(e.from) }) : T('{a} übernimmt die Führung', { a: nm(e.id) });
            case 'msg':    return escapeHtml(e.name || nm(e.id)) + ': ' + Msg.html(e.q);
            default:       return e.type;
        }
    }

    function escapeHtml(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return {
        COLORS: COLORS, EMOJIS: EMOJIS, emojiOf: emojiOf, validEmoji: validEmoji,
        renderSpeed: renderSpeed, renderRank: renderRank,
        renderCompass: renderCompass, renderRiders: renderRiders,
        renderFrontWork: renderFrontWork, renderEvents: renderEvents,
        renderClimbs: renderClimbs, renderNet: renderNet,
        renderHeadingSrc: renderHeadingSrc, badge: badge,
        fmtDur: fmtDur, fmtDist: fmtDist, escapeHtml: escapeHtml, kmh: kmh, eventText: eventText
    };
})();
