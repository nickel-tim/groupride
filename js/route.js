/* ============================================================
 * route.js -- die gemeinsame Streckenachse
 * ============================================================
 * Das Herzstueck. Ohne sie gibt es keine Reihenfolge:
 * paarweise Abstaende sagen NICHT, wer vorne ist.
 *
 * Die Achse ist eine Polylinie, die sich selbst organisiert:
 * Wer gerade am weitesten vorne liegt, verlaengert sie. Alle
 * anderen werden darauf projiziert und bekommen eine Position
 * als Bogenlaenge s (Meter seit Routenbeginn).
 *
 * Damit fallen ab:
 *   - Reihenfolge      = nach s sortieren
 *   - Luecke in Metern = Differenz der s
 *   - Ueberholvorgang  = Vorzeichenwechsel einer s-Differenz
 *   - Bergsprint       = s-Intervall mit Steigung, Zeit pro Fahrer darin
 *
 * Und Serpentinen zerstoeren die Logik nicht, weil die Suche auf
 * ein Fenster um die letzte bekannte Position begrenzt wird -- sonst
 * wuerde ein Fahrer auf der Kehre darunter faelschlich dort
 * einrasten.
 *
 * Genauigkeit: s wird per Haversine zwischen den Stuetzpunkten
 * aufsummiert (exakt), die lokale Projektionsgeometrie laeuft in
 * einer festen Tangentialebene (Verzerrung auf Ausfahrt-Skala
 * weit unter der GPS-Genauigkeit).
 * ============================================================ */

var Route = (function () {
    'use strict';

    /* Stuetzpunktabstand: nicht beliebig klein waehlbar. Bei 8 m Abstand
       und +-4 m GPS-Rauschen ist die Segmentrichtung auf +-27 Grad
       unbestimmt -- die Extrapolation ueber das Routenende zeigt dann
       irgendwohin. 20 m druecken das auf gut +-5 Grad. */
    var MIN_SPACING  = 20;    // m, Stuetzpunktabstand
    var MAX_OFFSET   = 45;    // m, weiter weg -> Route NICHT verlaengern
                              //    (schuetzt vor Parallelstrasse/Radweg)
    var SEARCH_WIN   = 400;   // m, Suchfenster um die letzte Position
    /* Ein Sprung ueber MAX_STEP pro Meldung waere >250 m/s -- das ist
       ein GPS-Ausreisser, kein Fahrer. Solche Punkte bleiben sonst
       dauerhaft als Knick in der Achse stehen. */
    var MAX_STEP     = 250;   // m, groesster akzeptierter Stuetzpunktsprung
    var MAX_TURN     = 100;   // Grad, staerkerer Knick = Ausreisser
    var TAIL_SMOOTH  = 0.30;  // Laplace-Faktor fuer den Routenschwanz
    /* GPS-Hoehe rauscht um mehrere Meter und ist damit die schlechteste
   Groesse, die das Geraet liefert. Ein enges Glaettungsfenster laesst
   davon so viel uebrig, dass die Steigungsrechnung unbrauchbar wird.
   100 m ist der Kompromiss: Rampen unter ~200 m Laenge sind damit
   nicht mehr aufloesbar -- ein Barometer haette das gekonnt, aber
   darauf gibt der Browser keinen Zugriff. */
    var ELE_SMOOTH   = 100;   // m, Fensterbreite Hoehenglaettung

    function R() {
        this.pts   = [];      // {lat, lon, ele, x, y, s}
        this.frame = null;
        this.eleSmoothed = false;
    }

    R.prototype.length = function () {
        return this.pts.length ? this.pts[this.pts.length - 1].s : 0;
    };

    R.prototype._push = function (lat, lon, ele) {
        if (!this.frame) this.frame = Geo.frame(lat, lon);
        var xy = this.frame.toXY(lat, lon);
        var s = 0;
        if (this.pts.length) {
            var last = this.pts[this.pts.length - 1];
            s = last.s + Geo.distance(last.lat, last.lon, lat, lon);
        }
        this.pts.push({ lat: lat, lon: lon, ele: (ele === undefined ? null : ele),
                        x: xy.x, y: xy.y, s: s });
        this.eleSmoothed = false;
    };

    /* Binaersuche: groesster Index mit pts[i].s <= s */
    R.prototype._idxAtS = function (s) {
        var lo = 0, hi = this.pts.length - 1;
        if (hi < 0) return -1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (this.pts[mid].s <= s) lo = mid; else hi = mid - 1;
        }
        return lo;
    };

    /* ---- Projektion ---------------------------------------------
       hintS: letzte bekannte Bogenlaenge dieses Fahrers, oder null.
       Rueckgabe: {s, offset, ahead} oder null bei leerer Route.
         offset = seitlicher Abstand zur Achse
         ahead  = true, wenn ueber das Routenende hinaus extrapoliert  */
    R.prototype.project = function (lat, lon, hintS) {
        var n = this.pts.length;
        if (n === 0) return null;
        if (n === 1) {
            return { s: 0, offset: Geo.distance(this.pts[0].lat, this.pts[0].lon, lat, lon),
                     ahead: false };
        }

        var xy = this.frame.toXY(lat, lon);
        var i0 = 0, i1 = n - 2;
        if (hintS !== null && hintS !== undefined) {
            var a = this._idxAtS(Math.max(0, hintS - SEARCH_WIN));
            var b = this._idxAtS(Math.min(this.length(), hintS + SEARCH_WIN));
            if (a >= 0) i0 = a;
            if (b >= 0) i1 = Math.min(n - 2, b);
            if (i1 < i0) i1 = i0;
        }

        var best = null;
        for (var i = i0; i <= i1; i++) {
            var p = this.pts[i], q = this.pts[i + 1];
            var pr = Geo.projectOnSegment(xy.x, xy.y, p.x, p.y, q.x, q.y);
            if (best === null || pr.dist < best.dist) {
                best = { dist: pr.dist, perp: pr.perp, t: pr.t, i: i, len: pr.len };
            }
        }
        if (best === null) return null;

        var segS = this.pts[best.i + 1].s - this.pts[best.i].s;
        var tc = best.t < 0 ? 0 : (best.t > 1 ? 1 : best.t);
        var s = this.pts[best.i].s + tc * segS;
        var offset = best.dist;
        var ahead = false;

        // Ueber das Ende hinaus: entlang der letzten Richtung extrapolieren
        if (best.i === n - 2 && best.t > 1) {
            s = this.pts[n - 1].s + (best.t - 1) * segS;
            offset = best.perp;
            ahead = true;
        }
        // Vor den Anfang: negatives s (Fahrer hinter dem Routenstart)
        if (best.i === 0 && best.t < 0) {
            s = best.t * segS;
            offset = best.perp;
        }

        return { s: s, offset: offset, ahead: ahead };
    };

    /* ---- Route pflegen -----------------------------------------
       mayExtend: nur der aktuelle "Routensetzer" darf verlaengern.

       Das ist keine Optimierung, sondern notwendig. Wenn abwechselnd
       verschiedene Fahrer Stuetzpunkte setzen, unterscheiden sich
       deren Positionen seitlich um mehrere Meter bei nur 20 m
       Laengsfortschritt. Die Polylinie zickzackt dann, die
       Segmentrichtungen werden falsch, und irgendwann faltet sich die
       Achse auf sich selbst zurueck -- ab da laufen die Bogenlaengen
       rueckwaerts und die Reihenfolge ist fuer ALLE Fahrer kaputt.  */
    R.prototype.consider = function (lat, lon, ele, hintS, mayExtend) {
        if (this.pts.length === 0) {
            this._push(lat, lon, ele);
            return { s: 0, offset: 0, ahead: false };
        }

        var pr = this.project(lat, lon, hintS);
        if (!pr) return null;
        var last = this.pts[this.pts.length - 1];
        var dLast = Geo.distance(last.lat, last.lon, lat, lon);

        var atFront = pr.ahead || pr.s >= this.length() - MIN_SPACING;

        /* Der Seitwaerts-Schutz gilt nur INNERHALB der Route. Jenseits
           des Endes ist "offset" der Abstand zur verlaengerten Geraden
           des letzten Segments -- in einer Kurve waechst der zwangslaeufig.
           Wuerde er hier greifen, entstuende eine Todesspirale: Der
           Fuehrende kaeme nicht mehr in die Route, liefe dadurch weiter
           voraus, wodurch der Abstand weiter waechst. Genau dort bricht
           die Achse dann fuer alle zusammen. */
        var onAxis = pr.ahead ? true : (pr.offset <= MAX_OFFSET);

        if (mayExtend && atFront && onAxis &&
            dLast >= MIN_SPACING && dLast <= MAX_STEP &&
            this._turnOk(lat, lon)) {
            this._push(lat, lon, ele);
            this._smoothTail();
            return { s: this.length(), offset: 0, ahead: false };
        }
        return pr;
    };

    /* Faltungsschutz: ein Stuetzpunkt, der die Richtung um mehr als
       MAX_TURN kippt, ist ein Ausreisser. Eine echte Kehre verteilt
       ihre 180 Grad auf mehrere Segmente (bei 20 m Abstand rund 40 Grad
       pro Segment) und kommt hier nie in Konflikt. */
    R.prototype._turnOk = function (lat, lon) {
        var n = this.pts.length;
        if (n < 2) return true;
        var a = this.pts[n - 2], b = this.pts[n - 1];
        var prev = Geo.bearing(a.lat, a.lon, b.lat, b.lon);
        var next = Geo.bearing(b.lat, b.lon, lat, lon);
        return Math.abs(Geo.angleDelta(prev, next)) <= MAX_TURN;
    };

    /* Laplace-Glaettung des vorletzten Punkts: nimmt den Restzickzack
       heraus, ohne den Verlauf zu verschieben. Danach die Bogenlaengen
       des Schwanzes neu rechnen. */
    R.prototype._smoothTail = function () {
        var n = this.pts.length;
        if (n < 3) return;
        var a = this.pts[n - 3], b = this.pts[n - 2], c = this.pts[n - 1];
        b.lat += TAIL_SMOOTH * (a.lat + c.lat - 2 * b.lat);
        b.lon += TAIL_SMOOTH * (a.lon + c.lon - 2 * b.lon);
        var xy = this.frame.toXY(b.lat, b.lon);
        b.x = xy.x; b.y = xy.y;
        b.s = a.s + Geo.distance(a.lat, a.lon, b.lat, b.lon);
        c.s = b.s + Geo.distance(b.lat, b.lon, c.lat, c.lon);
        this.eleSmoothed = false;
    };

    /* ---- Hoehenprofil ------------------------------------------
       Gleitender Mittelwert ueber ELE_SMOOTH Meter Streckenlaenge.
       Rohe GPS-Hoehe ist fuer Steigungen unbrauchbar -- ohne diese
       Glaettung "findet" man Rampen, die es nicht gibt.          */
    R.prototype.smoothElevation = function () {
        var n = this.pts.length;
        if (n < 3 || this.eleSmoothed) return;
        var half = ELE_SMOOTH / 2;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var s0 = this.pts[i].s - half, s1 = this.pts[i].s + half;
            var sum = 0, cnt = 0;
            for (var j = i; j >= 0 && this.pts[j].s >= s0; j--) {
                if (this.pts[j].ele !== null) { sum += this.pts[j].ele; cnt++; }
            }
            for (var k = i + 1; k < n && this.pts[k].s <= s1; k++) {
                if (this.pts[k].ele !== null) { sum += this.pts[k].ele; cnt++; }
            }
            out[i] = cnt ? sum / cnt : null;
        }
        for (var m = 0; m < n; m++) this.pts[m].eleS = out[m];
        this.eleSmoothed = true;
    };

    /* Geglaettete Hoehe an beliebiger Bogenlaenge, linear interpoliert. */
    R.prototype.eleAt = function (s) {
        this.smoothElevation();
        var n = this.pts.length;
        if (n === 0) return null;
        var i = this._idxAtS(s);
        if (i < 0) return null;
        if (i >= n - 1) return this.pts[n - 1].eleS;
        var p = this.pts[i], q = this.pts[i + 1];
        if (p.eleS === null || q.eleS === null) return p.eleS !== null ? p.eleS : q.eleS;
        var span = q.s - p.s;
        if (span < 1e-6) return p.eleS;
        var f = (s - p.s) / span;
        return p.eleS + f * (q.eleS - p.eleS);
    };

    /* Kurs (Grad) der Achse an der Stelle s -- fuer "wohin geht es weiter". */
    R.prototype.courseAt = function (s) {
        var n = this.pts.length;
        if (n < 2) return null;
        var i = this._idxAtS(s);
        if (i < 0) i = 0;
        if (i > n - 2) i = n - 2;
        var p = this.pts[i], q = this.pts[i + 1];
        return Geo.bearing(p.lat, p.lon, q.lat, q.lon);
    };

    R.prototype.toJSON = function () {
        return this.pts.map(function (p) {
            return { lat: p.lat, lon: p.lon, ele: p.ele, s: p.s };
        });
    };

    /* Fertige Strecke (geplante Route, importierte GPX-Datei) als Achse.
       minSpacing dünnt zu dichte Punkte aus (1-Hz-Aufzeichnungen haben
       alle 3 m einen) -- die Achse braucht nicht mehr als ~10 m. */
    R.fromPoints = function (pts, minSpacing) {
        var r = new R(), gap = minSpacing || 10, last = null;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (last && i < pts.length - 1 && Geo.distance(last.lat, last.lon, p.lat, p.lon) < gap) continue;
            r._push(p.lat, p.lon, (p.ele === undefined || isNaN(p.ele)) ? null : p.ele);
            last = p;
        }
        return r;
    };

    R.MIN_SPACING = MIN_SPACING;
    R.MAX_OFFSET  = MAX_OFFSET;
    R.SEARCH_WIN  = SEARCH_WIN;
    return R;
})();

if (typeof module !== 'undefined') module.exports = Route;
