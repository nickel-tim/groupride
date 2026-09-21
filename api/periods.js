/* periods.js -- periods of a league (purely computational, no database)
 *
 * A period is [start, end) in ms UTC. Calendar boundaries apply in the league's
 * time zone (default Europe/Berlin), so that "month" is right at midnight and across daylight saving time too.
 *
 *   once           exactly start_ts .. end_ts
 *   day  / every N N days, anchored at the start day
 *   week / every N N weeks, Monday 00:00
 *   month/ every N N calendar months, the 1st at 00:00   (3 months = every 3)
 *   year / every N N years, 1 January
 * The anchor is the beginning of the unit in which start_ts lies (week -> the Monday before,
 * month -> the 1st, year -> 1.1.). Before the anchor there is no period.
 */

const fmtCache = {};
function fmtFor(tz) {
    return fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
}

export function validTz(tz) {
    try { fmtFor(tz).format(0); return true; } catch (e) { return false; }
}

/* { y, m (1-12), d, h, mi, s } of the wall clock in tz */
export function localParts(ts, tz) {
    const o = {};
    for (const p of fmtFor(tz).formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

function offsetAt(ts, tz) {
    const p = localParts(ts, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/* Wall clock (midnight of the day y-m-d, m/d may overflow) -> ms UTC */
export function zonedMidnight(y, m, d, tz) {
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    let ts = guess - offsetAt(guess, tz);
    // After a daylight-saving change the first attempt can be off: adjust once
    ts = guess - offsetAt(ts, tz);
    return ts;
}

const DAY = 86400000;
function dayNumber(p) { return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY); }        // days since 1970 (wall clock)
function fromDayNumber(n) { const d = new Date(n * DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
function weekdayMon0(n) { return ((n + 3) % 7 + 7) % 7; }                               // 1.1.1970 was a Thursday -> 3

function anchorOf(league) {
    const p = localParts(league.start_ts, league.tz);
    switch (league.unit) {
        case 'day':   return { kind: 'day',   n: dayNumber(p) };
        case 'week':  { const n = dayNumber(p); return { kind: 'day', n: n - weekdayMon0(n) }; }
        case 'month': return { kind: 'month', n: p.y * 12 + (p.m - 1) };
        case 'year':  return { kind: 'month', n: p.y * 12 };
    }
    return null;
}
function stepOf(league) {
    switch (league.unit) {
        case 'day': return { kind: 'day', by: league.every };
        case 'week': return { kind: 'day', by: league.every * 7 };
        case 'month': return { kind: 'month', by: league.every };
        case 'year': return { kind: 'month', by: league.every * 12 };
    }
    return null;
}
function boundary(kind, n, tz) {
    if (kind === 'day') { const c = fromDayNumber(n); return zonedMidnight(c.y, c.m, c.d, tz); }
    return zonedMidnight(Math.floor(n / 12), (n % 12) + 1, 1, tz);
}

/* Period number i (0 = first). once: only i = 0. */
export function periodByIndex(league, i) {
    if (league.unit === 'once') return i === 0 ? { index: 0, start: league.start_ts, end: league.end_ts } : null;
    if (i < 0) return null;
    const a = anchorOf(league), s = stepOf(league);
    return { index: i, start: boundary(a.kind, a.n + i * s.by, league.tz), end: boundary(a.kind, a.n + (i + 1) * s.by, league.tz) };
}

/* The period in which ts lies, otherwise null (before the start, after the end of a one-off league). */
export function periodAt(league, ts) {
    if (league.unit === 'once') return ts >= league.start_ts && ts < league.end_ts ? periodByIndex(league, 0) : null;
    const a = anchorOf(league), s = stepOf(league), p = localParts(ts, league.tz);
    let cur = s.kind === 'day' ? dayNumber(p) : p.y * 12 + (p.m - 1);
    if (cur < a.n) return null;
    let i = Math.floor((cur - a.n) / s.by);
    // Wall clock and UTC can be one period apart at the boundary: check and adjust
    let per = periodByIndex(league, i);
    while (per && ts < per.start && i > 0) per = periodByIndex(league, --i);
    while (per && ts >= per.end) per = periodByIndex(league, ++i);
    return per && ts >= per.start ? per : null;
}

/* All periods that have already ended before `now` (at most `limit`, newest first). */
export function endedPeriods(league, now, limit = 36) {
    const cur = periodAt(league, now);
    let i;
    if (league.unit === 'once') return now >= league.end_ts ? [periodByIndex(league, 0)] : [];
    if (cur) i = cur.index - 1;
    else {
        // before the start: nothing. Otherwise the league is still running (then cur would be set)
        return [];
    }
    const out = [];
    for (; i >= 0 && out.length < limit; i--) out.push(periodByIndex(league, i));
    return out;
}

/* End of the grace period: only after that is it frozen */
export function frozenAfter(period, league) { return period.end + league.grace_h * 3600000; }
