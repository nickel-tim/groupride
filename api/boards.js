/* boards.js -- Ranglisten, Gesamtwertung, Einfrieren, Ruhmeshalle
 *
 * Wenige Abfragen je Anfrage (Free Plan: 50 pro Aufruf, 5 Mio. gelesene Zeilen pro Tag):
 * alle gespeicherten Kategorien kommen aus EINER Abfrage ueber ride_values.
 */
import Cats from '../js/liga-cats.js';
import { qa, q1, run, parseJson } from './util.js';
import { endedPeriods, frozenAfter, periodAt } from './periods.js';

const STREAK_MIN_M = 5000;
const DAY_MS = 86400000;
const KOM_POINTS = [3, 2, 1];

export async function members(db, leagueId) {
    return qa(db, `SELECT a.id, a.name, a.emoji, a.color, m.goals, m.joined_at
                     FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.league_id = ? ORDER BY m.joined_at`, leagueId);
}

const MEMBER = 'account_id IN (SELECT account_id FROM memberships WHERE league_id = ?)';

function dayNum(s) { const [y, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS); }

function longestRun(days) {
    const n = [...new Set(days.map(dayNum))].sort((a, b) => a - b);
    let best = 0, cur = 0, prev = null;
    for (const d of n) { cur = prev !== null && d === prev + 1 ? cur + 1 : 1; if (cur > best) best = cur; prev = d; }
    return best;
}

/* -> { key: Map(accountId -> Zahl) } fuer alle verlangten Kategorien im Zeitraum [ps, pe) */
export async function computeAll(db, league, keys, ps, pe) {
    const out = {};
    keys = [...new Set(keys)].filter(k => Cats.valid(k));
    keys.forEach(k => { out[k] = new Map(); });

    // 1) Summe / Max / Min / Tage aus ride_values in einer Abfrage
    const simple = keys.filter(k => ['sum', 'max', 'min', 'days'].includes(Cats.get(k).agg));
    if (simple.length) {
        const srcs = [...new Set(simple.map(k => Cats.srcOf(Cats.get(k))))];
        const rows = await qa(db,
            `SELECT cat, account_id a, SUM(v) s, MAX(v) mx, MIN(v) mn, COUNT(DISTINCT day) dd FROM ride_values
              WHERE cat IN (${srcs.map(() => '?').join(',')}) AND start_ts >= ? AND start_ts < ? AND ${MEMBER}
              GROUP BY cat, account_id`, ...srcs, ps, pe, league.id);
        for (const k of simple) {
            const c = Cats.get(k), src = Cats.srcOf(c), pick = { sum: 's', max: 'mx', min: 'mn', days: 'dd' }[c.agg];
            for (const r of rows) if (r.cat === src) out[k].set(r.a, r[pick]);
        }
    }

    // 2) Tageswerte: Serie und Hoehenmeter an einem Tag
    const daily = keys.filter(k => ['streak', 'dayMax'].includes(Cats.get(k).agg));
    if (daily.length) {
        const srcs = [...new Set(daily.map(k => Cats.srcOf(Cats.get(k))))];
        const rows = await qa(db,
            `SELECT cat, account_id a, day, SUM(v) s FROM ride_values
              WHERE cat IN (${srcs.map(() => '?').join(',')}) AND start_ts >= ? AND start_ts < ? AND ${MEMBER}
              GROUP BY cat, account_id, day`, ...srcs, ps, pe, league.id);
        for (const k of daily) {
            const c = Cats.get(k), src = Cats.srcOf(c), by = new Map();
            for (const r of rows) if (r.cat === src) { if (!by.has(r.a)) by.set(r.a, []); by.get(r.a).push(r); }
            for (const [a, list] of by) {
                if (c.agg === 'dayMax') out[k].set(a, Math.max(...list.map(r => r.s)));
                else { const v = longestRun(list.filter(r => r.s >= STREAK_MIN_M).map(r => r.day)); if (v) out[k].set(a, v); }
            }
        }
    }

    // 3) Entdecken
    if (out.explore) {
        const rows = await qa(db, `SELECT account_id a, COUNT(*) n FROM account_tiles WHERE first_ts >= ? AND first_ts < ? AND ${MEMBER} GROUP BY account_id`, ps, pe, league.id);
        for (const r of rows) out.explore.set(r.a, r.n);
    }

    // 4) Kletterkoenig: Punkte je Anstiegs-Segment nach Platz (3/2/1)
    if (out.kom) {
        const rows = await qa(db,
            `SELECT e.segment_id s, e.account_id a, MIN(e.ms) ms FROM segment_efforts e JOIN league_segments g ON g.id = e.segment_id
              WHERE g.league_id = ? AND g.kind = 'climb' AND e.start_ts >= ? AND e.start_ts < ?
                AND e.account_id IN (SELECT account_id FROM memberships WHERE league_id = ?)
              GROUP BY e.segment_id, e.account_id`, league.id, ps, pe, league.id);
        const bySeg = new Map();
        for (const r of rows) { if (!bySeg.has(r.s)) bySeg.set(r.s, []); bySeg.get(r.s).push(r); }
        for (const list of bySeg.values()) {
            for (const r of list) {
                const rank = 1 + list.filter(o => o.ms < r.ms).length, pts = KOM_POINTS[rank - 1] || 0;
                if (pts) out.kom.set(r.a, (out.kom.get(r.a) || 0) + pts);
            }
        }
    }

    // 5) einzelne Segmente
    for (const k of keys.filter(k => Cats.get(k).agg === 'seg')) {
        const id = k.slice(4);
        const rows = await qa(db,
            `SELECT e.account_id a, MIN(e.ms) v FROM segment_efforts e JOIN league_segments g ON g.id = e.segment_id
              WHERE e.segment_id = ? AND g.league_id = ? AND e.start_ts >= ? AND e.start_ts < ? AND ${MEMBER.replace('account_id', 'e.account_id')}
              GROUP BY e.account_id`, id, league.id, ps, pe, league.id);
        for (const r of rows) out[k].set(r.a, r.v);
    }
    return out;
}

/* Platz vergeben (Gleichstand = gleicher Platz). smaller: kleiner ist besser. */
export function rankRows(mem, values, smaller) {
    const have = [], none = [];
    for (const m of mem) {
        const v = values.get(m.id);
        (v === undefined || v === null ? none : have).push({ id: m.id, name: m.name, emoji: m.emoji, color: m.color, v });
    }
    have.sort((a, b) => smaller ? a.v - b.v : b.v - a.v);
    have.forEach((r, i) => { r.rank = i && have[i - 1].v === r.v ? have[i - 1].rank : i + 1; });
    none.forEach(r => { r.v = null; r.rank = null; });
    return have.concat(none);
}

/* Gesamtwertung: je Kategorie (Anzahl Mitglieder - Platz + 1) Punkte */
export function totalRows(mem, boards, league) {
    const off = new Set(parseJson(league.no_points, []));
    const pts = new Map(mem.map(m => [m.id, 0]));
    const n = mem.length;
    for (const [key, rows] of Object.entries(boards)) {
        if (off.has(key)) continue;
        for (const r of rows) if (r.rank !== null) pts.set(r.id, pts.get(r.id) + (n - r.rank + 1));
    }
    const values = new Map([...pts].filter(([, v]) => v > 0));
    const rows = rankRows(mem, values, false);
    rows.forEach(r => { r.points = r.v; });
    return rows;
}

export function goalProgress(league, mem, values) {
    const sum = key => { let s = 0; for (const v of (values[key] || new Map()).values()) s += v; return s; };
    const team = parseJson(league.goals, []).filter(g => Cats.get(g.cat) && Cats.get(g.cat).team)
        .map(g => ({ cat: g.cat, target: g.target, progress: sum(g.cat) }));
    const personal = mem.map(m => ({
        id: m.id,
        goals: parseJson(m.goals, []).filter(g => Cats.valid(g.cat))
            .map(g => ({ cat: g.cat, target: g.target, progress: (values[g.cat] && values[g.cat].get(m.id)) || 0 }))
    })).filter(p => p.goals.length);
    return { team, personal };
}

export function goalCats(league, mem) {
    const s = new Set(parseJson(league.goals, []).map(g => g.cat));
    mem.forEach(m => parseJson(m.goals, []).forEach(g => s.add(g.cat)));
    return [...s].filter(k => Cats.valid(k));
}

/* Alles fuer die Hauptansicht: Ranglisten aller aktiven Kategorien, Gesamtwertung, Ziele */
export async function overview(db, league, mem, per) {
    const active = parseJson(league.cats, []).filter(k => Cats.valid(k));
    const values = await computeAll(db, league, [...active, ...goalCats(league, mem)], per.start, per.end);
    const boards = {};
    for (const k of active) boards[k] = rankRows(mem, values[k], Cats.smaller(Cats.get(k)));
    const out = { boards, goals: goalProgress(league, mem, values) };
    if (league.scoring) out.total = totalRows(mem, boards, league);
    return out;
}

/* ---- Einfrieren ---- */
export async function isFrozen(db, leagueId, start) {
    return !!(await q1(db, 'SELECT 1 x FROM league_periods WHERE league_id = ? AND period_start = ?', leagueId, start));
}

export async function freezePeriod(db, league, per) {
    const mem = await members(db, league.id);
    const ov = await overview(db, league, mem, per);
    const rows = [];
    for (const [cat, list] of Object.entries(ov.boards)) for (const r of list) if (r.rank !== null) rows.push({ c: cat, r: r.rank, a: r.id, v: r.v, p: null });
    if (ov.total) for (const r of ov.total) if (r.rank !== null) rows.push({ c: '_total', r: r.rank, a: r.id, v: r.v, p: r.points });
    await run(db, 'INSERT OR IGNORE INTO league_periods(league_id, period_start, period_end, frozen_at) VALUES (?,?,?,?)', league.id, per.start, per.end, Date.now());
    if (rows.length) {
        await run(db,
            `INSERT OR IGNORE INTO league_results(league_id, period_start, cat, rank, account_id, v, points)
             SELECT ?, ?, json_extract(value,'$.c'), json_extract(value,'$.r'), json_extract(value,'$.a'), json_extract(value,'$.v'), json_extract(value,'$.p')
               FROM json_each(?)`, league.id, per.start, JSON.stringify(rows));
    }
}

/* Friert HOECHSTENS EINEN abgelaufenen Zeitraum ein (Abfragenbudget); die naechste Anfrage den naechsten. */
export async function ensureFrozen(db, league, now) {
    const ended = endedPeriods(league, now).filter(p => now >= frozenAfter(p, league));
    if (!ended.length) return false;
    const done = new Set((await qa(db, 'SELECT period_start s FROM league_periods WHERE league_id = ?', league.id)).map(r => r.s));
    const todo = ended.filter(p => !done.has(p.start)).pop();       // aeltester zuerst
    if (!todo) return false;
    await freezePeriod(db, league, todo);
    return true;
}

export async function frozenBoard(db, league, start) {
    const rows = await qa(db,
        `SELECT r.cat, r.rank, r.account_id id, r.v, r.points, a.name, a.emoji, a.color
           FROM league_results r LEFT JOIN accounts a ON a.id = r.account_id
          WHERE r.league_id = ? AND r.period_start = ? ORDER BY r.cat, r.rank`, league.id, start);
    const boards = {}, total = [];
    for (const r of rows) {
        const row = { id: r.id, name: r.name || 'Ehemaliges Mitglied', emoji: r.emoji, color: r.color, v: r.v, rank: r.rank };
        if (r.cat === '_total') { row.points = r.points; total.push(row); }
        else (boards[r.cat] = boards[r.cat] || []).push(row);
    }
    return { boards, total: league.scoring ? total : undefined };
}

/* Ruhmeshalle: je eingefrorenem Zeitraum die Top 3, dazu Titelzaehler */
export async function hall(db, league) {
    const periods = await qa(db, 'SELECT period_start s, period_end e FROM league_periods WHERE league_id = ? ORDER BY period_start DESC LIMIT 60', league.id);
    if (!periods.length) return { periods: [], titles: [] };
    const rows = await qa(db,
        `SELECT r.period_start s, r.cat, r.rank, r.account_id id, r.v, r.points, a.name, a.emoji
           FROM league_results r LEFT JOIN accounts a ON a.id = r.account_id
          WHERE r.league_id = ? AND r.rank <= 3 ORDER BY r.period_start DESC, r.cat, r.rank`, league.id);
    const by = new Map(periods.map(p => [p.s, { start: p.s, end: p.e, cats: {}, total: [] }]));
    const titles = new Map();
    for (const r of rows) {
        const p = by.get(r.s); if (!p) continue;
        const e = { rank: r.rank, id: r.id, name: r.name || 'Ehemaliges Mitglied', emoji: r.emoji, v: r.v, points: r.points };
        if (r.cat === '_total') p.total.push(e); else (p.cats[r.cat] = p.cats[r.cat] || []).push(e);
        if (r.rank === 1) {
            const t = titles.get(r.id) || { id: r.id, name: e.name, emoji: r.emoji, total: 0, cats: 0 };
            if (r.cat === '_total') t.total++; else t.cats++;
            titles.set(r.id, t);
        }
    }
    return { periods: periods.map(p => by.get(p.s)), titles: [...titles.values()].sort((a, b) => b.total - a.total || b.cats - a.cats) };
}

/* Nachbarn fuer die Tacho-Zeile */
export function standing(rows, meId) {
    const i = rows.findIndex(r => r.id === meId);
    const me = i >= 0 ? rows[i] : null;
    const ranked = rows.filter(r => r.rank !== null);
    if (!me || me.rank === null) return { me: me ? { rank: null, v: null } : null, of: ranked.length, above: null, below: ranked.length ? pick(ranked[ranked.length - 1]) : null };
    const idx = ranked.findIndex(r => r.id === meId);
    const above = ranked.slice(0, idx).reverse().find(r => r.rank < me.rank);
    const below = ranked.slice(idx + 1).find(r => r.rank > me.rank);
    return { me: { rank: me.rank, v: me.v }, of: ranked.length, above: above ? pick(above) : null, below: below ? pick(below) : null };
}
function pick(r) { return { id: r.id, name: r.name, emoji: r.emoji, v: r.v, rank: r.rank }; }

export { periodAt };
