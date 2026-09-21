/* ============================================================
 * segui.js -- interface for segments, best times and records
 * ============================================================
 *   - Climbs > Segments: list with best time, last time and course per segment
 *   - Climbs > Records:  fastest 1/5/10/20/40 km, best 5/20 minutes, ...
 *   - Editor: create a section of a saved ride as a segment
 *   - Live banner on the speedometer: time on the segment and lead/deficit
 *     against the best time while riding
 * ============================================================ */

var SegUI = (function () {
    'use strict';

    var state = { world: 'real', open: {} };
    var liveSeg = null, active = {}, toast = null, lastReport = null;
    var cr = { rec: null, pts: null, cum: null };

    function $(id) { return document.getElementById(id); }
    function esc(s) { return UI.escapeHtml(s); }

    function fmt(ms) {                        // m:ss
        var s = Math.round(ms / 1000), m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }
    function fmtDelta(ms) {                   // +8.3 s / −12.1 s
        var sgn = ms < 0 ? '−' : '+', a = Math.abs(ms) / 1000;
        return sgn + (a >= 60 ? fmt(Math.abs(ms)) : a.toFixed(1).replace('.', I18n.sep()) + ' s');
    }
    function fmtDate(t) { return Rides.fmtDate(t); }

    function setWorld(w) { state.world = (w === 'sim') ? 'sim' : 'real'; refresh(); }
    function worldSwitch() {
        return '<div class="worldsw"><div class="seg" role="group" aria-label="' + esc(T('Fahrten oder Simulation')) + '">' +
            '<button data-w="real"' + (state.world === 'real' ? ' class="on"' : '') + '>' + T('Echte Fahrten') + '</button>' +
            '<button data-w="sim"' + (state.world === 'sim' ? ' class="on"' : '') + '>' + T('Simulation') + '</button></div></div>';
    }

    /* ---------------- Segments ---------------- */
    function renderSegments() {
        Segments.use(state.world);
        var segs = Segments.list();
        segs.sort(function (a, b) {
            var la = a.efforts.length ? a.efforts[a.efforts.length - 1].t : a.created;
            var lb = b.efforts.length ? b.efforts[b.efforts.length - 1].t : b.created;
            return lb - la;
        });
        var out = [worldSwitch(), '<button class="btn" id="segNew">' + T('Segment aus einer Fahrt anlegen') + '</button>'];
        if (state.world === 'sim') out.push('<div class="note">' + T('Simulationsfahrten zählen nicht für deine echten Bestzeiten – sie haben eigene Segmente.') + '</div>');
        if (!segs.length) {
            out.push('<div class="empty">' + T('Noch keine Segmente.') + '<br>' +
                     T('Anstiege werden nach jeder Fahrt automatisch erkannt und gespeichert. Eigene Abschnitte legst du mit dem Knopf oben an – auch aus importierten GPX-Dateien.') + '</div>');
        }
        segs.forEach(function (seg) {
            var best = Segments.bestOf(seg), last = seg.efforts[seg.efforts.length - 1], open = !!state.open[seg.id];
            var body;
            if (!best) body = T('Noch nicht gefahren.');
            else {
                body = T('Bestzeit') + ' <span class="big">' + fmt(best.ms) + '</span> · ' + best.kmh.toFixed(1).replace('.', I18n.sep()) + ' km/h · ' + fmtDate(best.t);
                if (last && last !== best) body += '<br>' + T('Zuletzt') + ' ' + fmt(last.ms) + ' (<span class="' + (last.ms > best.ms ? 'neg' : 'pos') + '">' + fmtDelta(last.ms - best.ms) + '</span>)';
                body += '<br>' + (seg.efforts.length === 1 ? T('{n} Fahrt', { n: 1 }) : T('{n} Fahrten', { n: seg.efforts.length }));
                if (seg.gain > 0 && best.vam) body += ' · ' + Math.round(best.vam) + ' ' + T('Hm/h');
            }
            var eff = '';
            if (open && seg.efforts.length) {
                eff = seg.efforts.slice().sort(function (a, b) { return b.t - a.t; }).map(function (e) {
                    return '<div class="efrow' + (e === best ? ' pbrow' : '') + '"><span>' + fmtDate(e.t) + '</span>' +
                        '<span class="num">' + fmt(e.ms) + (e === best ? ' ★' : '') + '</span>' +
                        '<span class="num ' + (e.ms > best.ms ? 'neg' : 'pos') + '">' + (e === best ? '' : fmtDelta(e.ms - best.ms)) + '</span>' +
                        '<span class="num">' + e.kmh.toFixed(1).replace('.', I18n.sep()) + '</span></div>';
                }).join('');
            }
            out.push('<div class="segcard" data-id="' + seg.id + '">' +
                '<div class="sh"><b>' + esc(seg.name) + '</b><span class="sm">' + UI.fmtDist(seg.len) +
                (seg.gain > 0 ? ' · +' + Math.round(seg.gain) + ' ' + T('Hm') + ' · ' + (seg.grade * 100).toFixed(1).replace('.', I18n.sep()) + ' %' : '') + '</span></div>' +
                '<div class="sb">' + body + '</div>' + eff +
                '<div class="sa">' + (seg.efforts.length ? '<button data-act="open">' + (open ? T('Verlauf zu') : T('Verlauf anzeigen')) + '</button>' : '') +
                '<button data-act="rename">' + T('Umbenennen') + '</button><button data-act="del">' + T('Löschen') + '</button></div></div>');
        });
        $('segPane').innerHTML = out.join('');
    }

    /* ---------------- Records ---------------- */
    function renderRecords() {
        Segments.use(state.world);
        var st = Segments.bests(), out = [worldSwitch()], any = false;
        var fresh = {};
        if (lastReport && lastReport.world === state.world) lastReport.records.forEach(function (r) { fresh[r.key] = true; });
        Segments.RECORDS.forEach(function (R) {
            var rec = st[R.key];
            if (!rec) return;
            any = true;
            var val, sub = '';
            if (R.kind === 'time') { var L = +R.key.slice(1); val = fmt(rec.v); sub = (L / (rec.v / 1000) * 3.6).toFixed(1).replace('.', I18n.sep()) + ' km/h'; }
            else if (R.kind === 'dist') { val = UI.fmtDist(rec.v); sub = (rec.v / (R.win / 1000) * 3.6).toFixed(1).replace('.', I18n.sep()) + ' km/h'; }
            else if (R.kind === 'speed') val = (rec.v * 3.6).toFixed(1).replace('.', I18n.sep()) + ' km/h';
            else if (R.kind === 'gain') val = '+' + Math.round(rec.v) + ' ' + T('Hm');
            else val = UI.fmtDist(rec.v);
            out.push('<div class="recrow"><span class="rl">' + T(R.label) + (fresh[R.key] ? '<span class="newb">' + T('NEU') + '</span>' : '') +
                     '</span><span class="rv num">' + val + '</span><span class="rd">' + (sub ? sub + ' · ' : '') + esc(rec.rname) + ' · ' + fmtDate(rec.t) + '</span></div>');
        });
        if (!any) out.push('<div class="empty">' + T('Noch keine Rekorde.') + '<br>' +
                           T('Sie entstehen automatisch aus jeder beendeten Fahrt – auch aus importierten GPX-Dateien (Fahrten → Importieren). Kürzere Fahrten als 1 km zählen nicht.') + '</div>');
        $('recPane').innerHTML = out.join('');
    }

    function refresh() {
        if (!$('segPane')) return;
        renderSegments(); renderRecords();
    }

    /* ---------------- Editor ---------------- */
    function selection() {
        var total = cr.cum[cr.cum.length - 1] || 1;
        var fa = $('seA').value / 1000, fb = $('seB').value / 1000;
        return { iA: Track.idxAt(cr.cum, fa * total), iB: Math.min(cr.pts.length - 1, Track.idxAt(cr.cum, fb * total)), total: total };
    }

    function drawPreview() {
        var svg = $('seSvg'), W = svg.clientWidth || 300, H = svg.clientHeight || 170;
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        var pts = cr.pts, fr = Geo.frame(pts[0].lat, pts[0].lon), xy = pts.map(function (p) { return fr.toXY(p.lat, p.lon); });
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        xy.forEach(function (q) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
        var pad = 14, k = Math.min((W - 2 * pad) / Math.max(30, x1 - x0), (H - 2 * pad) / Math.max(30, y1 - y0));
        var ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 + y1 * k;
        function X(q) { return (q.x * k + ox).toFixed(1); }
        function Y(q) { return (oy - q.y * k).toFixed(1); }
        var step = Math.max(1, Math.floor(xy.length / 300)), all = '';
        for (var i = 0; i < xy.length; i += step) all += (all ? 'L' : 'M') + X(xy[i]) + ' ' + Y(xy[i]);
        var s = selection(), sel = '';
        for (var j = s.iA; j <= s.iB; j += Math.max(1, Math.floor((s.iB - s.iA) / 200))) sel += (sel ? 'L' : 'M') + X(xy[j]) + ' ' + Y(xy[j]);
        sel += 'L' + X(xy[s.iB]) + ' ' + Y(xy[s.iB]);
        svg.innerHTML = '<path class="stt" d="' + all + '"/><path class="ssel" d="' + sel + '"/>' +
            '<circle class="sdot" cx="' + X(xy[s.iA]) + '" cy="' + Y(xy[s.iA]) + '" r="5"/>' +
            '<circle class="sdot" cx="' + X(xy[s.iB]) + '" cy="' + Y(xy[s.iB]) + '" r="5"/>';
        var sec = pts.slice(s.iA, s.iB + 1), len = cr.cum[s.iB] - cr.cum[s.iA], dur = pts[s.iB].t - pts[s.iA].t;
        $('seStats').textContent = UI.fmtDist(len) + ' · +' + Math.round(Track.gain(sec)) + ' ' + T('Hm') + ' · ' +
            (dur > 0 ? fmt(dur) + ' · ' + (len / (dur / 1000) * 3.6).toFixed(1).replace('.', I18n.sep()) + ' km/h' : '');
        return { len: len };
    }

    function keepOrder(changed) {                 // start before end, at least 200 m in between
        var total = cr.cum[cr.cum.length - 1] || 1, min = Math.min(400, 200 / total * 1000);
        var a = +$('seA').value, b = +$('seB').value;
        if (b - a < min) { if (changed === 'A') { $('seB').value = Math.min(1000, a + min); if (+$('seB').value - a < min) $('seA').value = Math.max(0, +$('seB').value - min); } else { $('seA').value = Math.max(0, b - min); if (b - +$('seA').value < min) $('seB').value = Math.min(1000, +$('seA').value + min); } }
    }

    function loadRide(id) {
        var rec = Rides.get(id);
        if (!rec) return;
        cr.rec = rec; cr.pts = Segments.trackOf(rec); cr.cum = Track.cumulative(cr.pts);
        $('seA').value = 0; $('seB').value = 1000;
        $('seName').value = T('Segment') + ' ' + (Segments.list().length + 1);
        $('seMsg').textContent = '';
        drawPreview();
    }

    function openEditor() {
        Segments.use(state.world);
        var rides = Rides.list().filter(function (r) { return r.src !== 'plan' && Segments.worldOf(r.src) === state.world && r.n >= 20; });
        if (!rides.length) { alert(state.world === 'sim' ? T('Es gibt noch keine gespeicherte Simulationsfahrt.') : T('Es gibt noch keine gespeicherte Fahrt. Segmente werden aus einer Fahrt herausgeschnitten.')); return; }
        $('seRide').innerHTML = rides.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + ' · ' + UI.fmtDist(r.dist) + '</option>'; }).join('');
        $('segEdit').hidden = false;
        loadRide(rides[0].id);
    }

    function saveEditor() {
        var s = selection(), name = ($('seName').value || '').trim() || T('Segment');
        if (s.iB <= s.iA) { $('seMsg').textContent = T('Anfang muss vor dem Ende liegen.'); return; }
        Segments.use(state.world);
        var seg = Segments.fromSection(cr.pts, s.iA, s.iB, name, 'custom', false);
        if (seg.len < 150) { $('seMsg').textContent = T('Das Segment ist zu kurz (mindestens 150 m).'); return; }
        var found = Segments.addSegment(seg);
        $('seMsg').textContent = found === 1 ? T('„{name}“ gespeichert – in 1 Fahrt gefunden.', { name: name }) : T('„{name}“ gespeichert – in {n} Fahrten gefunden.', { name: name, n: found });
        refresh();
        setTimeout(function () { $('segEdit').hidden = true; }, 1100);
    }

    /* ---------------- Live banner ---------------- */
    function startLive(world) { liveSeg = Segments.live(world); active = {}; toast = null; renderBanner(); }
    function stopLive() { liveSeg = null; active = {}; toast = null; renderBanner(); }

    function feed(fix) {
        if (!liveSeg) return;
        var ev = liveSeg.update(fix);
        ev.forEach(function (e) {
            if (e.type === 'start' || e.type === 'progress') active[e.seg.id] = e;
            else if (e.type === 'abort') delete active[e.seg.id];
            else if (e.type === 'finish') {
                delete active[e.seg.id];
                toast = { until: Date.now() + 14000, e: e };
                if (e.isPB && e.best !== null && navigator.vibrate) { try { navigator.vibrate([180, 70, 180]); } catch (x) {} }
            }
        });
        renderBanner();
    }

    function renderBanner() {
        var el = $('segBanner');
        if (!el) return;
        var now = Date.now(), html = '', cls = '';
        if (toast && toast.until > now) {
            var e = toast.e;
            cls = e.isPB ? 'pb' : (e.delta > 0 ? 'behind' : 'ahead');
            html = '<b>' + esc(e.seg.name) + ' · ' + fmt(e.ms) + '</b> ' +
                   (e.best === null ? '<div class="sub2">' + T('Erste Fahrt – die Zeit ist jetzt deine Bestzeit.') + '</div>'
                    : e.isPB ? Emo.img('🏆') + ' ' + T('neue Bestzeit ({d})', { d: fmtDelta(e.delta) }) : '<div class="sub2">' + T('{d} zur Bestzeit {t}', { d: fmtDelta(e.delta), t: fmt(e.best) }) + '</div>');
        } else {
            var ids = Object.keys(active);
            if (ids.length) {
                var a = active[ids[0]];
                cls = a.delta == null ? '' : (a.delta <= 0 ? 'ahead' : 'behind');
                html = '<b>▲ ' + esc(a.seg.name) + '</b> ' + fmt(a.elapsed || 0) +
                       (a.best ? ' · ' + T('Bestzeit') + ' ' + fmt(a.best) : '') +
                       '<div class="sub2">' + (a.delta == null ? (a.best ? T('Vergleich ab 5 % der Strecke') : T('erste Fahrt auf diesem Segment'))
                           : (a.delta <= 0 ? T('vor der Bestzeit: {d}', { d: fmtDelta(a.delta).replace(/^[+−]/, '') }) : T('hinter der Bestzeit: {d}', { d: fmtDelta(a.delta).replace(/^[+−]/, '') }))) +
                       ' · ' + T('noch {d}', { d: UI.fmtDist(a.left !== undefined ? a.left : a.seg.len) }) + '</div>';
            }
        }
        el.hidden = !html;
        el.className = 'segbanner ' + cls;
        if (html) el.innerHTML = html;
    }

    /* ---------------- Wiring ---------------- */
    function init() {
        function pane(id) {
            $(id).addEventListener('click', function (e) {
                var w = e.target.closest('[data-w]');
                if (w) { setWorld(w.dataset.w); return; }
                if (e.target.id === 'segNew') { openEditor(); return; }
                var b = e.target.closest('[data-act]'), card = e.target.closest('.segcard');
                if (!b || !card) return;
                var id = card.dataset.id, act = b.dataset.act;
                Segments.use(state.world);
                if (act === 'open') { state.open[id] = !state.open[id]; renderSegments(); }
                else if (act === 'rename') {
                    var seg = Segments.get(id), nn = prompt(T('Neuer Name für das Segment:'), seg ? seg.name : '');
                    if (nn && nn.trim()) { Segments.rename(id, nn.trim().slice(0, 40)); renderSegments(); }
                } else if (act === 'del') {
                    if (confirm(T('Segment samt allen Zeiten löschen?'))) { Segments.remove(id); renderSegments(); }
                }
            });
        }
        pane('segPane'); pane('recPane');
        $('seRide').addEventListener('change', function () { loadRide(this.value); });
        $('seA').addEventListener('input', function () { keepOrder('A'); drawPreview(); });
        $('seB').addEventListener('input', function () { keepOrder('B'); drawPreview(); });
        $('seSave').addEventListener('click', saveEditor);
        $('seCancel').addEventListener('click', function () { $('segEdit').hidden = true; });
        setInterval(renderBanner, 1000);          // banner expires, even without a new position
        refresh();
    }

    return { init: init, refresh: refresh, setWorld: setWorld, startLive: startLive, stopLive: stopLive, feed: feed,
             setReport: function (r) { lastReport = r; refresh(); }, fmt: fmt };
})();
