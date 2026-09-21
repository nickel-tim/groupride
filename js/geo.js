/* ============================================================
 * geo.js -- Geodaesie-Grundlagen
 * ============================================================
 * Alles rechnet auf einer lokalen Tangentialebene in Metern.
 * Auf Gruppenausfahrt-Skala (wenige km) ist der Fehler daraus
 * weit unter der GPS-Genauigkeit, und es ist massiv schneller
 * als jede Ellipsoid-Rechnung bei 1 Hz x 8 Fahrern.
 * ============================================================ */

var Geo = (function () {
    'use strict';

    var D2R = Math.PI / 180;

    /* Meter pro Grad -- breitengradabhaengig (WGS84-Reihenentwicklung).
       Deutlich genauer als die uebliche 111320-Konstante. */
    function metersPerDegLat(lat) {
        var p = lat * D2R;
        return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
    }
    function metersPerDegLon(lat) {
        var p = lat * D2R;
        return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
    }

    /* Lokaler Bezugsrahmen um refLat/refLon: x = Ost, y = Nord, in Metern. */
    function frame(refLat, refLon) {
        var mLat = metersPerDegLat(refLat);
        var mLon = metersPerDegLon(refLat);
        return {
            refLat: refLat, refLon: refLon,
            toXY: function (lat, lon) {
                return { x: (lon - refLon) * mLon, y: (lat - refLat) * mLat };
            },
            toLatLon: function (x, y) {
                return { lat: refLat + y / mLat, lon: refLon + x / mLon };
            }
        };
    }

    /* Haversine, Meter. Fuer Distanzen, die exakt sein sollen. */
    function distance(lat1, lon1, lat2, lon2) {
        var R = 6371008.8;
        var dLat = (lat2 - lat1) * D2R;
        var dLon = (lon2 - lon1) * D2R;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /* Anfangspeilung (forward azimuth) in Grad, 0 = Nord, im Uhrzeigersinn. */
    function bearing(lat1, lon1, lat2, lon2) {
        var p1 = lat1 * D2R, p2 = lat2 * D2R;
        var dl = (lon2 - lon1) * D2R;
        var y = Math.sin(dl) * Math.cos(p2);
        var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.atan2(y, x) / D2R + 360) % 360;
    }

    /* Kuerzeste Winkeldifferenz b-a, Ergebnis in (-180, 180]. */
    function angleDelta(a, b) {
        var d = (b - a + 540) % 360 - 180;
        return d === -180 ? 180 : d;
    }

    /* Projektion eines Punkts auf ein Segment, alles in Metern.
         t     Laufparameter; 0..1 innerhalb, ausserhalb extrapoliert
         dist  echter Abstand zum Segment (auf die Endpunkte geklemmt)
         perp  senkrechter Abstand zur VERLAENGERTEN Geraden
               -- das ist der richtige Wert, wenn ueber das Ende
                  hinaus extrapoliert wird
         len   Segmentlaenge                                        */
    function projectOnSegment(px, py, ax, ay, bx, by) {
        var vx = bx - ax, vy = by - ay;
        var len2 = vx * vx + vy * vy;
        if (len2 < 1e-9) {
            var ddx = px - ax, ddy = py - ay;
            var d0 = Math.sqrt(ddx * ddx + ddy * ddy);
            return { t: 0, dist: d0, perp: d0, len: 0 };
        }
        var len = Math.sqrt(len2);
        var t = ((px - ax) * vx + (py - ay) * vy) / len2;
        var tc = t < 0 ? 0 : (t > 1 ? 1 : t);
        var cx = ax + tc * vx, cy = ay + tc * vy;
        var dx = px - cx, dy = py - cy;
        // Kreuzprodukt / Laenge = Abstand zur unendlichen Geraden
        var perp = Math.abs((px - ax) * vy - (py - ay) * vx) / len;
        return { t: t, dist: Math.sqrt(dx * dx + dy * dy), perp: perp, len: len };
    }

    return {
        D2R: D2R,
        metersPerDegLat: metersPerDegLat,
        metersPerDegLon: metersPerDegLon,
        frame: frame,
        distance: distance,
        bearing: bearing,
        angleDelta: angleDelta,
        projectOnSegment: projectOnSegment
    };
})();

if (typeof module !== 'undefined') module.exports = Geo;
