/* ============================================================
 * rides.js -- save, import, export rides
 * ============================================================
 * Everything stays on the device (localStorage). A server never sees any of it
 * (except what you upload yourself to the optional league, see
 * liga-sync.js), there is no account, and the rides are gone as soon as
 * the browser clears the site data -- that is why there is the GPX export for every
 * ride.
 *
 * Format of a saved ride (compact, about 35 bytes per point,
 * so around 250 KB for three hours):
 *   { id, name, src, start, dur, dist, n, x?,
 *     p: [[seconds since start, lat, lon, elevation|null], ...] }
 * src: 'ride' (ridden), 'sim' (simulation), 'gpx' (imported),
 *      'plan' (generated from a training plan)
 *
 * Sources for a ghost:
 *   - an own previously ridden ride
 *   - a GPX file WITH timestamps (Strava, Garmin, Wahoo ...)
 *   - a GPX route WITHOUT time plus a target pace
 *   - a training plan (sections with duration and pace) on a route
 * All four become the same form: points with time.
 * ============================================================ */

var Rides = (function () {
    'use strict';

    var IDX = 'rides:index', PFX = 'rides:r:', GPFX = 'rides:g:', DRAFT = 'rides:draft';
    var MIN_POINTS = 40;                 // below this saving is not worth it

    function read(k)  { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function write(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); return true; } catch (e) { return false; } }
    function drop(k)  { try { localStorage.removeItem(k); } catch (e) {} }

    function newId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

    /* ---------- Conversion ---------- */
    // pts: [{t (ms), lat, lon, ele|null}]  ->  compact
    function pack(pts) {
        var t0 = pts[0].t;
        return pts.map(function (q) {
            return [Math.round((q.t - t0) / 100) / 10, +q.lat.toFixed(6), +q.lon.toFixed(6),
                    (q.ele === null || q.ele === undefined || isNaN(q.ele)) ? null : Math.round(q.ele * 10) / 10];
        });
    }

    function distanceOf(pts) {
        var d = 0;
        for (var i = 1; i < pts.length; i++) d += Geo.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        return d;
    }

    function fmtDate(t) {
        var d = new Date(t);
        return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '. ' +
               String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /* ---------- Storage ---------- */
    function list() {
        var l = read(IDX) || [];
        return l.slice().sort(function (a, b) { return b.start - a.start; });
    }
    function get(id) { return read(PFX + id); }

    /* o: { name, src, pts } -> { ok, id } | { ok:false, err } */
    function save(o) {
        if (!o.pts || o.pts.length < 2) return { ok: false, err: T('Zu kurz zum Speichern.') };
        var id = newId();
        var rec = {
            id: id, src: o.src || 'ride',
            name: o.name || ((o.src === 'sim' ? T('Simulation') : T('Ausfahrt')) + ' ' + fmtDate(o.pts[0].t)),
            start: o.pts[0].t, dur: o.pts[o.pts.length - 1].t - o.pts[0].t,
            dist: Math.round(distanceOf(o.pts)), n: o.pts.length,
            p: pack(o.pts)
        };
        if (o.x) rec.x = o.x;               // extra data of the recording, e.g. { coffee: 2 } for the league
        if (!write(PFX + id, rec)) return { ok: false, err: T('Speicher voll – alte Ausfahrten löschen oder als GPX sichern.') };
        var hasGroup = false;
        if (o.group) {
            // The group is optional: if it no longer fits, at least the own ride stays
            hasGroup = write(GPFX + id, o.group);
            if (!hasGroup) drop(GPFX + id);
        }
        var idx = read(IDX) || [];
        idx.push({ id: id, name: rec.name, src: rec.src, start: rec.start, dur: rec.dur, dist: rec.dist, n: rec.n, g: hasGroup });
        if (!write(IDX, idx)) { drop(PFX + id); drop(GPFX + id); return { ok: false, err: T('Speicher voll.') }; }
        return { ok: true, id: id, rec: rec };
    }

    function getGroup(id) { return read(GPFX + id); }

    function remove(id) {
        drop(PFX + id); drop(GPFX + id);
        write(IDX, (read(IDX) || []).filter(function (r) { return r.id !== id; }));
    }

    function usage() {                         // rough, in KB
        var bytes = 0;
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k.indexOf('rides:') === 0) bytes += k.length + (localStorage.getItem(k) || '').length;
            }
        } catch (e) {}
        return Math.round(bytes * 2 / 1024);   // UTF-16: 2 bytes per character
    }

    /* ---------- Draft: protects against a crash/empty battery during the ride ---------- */
    function saveDraft(src, pts) {
        if (pts.length < MIN_POINTS) return;
        write(DRAFT, { src: src, start: pts[0].t, p: pack(pts) });
    }
    function draft() { return read(DRAFT); }
    function clearDraft() { drop(DRAFT); }
    function unpack(rec) {
        return rec.p.map(function (q) { return { t: rec.start + q[0] * 1000, lat: q[1], lon: q[2], ele: q[3] }; });
    }

    /* ---------- GPX ---------- */
    function gpx(name, pts) {
        function iso(t) { return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'); }
        function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        var o = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<gpx version="1.1" creator="Gruppenausfahrt" xmlns="http://www.topografix.com/GPX/1/1">',
            '<trk><name>' + esc(name) + '</name><type>cycling</type><trkseg>'];
        pts.forEach(function (p) {
            o.push('<trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '">' +
                   ((p.ele !== null && p.ele !== undefined) ? '<ele>' + p.ele.toFixed(1) + '</ele>' : '') +
                   '<time>' + iso(p.t) + '</time></trkpt>');
        });
        o.push('</trkseg></trk></gpx>');
        return o.join('\n');
    }

    /* -> { name, pts: [{lat, lon, ele, t|null}], timed } or throws */
    function parseGpx(text) {
        var doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error(T('Keine gültige GPX-Datei.'));
        var nodes = doc.getElementsByTagName('trkpt');
        if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
        if (nodes.length < 2) throw new Error(T('Die Datei enthält keine Strecke (trkpt/rtept).'));
        var pts = [], timed = 0;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
            if (isNaN(lat) || isNaN(lon)) continue;
            var e = n.getElementsByTagName('ele')[0], tm = n.getElementsByTagName('time')[0];
            var t = tm ? Date.parse(tm.textContent) : NaN;
            if (!isNaN(t)) timed++;
            pts.push({ lat: lat, lon: lon, ele: e ? parseFloat(e.textContent) : null, t: isNaN(t) ? null : t });
        }
        var nm = doc.getElementsByTagName('name')[0];
        return { name: nm ? nm.textContent.trim() : '', pts: pts, timed: timed >= pts.length * 0.9 };
    }

    /* ---------- Putting time on a route ---------- */
    // Constant pace (km/h) over a route without timestamps
    function withPace(pts, kmh) {
        var v = Math.max(1, kmh) / 3.6, t = Date.now(), out = [];
        for (var i = 0; i < pts.length; i++) {
            if (i) t += Geo.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) / v * 1000;
            out.push({ t: t, lat: pts[i].lat, lon: pts[i].lon, ele: pts[i].ele });
        }
        return out;
    }

    /* Training plan: sections { min, kmh } one after another on a route.
       One point per second is generated. If the plan or the route ends,
       the ghost ends there. */
    function fromPlan(routePts, segments) {
        var n = routePts.length, cum = [0];
        for (var i = 1; i < n; i++) {
            cum.push(cum[i - 1] + Geo.distance(routePts[i - 1].lat, routePts[i - 1].lon, routePts[i].lat, routePts[i].lon));
        }
        var total = cum[n - 1];
        function at(d) {
            if (d >= total) return routePts[n - 1];
            var lo = 0, hi = n - 1;
            while (lo < hi) { var m = (lo + hi + 1) >> 1; if (cum[m] <= d) lo = m; else hi = m - 1; }
            var a = routePts[lo], b = routePts[Math.min(n - 1, lo + 1)], span = (cum[Math.min(n - 1, lo + 1)] - cum[lo]) || 1;
            var f = (d - cum[lo]) / span;
            return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon),
                     ele: (a.ele !== null && b.ele !== null) ? a.ele + f * (b.ele - a.ele) : a.ele };
        }
        var bounds = [], acc = 0;
        segments.forEach(function (s) { acc += s.min * 60; bounds.push({ end: acc, v: s.kmh / 3.6 }); });
        var planSec = acc, out = [], d = 0, T = 0, k = 0, t0 = Date.now();
        while (T <= planSec && d < total && out.length < 30000) {
            var p = at(d);
            out.push({ t: t0 + T * 1000, lat: p.lat, lon: p.lon, ele: p.ele });
            while (k < bounds.length - 1 && T >= bounds[k].end) k++;
            d += bounds[k].v;
            T += 1;
        }
        var last = at(Math.min(d, total));
        out.push({ t: t0 + T * 1000, lat: last.lat, lon: last.lon, ele: last.ele });
        return out;
    }

    /* Check a plan file. Expects:
       { "name": "4x4", "segments": [ { "min": 10, "kmh": 25 }, ... ] }
       optionally "gpx": "<gpx ...>" as the route. */
    function parsePlan(text) {
        var o = JSON.parse(text);
        if (!o || !Array.isArray(o.segments) || !o.segments.length) throw new Error(T('Im Plan fehlt „segments“.'));
        o.segments.forEach(function (s, i) {
            if (!(s.min > 0) || !(s.kmh > 0)) throw new Error(T('Abschnitt {n}: „min“ und „kmh“ müssen größer 0 sein.', { n: i + 1 }));
        });
        return o;
    }

    return {
        MIN_POINTS: MIN_POINTS,
        list: list, get: get, getGroup: getGroup, save: save, remove: remove, usage: usage,
        saveDraft: saveDraft, draft: draft, clearDraft: clearDraft, unpack: unpack,
        gpx: gpx, parseGpx: parseGpx, withPace: withPace, fromPlan: fromPlan, parsePlan: parsePlan,
        fmtDate: fmtDate, distanceOf: distanceOf
    };
})();
