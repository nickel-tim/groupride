/* ============================================================
 * liga-cats.js -- catalogue of the league categories
 * ============================================================
 * One source for the app AND the server (api/): name, way of computing and display.
 *
 * agg  How the ranking is computed from the rides of the period:
 *      sum      sum of all ride values
 *      max/min  best single value (min = smaller is better, times)
 *      days     number of distinct calendar days with a ride
 *      streak   longest run of consecutive days with >= 5 km
 *      dayMax   daily sum, of which the maximum
 *      explore  new tiles in the period (comes from account_tiles)
 *      kom      points from league segments of the kind "climb"
 *      seg      time on a league segment (key "seg:<id>")
 * src  From which stored values the ranking is read (default: the key itself)
 * unit Display: km | dur | kmh | m | count | time | points
 * team true = summable, suitable for team goals
 * grp  true = only exists if the ride was recorded in a group
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

    // Values reported by the app per ride (the table ride_values). The rest is derived.
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
    function smaller(c) { return c.agg === 'min' || c.agg === 'seg'; }         // smaller is better

    /* ---- Display ---- */
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function fmtDur(ms) {
        var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
        return h ? h + ':' + two(m) + ' h' : m + ' min';
    }
    function fmtTime(ms) {
        var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
        return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
    }
    function num(v, d) { return v.toFixed(d).replace('.', typeof I18n !== 'undefined' ? I18n.sep() : ','); }   // I18n exists only in the app
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
            case 'points': return Math.round(v) + ' ' + (typeof T !== 'undefined' ? T('P.') : 'P.');       // T exists only in the app
            default:       return String(Math.round(v));
        }
    }
    /* Difference for the speedometer ("+12.4 km") */
    function formatDelta(key, d) {
        var s = d < 0 ? '−' : '+';
        return s + format(key, Math.abs(d)).replace(' P.', '');
    }

    return { LIST: LIST, STORED: STORED, DEFAULT_ON: DEFAULT_ON, get: get, valid: valid, srcOf: srcOf,
             smaller: smaller, format: format, formatDelta: formatDelta, fmtDur: fmtDur, fmtTime: fmtTime };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LigaCats;
