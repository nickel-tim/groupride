/* ============================================================
 * smooth.js -- ruckelfreie Anzeige trotz 1-Hz-Positionen
 * ============================================================
 * Positionen kommen nur etwa einmal pro Sekunde (die der anderen Fahrer
 * alle zwei), gezeichnet wird aber mit 30 Bildern pro Sekunde. Ohne
 * Glaettung springen Punkte und Zeiger im Sekundentakt -- bei 10 m/s rund
 * 9 m auf einmal. Zwei Dinge dagegen:
 *
 *   1. Weiterschieben ("Koppelnavigation"): aus den letzten beiden
 *      Meldungen wird ein Tempo geschaetzt; der Punkt gleitet damit weiter,
 *      bis die naechste Meldung eintrifft -- hoechstens EXTRAP_MS lang,
 *      denn ohne Meldung weiss man nicht, ob der Fahrer noch rollt.
 *   2. Nachfuehren: trifft die Meldung ein, springt der Punkt NICHT dorthin,
 *      sondern naehert sich exponentiell an (Zeitkonstante TAU_POS). Ein
 *      kleiner Schaetzfehler wird so nie als Ruck sichtbar.
 *
 * Dasselbe fuer Winkel (Fahrtrichtung), dabei immer auf dem kuerzesten
 * Weg -- von 359 Grad auf 1 Grad darf der Zeiger nicht rueckwaerts
 * durch die ganze Rose laufen.
 *
 * Das ist reine Darstellung. Auswertung (Rang, Luecken, Ueberholen)
 * rechnet weiter mit den gemeldeten Positionen, nie mit den geglaetteten.
 * Ein Tracker gehoert einer Ansicht (Karte, Kompass); jede schaetzt fuer
 * sich, deshalb stoeren sie sich nicht.
 * ============================================================ */

var Smooth = (function () {
    'use strict';

    var TAU_POS   = 0.22;     // s
    var TAU_HDG   = 0.35;     // s
    var EXTRAP_MS = 2600;
    var SNAP_M    = 60;       // groessere Spruenge (erste Meldung, Neustart) nicht verschleifen
    /* Ein Sprung ist keine Fahrt: Springt die Position zwischen zwei Bildern (Spulen im
       Replay, Neustart, GPS-Sprung), waere das rechnerisch ein absurdes Tempo -- und der
       Punkt wuerde damit noch bis zu 2,6 s weiterschiessen. Darueber gilt: kein Tempo, hinsetzen.
       Die Grenze liegt weit ueber dem, was der Zeitraffer der Simulation (x20 = ~190 m/s)
       erzeugt. */
    var MAX_V     = 400;      // m/s

    var api = { enabled: true };   // "enabled = false": rohe Werte, zum Vergleichen und Debuggen

    api.angDelta = function (from, to) { return ((to - from + 540) % 360) - 180; };

    /* frame: Bezugssystem der Meter (aendert es sich, faengt der Tracker neu an) */
    api.create = function () { return { frame: null, r: {}, hd: null, hl: null }; };

    api.reset = function (trk, frame) {
        if (trk.frame !== frame) { trk.frame = frame; trk.r = {}; trk.hd = null; trk.hl = null; }
        return trk;
    };

    /* Glatte Anzeigeposition eines Fahrers (Meter im Bezugssystem).
       r: Fahrer (id, heading), xy: letzte gemeldete Position, stale: keine
       Meldung mehr -> nicht weiterschieben. Rueckgabe {x, y, hd}. */
    api.follow = function (trk, r, xy, now, stale) {
        if (!api.enabled || trk.off) return { x: xy.x, y: xy.y, hd: r.heading === undefined ? null : r.heading };
        var st = trk.r[r.id];
        if (!st) {
            st = trk.r[r.id] = { fx: xy.x, fy: xy.y, tf: now, vx: 0, vy: 0, x: xy.x, y: xy.y, tl: now,
                                 hd: (r.heading === null || r.heading === undefined) ? null : r.heading };
        }
        // neue Meldung erkannt: Tempo aus dem Weg seit der letzten schaetzen
        if (Math.abs(xy.x - st.fx) > 1e-4 || Math.abs(xy.y - st.fy) > 1e-4) {
            var dtf = (now - st.tf) / 1000;
            var jumped = dtf > 0 && Math.hypot(xy.x - st.fx, xy.y - st.fy) / dtf > MAX_V;
            if (jumped) {
                st.vx = st.vy = 0; st.x = xy.x; st.y = xy.y;         // hinsetzen, nicht ausbremsen
            } else if (dtf > 0.05 && dtf < 8) {
                st.vx = 0.3 * st.vx + 0.7 * (xy.x - st.fx) / dtf;
                st.vy = 0.3 * st.vy + 0.7 * (xy.y - st.fy) / dtf;
            } else { st.vx = st.vy = 0; }
            st.fx = xy.x; st.fy = xy.y; st.tf = now;
        }
        var age = stale ? 0 : Math.min(now - st.tf, EXTRAP_MS) / 1000;
        var tx = st.fx + st.vx * age, ty = st.fy + st.vy * age;

        var dt = Math.min(0.25, Math.max(0, (now - st.tl) / 1000));
        st.tl = now;
        if (Math.hypot(tx - st.x, ty - st.y) > SNAP_M) { st.x = tx; st.y = ty; }
        else {
            var a = 1 - Math.exp(-dt / TAU_POS);
            st.x += (tx - st.x) * a; st.y += (ty - st.y) * a;
        }

        if (r.heading !== null && r.heading !== undefined) {
            if (st.hd === null) st.hd = r.heading;
            else st.hd += api.angDelta(st.hd, r.heading) * (1 - Math.exp(-dt / TAU_HDG));
        }
        return st;
    };

    /* Glatte eigene Richtung (Grad) fuer Kartendrehung bzw. Kompass.
       target = null -> keine Richtung bekannt (Tracker vergisst sie). */
    api.heading = function (trk, target, now) {
        if (target === null || target === undefined) { trk.hd = null; trk.hl = null; return null; }
        if (!api.enabled || trk.off || trk.hd === null) { trk.hd = target; trk.hl = now; return target; }
        var dt = Math.min(0.25, Math.max(0, (now - (trk.hl || now)) / 1000));
        trk.hd += api.angDelta(trk.hd, target) * (1 - Math.exp(-dt / TAU_HDG));
        trk.hl = now;
        return trk.hd;
    };

    // Fahrer, die nicht mehr da sind, aus dem Tracker nehmen
    api.prune = function (trk, seen) { for (var id in trk.r) if (!seen[id]) delete trk.r[id]; };

    return api;
})();
