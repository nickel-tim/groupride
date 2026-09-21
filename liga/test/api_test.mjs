/* Integrationstest der Liga-API gegen einen laufenden Worker mit lokaler D1.
 *
 *   Terminal 1:  npx wrangler d1 migrations apply groupride --local -c liga/wrangler.dev.jsonc
 *                npx wrangler dev -c liga/wrangler.dev.jsonc
 *   Terminal 2:  node liga/test/api_test.mjs            (BASE=http://127.0.0.1:8787 ist Standard)
 *
 * Der Test spielt mehrere "Handys": eigene Schluesselpaare, echte Signaturen, echte Codes
 * (DEV_MAIL=1 legt den Code in die Antwort). Er laeuft mehrfach hintereinander, weil er
 * zufaellige Adressen benutzt.
 */
import Codec from '../../js/liga-codec.js';
import Cats from '../../js/liga-cats.js';
import * as P from '../../api/periods.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let failed = 0, total = 0;
function check(name, cond, extra) {
    total++; if (!cond) failed++;
    console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond && !process.env.VERBOSE ? '' : (extra !== undefined ? '  ' + JSON.stringify(extra) : '')));
}
const rnd = () => Math.random().toString(36).slice(2, 8);

/* ---------- ein "Handy" ---------- */
class Dev {
    async init() {
        this.pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        this.key = Codec.toB64(new Uint8Array(await crypto.subtle.exportKey('raw', this.pair.publicKey)));
        return this;
    }
    async call(method, path, body, opts = {}) {
        const text = body === undefined ? '' : JSON.stringify(body);
        const bytes = new TextEncoder().encode(text);
        const ts = opts.ts || Date.now();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', opts.signBody !== undefined ? new TextEncoder().encode(opts.signBody) : bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
        const msg = method + '\n' + path + '\n' + ts + '\n' + hash;
        const sig = Codec.toB64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.pair.privateKey, new TextEncoder().encode(msg))));
        const headers = opts.unsigned ? {} : { 'x-key': this.key, 'x-ts': String(ts), 'x-sig': sig };
        if (text) headers['content-type'] = 'application/json';
        const res = await fetch(BASE + path, { method, headers, body: text || undefined });
        const out = await res.json().catch(() => ({}));
        return { status: res.status, ...out };
    }
    /* Konto per E-Mail-Code anlegen/anmelden */
    async login(email, name, extra) {
        const s = await this.call('POST', '/api/auth/start', { email });
        if (!s.devCode) throw new Error('kein devCode: ' + JSON.stringify(s));
        const v = await this.call('POST', '/api/auth/verify', { email, code: s.devCode, name, ...extra });
        if (v.status !== 200) throw new Error('verify: ' + JSON.stringify(v));
        this.account = v.account; this.created = v.created; this.email = email;
        return this;
    }
}

/* ---------- synthetische Fahrten ---------- */
const M = 111320;
function makeRide(startTs, { km = 30, v = 7.5, lat = 48.1, lon = 11.5, hd = 0.6, ele0 = 500, seed = 1 } = {}) {
    let s = seed * 9301;
    const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
    const pts = []; let d = 0, t = 0, la = lat, lo = lon;
    while (d < km * 1000) {
        pts.push({ t: startTs + t * 1000, lat: la + r() * 0.6 / M, lon: lo + r() * 0.6 / M, ele: ele0 + 20 * Math.sin(d / 3000) + r() });
        la += Math.cos(hd) * v / M; lo += Math.sin(hd) * v / (M * Math.cos(la * Math.PI / 180)); d += v; t += 1;
    }
    return pts;
}
function rawDist(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot((pts[i].lat - pts[i - 1].lat) * M, (pts[i].lon - pts[i - 1].lon) * M * Math.cos(pts[i].lat * Math.PI / 180));
    return d;
}
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
async function rideBody(pts, over = {}) {
    const dist = rawDist(pts) * 0.97, dur = pts[pts.length - 1].t - pts[0].t;
    return {
        id: 'r' + rnd() + rnd(), name: 'Testfahrt', src: 'ride', day: dayOf(pts[0].t), dist, moving: dur * 0.95, algo: 1,
        values: { gain: 120, top: 14.2 }, track: await Codec.encode(pts), tiles: Codec.toB64(Codec.packTiles(Codec.tilesOf(pts))), ...over
    };
}
const H = 3600000, D = 86400000, NOW = Date.now();

/* ============================================================ */
console.log('--- Zeitraeume (reine Rechnung)');
{
    const L = (o) => ({ tz: 'Europe/Berlin', every: 1, grace_h: 48, end_ts: null, ...o });
    const iso = ms => new Date(ms).toISOString();
    const feb = Date.parse('2026-02-10T12:00:00Z');
    const m = L({ unit: 'month', start_ts: feb });
    const mar = P.periodAt(m, Date.parse('2026-03-15T12:00:00Z'));
    check('Monat Maerz beginnt um Mitternacht Berlin (MEZ)', iso(mar.start) === '2026-02-28T23:00:00.000Z', iso(mar.start));
    check('Monat Maerz endet mit Sommerzeit (MESZ)', iso(mar.end) === '2026-03-31T22:00:00.000Z', iso(mar.end));
    check('Grenze: 31.3. 23:30 Berlin liegt noch im Maerz', P.periodAt(m, Date.parse('2026-03-31T21:30:00Z')).index === mar.index);
    check('Grenze: 1.4. 00:30 Berlin liegt im April', P.periodAt(m, Date.parse('2026-03-31T22:30:00Z')).index === mar.index + 1);
    check('vor dem Start: kein Zeitraum', P.periodAt(m, Date.parse('2026-01-31T12:00:00Z')) === null);
    const q = L({ unit: 'month', every: 3, start_ts: Date.parse('2026-01-05T00:00:00Z') });
    const q2 = P.periodAt(q, Date.parse('2026-05-01T12:00:00Z'));
    check('3 Monate: Jan-Mrz, dann Apr-Jun', iso(P.periodByIndex(q, 0).start) === '2025-12-31T23:00:00.000Z' && iso(q2.start) === '2026-03-31T22:00:00.000Z' && q2.index === 1, [iso(q2.start), q2.index]);
    const w = L({ unit: 'week', start_ts: Date.parse('2026-03-25T10:00:00Z') });     // Mittwoch
    const wk = P.periodAt(w, Date.parse('2026-03-25T10:00:00Z'));
    check('Woche beginnt am Montag', iso(wk.start) === '2026-03-22T23:00:00.000Z' && new Date(wk.start + H).getUTCDay() === 1, iso(wk.start));
    check('Woche ueber die Zeitumstellung (29.3.) ist 167 h lang', (wk.end - wk.start) === 167 * H, (wk.end - wk.start) / H);
    check('Zeitumstellung: Woche 30.3.-5.4. beginnt Mo 00:00 MESZ', iso(P.periodAt(w, Date.parse('2026-04-01T12:00:00Z')).start) === '2026-03-29T22:00:00.000Z');
    const y = L({ unit: 'year', start_ts: Date.parse('2026-06-01T00:00:00Z') });
    check('Jahr: 1.1. bis 1.1.', iso(P.periodAt(y, Date.parse('2026-08-01T00:00:00Z')).start) === '2025-12-31T23:00:00.000Z');
    const d10 = L({ unit: 'day', every: 10, start_ts: Date.parse('2026-06-01T10:00:00Z') });
    const p10 = P.periodAt(d10, Date.parse('2026-06-15T10:00:00Z'));
    check('10 Tage: zweiter Zeitraum ab 11.6.', p10.index === 1 && iso(p10.start) === '2026-06-10T22:00:00.000Z', iso(p10.start));
    const once = L({ unit: 'once', start_ts: 1000, end_ts: 5000 });
    check('einmalig: innen ja, aussen nein', P.periodAt(once, 2000).index === 0 && P.periodAt(once, 5000) === null && P.periodAt(once, 999) === null);
    check('beendete Zeitraeume: neueste zuerst, ohne den laufenden', P.endedPeriods(m, Date.parse('2026-05-10T12:00:00Z')).map(p => p.index).join() === '2,1,0', P.endedPeriods(m, Date.parse('2026-05-10T12:00:00Z')).map(p => p.index));
    check('Zeitzone New York', iso(P.periodAt(L({ unit: 'month', start_ts: feb, tz: 'America/New_York' }), Date.parse('2026-03-15T12:00:00Z')).start) === '2026-03-01T05:00:00.000Z');
}

console.log('--- Codec');
{
    const pts = makeRide(NOW - D, { km: 5 });
    const b = await Codec.encode(pts), back = await Codec.decode(b);
    check('Track: Rundlauf gleiche Punktzahl und Zeit', back.n === pts.length && back.pts[0].t === pts[0].t && back.pts[back.n - 1].t === pts[pts.length - 1].t);
    const maxErr = Math.max(...pts.map((p, i) => Math.hypot((p.lat - back.pts[i].lat) * M, (p.lon - back.pts[i].lon) * M * 0.667)));
    check('Track: Rundungsfehler unter 1 m', maxErr < 1, maxErr);
    check('Track: Hoehe auf 0,1 m', Math.max(...pts.map((p, i) => Math.abs(p.ele - back.pts[i].ele))) <= 0.051);
    const big = await Codec.encode(makeRide(NOW - D, { km: 50, seed: 7 }));
    check('50 km, 1 Hz: unter 30 KB als Base64', big.length < 30000, big.length + ' Zeichen');
    const noEle = await Codec.decode(await Codec.encode(pts.map(p => ({ ...p, ele: null }))));
    check('Track ohne Hoehe', noEle.pts[0].ele === null);
    check('Kacheln: Rundlauf', JSON.stringify(Codec.unpackTiles(Codec.packTiles([5, 9, 100000]))) === '[5,9,100000]');
    let threw = false; try { Codec.unpack(new Uint8Array([200, 1])); } catch (e) { threw = true; }
    check('beschaedigter Track wirft', threw);
}

console.log('--- Anmeldung');
const S = rnd();
const anna = await new Dev().init(), ben = await new Dev().init(), cy = await new Dev().init();
{
    check('Health', (await new Dev().init().then(d => d.call('GET', '/api/health', undefined, { unsigned: true }))).mail === 'dev');
    const u = await anna.call('GET', '/api/me', undefined, { unsigned: true });
    check('ohne Signatur: 401', u.status === 401 && u.code === 'no_sig', u);
    const unknown = await anna.call('GET', '/api/me');
    check('unbekannter Schluessel: 401 unknown_key', unknown.status === 401 && unknown.code === 'unknown_key', unknown);
    const bad = await anna.call('GET', '/api/me', undefined, { ts: Date.now() - 20 * 60000 });
    check('alte Uhrzeit: 401 clock', bad.status === 401 && bad.code === 'clock', bad);
    const tamper = await anna.call('POST', '/api/auth/start', { email: 'x@y.de' }, { signBody: '{"email":"a@b.de"}' });
    check('veraenderter Body: Signatur ungueltig', tamper.status === 401 && tamper.code === 'bad_sig', tamper);
    const badMail = await anna.call('POST', '/api/auth/start', { email: 'kein-mail' });
    check('ungueltige Adresse: 400', badMail.status === 400, badMail);

    const email = `anna-${S}@example.com`;
    const s = await anna.call('POST', '/api/auth/start', { email });
    check('Code angefordert', s.status === 200 && /^\d{6}$/.test(s.devCode), s);
    const wrong = await anna.call('POST', '/api/auth/verify', { email, code: s.devCode === '000000' ? '111111' : '000000' });
    check('falscher Code: 400 wrong', wrong.status === 400 && wrong.code === 'wrong', wrong);
    const other = await ben.call('POST', '/api/auth/verify', { email, code: s.devCode });
    check('Code an fremden Schluessel gebunden', other.status === 400, other);
    const ok = await anna.call('POST', '/api/auth/verify', { email, code: s.devCode, name: 'Anna', emoji: 1, color: '#ff0000' });
    check('richtiger Code: Konto angelegt', ok.status === 200 && ok.created && ok.account.name === 'Anna' && ok.account.emoji === 1, ok);
    anna.account = ok.account;
    const again = await anna.call('POST', '/api/auth/verify', { email, code: s.devCode, name: 'Anna' });
    check('Code nur einmal verwendbar', again.status === 400, again);
    const me = await anna.call('GET', '/api/me');
    check('/api/me', me.status === 200 && me.account.id === anna.account.id && me.devices.length === 1 && me.devices[0].current, me);

    // zweites Geraet: dasselbe Konto (Browserdaten geloescht / neues Handy)
    const anna2 = await new Dev().init();
    await anna2.login(email, 'Egal');
    check('zweites Geraet: gleiches Konto, nicht neu', anna2.account.id === anna.account.id && anna2.created === false, anna2.account);
    check('Name bleibt der vom ersten Anlegen', anna2.account.name === 'Anna');
    const me2 = await anna.call('GET', '/api/me');
    check('zwei Geraete', me2.devices.length === 2);
    const rm = await anna.call('DELETE', '/api/devices/' + me2.devices.find(d => !d.current).id);
    check('anderes Geraet abmelden', rm.status === 200);
    check('abgemeldetes Geraet: 401', (await anna2.call('GET', '/api/me')).status === 401);
    check('eigenes Geraet nicht abmeldbar', (await anna.call('DELETE', '/api/devices/' + me2.devices.find(d => d.current).id)).status === 404);

    // Begrenzung: hoechstens 5 Codes je Stunde und Adresse
    const spam = `spam-${S}@example.com`, dev = await new Dev().init(); let last;
    for (let i = 0; i < 6; i++) last = await dev.call('POST', '/api/auth/start', { email: spam });
    check('6. Code binnen einer Stunde: 429', last.status === 429, last);
    // 5 Fehlversuche sperren den Code
    const lock = `lock-${S}@example.com`, dl = await new Dev().init();
    const ls = await dl.call('POST', '/api/auth/start', { email: lock });
    let lr; for (let i = 0; i < 6; i++) lr = await dl.call('POST', '/api/auth/verify', { email: lock, code: ls.devCode === '123456' ? '654321' : '123456' });
    const good = await dl.call('POST', '/api/auth/verify', { email: lock, code: ls.devCode });
    check('nach 5 Fehlversuchen ist auch der richtige Code gesperrt', lr.status === 429 && good.status === 429, [lr.status, good.status]);

    await ben.login(`ben-${S}@example.com`, 'Ben', { emoji: 2 });
    await cy.login(`cy-${S}@example.com`, 'Cy');
    check('Ben und Cy angemeldet', ben.account.name === 'Ben' && cy.account.name === 'Cy');
    const upd = await ben.call('PUT', '/api/me', { name: 'Benny', emoji: 3 });
    check('Profil aendern', upd.status === 200 && upd.account.name === 'Benny');
    ben.account.name = 'Benny';
}

console.log('--- Fahrten hochladen');
let rideA1, rideA2, rideA3, rideB1, rideB2;
{
    const t0 = NOW - 6 * D;
    const p1 = makeRide(t0, { km: 30, seed: 1 });
    rideA1 = await rideBody(p1);
    let r = await anna.call('POST', '/api/rides', rideA1);
    check('Fahrt 30 km angenommen', r.status === 200 && r.ok && !r.dup, r);
    check('unplausible Werte werden weggelassen, nicht die Fahrt', (await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 5.5 * D, { km: 12, seed: 2 }), { values: { top: 50, gain: 90, wat: 1 } }))).dropped?.join() === 'top,wat');
    r = await anna.call('POST', '/api/rides', rideA1);
    check('gleiche Fahrt nochmal: idempotent', r.status === 200 && r.dup === true, r);
    check('fremde Fahrt-ID: 409', (await ben.call('POST', '/api/rides', rideA1)).status === 409);
    // Ueberschneidung: zweite Fahrt, halb zeitgleich
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(t0 + 10 * 60000, { km: 20, seed: 3 })));
    check('Ueberschneidung mit eigener Fahrt: 409 overlap', r.status === 409 && r.reason === 'overlap', r);
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 3 * D, { km: 10 }), { src: 'sim' }));
    check('Simulation abgelehnt', r.status === 422 && r.reason === 'src', r);
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 3 * D, { km: 10 }), { src: 'plan' }));
    check('Plan abgelehnt', r.status === 422 && r.reason === 'src');
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 3 * D, { km: 0.6, v: 5 }).slice(0, 30)));
    check('zu kurz abgelehnt', r.status === 422 && r.reason === 'short', r);
    const jumpy = makeRide(NOW - 3 * D, { km: 10 }); for (let i = 300; i < jumpy.length; i++) jumpy[i].lat += 0.05;
    r = await anna.call('POST', '/api/rides', await rideBody(jumpy));
    check('GPS-Sprung abgelehnt', r.status === 422 && r.reason === 'jump', r);
    const fast = makeRide(NOW - 3 * D, { km: 20, v: 24 });
    r = await anna.call('POST', '/api/rides', await rideBody(fast));
    check('86 km/h im Schnitt: keine Radfahrt', r.status === 422 && r.reason === 'too_fast', r);
    const p = makeRide(NOW - 3 * D, { km: 10 });
    r = await anna.call('POST', '/api/rides', await rideBody(p, { dist: rawDist(p) * 3 }));
    check('Strecke passt nicht zum Track', r.status === 422 && r.reason === 'dist_mismatch', r);
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW + 2 * D, { km: 10 })));
    check('Fahrt in der Zukunft abgelehnt', r.status === 422 && r.reason === 'time', r);
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 500 * D, { km: 10 })));
    check('Fahrt aelter als 400 Tage abgelehnt', r.status === 422 && r.reason === 'time');
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 3 * D, { km: 10 }), { track: 'AAAA' }));
    check('beschaedigter Track abgelehnt', r.status === 422 && r.reason === 'track', r);
    r = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 3 * D, { km: 10 }), { day: '2001-01-01' }));
    check('Datum passt nicht zur Startzeit', r.status === 400, r);

    // weitere Fahrten fuer die Ligen
    rideA2 = await rideBody(makeRide(NOW - 4 * D, { km: 40, seed: 4, lat: 48.3 }), { values: { gain: 400, top: 16.5, t10k: 1300000, avg20: 6.8 } });
    rideA3 = await rideBody(makeRide(NOW - 3 * D, { km: 20, seed: 5, lat: 48.5 }), { values: { gain: 80, top: 12 } });
    for (const b of [rideA2, rideA3]) check('Fahrt angenommen', (await anna.call('POST', '/api/rides', b)).status === 200);
    rideB1 = await rideBody(makeRide(NOW - 5 * D, { km: 60, seed: 6, lat: 48.1, v: 8 }), { values: { gain: 300, top: 18.1, t10k: 1250000 } });   // gleiche Gegend wie Anna
    rideB2 = await rideBody(makeRide(NOW - 2 * D, { km: 25, seed: 8, lat: 48.7 }), { values: { gain: 100, top: 11, coffee: 1, front: 600000 } });
    for (const b of [rideB1, rideB2]) check('Fahrt (Ben) angenommen', (await ben.call('POST', '/api/rides', b)).status === 200);
    const list = await anna.call('GET', '/api/rides');
    check('Fahrtenliste', list.rides.length === 4, list.rides.length);       // 30, 12, 40, 20 km
    const tr = await anna.call('GET', '/api/rides/' + rideA1.id + '/track');
    const dec = await Codec.decode(tr.track);
    check('eigenen Track zurueckholen', dec.n > 3000 && dec.pts[0].t === (await Codec.decode(rideA1.track)).pts[0].t);
    check('fremden Track lesen: 404', (await ben.call('GET', '/api/rides/' + rideA1.id + '/track')).status === 404);
    const t = performance.now(); await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 60 * D, { km: 50, seed: 11 })));
    console.log('     (50-km-Upload inkl. Netz und Server: ' + Math.round(performance.now() - t) + ' ms)');
}

console.log('--- Liga');
let league, inviteLink;
{
    const bad = await anna.call('POST', '/api/leagues', { name: '' });
    check('Liga ohne Namen: 400', bad.status === 400);
    const badCat = await anna.call('POST', '/api/leagues', { name: 'x', cats: ['gibtsnicht'] });
    check('unbekannte Kategorie: 400', badCat.status === 400, badCat);
    const badGoal = await anna.call('POST', '/api/leagues', { name: 'x', goals: [{ cat: 'top', target: 5 }] });
    check('Team-Ziel auf nicht summierbare Kategorie: 400', badGoal.status === 400, badGoal);
    const badTz = await anna.call('POST', '/api/leagues', { name: 'x', tz: 'Mars/Olympus' });
    check('unbekannte Zeitzone: 400', badTz.status === 400);
    const badOnce = await anna.call('POST', '/api/leagues', { name: 'x', unit: 'once', start_ts: 5000, end_ts: 4000 });
    check('einmalige Liga: Ende vor Start: 400', badOnce.status === 400);

    const c = await anna.call('POST', '/api/leagues', {
        name: 'Testliga', unit: 'day', every: 30, start_ts: NOW - 10 * D,
        cats: ['dist', 'time', 'gain', 'rides', 'days', 'streak', 'long_dist', 'top', 't10k', 'avg20', 'explore', 'coffee', 'front', 'kom'],
        goals: [{ cat: 'dist', target: 500000 }]
    });
    check('Liga angelegt', c.status === 200 && c.id && c.invite.startsWith(c.id + '.'), c);
    league = c.id; inviteLink = c.invite;
    const secret = c.invite.split('.')[1];
    check('Ben mit falschem Geheimnis: 403', (await ben.call('POST', '/api/leagues/join', { id: league, secret: 'falsch' })).status === 403);
    check('Ben tritt bei', (await ben.call('POST', '/api/leagues/join', { id: league, secret })).status === 200);
    check('Beitritt zweimal ist harmlos', (await ben.call('POST', '/api/leagues/join', { id: league, secret })).already === true);
    check('Cy (kein Mitglied) sieht die Liga nicht: 404', (await cy.call('GET', '/api/leagues/' + league)).status === 404);
    check('Cy sieht keine Rangliste: 404', (await cy.call('GET', `/api/leagues/${league}/standing?cat=dist`)).status === 404);
    check('Ligen von Ben', (await ben.call('GET', '/api/leagues')).leagues.length === 1);
}

console.log('--- Ranglisten');
{
    const ov = await anna.call('GET', '/api/leagues/' + league);
    check('Uebersicht', ov.status === 200 && ov.members.length === 2 && ov.period.open && !ov.period.frozen, ov.period);
    const km = r => Math.round(r.v / 1000);
    const dist = ov.boards.dist;
    // Anna: 30 + 12 + 40 + 20 = 102 km, Ben: 60 + 25 = 85 km (mal 0,97-Toleranz)
    check('Kilometer: Anna vor Ben', dist[0].name === 'Anna' && dist[0].rank === 1 && dist[1].name === 'Benny' && dist[1].rank === 2, dist.map(r => [r.name, km(r)]));
    check('Kilometer: Summen stimmen (Anna ~99, Ben ~82)', Math.abs(km(dist[0]) - 99) < 5 && Math.abs(km(dist[1]) - 82) < 5, dist.map(r => km(r)));
    check('Fahrten zaehlen', ov.boards.rides[0].v === 4 && ov.boards.rides[1].v === 2, ov.boards.rides.map(r => r.v));
    check('Fahrtage', ov.boards.days[0].v === 4 && ov.boards.days[1].v === 2, ov.boards.days.map(r => r.v));

    check('Laengste Fahrt: Ben 60 km vor Anna 40 km', ov.boards.long_dist[0].name === 'Benny' && km(ov.boards.long_dist[0]) === 58, ov.boards.long_dist.map(r => [r.name, km(r)]));
    check('Topspeed: Ben 18,1 vor Anna 16,5', ov.boards.top[0].name === 'Benny' && ov.boards.top[0].v === 18.1 && ov.boards.top[1].v === 16.5, ov.boards.top.map(r => r.v));
    check('Bestzeit: KLEINER ist besser (Ben 1250 s vor Anna 1300 s)', ov.boards.t10k[0].name === 'Benny' && ov.boards.t10k[0].v === 1250000, ov.boards.t10k);
    check('Kategorie nur fuer Anna: Ben ohne Wert, kein Rang', ov.boards.avg20[0].name === 'Anna' && ov.boards.avg20[1].rank === null && ov.boards.avg20[1].v === null, ov.boards.avg20);
    check('Hoehenmeter: Summe der gemeldeten Werte (Anna 120+90+400+80, Ben 300+100)', ov.boards.gain[0].name === 'Anna' && ov.boards.gain[0].v === 690 && ov.boards.gain[1].v === 400, ov.boards.gain.map(r => r.v));
    const exploreBefore = ov.boards.explore.find(r => r.name === 'Anna').v;
    const rerun = await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 1.5 * D, { km: 30, seed: 40 })));       // dieselbe Strecke wie Annas erste Fahrt
    const ovRe = await anna.call('GET', '/api/leagues/' + league);
    check('dieselbe Gegend nochmal befahren: keine neuen Kacheln', rerun.status === 200 && ovRe.boards.explore.find(r => r.name === 'Anna').v === exploreBefore, [exploreBefore, ovRe.boards.explore.find(r => r.name === 'Anna').v]);
    check('...aber Kilometer und Fahrten zaehlen', ovRe.boards.rides.find(r => r.name === 'Anna').v === 5);
    check('Kaffee: nur Ben', ov.boards.coffee[0].name === 'Benny' && ov.boards.coffee[0].v === 1);
    check('Wasserträger: nur Ben', ov.boards.front[0].name === 'Benny' && ov.boards.front[0].v === 600000);
    check('Serie: Anna hat zwei Tage in Folge (vor 4 und 3 Tagen), Ben einen', ov.boards.streak[0].name === 'Anna' && ov.boards.streak[0].v >= 2 && ov.boards.streak[1].v === 1, ov.boards.streak.map(r => [r.name, r.v]));
    check('Entdecken: beide haben neue Kacheln', ov.boards.explore.every(r => r.v > 10), ov.boards.explore.map(r => r.v));
    check('Kletterkoenig ohne Segmente: niemand', ov.boards.kom.every(r => r.rank === null));
    check('Gesamtwertung vorhanden', Array.isArray(ov.total) && ov.total.length === 2 && ov.total[0].points > 0, ov.total);
    const sumPoints = ov.total.reduce((a, r) => a + r.points, 0);
    check('Punkte: je Kategorie mit Wert (n - Platz + 1), gesamt plausibel', sumPoints > 10 && sumPoints < 60, sumPoints);
    check('Teamziel: Fortschritt = Summe beider', ov.goals.team[0].cat === 'dist' && Math.abs(ov.goals.team[0].progress - (dist[0].v + dist[1].v)) < 1, ov.goals.team);

    // Stand fuer den Tacho
    const st = await ben.call('GET', `/api/leagues/${league}/standing?cat=dist`);
    check('Tacho-Stand: Ben Platz 2, Anna vor ihm', st.standing.me.rank === 2 && st.standing.above.name === 'Anna' && st.standing.below === null && st.standing.of === 2, st.standing);
    const st2 = await anna.call('GET', `/api/leagues/${league}/standing?cat=t10k`);
    check('Tacho-Stand Bestzeit: Anna Platz 2, Ben vor ihr', st2.standing.me.rank === 2 && st2.standing.above.name === 'Benny');
    check('Tacho-Stand Gesamt', (await anna.call('GET', `/api/leagues/${league}/standing?cat=_total`)).standing.me.rank >= 1);
    check('Tacho-Stand unbekannte Kategorie: 400', (await anna.call('GET', `/api/leagues/${league}/standing?cat=x`)).status === 400);

    // persoenliche Ziele
    const g = await ben.call('PUT', `/api/leagues/${league}/goals`, { goals: [{ cat: 'dist', target: 200000 }, { cat: 'gain', target: 1000 }] });
    check('persoenliche Ziele setzen', g.status === 200 && g.goals.length === 2);
    const ov2 = await anna.call('GET', '/api/leagues/' + league);
    const bg = ov2.goals.personal.find(p => p.id === ben.account.id);
    check('persoenliche Ziele fuer alle sichtbar, mit Fortschritt', bg && bg.goals[0].cat === 'dist' && bg.goals[0].progress > 80000, bg);

    check('Zeitraum-Navigation: erster Zeitraum, kein Vorgaenger und kein Nachfolger', ov.period.prev === null && ov.period.next === null && ov.period.index === 0, ov.period);
}

console.log('--- Einstellungen und Rechte');
{
    check('Ben (kein Admin) darf nicht aendern: 403', (await ben.call('PATCH', '/api/leagues/' + league, { name: 'Hack' })).status === 403);
    const p = await anna.call('PATCH', '/api/leagues/' + league, { name: 'Testliga 2', cats: ['dist', 'top'], scoring: false });
    check('Admin aendert Einstellungen', p.status === 200);
    const ov = await ben.call('GET', '/api/leagues/' + league);
    check('Aenderung wirkt: nur 2 Kategorien, keine Gesamtwertung', ov.league.name === 'Testliga 2' && Object.keys(ov.boards).length === 2 && ov.total === undefined, Object.keys(ov.boards));
    await anna.call('PATCH', '/api/leagues/' + league, { cats: ['dist', 'time', 'gain', 'rides', 'days', 'streak', 'long_dist', 'top', 't10k', 'avg20', 'explore', 'coffee', 'front', 'kom'], scoring: true, no_points: ['coffee'] });
    const ov3 = await ben.call('GET', '/api/leagues/' + league);
    const withCoffee = ov3.total.find(r => r.name === 'Benny').points;
    await anna.call('PATCH', '/api/leagues/' + league, { no_points: [] });
    const ov4 = await ben.call('GET', '/api/leagues/' + league);
    check('Kategorie aus der Gesamtwertung nehmen aendert die Punkte', ov4.total.find(r => r.name === 'Benny').points > withCoffee, [withCoffee, ov4.total.find(r => r.name === 'Benny').points]);
    const rot = await anna.call('PATCH', '/api/leagues/' + league, { rotateInvite: true });
    check('Einladung erneuern', rot.invite && rot.invite !== inviteLink);
    check('alte Einladung ungueltig', (await cy.call('POST', '/api/leagues/join', { id: league, secret: inviteLink.split('.')[1] })).status === 403);
    inviteLink = rot.invite;
    check('neue Einladung gilt', (await cy.call('POST', '/api/leagues/join', { id: league, secret: inviteLink.split('.')[1] })).status === 200);
    check('Cy sieht jetzt die Liga', (await cy.call('GET', '/api/leagues/' + league)).members.length === 3);
    check('Ben darf Cy nicht entfernen: 403', (await ben.call('DELETE', `/api/leagues/${league}/members/${cy.account.id}`)).status === 403);
    check('Admin entfernt Cy', (await anna.call('DELETE', `/api/leagues/${league}/members/${cy.account.id}`)).status === 200);
    check('Cy sieht die Liga nicht mehr', (await cy.call('GET', '/api/leagues/' + league)).status === 404);
}

console.log('--- Abgelaufener Zeitraum: Einfrieren und Ruhmeshalle');
{
    // einmalige Liga vor 40..35 Tagen, ohne Nachfrist
    const c = await anna.call('POST', '/api/leagues', { name: 'Sommer', unit: 'once', start_ts: NOW - 50 * D, end_ts: NOW - 30 * D, grace_h: 0, cats: ['dist', 'top', 'rides'] });
    const id = c.id, secret = c.invite.split('.')[1];
    await ben.call('POST', '/api/leagues/join', { id, secret });
    const mk = async (dev, daysAgo, km, seed, top) => dev.call('POST', '/api/rides', await rideBody(makeRide(NOW - daysAgo * D, { km, seed, lat: 47 + seed * 0.1 }), { values: { top } }));
    check('alte Fahrt Anna', (await mk(anna, 45, 30, 21, 15)).status === 200);
    check('alte Fahrt Ben', (await mk(ben, 44, 45, 22, 13)).status === 200);
    check('alte Fahrt Ben 2', (await mk(ben, 43, 15, 23, 17)).status === 200);
    const ov = await anna.call('GET', '/api/leagues/' + id);
    check('Zeitraum ist eingefroren', ov.period.frozen === true && ov.period.open === false, ov.period);
    check('eingefrorene Rangliste: Ben 60 km vor Anna 30 km', ov.boards.dist[0].name === 'Benny' && Math.round(ov.boards.dist[0].v / 1000) === 58, ov.boards.dist.map(r => [r.name, Math.round(r.v / 1000)]));
    check('eingefrorene Gesamtwertung', ov.total[0].name === 'Benny' && ov.total[0].points > ov.total[1].points, ov.total);
    const hall = await ben.call('GET', `/api/leagues/${id}/hall`);
    check('Ruhmeshalle: ein Zeitraum, Sieger je Kategorie', hall.periods.length === 1 && hall.periods[0].cats.dist[0].name === 'Benny' && hall.periods[0].cats.top[0].name === 'Benny', hall);
    check('Titelzaehler', hall.titles[0].name === 'Benny' && hall.titles[0].total === 1, hall.titles);
    // eine spaet hochgeladene Fahrt aendert den eingefrorenen Stand nicht mehr
    await anna.call('POST', '/api/rides', await rideBody(makeRide(NOW - 42 * D, { km: 90, seed: 24, lat: 46 })));
    const ov2 = await anna.call('GET', '/api/leagues/' + id);
    check('nach dem Einfrieren zaehlen spaete Fahrten nicht mehr', ov2.boards.dist[0].name === 'Benny');
    const t = await anna.call('PATCH', '/api/leagues/' + id, { unit: 'month' });
    check('Zeitraum nach dem Abschluss nicht mehr aenderbar: 409', t.status === 409, t);
    check('Name bleibt aenderbar', (await anna.call('PATCH', '/api/leagues/' + id, { name: 'Sommer 2026' })).status === 200);
    // Nachfrist: Liga, die gerade erst zu Ende ist, friert noch nicht ein
    const g = await anna.call('POST', '/api/leagues', { name: 'Frisch', unit: 'once', start_ts: NOW - 5 * D, end_ts: NOW - 1 * D, grace_h: 48, cats: ['dist'] });
    const og = await anna.call('GET', '/api/leagues/' + g.id);
    check('innerhalb der Nachfrist noch nicht eingefroren', og.period.frozen === false && og.period.open === false, og.period);
    check('leere Ruhmeshalle', (await anna.call('GET', `/api/leagues/${g.id}/hall`)).periods.length === 0);
}

console.log('--- Teilen');
{
    const full = makeRide(NOW - 6 * D, { km: 30, seed: 1 });
    const trimmed = full.slice(300, full.length - 300);
    const bad = await anna.call('POST', `/api/rides/${rideA1.id}/share`, { league, track: await Codec.encode(trimmed), trim: 300 });
    check('Teilen', bad.status === 200, bad);
    const l = await ben.call('GET', `/api/leagues/${league}/shared`);
    check('Ben sieht die geteilte Fahrt mit Besitzer', l.rides.length === 1 && l.rides[0].owner_name === 'Anna' && l.rides[0].trim_m === 300, l);
    const dl = await ben.call('GET', `/api/leagues/${league}/shared/${rideA1.id}/track`);
    const back = await Codec.decode(dl.track);
    check('gekuerzte Kopie: Anfang und Ende fehlen', back.n === trimmed.length && back.n < full.length - 500, back.n);
    check('Cy (kein Mitglied): 404', (await cy.call('GET', `/api/leagues/${league}/shared`)).status === 404);
    check('Ben kann Annas Fahrt nicht teilen', (await ben.call('POST', `/api/rides/${rideA1.id}/share`, { league, track: await Codec.encode(trimmed), trim: 300 })).status === 404);
    const out = await anna.call('POST', `/api/rides/${rideA1.id}/share`, { league: 'gibtsnicht', track: await Codec.encode(trimmed), trim: 300 });
    check('Teilen in fremde Liga: 403', out.status === 403);
    const foreign = await anna.call('POST', `/api/rides/${rideA1.id}/share`, { league, track: await Codec.encode(makeRide(NOW - 100 * D, { km: 3 })), trim: 0 });
    check('Kopie ausserhalb der Fahrt abgelehnt', foreign.status === 422 && foreign.reason === 'range', foreign);
    check('in der Liste steht, wohin geteilt ist', (await anna.call('GET', '/api/rides')).rides.find(r => r.id === rideA1.id).shared[0] === league);
    check('Zuruecknehmen', (await anna.call('DELETE', `/api/rides/${rideA1.id}/share/${league}`)).status === 200);
    check('danach nicht mehr sichtbar', (await ben.call('GET', `/api/leagues/${league}/shared`)).rides.length === 0);
    check('Kopie geloescht', (await ben.call('GET', `/api/leagues/${league}/shared/${rideA1.id}/track`)).status === 404);
}

console.log('--- Liga-Segmente und Kletterkoenig');
{
    const seg = makeRide(NOW, { km: 2, seed: 30 });
    const poly = await Codec.encode(seg.filter((_, i) => i % 5 === 0));
    check('Segment ohne Namen: 400', (await anna.call('POST', `/api/leagues/${league}/segments`, { name: '', poly, len: 2000 })).status === 400);
    check('Segment mit falscher Laenge: 400', (await anna.call('POST', `/api/leagues/${league}/segments`, { name: 'x', poly, len: 5 })).status === 400);
    const s = await anna.call('POST', `/api/leagues/${league}/segments`, { name: 'Testberg', kind: 'climb', poly, len: 2000, gain: 150 });
    check('Segment angelegt', s.status === 200 && s.id, s);
    const s2 = await ben.call('POST', `/api/leagues/${league}/segments`, { name: 'Sprint', kind: 'sprint', poly, len: 500 });
    check('Mitglied legt auch eins an', s2.status === 200);
    const list = await cy.call('GET', `/api/leagues/${league}/segments`);
    check('Nichtmitglied sieht keine Segmente', list.status === 404);
    const l2 = await ben.call('GET', `/api/leagues/${league}/segments`);
    check('Liste enthaelt Linie', l2.segments.length === 2 && l2.segments[0].poly.length > 10, l2.segments.map(x => x.name));
    const put = await anna.call('PUT', `/api/leagues/${league}/segments/${s.id}/efforts`, { efforts: [{ ride: rideA1.id, ms: 400000 }, { ride: rideA2.id, ms: 380000 }, { ride: rideB1.id, ms: 100000 }, { ride: rideA3.id, ms: 5 }] });
    check('Annas Zeiten: fremde Fahrt und unmoegliche Zeit werden ignoriert', put.stored === 2, put);
    await ben.call('PUT', `/api/leagues/${league}/segments/${s.id}/efforts`, { efforts: [{ ride: rideB1.id, ms: 350000 }, { ride: rideB2.id, ms: 420000 }] });
    await anna.call('PATCH', '/api/leagues/' + league, { cats: ['dist', 'kom'] });
    const ov = await anna.call('GET', '/api/leagues/' + league);
    check('Kletterkoenig: Ben 3 Punkte (schneller), Anna 2', ov.boards.kom[0].name === 'Benny' && ov.boards.kom[0].v === 3 && ov.boards.kom[1].v === 2, ov.boards.kom.map(r => [r.name, r.v]));
    const st = await anna.call('GET', `/api/leagues/${league}/standing?cat=seg:${s.id}`);
    check('Segment-Rangliste: Ben 350 s vor Anna 380 s (bester Wert je Fahrer)', st.standing.me.rank === 2 && st.standing.above.v === 350000 && st.standing.me.v === 380000, st.standing);
    check('Segment loeschen (fremdes, kein Admin): 403', (await ben.call('DELETE', `/api/leagues/${league}/segments/${s.id}`)).status === 403);
    check('eigenes Segment loeschen', (await ben.call('DELETE', `/api/leagues/${league}/segments/${s2.id}`)).status === 200);
    check('Admin loescht fremdes Segment', (await anna.call('DELETE', `/api/leagues/${league}/segments/${s.id}`)).status === 200);
    check('danach keine Kletterpunkte mehr', (await anna.call('GET', '/api/leagues/' + league)).boards.kom.every(r => r.rank === null));
    await anna.call('PATCH', '/api/leagues/' + league, { cats: ['dist', 'explore'] });
}

console.log('--- Loeschen');
{
    const before = (await anna.call('GET', '/api/leagues/' + league)).boards.explore.find(r => r.name === 'Anna').v;
    check('Fahrt loeschen', (await anna.call('DELETE', '/api/rides/' + rideA2.id)).status === 200);
    const after = (await anna.call('GET', '/api/leagues/' + league)).boards.explore.find(r => r.name === 'Anna').v;
    check('Entdecken: Kacheln der geloeschten Fahrt zaehlen nicht mehr', after < before, [before, after]);
    check('geloeschte Fahrt fehlt in der Liste', !(await anna.call('GET', '/api/rides')).rides.some(r => r.id === rideA2.id));
    check('Ben: fremde Fahrt loeschen: 404', (await ben.call('DELETE', '/api/rides/' + rideA3.id)).status === 404);

    // Admin verlaesst die Liga: Ben wird Admin
    check('Admin verlaesst die Liga', (await anna.call('DELETE', `/api/leagues/${league}/members/${anna.account.id}`)).status === 200);
    const ov = await ben.call('GET', '/api/leagues/' + league);
    check('Ben ist jetzt Admin', ov.league.isAdmin === true && ov.members.length === 1, ov.league);
    // Konto loeschen: nimmt alles mit
    check('Konto ohne Bestaetigung: 400', (await ben.call('DELETE', '/api/me', {})).status === 400);
    check('Konto loeschen', (await ben.call('DELETE', '/api/me', { confirm: true })).status === 200);
    check('danach ist der Schluessel ungueltig', (await ben.call('GET', '/api/me')).status === 401);
    const again = await new Dev().init().then(d => d.login(`ben-${S}@example.com`, 'Ben neu'));
    check('nach dem Loeschen kann man neu anfangen (neues Konto)', again.created === true && again.account.id !== ben.account.id);
    check('neues Konto hat keine Fahrten', (await again.call('GET', '/api/rides')).rides.length === 0);
    check('Liga ohne Mitglieder geloescht (Ben war allein)', (await anna.call('GET', '/api/leagues/' + league)).status === 404);
}

console.log('\nERGEBNIS: ' + (failed ? failed + ' von ' + total + ' FEHLGESCHLAGEN' : 'alle ' + total + ' bestanden'));
process.exit(failed ? 1 : 0);
