/* ============================================================
 * sim.js -- simulated group ride with a known truth
 * ============================================================
 * Checks the core logic against ground truth:
 *   - order despite GPS noise
 *   - overtaking without ping-pong
 *   - hairpin does not break the projection
 *   - climb detection: number, elevation gain, ranking
 *   - front work adds up plausibly
 *   - drop is detected
 * ============================================================ */

global.Geo       = require('../js/geo.js');
global.Route     = require('../js/route.js');
global.Analytics = require('../js/analytics.js');

/* ---------- reproducible randomness ---------- */
var seed = 20260920;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss(s) { return s * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }

/* ---------- Build the centre line ----------------
   Road with bends, a hairpin (180 degrees) and two climbs. */
function eleAt(s) {
    if (s < 1000) return 100;
    if (s < 1600) return 100 + (s - 1000) * 0.10;        // Climb 1: +60 m, 10 %
    if (s < 2200) return 160;
    if (s < 3000) return 160 + (s - 2200) * 0.06;        // Climb 2: +48 m, 6 %
    return 208 - (s - 3000) * 0.04;                      // Descent
}

/* Hairpin as a real bend: 180 degrees over an arc with 30 m
   radius (arc length pi*R = 94 m). That puts the outbound and return legs
   about 60 m apart -- that is what an Alpine hairpin really looks like.
   A reversal of direction WITHOUT lateral offset would be congruent
   road and thereby an unsolvable problem, not a test case. */
var HP_START = 1200, HP_LEN = 94;
function headingAt(s) {
    var h = 40 + 25 * Math.sin(s / 700);                  // gentle bends
    if (s <= HP_START) return h;
    if (s >= HP_START + HP_LEN) return h + 180;
    return h + 180 * (s - HP_START) / HP_LEN;
}

var LAT0 = 47.8021, LON0 = 11.0912;               // somewhere in the Alpine foothills
var center = [];
(function buildCenter() {
    var lat = LAT0, lon = LON0, s = 0, step = 2;
    while (s <= 4200) {
        center.push({ s: s, lat: lat, lon: lon, ele: eleAt(s) });
        var h = headingAt(s) * Geo.D2R;
        var dN = step * Math.cos(h), dE = step * Math.sin(h);
        lat += dN / Geo.metersPerDegLat(lat);
        lon += dE / Geo.metersPerDegLon(lat);
        s += step;
    }
})();

function atS(s) {
    if (s <= 0) return center[0];
    if (s >= center[center.length - 1].s) return center[center.length - 1];
    var lo = 0, hi = center.length - 1;
    while (lo < hi) { var m = (lo + hi + 1) >> 1; if (center[m].s <= s) lo = m; else hi = m - 1; }
    var p = center[lo], q = center[Math.min(center.length - 1, lo + 1)];
    var f = (q.s - p.s) > 0 ? (s - p.s) / (q.s - p.s) : 0;
    return { s: s, lat: p.lat + f * (q.lat - p.lat), lon: p.lon + f * (q.lon - p.lon),
             ele: p.ele + f * (q.ele - p.ele) };
}

/* ---------- Riders ----------
   Speed depends on the gradient; everyone has their own strengths. */
function grade(s) { return (eleAt(s + 25) - eleAt(s - 25)) / 50; }

var riders = [
    { id: 'a', name: 'Anna',  flat: 9.2, climbSkill: 1.35, s: 40 },   // mountain goat
    { id: 'b', name: 'Ben',   flat: 10.4, climbSkill: 0.78, s: 20 },  // flatland engine
    { id: 'c', name: 'Carla', flat: 9.4, climbSkill: 1.02, s: 30 },   // constant
    { id: 'd', name: 'Dirk',  flat: 8.2, climbSkill: 0.70, s: 10 }    // gets dropped
];

function speedOf(r, s, t) {
    var g = grade(s);
    var v = r.flat;
    if (g > 0.005) v = r.flat * r.climbSkill * Math.max(0.3, 1 - g * 7);
    else if (g < -0.005) v = r.flat * (1 - g * 4);
    if (r.id === 'b' && s > 900 && s < 1100) v *= 1.5;      // Ben attacks before the climb
    if (r.id === 'd' && t > 260) v *= 0.55;                  // Dirk cracks
    return Math.max(1.5, v);
}

/* ---------- Simulation ---------- */
var route = new Route();
var an = new Analytics(route);
var T0 = Date.now() - 600000;
var dt = 1;                     // 1 Hz, like real GPS
var trueOrderChecks = 0, orderOk = 0;
var trueCross = 0;
var prevTrueSign = {};

for (var t = 0; t <= 520; t += dt) {
    // advance the true positions
    riders.forEach(function (r) { r.s += speedOf(r, r.s, t) * dt; });

    // feed in noisy reports
    riders.forEach(function (r) {
        var c = atS(r.s);
        var h = headingAt(r.s) * Geo.D2R;
        // Noise: along and across the direction of travel, ~4 m each
        var along = gauss(4), cross = gauss(4);
        var dN = along * Math.cos(h) - cross * Math.sin(h);
        var dE = along * Math.sin(h) + cross * Math.cos(h);
        var lat = c.lat + dN / Geo.metersPerDegLat(c.lat);
        var lon = c.lon + dE / Geo.metersPerDegLon(c.lat);
        an.ingest(r.id, {
            lat: lat, lon: lon,
            ele: c.ele + gauss(6),              // GPS elevation is coarse
            speed: speedOf(r, r.s, t) + gauss(0.2),
            acc: 6, t: T0 + t * 1000, name: r.name
        });
    });

    an.tick(T0 + t * 1000);

    // --- Check order (only when the truth is unambiguous) ---
    var truth = riders.slice().sort(function (x, y) { return y.s - x.s; });
    var clear = true;
    for (var i = 1; i < truth.length; i++) {
        if (truth[i - 1].s - truth[i].s < Analytics.PASS_DEADBAND) clear = false;
    }
    if (clear && t > 30) {
        trueOrderChecks++;
        var det = an.order().map(function (r) { return r.id; }).join('');
        if (det === truth.map(function (r) { return r.id; }).join('')) orderOk++;
    }

    /* --- count true crossings ---
       Only from WARMUP on, because as long as the axis is shorter than 150 m,
       the detector deliberately stays silent. Counting earlier would charge it
       start-up artefacts as "missed". */
    for (var p = 0; t >= 45 && p < riders.length; p++) {
        for (var q = p + 1; q < riders.length; q++) {
            var A = riders[p], B = riders[q];
            var key = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id;
            var first = A.id < B.id ? A : B, second = A.id < B.id ? B : A;
            var d = first.s - second.s;
            var sign = d > Analytics.PASS_DEADBAND ? 1 : (d < -Analytics.PASS_DEADBAND ? -1 : 0);
            if (sign === 0) continue;
            if (prevTrueSign[key] !== undefined && prevTrueSign[key] !== sign) trueCross++;
            prevTrueSign[key] = sign;
        }
    }
}

/* ---------- Evaluation ---------- */
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + ' %' : 'n/a'; }

console.log('=== Reihenfolge ===');
console.log('eindeutige Stichproben :', trueOrderChecks);
console.log('korrekt erkannt        :', orderOk, '(' + pct(orderOk, trueOrderChecks) + ')');

var passes = an.events.filter(function (e) { return e.type === 'pass'; });
console.log('\n=== Ueberholvorgaenge ===');
console.log('wahre Kreuzungen  :', trueCross);
console.log('erkannt           :', passes.length);
console.log('Ping-Pong-Faktor  :', trueCross ? (passes.length / trueCross).toFixed(2) : 'n/a',
            '(1.0 = ideal, >2 = Rauschen durchgeschlagen)');
passes.slice(0, 12).forEach(function (e) {
    console.log('   ' + an.riders[e.id].name + ' ueberholt ' + an.riders[e.over].name +
                '  @ t=' + Math.round((e.t - T0) / 1000) + 's');
});

console.log('\n=== Berge (Wahrheit: 2 Berge, +60 m / 10 %, +48 m / 6 %) ===');
an.climbs.forEach(function (c) {
    console.log('Berg ' + c.no + ': ab s=' + Math.round(c.sStart) + ' m, Laenge ' +
                Math.round(c.len) + ' m, +' + c.gain.toFixed(1) + ' m, ' +
                (c.grade * 100).toFixed(1) + ' %');
    an.climbRanking(c).forEach(function (x, i) {
        console.log('    ' + (i + 1) + '. ' + x.name + '  ' + (x.ms / 1000).toFixed(1) +
                    ' s   VAM ' + Math.round(x.vam) + ' m/h');
    });
});

console.log('\n=== Fuehrungsarbeit ===');
var ord = an.order();
var tot = 0; ord.forEach(function (r) { tot += r.frontMs; });
ord.forEach(function (r) {
    console.log('  ' + (r.name + '     ').slice(0, 7) + (r.frontMs / 1000).toFixed(0) + ' s  (' +
                pct(r.frontMs, tot) + ')');
});
console.log('Summe Fuehrungszeit :', (tot / 1000).toFixed(0), 's   Fahrtdauer: 520 s');

console.log('\n=== Ablosungen (erste 8) ===');
an.stints.slice(0, 8).forEach(function (s) {
    console.log('  ' + (an.riders[s.id].name + '     ').slice(0, 7) +
                (s.ms / 1000).toFixed(0) + ' s, ' + Math.round(s.meters) + ' m');
});

console.log('\n=== Antritte / Abriss ===');
an.events.filter(function (e) { return e.type === 'attack' || e.type === 'drop' || e.type === 'rejoin'; })
    .forEach(function (e) {
        console.log('  t=' + Math.round((e.t - T0) / 1000) + 's  ' + e.type + '  ' +
                    an.riders[e.id].name + (e.gain ? ' +' + e.gain + ' m' : '') +
                    (e.gap ? ' Luecke ' + e.gap + ' m' : ''));
    });

console.log('\n=== Achse ===');
console.log('Routenlaenge erkannt :', Math.round(route.length()), 'm');
console.log('Wahre Strecke Fuehrender:', Math.round(Math.max.apply(null, riders.map(function (r) { return r.s; }))), 'm');
console.log('Stuetzpunkte         :', route.pts.length);
var maxOff = 0;
riders.forEach(function (r) {
    var rr = an.riders[r.id];
    if (rr.offset > maxOff) maxOff = rr.offset;
});
console.log('groesster Querabstand:', maxOff.toFixed(1), 'm (Rauschen ~4 m -> plausibel)');

/* ---------- hard assertions ---------- */
var fails = [];
if (orderOk / trueOrderChecks < 0.95) fails.push('Reihenfolge unter 95 % korrekt');
if (an.climbs.length !== 2) fails.push('Bergerkennung: ' + an.climbs.length + ' statt 2');
if (an.climbs.length === 2) {
    if (Math.abs(an.climbs[0].gain - 60) > 12) fails.push('Berg 1 Hoehengewinn weit weg');
    if (Math.abs(an.climbs[1].gain - 48) > 12) fails.push('Berg 2 Hoehengewinn weit weg');
    var r1 = an.climbRanking(an.climbs[0]);
    if (r1.length && r1[0].name !== 'Anna') fails.push('Berg 1: Anna muesste gewinnen, war ' + r1[0].name);
}
if (trueCross && passes.length / trueCross > 2.0) fails.push('zu viele Ueberholvorgaenge (Ping-Pong)');
if (!an.events.some(function (e) { return e.type === 'drop' && an.riders[e.id].name === 'Dirk'; }))
    fails.push('Dirks Abriss nicht erkannt');
if (Math.abs(route.length() - Math.max.apply(null, riders.map(function (r) { return r.s; }))) > 120)
    fails.push('Routenlaenge weicht stark ab');

console.log('\n=== ERGEBNIS ===');
if (fails.length) { fails.forEach(function (f) { console.log('  FEHLER: ' + f); }); process.exit(1); }
else console.log('  alle Zusicherungen erfuellt');
