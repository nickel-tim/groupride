/* rides.js -- upload, check, read, delete, share rides
 *
 * The server DOES NOT RECOMPUTE (10 ms CPU on the free plan), it only checks whether the data
 * matches the track and whether the ride is credible. The metrics come from the browser.
 */
import Codec from '../js/liga-codec.js';
import Cats from '../js/liga-cats.js';
import { bad, denied, missing, rejected, HttpError, q1, qa, run, stmt, cleanText } from './util.js';

const MIN_POINTS = 40, MAX_POINTS = 40000, MIN_DUR_MS = 120000, MIN_DIST_M = 500;
const MAX_JUMP_SPEED = 100;              // m/s between two points (for gaps <= 30 s)
const MAX_AVG_SPEED = 20;                // m/s moving average, 72 km/h
const MAX_PER_DAY = 20;
const MAX_AGE_MS = 400 * 86400000;
const MAX_BODY = 400 * 1024;
const MAX_STEPS = 12000;                 // this many point pairs we check at most (CPU budget)

const RAD = Math.PI / 180, M_PER_DEG = 111320;

/* Rough characteristics of the track (equirectangular approximation, enough for plausibility) */
function inspect(pts) {
    const n = pts.length, step = Math.max(1, Math.ceil(n / MAX_STEPS));
    let dist = 0, maxV = 0, moving = 0, bad = null;
    for (let i = step; i < n; i += step) {
        const a = pts[i - step], b = pts[i], dt = (b.t - a.t) / 1000;
        if (dt <= 0) { bad = 'time_order'; break; }
        const dy = (b.lat - a.lat) * M_PER_DEG, dx = (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat + b.lat) / 2 * RAD);
        const d = Math.hypot(dx, dy);
        dist += d;
        if (dt <= 30 * step) maxV = Math.max(maxV, d / dt);
        if (d / dt >= 1 && dt < 20 * step) moving += dt;
    }
    return { dist, maxV, moving, bad };
}

const VALUE_RULES = {
    gain:     (v, r) => v <= 12000 && v <= r.dist,
    top:      (v) => v > 0 && v <= 30,                                   // > 108 km/h is a GPS error
    avg20:    (v, r) => r.dist >= 20000 && v > 0 && v <= MAX_AVG_SPEED,
    t10k:     (v, r) => r.dist >= 10000 && v >= 10000 / MAX_AVG_SPEED * 1000 && v <= r.dur,
    t20k:     (v, r) => r.dist >= 20000 && v >= 20000 / MAX_AVG_SPEED * 1000 && v <= r.dur,
    t40k:     (v, r) => r.dist >= 40000 && v >= 40000 / MAX_AVG_SPEED * 1000 && v <= r.dur,
    avg1h:    (v, r) => r.dur >= 3300000 && v > 0 && v <= MAX_AVG_SPEED,
    vam:      (v) => v > 0 && v <= 3500,
    front:    (v, r) => v >= 0 && v <= r.dur,
    attacks:  (v) => Number.isInteger(v) && v >= 0 && v <= 500,
    escape:   (v, r) => v > 0 && v <= r.dur,
    together: (v, r) => v >= 0 && v <= r.dist * 1.05,
    coffee:   (v, r) => Number.isInteger(v) && v >= 0 && v <= Math.min(50, Math.floor(r.dur / 900000) + 1)
};

/* Implausible single values are left out (the whole ride is not rejected) */
function cleanValues(values, ride) {
    const rows = [{ c: 'dist', v: ride.dist }, { c: 'time', v: ride.moving }, { c: 'rides', v: 1 }], dropped = [];
    for (const [k, raw] of Object.entries(values || {})) {
        const v = Number(raw);
        if (['dist', 'time', 'rides'].includes(k)) continue;              // come from the ride itself
        if (!Cats.STORED.includes(k) || !VALUE_RULES[k]) { dropped.push(k); continue; }
        if (!Number.isFinite(v) || !VALUE_RULES[k](v, ride)) { dropped.push(k); continue; }
        rows.push({ c: k, v });
    }
    return { rows, dropped };
}

function dayNum(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }

export async function uploadRide(env, auth, body) {
    const a = auth.account.id, now = Date.now();
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw bad('Fahrt-ID ungültig.');
    const src = body.src;
    if (src !== 'ride' && src !== 'gpx') throw rejected('src', 'Simulationen, Ghosts und Pläne zählen nicht.');
    if (typeof body.track !== 'string' || body.track.length > MAX_BODY) throw rejected('size', 'Der Track ist zu groß.');

    const existing = await q1(env.DB, 'SELECT account_id FROM rides WHERE id = ?', id);
    if (existing) {
        if (existing.account_id !== a) throw new HttpError(409, 'Diese Fahrt-ID ist vergeben.');
        return { ok: true, dup: true };
    }

    let tr;
    try { tr = await Codec.decode(body.track, MAX_POINTS); } catch (e) { throw rejected('track', 'Der Track ist beschädigt.'); }
    const pts = tr.pts, n = pts.length;
    if (n < MIN_POINTS) throw rejected('short', 'Zu kurz: mindestens ' + MIN_POINTS + ' Punkte.');
    const start = pts[0].t, end = pts[n - 1].t, dur = end - start;
    if (dur < MIN_DUR_MS) throw rejected('short', 'Zu kurz: mindestens 2 Minuten.');
    if (end > now + 300000 || start < now - MAX_AGE_MS) throw rejected('time', 'Die Zeitstempel liegen in der Zukunft oder zu weit zurück.');
    for (const p of pts) if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) throw rejected('coords', 'Ungültige Koordinaten.');
    if (tr.hasEle) for (const p of pts) if (p.ele < -500 || p.ele > 9000) throw rejected('elevation', 'Ungültige Höhen.');

    const ins = inspect(pts);
    if (ins.bad) throw rejected('time_order', 'Die Zeitstempel laufen nicht vorwärts.');
    if (ins.dist < MIN_DIST_M) throw rejected('short', 'Zu kurz: mindestens 500 m.');
    if (ins.maxV > MAX_JUMP_SPEED) throw rejected('jump', 'Der Track enthält GPS-Sprünge (über 360 km/h).');

    const dist = Number(body.dist), moving = Number(body.moving);
    if (!(dist > 0) || !(moving > 0)) throw bad('dist/moving fehlen.');
    if (dist > ins.dist * 1.05 + 50 || dist < ins.dist * 0.6) throw rejected('dist_mismatch', 'Die Strecke passt nicht zum Track.');
    if (moving > dur + 1000) throw rejected('moving_mismatch', 'Die Fahrzeit passt nicht zum Track.');
    if (dist / (moving / 1000) > MAX_AVG_SPEED) throw rejected('too_fast', 'Schnitt über 72 km/h – das ist keine Radfahrt.');

    const day = String(body.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Math.abs(dayNum(day) - start) > 2 * 86400000) throw bad('Datum passt nicht zur Startzeit.');

    // the same ride from the app and a GPX import must not count twice
    const near = await qa(env.DB, 'SELECT start_ts, end_ts FROM rides WHERE account_id = ? AND start_ts < ? AND end_ts > ? LIMIT 8', a, end, start);
    for (const o of near) {
        const overlap = Math.min(end, o.end_ts) - Math.max(start, o.start_ts);
        if (overlap > 0.5 * Math.min(dur, o.end_ts - o.start_ts)) throw new HttpError(409, 'Zu dieser Zeit gibt es schon eine Fahrt.', { reason: 'overlap' });
    }
    const today = await q1(env.DB, 'SELECT COUNT(*) n FROM rides WHERE account_id = ? AND created_at > ?', a, now - 86400000);
    if (today.n >= MAX_PER_DAY) throw new HttpError(429, 'Zu viele Uploads heute.');

    const ride = { dist, moving, dur };
    const { rows, dropped } = cleanValues(body.values, ride);
    let tiles = null, tileIds = [];
    if (typeof body.tiles === 'string' && body.tiles) {
        try { tileIds = Codec.unpackTiles(Codec.fromB64(body.tiles), 5000); tiles = body.tiles; } catch (e) { tileIds = []; tiles = null; }
    }

    const ops = [
        stmt(env.DB, `INSERT INTO rides(id, account_id, name, src, start_ts, end_ts, day, dist_m, moving_ms, n_points, algo, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, a, cleanText(body.name, 60) || 'Fahrt', src, start, end, day, dist, moving, n, Number(body.algo) || 1, now),
        stmt(env.DB, 'INSERT INTO tracks(ride_id, fmt, data, tiles) VALUES (?,?,?,?)', id, 1, body.track, tiles),
        stmt(env.DB, `INSERT INTO ride_values(ride_id, cat, v, account_id, start_ts, day)
                      SELECT ?, json_extract(value,'$.c'), json_extract(value,'$.v'), ?, ?, ? FROM json_each(?)`,
            id, a, start, day, JSON.stringify(rows))
    ];
    if (tileIds.length) {
        ops.push(stmt(env.DB, `INSERT INTO account_tiles(account_id, tile, first_ts) SELECT ?, value, ? FROM json_each(?) WHERE true
                               ON CONFLICT(account_id, tile) DO UPDATE SET first_ts = MIN(first_ts, excluded.first_ts)`,
            a, start, JSON.stringify(tileIds)));
    }
    await env.DB.batch(ops);
    return { ok: true, id, dropped, values: rows.length };
}

export async function listRides(env, auth) {
    const rows = await qa(env.DB,
        `SELECT id, name, src, start_ts, end_ts, day, dist_m, moving_ms, n_points, algo FROM rides
          WHERE account_id = ? ORDER BY start_ts DESC LIMIT 500`, auth.account.id);
    const sh = await qa(env.DB, `SELECT s.ride_id, s.league_id FROM ride_shares s JOIN rides r ON r.id = s.ride_id WHERE r.account_id = ?`, auth.account.id);
    const shared = {};
    sh.forEach(s => { (shared[s.ride_id] = shared[s.ride_id] || []).push(s.league_id); });
    return { rides: rows.map(r => ({ ...r, shared: shared[r.id] || [] })) };
}

async function ownRide(env, auth, id) {
    const r = await q1(env.DB, 'SELECT id, account_id, start_ts, n_points, dist_m, moving_ms, end_ts FROM rides WHERE id = ?', id);
    if (!r || r.account_id !== auth.account.id) throw missing('Fahrt nicht gefunden.');
    return r;
}

export async function rideTrack(env, auth, id) {
    await ownRide(env, auth, id);
    const t = await q1(env.DB, 'SELECT fmt, data FROM tracks WHERE ride_id = ?', id);
    if (!t) throw missing();
    return { fmt: t.fmt, track: t.data };
}

/* After an algorithm update: replace the values of a ride */
export async function putValues(env, auth, id, body) {
    const r = await ownRide(env, auth, id);
    const ride = { dist: r.dist_m, moving: r.moving_ms, dur: r.end_ts - r.start_ts };
    const { rows, dropped } = cleanValues(body.values, ride);
    const day = (await q1(env.DB, 'SELECT day FROM rides WHERE id = ?', id)).day;
    await env.DB.batch([
        stmt(env.DB, 'DELETE FROM ride_values WHERE ride_id = ?', id),
        stmt(env.DB, `INSERT INTO ride_values(ride_id, cat, v, account_id, start_ts, day)
                      SELECT ?, json_extract(value,'$.c'), json_extract(value,'$.v'), ?, ?, ? FROM json_each(?)`,
            id, auth.account.id, r.start_ts, day, JSON.stringify(rows)),
        stmt(env.DB, 'UPDATE rides SET algo = ? WHERE id = ?', Number(body.algo) || 1, id)
    ]);
    return { ok: true, dropped };
}

/* Rebuild the account's tiles from the remaining rides (after deleting a ride) */
async function rebuildTiles(env, accountId) {
    const rows = await qa(env.DB, `SELECT r.start_ts s, t.tiles FROM rides r JOIN tracks t ON t.ride_id = r.id WHERE r.account_id = ? AND t.tiles IS NOT NULL`, accountId);
    const first = new Map();
    for (const r of rows) {
        let ids; try { ids = Codec.unpackTiles(Codec.fromB64(r.tiles), 5000); } catch (e) { continue; }
        for (const t of ids) if (!first.has(t) || first.get(t) > r.s) first.set(t, r.s);
    }
    const ops = [stmt(env.DB, 'DELETE FROM account_tiles WHERE account_id = ?', accountId)];
    const all = [...first];
    for (let i = 0; i < all.length; i += 1500) {
        ops.push(stmt(env.DB, `INSERT INTO account_tiles(account_id, tile, first_ts)
                               SELECT ?, json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)`,
            accountId, JSON.stringify(all.slice(i, i + 1500))));
    }
    await env.DB.batch(ops);
}

export async function deleteRide(env, auth, id) {
    await ownRide(env, auth, id);
    await run(env.DB, 'DELETE FROM rides WHERE id = ?', id);
    await rebuildTiles(env, auth.account.id);
    return { ok: true };
}

/* ---- Sharing: trimmed copy for the members of a league ---- */
export async function shareRide(env, auth, id, body) {
    const r = await ownRide(env, auth, id);
    const league = String(body.league || '');
    const mem = await q1(env.DB, 'SELECT 1 x FROM memberships WHERE league_id = ? AND account_id = ?', league, auth.account.id);
    if (!mem) throw denied('Du bist in dieser Liga nicht Mitglied.');
    if (typeof body.track !== 'string' || body.track.length > MAX_BODY) throw rejected('size', 'Der Track ist zu groß.');
    let tr;
    try { tr = await Codec.decode(body.track, r.n_points); } catch (e) { throw rejected('track', 'Der Track ist beschädigt.'); }
    if (tr.n < 10) throw rejected('short', 'Nach dem Kürzen bleibt zu wenig übrig.');
    if (tr.pts[0].t < r.start_ts - 1000 || tr.pts[tr.n - 1].t > r.end_ts + 1000) throw rejected('range', 'Die Kopie liegt außerhalb der Fahrt.');
    const trim = Math.max(0, Math.min(2000, Number(body.trim) || 0));
    await env.DB.batch([
        stmt(env.DB, 'INSERT OR REPLACE INTO shared_tracks(ride_id, fmt, trim_m, data) VALUES (?,?,?,?)', id, 1, trim, body.track),
        stmt(env.DB, 'INSERT OR IGNORE INTO ride_shares(ride_id, league_id, shared_at) VALUES (?,?,?)', id, league, Date.now())
    ]);
    return { ok: true };
}

export async function unshareRide(env, auth, id, league) {
    await ownRide(env, auth, id);
    await run(env.DB, 'DELETE FROM ride_shares WHERE ride_id = ? AND league_id = ?', id, league);
    const left = await q1(env.DB, 'SELECT COUNT(*) n FROM ride_shares WHERE ride_id = ?', id);
    if (!left.n) await run(env.DB, 'DELETE FROM shared_tracks WHERE ride_id = ?', id);
    return { ok: true };
}

export async function listShared(env, league) {
    const rows = await qa(env.DB,
        `SELECT r.id, r.name, r.start_ts, r.end_ts, r.dist_m, r.moving_ms, s.shared_at, a.id owner, a.name owner_name, a.emoji, a.color, t.trim_m
           FROM ride_shares s JOIN rides r ON r.id = s.ride_id JOIN accounts a ON a.id = r.account_id JOIN shared_tracks t ON t.ride_id = r.id
          WHERE s.league_id = ? ORDER BY s.shared_at DESC LIMIT 100`, league);
    return { rides: rows };
}

export async function sharedTrack(env, league, id) {
    const r = await q1(env.DB,
        `SELECT t.data, t.trim_m FROM ride_shares s JOIN shared_tracks t ON t.ride_id = s.ride_id WHERE s.league_id = ? AND s.ride_id = ?`, league, id);
    if (!r) throw missing('Nicht geteilt.');
    return { track: r.data, trim: r.trim_m };
}
