/* auth.js -- login
 *
 * Every request carries a signature of the device key (ECDSA P-256):
 *   X-Key  public key (raw, base64url)
 *   X-Ts   time in ms, must be within 5 min
 *   X-Sig  signature (r||s, base64url) over  METHOD \n PATH?QUERY \n TS \n SHA256(body)
 * There are no cookies and no sessions: if the key is lost (browser data
 * cleared), you log in again by e-mail code and get a new key
 * for the same account.
 */
import { bad, HttpError, q1, qa, run, stmt, sha256hex, hmacHex, b64uToBytes, randomId, safeEqual, cleanText, enc } from './util.js';
import { sendCode } from './mail.js';

const SKEW_MS = 5 * 60 * 1000;
const CODE_TTL = 10 * 60 * 1000;
const CODE_TRIES = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export async function readSigned(request, env, bodyBytes) {
    const key = request.headers.get('x-key'), ts = Number(request.headers.get('x-ts')), sig = request.headers.get('x-sig');
    if (!key || !sig || !ts) throw new HttpError(401, 'Signatur fehlt.', { code: 'no_sig' });
    if (Math.abs(Date.now() - ts) > SKEW_MS) throw new HttpError(401, 'Die Uhr deines Geräts geht falsch.', { code: 'clock' });
    let pub, sigBytes;
    try { pub = b64uToBytes(key); sigBytes = b64uToBytes(sig); } catch (e) { throw new HttpError(401, 'Signatur ungültig.', { code: 'bad_sig' }); }
    if (pub.length !== 65 || pub[0] !== 4 || sigBytes.length !== 64) throw new HttpError(401, 'Signatur ungültig.', { code: 'bad_sig' });
    const url = new URL(request.url);
    const msg = request.method + '\n' + url.pathname + url.search + '\n' + ts + '\n' + await sha256hex(bodyBytes);
    let ok = false;
    try {
        const k = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sigBytes, enc.encode(msg));
    } catch (e) { ok = false; }
    if (!ok) throw new HttpError(401, 'Signatur ungültig.', { code: 'bad_sig' });
    return key;
}

/* Verify the signature and load the account belonging to the key. */
export async function authenticate(request, env, bodyBytes, opts = {}) {
    const pubkey = await readSigned(request, env, bodyBytes);
    const row = await q1(env.DB,
        `SELECT d.pubkey, d.last_seen, a.id, a.name, a.emoji, a.color, a.deleted_at
           FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.pubkey = ?`, pubkey);
    if (!row || row.deleted_at) {
        if (opts.allowUnknown) return { pubkey, account: null };
        throw new HttpError(401, 'Dieses Gerät ist nicht angemeldet.', { code: 'unknown_key' });
    }
    const now = Date.now();
    if (!row.last_seen || now - row.last_seen > 3600000) {
        await run(env.DB, 'UPDATE devices SET last_seen = ? WHERE pubkey = ?', now, pubkey);
    }
    return { pubkey, account: { id: row.id, name: row.name, emoji: row.emoji, color: row.color } };
}

function secretOf(env) {
    if (!env.AUTH_SECRET || String(env.AUTH_SECRET).length < 16) throw new HttpError(503, 'Server nicht fertig eingerichtet (AUTH_SECRET fehlt).');
    return env.AUTH_SECRET;
}
export async function emailHash(env, email) { return hmacHex(secretOf(env), 'mail:' + email.trim().toLowerCase()); }
async function codeHash(env, emailH, pubkey, code) { return hmacHex(secretOf(env), 'code:' + emailH + ':' + pubkey + ':' + code); }

export async function startLogin(env, pubkey, body) {
    const email = cleanText(body.email, 254);
    if (!EMAIL_RE.test(email)) throw bad('Das sieht nicht nach einer E-Mail-Adresse aus.');
    const eh = await emailHash(env, email), now = Date.now();
    await run(env.DB, 'DELETE FROM login_codes WHERE expires_at < ?', now - 3600000);
    const hourly = await q1(env.DB, 'SELECT COUNT(*) n FROM login_codes WHERE email_hash = ? AND created_at > ?', eh, now - 3600000);
    if (hourly.n >= 5) throw new HttpError(429, 'Zu viele Codes angefordert. Bitte in einer Stunde erneut versuchen.');
    const daily = await q1(env.DB, 'SELECT COUNT(*) n FROM login_codes WHERE created_at > ?', now - 86400000);
    if (daily.n >= (Number(env.MAIL_DAILY_MAX) || 90)) throw new HttpError(429, 'Heute wurden zu viele Codes verschickt. Bitte morgen erneut versuchen.');

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await run(env.DB, 'INSERT INTO login_codes(email_hash, pubkey, code_hash, expires_at, created_at) VALUES (?,?,?,?,?)',
        eh, pubkey, await codeHash(env, eh, pubkey, code), now + CODE_TTL, now);
    const sent = await sendCode(env, email, code, body.lang === 'en' ? 'en' : 'de');
    // The answer does not reveal whether an account already exists for the address.
    return sent.dev ? { ok: true, devCode: sent.code } : { ok: true };
}

export async function verifyLogin(env, pubkey, body) {
    const email = cleanText(body.email, 254), code = cleanText(body.code, 6);
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) throw bad('Bitte den 6-stelligen Code eingeben.');
    const eh = await emailHash(env, email), now = Date.now();
    const row = await q1(env.DB,
        'SELECT id, code_hash, attempts FROM login_codes WHERE email_hash = ? AND pubkey = ? AND expires_at > ? ORDER BY id DESC LIMIT 1',
        eh, pubkey, now);
    if (!row) throw new HttpError(400, 'Der Code ist abgelaufen. Bitte einen neuen anfordern.', { code: 'expired' });
    if (row.attempts >= CODE_TRIES) throw new HttpError(429, 'Zu viele Fehlversuche. Bitte einen neuen Code anfordern.');
    const good = safeEqual(row.code_hash, await codeHash(env, eh, pubkey, code));
    if (!good) {
        await run(env.DB, 'UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
        throw new HttpError(400, 'Der Code stimmt nicht.', { code: 'wrong' });
    }
    await run(env.DB, 'DELETE FROM login_codes WHERE email_hash = ?', eh);

    let acc = await q1(env.DB, 'SELECT id, name, emoji, color, deleted_at FROM accounts WHERE email_hash = ?', eh);
    if (acc && acc.deleted_at) acc = null;
    let created = false;
    if (!acc) {
        const id = randomId(12);
        const name = cleanText(body.name, 14) || 'Fahrer';
        const emoji = Number.isInteger(body.emoji) && body.emoji >= 0 && body.emoji < 64 ? body.emoji : null;
        const color = /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null;
        await run(env.DB, 'INSERT INTO accounts(id, name, emoji, color, email_hash, created_at) VALUES (?,?,?,?,?,?)', id, name, emoji, color, eh, now);
        acc = { id, name, emoji, color };
        created = true;
    }
    // A key belongs to exactly one account. If it already exists elsewhere, it is moved over.
    await run(env.DB, `INSERT INTO devices(pubkey, account_id, label, created_at, last_seen) VALUES (?,?,?,?,?)
                       ON CONFLICT(pubkey) DO UPDATE SET account_id = excluded.account_id, last_seen = excluded.last_seen`,
        pubkey, acc.id, cleanText(body.label, 40) || null, now, now);
    return { ok: true, created, account: { id: acc.id, name: acc.name, emoji: acc.emoji, color: acc.color } };
}

/* ---- Account ---- */
export async function myAccount(env, auth) {
    const devices = await qa(env.DB, 'SELECT pubkey, label, created_at, last_seen FROM devices WHERE account_id = ? ORDER BY created_at', auth.account.id);
    return {
        account: auth.account,
        devices: devices.map(d => ({ id: d.pubkey.slice(0, 16), label: d.label, created_at: d.created_at, last_seen: d.last_seen, current: d.pubkey === auth.pubkey }))
    };
}

export async function updateAccount(env, auth, body) {
    const name = body.name === undefined ? auth.account.name : (cleanText(body.name, 14) || auth.account.name);
    const emoji = body.emoji === undefined ? auth.account.emoji : (Number.isInteger(body.emoji) && body.emoji >= 0 && body.emoji < 64 ? body.emoji : null);
    const color = body.color === undefined ? auth.account.color : (/^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null);
    await run(env.DB, 'UPDATE accounts SET name = ?, emoji = ?, color = ? WHERE id = ?', name, emoji, color, auth.account.id);
    return { ok: true, account: { id: auth.account.id, name, emoji, color } };
}

export async function removeDevice(env, auth, shortId) {
    const rows = await qa(env.DB, 'SELECT pubkey FROM devices WHERE account_id = ?', auth.account.id);
    const hit = rows.filter(r => r.pubkey.slice(0, 16) === shortId && r.pubkey !== auth.pubkey);
    if (!hit.length) throw new HttpError(404, 'Gerät nicht gefunden (das aktuelle Gerät lässt sich hier nicht abmelden).');
    await run(env.DB, 'DELETE FROM devices WHERE pubkey = ?', hit[0].pubkey);
    return { ok: true };
}

/* Delete the account with everything. Leagues he administers go to the longest-standing member;
   if he is alone, the league is deleted. */
export async function deleteAccount(env, auth) {
    const id = auth.account.id;
    const owned = await qa(env.DB, 'SELECT id FROM leagues WHERE admin_id = ?', id);
    const ops = [];
    for (const l of owned) {
        const next = await q1(env.DB, 'SELECT account_id FROM memberships WHERE league_id = ? AND account_id <> ? ORDER BY joined_at LIMIT 1', l.id, id);
        ops.push(next ? stmt(env.DB, 'UPDATE leagues SET admin_id = ? WHERE id = ?', next.account_id, l.id)
                      : stmt(env.DB, 'DELETE FROM leagues WHERE id = ?', l.id));
    }
    // Segments he created remain with the league
    ops.push(stmt(env.DB, 'UPDATE league_segments SET created_by = (SELECT admin_id FROM leagues WHERE id = league_segments.league_id) WHERE created_by = ?', id));
    ops.push(stmt(env.DB, 'DELETE FROM accounts WHERE id = ?', id));
    await env.DB.batch(ops);
    return { ok: true };
}
