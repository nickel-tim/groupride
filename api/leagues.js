/* leagues.js -- leagues: create, join, configure, rankings, hall of fame, segments */
import Codec from '../js/liga-codec.js';
import Cats from '../js/liga-cats.js';
import { bad, denied, missing, rejected, HttpError, q1, qa, run, stmt, cleanText, parseJson, randomId, sha256hex, safeEqual } from './util.js';
import { periodAt, periodByIndex, validTz, frozenAfter } from './periods.js';
import * as B from './boards.js';

const MAX_MEMBERS = 50, MAX_LEAGUES_OWNED = 20, MAX_LEAGUES_JOINED = 30, MAX_SEGMENTS = 30;
const UNITS = ['once', 'day', 'week', 'month', 'year'];

/* ---- Check settings ---- */
function cleanCats(list) {
    if (!Array.isArray(list)) throw bad('Kategorien fehlen.');
    const out = [...new Set(list.map(String))].filter(k => Cats.valid(k));
    if (!out.length) throw bad('Mindestens eine Kategorie wählen.');
    if (out.length > 40) throw bad('Zu viele Kategorien.');
    return out;
}
function cleanGoals(list, teamOnly) {
    if (!Array.isArray(list)) throw bad('Ziele ungültig.');
    const out = [];
    for (const g of list.slice(0, 12)) {
        const c = Cats.get(String(g.cat || ''));
        const target = Number(g.target);
        if (!c || !(target > 0) || !Number.isFinite(target)) throw bad('Ziel ungültig.');
        if (teamOnly && !c.team) throw bad('„' + c.label + '“ lässt sich nicht als Team-Ziel summieren.');
        out.push({ cat: c.key, target });
    }
    return out;
}

function readSettings(body, base) {
    const s = { ...base };
    if (body.name !== undefined) { s.name = cleanText(body.name, 40); if (!s.name) throw bad('Die Liga braucht einen Namen.'); }
    if (body.tz !== undefined) { if (!validTz(String(body.tz))) throw bad('Zeitzone unbekannt.'); s.tz = String(body.tz); }
    if (body.unit !== undefined) {
        if (!UNITS.includes(body.unit)) throw bad('Zeitraum unbekannt.');
        s.unit = body.unit;
    }
    if (body.every !== undefined) { const e = Number(body.every); if (!Number.isInteger(e) || e < 1 || e > 366) throw bad('Anzahl ungültig.'); s.every = e; }
    if (body.start_ts !== undefined) { const t = Number(body.start_ts); if (!Number.isFinite(t) || t < 0) throw bad('Start ungültig.'); s.start_ts = t; }
    if (body.end_ts !== undefined) s.end_ts = body.end_ts === null ? null : Number(body.end_ts);
    if (s.unit === 'once') {
        if (!(s.end_ts > s.start_ts)) throw bad('Das Ende muss nach dem Start liegen.');
        if (s.end_ts - s.start_ts > 5 * 366 * 86400000) throw bad('Höchstens 5 Jahre.');
    } else s.end_ts = null;
    if (body.cats !== undefined) s.cats = JSON.stringify(cleanCats(body.cats));
    if (body.scoring !== undefined) s.scoring = body.scoring ? 1 : 0;
    if (body.no_points !== undefined) {
        if (!Array.isArray(body.no_points)) throw bad('Liste ungültig.');
        s.no_points = JSON.stringify([...new Set(body.no_points.map(String))].filter(k => Cats.valid(k)));
    }
    if (body.goals !== undefined) s.goals = JSON.stringify(cleanGoals(body.goals, true));
    if (body.grace_h !== undefined) { const g = Number(body.grace_h); if (!Number.isInteger(g) || g < 0 || g > 168) throw bad('Nachfrist ungültig.'); s.grace_h = g; }
    return s;
}

async function loadLeague(env, id) {
    const l = await q1(env.DB, 'SELECT * FROM leagues WHERE id = ?', String(id || ''));
    if (!l) throw missing('Liga nicht gefunden.');
    return l;
}
/* Member? Otherwise 404 (does not reveal whether the league exists) */
async function memberOf(env, auth, id) {
    const l = await q1(env.DB, `SELECT l.* FROM leagues l JOIN memberships m ON m.league_id = l.id WHERE l.id = ? AND m.account_id = ?`, String(id || ''), auth.account.id);
    if (!l) throw missing('Liga nicht gefunden.');
    return l;
}
async function adminOf(env, auth, id) {
    const l = await memberOf(env, auth, id);
    if (l.admin_id !== auth.account.id) throw denied('Das darf nur der Ersteller der Liga.');
    return l;
}

function publicLeague(l, me) {
    return {
        id: l.id, name: l.name, tz: l.tz, unit: l.unit, every: l.every, start_ts: l.start_ts, end_ts: l.end_ts,
        cats: parseJson(l.cats, []), scoring: !!l.scoring, no_points: parseJson(l.no_points, []), goals: parseJson(l.goals, []),
        grace_h: l.grace_h, admin: l.admin_id, isAdmin: l.admin_id === me
    };
}

/* ---- create / join ---- */
export async function createLeague(env, auth, body) {
    const owned = await q1(env.DB, 'SELECT COUNT(*) n FROM leagues WHERE admin_id = ?', auth.account.id);
    if (owned.n >= MAX_LEAGUES_OWNED) throw new HttpError(429, 'Du verwaltest schon zu viele Ligen.');
    const base = { name: '', tz: 'Europe/Berlin', unit: 'month', every: 1, start_ts: Date.now(), end_ts: null,
        cats: JSON.stringify(Cats.DEFAULT_ON), scoring: 1, no_points: '[]', goals: '[]', grace_h: 48 };
    const s = readSettings(body, base);
    if (!s.name) throw bad('Die Liga braucht einen Namen.');
    const id = randomId(9), secret = randomId(12), now = Date.now();
    await env.DB.batch([
        stmt(env.DB, `INSERT INTO leagues(id, name, admin_id, invite_hash, tz, unit, every, start_ts, end_ts, cats, scoring, no_points, goals, grace_h, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, s.name, auth.account.id, await sha256hex(secret), s.tz, s.unit, s.every, s.start_ts, s.end_ts, s.cats, s.scoring, s.no_points, s.goals, s.grace_h, now),
        stmt(env.DB, 'INSERT INTO memberships(league_id, account_id, joined_at) VALUES (?,?,?)', id, auth.account.id, now)
    ]);
    return { ok: true, id, invite: id + '.' + secret };
}

export async function joinLeague(env, auth, body) {
    const id = String(body.id || ''), secret = String(body.secret || '');
    const l = await q1(env.DB, 'SELECT * FROM leagues WHERE id = ? AND closed_at IS NULL', id);
    if (!l || !safeEqual(l.invite_hash, await sha256hex(secret))) throw denied('Die Einladung ist ungültig oder abgelaufen.');
    const already = await q1(env.DB, 'SELECT 1 x FROM memberships WHERE league_id = ? AND account_id = ?', id, auth.account.id);
    if (!already) {
        const n = await q1(env.DB, 'SELECT COUNT(*) n FROM memberships WHERE league_id = ?', id);
        if (n.n >= MAX_MEMBERS) throw new HttpError(409, 'Die Liga ist voll.');
        const mine = await q1(env.DB, 'SELECT COUNT(*) n FROM memberships WHERE account_id = ?', auth.account.id);
        if (mine.n >= MAX_LEAGUES_JOINED) throw new HttpError(409, 'Du bist schon in zu vielen Ligen.');
        await run(env.DB, 'INSERT INTO memberships(league_id, account_id, joined_at) VALUES (?,?,?)', id, auth.account.id, Date.now());
    }
    return { ok: true, id, name: l.name, already: !!already };
}

export async function myLeagues(env, auth) {
    const rows = await qa(env.DB, `SELECT l.* FROM leagues l JOIN memberships m ON m.league_id = l.id WHERE m.account_id = ? ORDER BY l.created_at`, auth.account.id);
    return { leagues: rows.map(l => ({ ...publicLeague(l, auth.account.id), period: periodAt(l, Date.now()) })) };
}

/* ---- Settings ---- */
export async function patchLeague(env, auth, id, body) {
    const l = await adminOf(env, auth, id);
    const timeChange = ['unit', 'every', 'start_ts', 'end_ts', 'tz'].some(k => body[k] !== undefined && String(body[k]) !== String(l[k]));
    if (timeChange) {
        const frozen = await q1(env.DB, 'SELECT COUNT(*) n FROM league_periods WHERE league_id = ?', id);
        if (frozen.n) throw new HttpError(409, 'Der Zeitraum lässt sich nach dem ersten Abschluss nicht mehr ändern.');
    }
    const s = readSettings(body, l);
    let invite;
    const ops = [stmt(env.DB, `UPDATE leagues SET name=?, tz=?, unit=?, every=?, start_ts=?, end_ts=?, cats=?, scoring=?, no_points=?, goals=?, grace_h=? WHERE id=?`,
        s.name, s.tz, s.unit, s.every, s.start_ts, s.end_ts, s.cats, s.scoring, s.no_points, s.goals, s.grace_h, id)];
    if (body.rotateInvite) {
        const secret = randomId(12); invite = id + '.' + secret;
        ops.push(stmt(env.DB, 'UPDATE leagues SET invite_hash = ? WHERE id = ?', await sha256hex(secret), id));
    }
    await env.DB.batch(ops);
    return { ok: true, invite };
}

export async function setMyGoals(env, auth, id, body) {
    await memberOf(env, auth, id);
    const goals = cleanGoals(body.goals || [], false);
    await run(env.DB, 'UPDATE memberships SET goals = ? WHERE league_id = ? AND account_id = ?', JSON.stringify(goals), id, auth.account.id);
    return { ok: true, goals };
}

export async function removeMember(env, auth, id, accountId) {
    const l = await memberOf(env, auth, id);
    const self = accountId === auth.account.id;
    if (!self && l.admin_id !== auth.account.id) throw denied('Nur der Ersteller kann Mitglieder entfernen.');
    if (self && l.admin_id === auth.account.id) {
        const next = await q1(env.DB, 'SELECT account_id FROM memberships WHERE league_id = ? AND account_id <> ? ORDER BY joined_at LIMIT 1', id, accountId);
        if (!next) { await run(env.DB, 'DELETE FROM leagues WHERE id = ?', id); return { ok: true, deleted: true }; }
        await run(env.DB, 'UPDATE leagues SET admin_id = ? WHERE id = ?', next.account_id, id);
    }
    await env.DB.batch([
        stmt(env.DB, 'DELETE FROM memberships WHERE league_id = ? AND account_id = ?', id, accountId),
        stmt(env.DB, 'DELETE FROM ride_shares WHERE league_id = ? AND ride_id IN (SELECT id FROM rides WHERE account_id = ?)', id, accountId),
        stmt(env.DB, 'DELETE FROM segment_efforts WHERE account_id = ? AND segment_id IN (SELECT id FROM league_segments WHERE league_id = ?)', accountId, id)
    ]);
    return { ok: true };
}

export async function deleteLeague(env, auth, id) {
    await adminOf(env, auth, id);
    await run(env.DB, 'DELETE FROM leagues WHERE id = ?', id);
    return { ok: true };
}

/* ---- Views ---- */
function pickPeriod(league, now, startParam) {
    if (startParam) {
        const per = periodAt(league, Number(startParam));
        if (!per) throw bad('Diesen Zeitraum gibt es nicht.');
        return per;
    }
    // The period in which "now" lies. Before the start the first one, after the end of a one-off league the only one.
    return periodAt(league, now) || periodByIndex(league, 0);
}

function periodInfo(league, per, now, frozen) {
    const prev = per.index > 0 ? periodByIndex(league, per.index - 1) : null;
    const next = league.unit === 'once' ? null : periodByIndex(league, per.index + 1);
    return {
        start: per.start, end: per.end, index: per.index, frozen,
        open: now >= per.start && now < per.end, upcoming: now < per.start,
        finalAt: frozenAfter(per, league),
        prev: prev ? prev.start : null, next: next && next.start <= now ? next.start : null
    };
}

export async function leagueOverview(env, auth, id, url) {
    const league = await memberOf(env, auth, id), now = Date.now();
    await B.ensureFrozen(env.DB, league, now);
    const per = pickPeriod(league, now, url.searchParams.get('p'));
    const mem = await B.members(env.DB, id);
    const frozen = await B.isFrozen(env.DB, id, per.start);
    let data;
    if (frozen) {
        data = await B.frozenBoard(env.DB, league, per.start);
        data.goals = { team: [], personal: [] };
    } else data = await B.overview(env.DB, league, mem, per);
    return {
        league: publicLeague(league, auth.account.id),
        members: mem.map(m => ({ id: m.id, name: m.name, emoji: m.emoji, color: m.color, me: m.id === auth.account.id })),
        period: periodInfo(league, per, now, frozen),
        ...data
    };
}

export async function leagueStanding(env, auth, id, url) {
    const league = await memberOf(env, auth, id), now = Date.now();
    const cat = String(url.searchParams.get('cat') || 'dist');
    const per = periodAt(league, now);
    if (!per) return { period: null, standing: null };
    const mem = await B.members(env.DB, id);
    let rows;
    if (cat === '_total') rows = (await B.overview(env.DB, league, mem, per)).total || [];
    else {
        if (!Cats.valid(cat)) throw bad('Kategorie unbekannt.');
        const v = await B.computeAll(env.DB, league, [cat], per.start, per.end);
        rows = B.rankRows(mem, v[cat], Cats.smaller(Cats.get(cat)));
    }
    return { period: { start: per.start, end: per.end }, cat, standing: B.standing(rows, auth.account.id) };
}

export async function leagueHall(env, auth, id) {
    const league = await memberOf(env, auth, id);
    await B.ensureFrozen(env.DB, league, Date.now());
    return B.hall(env.DB, league);
}

/* ---- Segments ---- */
export async function createSegment(env, auth, id, body) {
    const league = await memberOf(env, auth, id);
    const n = await q1(env.DB, 'SELECT COUNT(*) n FROM league_segments WHERE league_id = ?', id);
    if (n.n >= MAX_SEGMENTS) throw new HttpError(409, 'Die Liga hat schon ' + MAX_SEGMENTS + ' Segmente.');
    const name = cleanText(body.name, 40), kind = ['climb', 'sprint', 'other'].includes(body.kind) ? body.kind : 'climb';
    if (!name) throw bad('Das Segment braucht einen Namen.');
    let tr;
    try { tr = await Codec.decode(String(body.poly || ''), 2000); } catch (e) { throw rejected('poly', 'Segment-Linie beschädigt.'); }
    if (tr.n < 2) throw rejected('poly', 'Segment zu kurz.');
    const len = Number(body.len);
    if (!(len >= 100 && len <= 60000)) throw bad('Länge muss zwischen 100 m und 60 km liegen.');
    const sid = randomId(8);
    await run(env.DB, 'INSERT INTO league_segments(id, league_id, name, kind, len_m, gain_m, poly, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        sid, league.id, name, kind, len, Number.isFinite(Number(body.gain)) ? Number(body.gain) : null, String(body.poly), auth.account.id, Date.now());
    return { ok: true, id: sid };
}

export async function listSegments(env, auth, id) {
    await memberOf(env, auth, id);
    const rows = await qa(env.DB, 'SELECT id, name, kind, len_m len, gain_m gain, poly, created_by, created_at FROM league_segments WHERE league_id = ? ORDER BY created_at', id);
    return { segments: rows };
}

export async function deleteSegment(env, auth, id, sid) {
    const league = await memberOf(env, auth, id);
    const s = await q1(env.DB, 'SELECT created_by FROM league_segments WHERE id = ? AND league_id = ?', sid, id);
    if (!s) throw missing('Segment nicht gefunden.');
    if (s.created_by !== auth.account.id && league.admin_id !== auth.account.id) throw denied('Nur Ersteller oder Admin.');
    await run(env.DB, 'DELETE FROM league_segments WHERE id = ?', sid);
    return { ok: true };
}

/* The client reports the times of its own rides on the segment. The server only checks membership. */
export async function putEfforts(env, auth, id, sid, body) {
    await memberOf(env, auth, id);
    if (!await q1(env.DB, 'SELECT 1 x FROM league_segments WHERE id = ? AND league_id = ?', sid, id)) throw missing('Segment nicht gefunden.');
    const list = (Array.isArray(body.efforts) ? body.efforts : []).slice(0, 200).map(e => ({ r: String(e.ride || ''), ms: Number(e.ms) }))
        .filter(e => e.r && e.ms >= 10000 && e.ms <= 6 * 3600000);
    if (!list.length) return { ok: true, stored: 0 };
    const rides = await qa(env.DB, `SELECT id, start_ts FROM rides WHERE account_id = ? AND id IN (SELECT json_extract(value,'$.r') FROM json_each(?))`,
        auth.account.id, JSON.stringify(list));
    const start = new Map(rides.map(r => [r.id, r.start_ts]));
    const rows = list.filter(e => start.has(e.r)).map(e => ({ r: e.r, ms: Math.round(e.ms), t: start.get(e.r) }));
    if (rows.length) {
        await run(env.DB, `INSERT OR REPLACE INTO segment_efforts(segment_id, ride_id, account_id, start_ts, ms)
                           SELECT ?, json_extract(value,'$.r'), ?, json_extract(value,'$.t'), json_extract(value,'$.ms') FROM json_each(?)`,
            sid, auth.account.id, JSON.stringify(rows));
    }
    return { ok: true, stored: rows.length };
}
