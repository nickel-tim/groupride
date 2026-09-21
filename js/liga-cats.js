/* ============================================================
 * liga-cats.js -- Katalog der Liga-Kategorien
 * ============================================================
 * Eine Quelle fuer App UND Server (api/): Name, Rechenart und Anzeige.
 *
 * agg  Wie die Rangliste aus den Fahrten des Zeitraums zusammenrechnet:
 *      sum      Summe aller Fahrt-Werte
 *      max/min  bester Einzelwert (min = kleiner ist besser, Zeiten)
 *      days     Anzahl verschiedener Kalendertage mit einer Fahrt
 *      streak   laengste Folge aufeinanderfolgender Tage mit >= 5 km
 *      dayMax   Tagessumme, davon das Maximum
 *      explore  neue Kacheln im Zeitraum (kommt aus account_tiles)
 *      kom      Punkte aus Liga-Segmenten der Art "Anstieg"
 *      seg      Zeit auf einem Liga-Segment (Schluessel "seg:<id>")
 * src  Aus welchen gespeicherten Werten die Rangliste gelesen wird (Standard: der Schluessel selbst)
 * unit Anzeige: km | dur | kmh | m | count | time | points
 * team true = summierbar, taugt fuer Team-Ziele
 * grp  true = gibt es nur, wenn die Fahrt in einer Gruppe aufgezeichnet wurde
 * ============================================================ */

var LigaCats = (function () {
    'use strict';

    var LIST = [
        { key: 'dist',      label: 'Kilometer',                  grp: 'Distanz',  agg: 'sum',    unit: 'km',    team: true },
        { key: 'time',      label: 'Fahrzeit',                   grp: 'Distanz',  agg: 'sum',    unit: 'dur',   team: true },
        { key: 'gain',      label: 'Höhenmeter',                 grp: 'Distanz',  agg: 'sum',    unit: 'm',     team: true },
        { key: 'rides',     label: 'Anzahl Fahrten',             grp: 'Distanz',  agg: 'sum',    unit: 'count', team: true },
        { key: 'days',      label: 'Fahrtage',                   grp: 'Distanz',  agg: 'days',   unit: 'count', src: 'rides' },
        { key: 'streak',    label: 'Serie (Tage in Folge)',      grp: 'Distanz',  agg: 'streak', unit: 'count', src: 'dist' },
        { key: 'long_dist', label: 'Längste Fahrt',              grp: 'Distanz',  agg: 'max',    unit: 'km',    src: 'dist' },
        { key: 'long_time', label: 'Längste Fahrzeit',           grp: 'Distanz',  agg: 'max',    unit: 'dur',   src: 'time' },
        { key: 'gain_day',  label: 'Höhenmeter an einem Tag',    grp: 'Distanz',  agg: 'dayMax', unit: 'm',     src: 'gain' },

        { key: 'top',       label: 'Topspeed',                   grp: 'Tempo',    agg: 'max',    unit: 'kmh' },
        { key: 'avg20',     label: 'Schnellster Schnitt (ab 20 km)', grp: 'Tempo', agg: 'max',   unit: 'kmh' },
        { key: 't10k',      label: 'Bestzeit 10 km',             grp: 'Tempo',    agg: 'min',    unit: 'time' },
        { key: 't20k',      label: 'Bestzeit 20 km',             grp: 'Tempo',    agg: 'min',    unit: 'time' },
        { key: 't40k',      label: 'Bestzeit 40 km',             grp: 'Tempo',    agg: 'min',    unit: 'time' },
        { key: 'avg1h',     label: 'Beste Stunde',               grp: 'Tempo',    agg: 'max',    unit: 'kmh' },

        { key: 'vam',       label: 'Steigrate',                  grp: 'Berg',     agg: 'max',    unit: 'mh' },
        { key: 'kom',       label: 'Kletterkönig',               grp: 'Berg',     agg: 'kom',    unit: 'points' },

        { key: 'front',     label: 'Wasserträger (Führung)',     grp: 'Gruppe',   agg: 'sum',    unit: 'dur',   team: true, gp: true },
        { key: 'attacks',   label: 'Angriffe',                   grp: 'Gruppe',   agg: 'sum',    unit: 'count', team: true, gp: true },
        { key: 'escape',    label: 'Ausreißer',                  grp: 'Gruppe',   agg: 'max',    unit: 'dur',   gp: true },
        { key: 'together',  label: 'Gemeinsam gefahren',         grp: 'Gruppe',   agg: 'sum',    unit: 'km',    team: true, gp: true },
        { key: 'coffee',    label: 'Kaffeepausen',               grp: 'Gruppe',   agg: 'sum',    unit: 'count', team: true, gp: true },

        { key: 'explore',   label: 'Entdecken (neue Kacheln)',   grp: 'Entdecken', agg: 'explore', unit: 'count', team: true }
    ];

    // Von der App je Fahrt gemeldete Werte (die Tabelle ride_values). Der Rest wird abgeleitet.
    var STORED = ['dist', 'time', 'gain', 'rides', 'top', 'avg20', 't10k', 't20k', 't40k', 'avg1h', 'vam',
                  'front', 'attacks', 'escape', 'together', 'coffee'];

    var DEFAULT_ON = ['dist', 'time', 'gain', 'long_dist', 'days', 'top', 'front'];
    var MAP = {};
    LIST.forEach(function (c) { MAP[c.key] = c; });

    function get(key) {
        if (MAP[key]) return MAP[key];
        if (/^seg:[A-Za-z0-9_-]{1,40}$/.test(key)) return { key: key, label: 'Segment', grp: 'Berg', agg: 'seg', unit: 'time', src: null };
        return null;
    }
    function valid(key) { return !!get(key); }
    function srcOf(c) { return c.src || c.key; }
    function smaller(c) { return c.agg === 'min' || c.agg === 'seg'; }         // kleiner ist besser

    /* ---- Anzeige ---- */
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function fmtDur(ms) {
        var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
        return h ? h + ':' + two(m) + ' h' : m + ' min';
    }
    function fmtTime(ms) {
        var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
        return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
    }
    function num(v, d) { return v.toFixed(d).replace('.', ','); }
    function format(key, v) {
        var c = get(key);
        if (v === null || v === undefined || isNaN(v)) return '–';
        switch (c ? c.unit : 'count') {
            case 'km':     return num(v / 1000, v >= 100000 ? 0 : 1) + ' km';
            case 'dur':    return fmtDur(v);
            case 'time':   return fmtTime(v);
            case 'kmh':    return num(v * 3.6, 1) + ' km/h';
            case 'm':      return Math.round(v) + ' m';
            case 'mh':     return Math.round(v) + ' m/h';
            case 'points': return Math.round(v) + ' P.';
            default:       return String(Math.round(v));
        }
    }
    /* Unterschied fuer den Tacho ("+12,4 km") */
    function formatDelta(key, d) {
        var s = d < 0 ? '−' : '+';
        return s + format(key, Math.abs(d)).replace(' P.', '');
    }

    return { LIST: LIST, STORED: STORED, DEFAULT_ON: DEFAULT_ON, get: get, valid: valid, srcOf: srcOf,
             smaller: smaller, format: format, formatDelta: formatDelta, fmtDur: fmtDur, fmtTime: fmtTime };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LigaCats;
