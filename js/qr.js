/* ============================================================
 * qr.js -- QR code as SVG for the invitation link
 * ============================================================
 * Error correction M (about 15 %): robust enough for a display in
 * the sun, and with a link containing a group key (about 80 to 140
 * characters) the code stays coarse enough that even a phone camera
 * at arm's length reads it reliably.
 *
 * Always black on white with a four-module quiet zone -- regardless
 * of the theme. An inverted or coloured code is not recognised by
 * many scanners.
 * ============================================================ */

var QR = (function () {
    'use strict';

    function svg(text) {
        var q = qrcode(0, 'M');           // 0 = smallest fitting version
        q.addData(text);
        q.make();

        var n = q.getModuleCount(), quiet = 4, size = n + 2 * quiet;
        var d = [];
        for (var r = 0; r < n; r++) {
            var c = 0;
            while (c < n) {
                if (!q.isDark(r, c)) { c++; continue; }
                var start = c;
                while (c < n && q.isDark(r, c)) c++;       // horizontal run length
                d.push('M' + (start + quiet) + ' ' + (r + quiet) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z');
            }
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
               '" shape-rendering="crispEdges" role="img" aria-label="' + T('QR-Code zum Beitreten') + '">' +
               '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
               '<path fill="#000" d="' + d.join('') + '"/></svg>';
    }

    return { svg: svg };
})();
