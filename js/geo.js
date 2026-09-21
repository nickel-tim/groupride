/* ============================================================
 * geo.js -- geodesy basics
 * ============================================================
 * Everything works on a local tangent plane in metres. At group-ride
 * scale (a few km) the error this introduces is far below GPS accuracy,
 * and it is massively faster than any ellipsoid computation at
 * 1 Hz x 8 riders.
 * ============================================================ */

var Geo = (function () {
    'use strict';

    var D2R = Math.PI / 180;

    /* Metres per degree -- depends on latitude (WGS84 series expansion).
       Considerably more accurate than the usual 111320 constant. */
    function metersPerDegLat(lat) {
        var p = lat * D2R;
        return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
    }
    function metersPerDegLon(lat) {
        var p = lat * D2R;
        return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
    }

    /* Local reference frame around refLat/refLon: x = east, y = north, in metres. */
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

    /* Haversine, metres. For distances that need to be exact. */
    function distance(lat1, lon1, lat2, lon2) {
        var R = 6371008.8;
        var dLat = (lat2 - lat1) * D2R;
        var dLon = (lon2 - lon1) * D2R;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /* Initial bearing (forward azimuth) in degrees, 0 = north, clockwise. */
    function bearing(lat1, lon1, lat2, lon2) {
        var p1 = lat1 * D2R, p2 = lat2 * D2R;
        var dl = (lon2 - lon1) * D2R;
        var y = Math.sin(dl) * Math.cos(p2);
        var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.atan2(y, x) / D2R + 360) % 360;
    }

    /* Shortest angle difference b-a, result in (-180, 180]. */
    function angleDelta(a, b) {
        var d = (b - a + 540) % 360 - 180;
        return d === -180 ? 180 : d;
    }

    /* Projection of a point onto a segment, everything in metres.
         t     running parameter; 0..1 inside, extrapolated outside
         dist  true distance to the segment (clamped to the end points)
         perp  perpendicular distance to the EXTENDED line
               -- this is the right value when extrapolating beyond
                  the end
         len   segment length                                       */
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
        // cross product / length = distance to the infinite line
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
