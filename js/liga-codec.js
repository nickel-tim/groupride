/* ============================================================
 * liga-codec.js -- Track und Kacheln kompakt kodieren
 * ============================================================
 * Diese Datei wird von der App UND vom Server (api/) benutzt -- gleiche Quelle, damit
 * beide Seiten nie auseinanderlaufen. Deshalb am Ende die CommonJS-Weiche.
 *
 * Track, Format 1 (vor gzip):
 *   varint n, varint startMs, varint flags (Bit 0: Hoehe vorhanden)
 *   je Punkt: zz dt (Zehntelsekunden seit vorigem), zz dlat, zz dlon (1e-5 Grad ~ 1,1 m),
 *             [zz dele (Dezimeter)]
 *   Der erste Punkt hat dt 0 und dlat/dlon/dele relativ zu 0 (also absolut).
 * varint: 7 Bit je Byte, hoechstes Bit = "es folgt noch eins". zz: Vorzeichen in Bit 0.
 * Alles mit normaler Arithmetik statt Bitoperationen, weil startMs (~1,7e12) nicht in 32 Bit passt.
 *
 * Kacheln (Zoom 15, id = x * 32768 + y): sortiert, Differenzen als varint.
 * ============================================================ */

var LigaCodec = (function () {
    'use strict';

    var Q = 1e5;                 // Grad -> ganze Einheiten
    var TILE_Z = 15;

    function zz(n) { return n >= 0 ? n * 2 : -n * 2 - 1; }
    function unzz(u) { return u % 2 === 0 ? u / 2 : -(u + 1) / 2; }

    function Writer() { this.b = []; }
    Writer.prototype.u = function (n) {
        while (n >= 128) { this.b.push((n % 128) + 128); n = Math.floor(n / 128); }
        this.b.push(n);
    };
    Writer.prototype.s = function (n) { this.u(zz(n)); };
    Writer.prototype.bytes = function () { return new Uint8Array(this.b); };

    function Reader(bytes) { this.b = bytes; this.i = 0; }
    Reader.prototype.u = function () {
        var n = 0, mul = 1, byte, guard = 0;
        do {
            if (this.i >= this.b.length) throw new Error('Track abgeschnitten');
            byte = this.b[this.i++];
            n += (byte % 128) * mul; mul *= 128;
            if (++guard > 8) throw new Error('Ungueltige Zahl im Track');
        } while (byte >= 128);
        return n;
    };
    Reader.prototype.s = function () { return unzz(this.u()); };

    /* pts: [{t (ms), lat, lon, ele|null}] aufsteigend nach t  ->  Uint8Array (ungepackt) */
    function pack(pts) {
        var w = new Writer(), n = pts.length, hasEle = false, i;
        for (i = 0; i < n; i++) if (pts[i].ele !== null && pts[i].ele !== undefined && !isNaN(pts[i].ele)) { hasEle = true; break; }
        w.u(n); w.u(Math.round(pts[0].t)); w.u(hasEle ? 1 : 0);
        var t0 = pts[0].t, pq = 0, pla = 0, plo = 0, pe = 0, lastEle = 0;
        for (i = 0; i < n; i++) {
            var p = pts[i], q = Math.round((p.t - t0) / 100);
            var la = Math.round(p.lat * Q), lo = Math.round(p.lon * Q);
            w.s(q - pq); w.s(la - pla); w.s(lo - plo);
            if (hasEle) {
                var e = (p.ele === null || p.ele === undefined || isNaN(p.ele)) ? lastEle : Math.round(p.ele * 10);
                w.s(e - pe); pe = e; lastEle = e;
            }
            pq = q; pla = la; plo = lo;
        }
        return w.bytes();
    }

    /* Uint8Array -> { n, t0, hasEle, pts: [{t, lat, lon, ele}] }. maxN begrenzt, was gelesen wird. */
    function unpack(bytes, maxN) {
        var r = new Reader(bytes), n = r.u(), t0 = r.u(), flags = r.u();
        if (n > (maxN || 200000)) throw new Error('Track zu lang');
        var hasEle = !!(flags & 1), pts = new Array(n), q = 0, la = 0, lo = 0, e = 0;
        for (var i = 0; i < n; i++) {
            q += r.s(); la += r.s(); lo += r.s();
            if (hasEle) e += r.s();
            pts[i] = { t: t0 + q * 100, lat: la / Q, lon: lo / Q, ele: hasEle ? e / 10 : null };
        }
        return { n: n, t0: t0, hasEle: hasEle, pts: pts };
    }

    /* ---- Kacheln ---- */
    function tileOf(lat, lon) {
        var n = 1 << TILE_Z, x = Math.floor((lon + 180) / 360 * n);
        var s = Math.sin(lat * Math.PI / 180);
        var y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
        x = Math.max(0, Math.min(n - 1, x)); y = Math.max(0, Math.min(n - 1, y));
        return x * n + y;
    }
    function tilesOf(pts) {
        var seen = {}, out = [];
        for (var i = 0; i < pts.length; i++) {
            var id = tileOf(pts[i].lat, pts[i].lon);
            if (!seen[id]) { seen[id] = 1; out.push(id); }
        }
        return out.sort(function (a, b) { return a - b; });
    }
    function packTiles(ids) {
        var w = new Writer(), prev = 0;
        w.u(ids.length);
        for (var i = 0; i < ids.length; i++) { w.u(ids[i] - prev); prev = ids[i]; }
        return w.bytes();
    }
    function unpackTiles(bytes, maxN) {
        var r = new Reader(bytes), n = r.u(), out = new Array(n), prev = 0;
        if (n > (maxN || 5000)) throw new Error('Zu viele Kacheln');
        for (var i = 0; i < n; i++) { prev += r.u(); out[i] = prev; }
        return out;
    }

    /* ---- Base64 (URL-sicher, ohne Auffuellung) ---- */
    function toB64(bytes) {
        var s = '', CH = 0x8000;
        for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function fromB64(str) {
        str = String(str).replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        var s = atob(str), out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    /* ---- gzip (Browser und Worker haben CompressionStream) ---- */
    function pipe(bytes, stream) {
        return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    function gzip(bytes) { return pipe(bytes, new CompressionStream('gzip')); }
    function gunzip(bytes, maxOut) {
        // Schutz gegen Zip-Bomben: Ergebnis begrenzen
        var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), parts = [], total = 0;
        function next() {
            return reader.read().then(function (r) {
                if (r.done) {
                    var out = new Uint8Array(total), o = 0;
                    parts.forEach(function (p) { out.set(p, o); o += p.length; });
                    return out;
                }
                total += r.value.length;
                if (total > (maxOut || 4000000)) { reader.cancel(); throw new Error('Track zu gross'); }
                parts.push(r.value);
                return next();
            });
        }
        return next();
    }

    /* Komplett: Punkte -> gzip -> Base64, und zurueck */
    function encode(pts) { return gzip(pack(pts)).then(toB64); }
    function decode(b64, maxN) { return gunzip(fromB64(b64)).then(function (b) { return unpack(b, maxN); }); }

    return {
        Q: Q, TILE_Z: TILE_Z, pack: pack, unpack: unpack,
        tileOf: tileOf, tilesOf: tilesOf, packTiles: packTiles, unpackTiles: unpackTiles,
        toB64: toB64, fromB64: fromB64, gzip: gzip, gunzip: gunzip, encode: encode, decode: decode
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LigaCodec;
