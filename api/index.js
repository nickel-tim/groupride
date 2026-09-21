/* index.js -- league API (Cloudflare Worker)
 *
 * Only /api/* ends up here (wrangler.jsonc: assets.run_worker_first). Everything else is served by
 * Cloudflare directly as a static file.
 */
import { HttpError, json, bad, q1 } from './util.js';
import { authenticate, readSigned, startLogin, verifyLogin, myAccount, updateAccount, removeDevice, deleteAccount } from './auth.js';
import * as R from './rides.js';
import * as L from './leagues.js';

const MAX_BODY = 512 * 1024;

/* [method, pattern, handler, { open: true }]  open = without a known account (signed only) */
const ROUTES = [
    ['GET',    /^\/api\/health$/,                                   async ({ env }) => health(env), { anon: true }],
    ['POST',   /^\/api\/auth\/start$/,                              ({ env, key, body }) => startLogin(env, key, body), { open: true }],
    ['POST',   /^\/api\/auth\/verify$/,                             ({ env, key, body }) => verifyLogin(env, key, body), { open: true }],

    ['GET',    /^\/api\/me$/,                                       ({ env, auth }) => myAccount(env, auth)],
    ['PUT',    /^\/api\/me$/,                                       ({ env, auth, body }) => updateAccount(env, auth, body)],
    ['DELETE', /^\/api\/me$/,                                       ({ env, auth, body }) => body.confirm === true ? deleteAccount(env, auth) : Promise.reject(bad('Bestätigung fehlt.'))],
    ['DELETE', /^\/api\/devices\/([\w-]{16})$/,                     ({ env, auth, m }) => removeDevice(env, auth, m[1])],

    ['POST',   /^\/api\/rides$/,                                    ({ env, auth, body }) => R.uploadRide(env, auth, body)],
    ['GET',    /^\/api\/rides$/,                                    ({ env, auth }) => R.listRides(env, auth)],
    ['GET',    /^\/api\/rides\/([\w-]{8,64})\/track$/,              ({ env, auth, m }) => R.rideTrack(env, auth, m[1])],
    ['PUT',    /^\/api\/rides\/([\w-]{8,64})\/values$/,             ({ env, auth, m, body }) => R.putValues(env, auth, m[1], body)],
    ['DELETE', /^\/api\/rides\/([\w-]{8,64})$/,                     ({ env, auth, m }) => R.deleteRide(env, auth, m[1])],
    ['POST',   /^\/api\/rides\/([\w-]{8,64})\/share$/,              ({ env, auth, m, body }) => R.shareRide(env, auth, m[1], body)],
    ['DELETE', /^\/api\/rides\/([\w-]{8,64})\/share\/([\w-]{6,40})$/, ({ env, auth, m }) => R.unshareRide(env, auth, m[1], m[2])],

    ['POST',   /^\/api\/leagues$/,                                  ({ env, auth, body }) => L.createLeague(env, auth, body)],
    ['GET',    /^\/api\/leagues$/,                                  ({ env, auth }) => L.myLeagues(env, auth)],
    ['POST',   /^\/api\/leagues\/join$/,                            ({ env, auth, body }) => L.joinLeague(env, auth, body)],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})$/,                   ({ env, auth, m, url }) => L.leagueOverview(env, auth, m[1], url)],
    ['PATCH',  /^\/api\/leagues\/([\w-]{6,40})$/,                   ({ env, auth, m, body }) => L.patchLeague(env, auth, m[1], body)],
    ['DELETE', /^\/api\/leagues\/([\w-]{6,40})$/,                   ({ env, auth, m }) => L.deleteLeague(env, auth, m[1])],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})\/standing$/,         ({ env, auth, m, url }) => L.leagueStanding(env, auth, m[1], url)],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})\/hall$/,             ({ env, auth, m }) => L.leagueHall(env, auth, m[1])],
    ['PUT',    /^\/api\/leagues\/([\w-]{6,40})\/goals$/,            ({ env, auth, m, body }) => L.setMyGoals(env, auth, m[1], body)],
    ['DELETE', /^\/api\/leagues\/([\w-]{6,40})\/members\/([\w-]{6,40})$/, ({ env, auth, m }) => L.removeMember(env, auth, m[1], m[2])],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})\/shared$/,           async ({ env, auth, m }) => { await member(env, auth, m[1]); return R.listShared(env, m[1]); }],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})\/shared\/([\w-]{8,64})\/track$/, async ({ env, auth, m }) => { await member(env, auth, m[1]); return R.sharedTrack(env, m[1], m[2]); }],
    ['POST',   /^\/api\/leagues\/([\w-]{6,40})\/segments$/,         ({ env, auth, m, body }) => L.createSegment(env, auth, m[1], body)],
    ['GET',    /^\/api\/leagues\/([\w-]{6,40})\/segments$/,         ({ env, auth, m }) => L.listSegments(env, auth, m[1])],
    ['DELETE', /^\/api\/leagues\/([\w-]{6,40})\/segments\/([\w-]{4,20})$/, ({ env, auth, m }) => L.deleteSegment(env, auth, m[1], m[2])],
    ['PUT',    /^\/api\/leagues\/([\w-]{6,40})\/segments\/([\w-]{4,20})\/efforts$/, ({ env, auth, m, body }) => L.putEfforts(env, auth, m[1], m[2], body)]
];

async function member(env, auth, leagueId) {
    const ok = await q1(env.DB, 'SELECT 1 x FROM memberships WHERE league_id = ? AND account_id = ?', leagueId, auth.account.id);
    if (!ok) throw new HttpError(404, 'Liga nicht gefunden.');
}

function health(env) {
    return {
        ok: true,
        db: !!env.DB,
        secret: !!env.AUTH_SECRET && String(env.AUTH_SECRET).length >= 16,
        mail: env.DEV_MAIL === '1' ? 'dev' : (env.RESEND_API_KEY && env.MAIL_FROM ? 'resend' : 'none')
    };
}

async function handle(request, env) {
    const url = new URL(request.url);
    const route = ROUTES.find(r => r[0] === request.method && r[1].test(url.pathname));
    if (!route) {
        if (ROUTES.some(r => r[1].test(url.pathname))) throw new HttpError(405, 'Methode nicht erlaubt.');
        throw new HttpError(404, 'Unbekannter Aufruf.');
    }
    const [, pattern, fn, opts = {}] = route;
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß.');
    let body = {};
    if (bytes.length) {
        try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw bad('Kein gültiges JSON.'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON-Objekt erwartet.');
    }
    const ctx = { env, url, request, body, m: url.pathname.match(pattern) };
    if (opts.anon) return fn(ctx);
    if (opts.open) ctx.key = await readSigned(request, env, bytes);
    else ctx.auth = await authenticate(request, env, bytes);
    return fn(ctx);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
        try {
            return json(await handle(request, env));
        } catch (e) {
            if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
            console.error('Liga-API:', e && e.stack || e);
            return json({ error: 'Interner Fehler.' }, 500);
        }
    }
};
