/* ============================================================
 * qr.js -- QR-Code als SVG fuer den Einladungslink
 * ============================================================
 * Fehlerkorrektur M (rund 15 %): robust genug fuer ein Display in
 * der Sonne, und der Code bleibt bei einem Link mit Gruppenschluessel
 * (rund 80 bis 140 Zeichen) noch grob genug, dass ihn auch eine
 * Handykamera auf Armlaenge sicher liest.
 *
 * Immer schwarz auf weiss mit vier Modulen Ruhezone -- unabhaengig
 * vom Theme. Ein invertierter oder farbiger Code wird von vielen
 * Scannern nicht erkannt.
 * ============================================================ */

var QR = (function () {
    'use strict';

    function svg(text) {
        var q = qrcode(0, 'M');           // 0 = kleinste passende Version
        q.addData(text);
        q.make();

        var n = q.getModuleCount(), quiet = 4, size = n + 2 * quiet;
        var d = [];
        for (var r = 0; r < n; r++) {
            var c = 0;
            while (c < n) {
                if (!q.isDark(r, c)) { c++; continue; }
                var start = c;
                while (c < n && q.isDark(r, c)) c++;       // waagerechte Laufweite
                d.push('M' + (start + quiet) + ' ' + (r + quiet) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z');
            }
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
               '" shape-rendering="crispEdges" role="img" aria-label="QR-Code zum Beitreten">' +
               '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
               '<path fill="#000" d="' + d.join('') + '"/></svg>';
    }

    return { svg: svg };
})();
