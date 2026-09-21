/* util.js -- kleine Helfer fuer den Liga-Worker */

export class HttpError extends Error {
    constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const denied = (msg) => new HttpError(403, msg || 'Nicht erlaubt.');
export const missing = (msg) => new HttpError(404, msg || 'Nicht gefunden.');
export const rejected = (reason, msg) => new HttpError(422, msg || reason, { reason });

export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
    });
}

export const enc = new TextEncoder();

export function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
export function bytesToB64u(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function hex(buf) {
    return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function sha256hex(data) {
    return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}
export async function hmacHex(secret, text) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export function randomId(bytes = 16) {
    return bytesToB64u(crypto.getRandomValues(new Uint8Array(bytes)));
}
/* Vergleich ohne fruehen Abbruch (gegen Zeitmessung bei Geheimnissen) */
export function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

/* ---- D1 ---- */
export const q1 = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const qa = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);

export function cleanText(s, max) {
    return String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
export function parseJson(s, fallback) {
    try { const v = JSON.parse(s); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}
