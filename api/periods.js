/* periods.js -- Zeitraeume einer Liga (rein rechnerisch, ohne Datenbank)
 *
 * Ein Zeitraum ist [start, end) in ms UTC. Kalendergrenzen gelten in der Zeitzone der
 * Liga (Standard Europe/Berlin), damit "Monat" auch um Mitternacht und bei Sommerzeit stimmt.
 *
 *   once           genau start_ts .. end_ts
 *   day  / every N N Tage, verankert am Starttag
 *   week / every N N Wochen, Montag 00:00
 *   month/ every N N Kalendermonate, der 1. um 00:00   (3 Monate = every 3)
 *   year / every N N Jahre, 1. Januar
 * Der Anker ist der Beginn der Einheit, in der start_ts liegt (Woche -> Montag davor,
 * Monat -> der 1., Jahr -> 1.1.). Vor dem Anker gibt es keinen Zeitraum.
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

/* { y, m (1-12), d, h, mi, s } der Wanduhr in tz */
export function localParts(ts, tz) {
    const o = {};
    for (const p of fmtFor(tz).formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

function offsetAt(ts, tz) {
    const p = localParts(ts, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/* Wanduhr (Mitternacht des Tages y-m-d, m/d duerfen ueberlaufen) -> ms UTC */
export function zonedMidnight(y, m, d, tz) {
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    let ts = guess - offsetAt(guess, tz);
    // Nach einem Sommerzeit-Wechsel kann der erste Versuch daneben liegen: einmal nachziehen
    ts = guess - offsetAt(ts, tz);
    return ts;
}

const DAY = 86400000;
function dayNumber(p) { return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY); }        // Tage seit 1970 (Wanduhr)
function fromDayNumber(n) { const d = new Date(n * DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
function weekdayMon0(n) { return ((n + 3) % 7 + 7) % 7; }                               // 1.1.1970 war Donnerstag -> 3

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

/* Zeitraum Nummer i (0 = erster). once: nur i = 0. */
export function periodByIndex(league, i) {
    if (league.unit === 'once') return i === 0 ? { index: 0, start: league.start_ts, end: league.end_ts } : null;
    if (i < 0) return null;
    const a = anchorOf(league), s = stepOf(league);
    return { index: i, start: boundary(a.kind, a.n + i * s.by, league.tz), end: boundary(a.kind, a.n + (i + 1) * s.by, league.tz) };
}

/* Der Zeitraum, in dem ts liegt, sonst null (vor dem Start, nach dem Ende einer einmaligen Liga). */
export function periodAt(league, ts) {
    if (league.unit === 'once') return ts >= league.start_ts && ts < league.end_ts ? periodByIndex(league, 0) : null;
    const a = anchorOf(league), s = stepOf(league), p = localParts(ts, league.tz);
    let cur = s.kind === 'day' ? dayNumber(p) : p.y * 12 + (p.m - 1);
    if (cur < a.n) return null;
    let i = Math.floor((cur - a.n) / s.by);
    // Wanduhr und UTC koennen an der Grenze um einen Zeitraum auseinanderliegen: pruefen und nachziehen
    let per = periodByIndex(league, i);
    while (per && ts < per.start && i > 0) per = periodByIndex(league, --i);
    while (per && ts >= per.end) per = periodByIndex(league, ++i);
    return per && ts >= per.start ? per : null;
}

/* Alle Zeitraeume, die vor `now` schon zu Ende sind (hoechstens `limit`, die neuesten zuerst). */
export function endedPeriods(league, now, limit = 36) {
    const cur = periodAt(league, now);
    let i;
    if (league.unit === 'once') return now >= league.end_ts ? [periodByIndex(league, 0)] : [];
    if (cur) i = cur.index - 1;
    else {
        // vor dem Start: nichts. Sonst laeuft die Liga noch (dann waere cur gesetzt)
        return [];
    }
    const out = [];
    for (; i >= 0 && out.length < limit; i--) out.push(periodByIndex(league, i));
    return out;
}

/* Ende der Nachfrist: erst danach wird eingefroren */
export function frozenAfter(period, league) { return period.end + league.grace_h * 3600000; }
