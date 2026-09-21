/* The login mail is written in the app language. No server needed:  node liga/test/mail_test.mjs */
import { sendCode } from '../../api/mail.js';

let failed = 0;
const check = (name, cond, extra) => { if (!cond) failed++; console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra))); };
const env = { RESEND_API_KEY: 'x', MAIL_FROM: 'Test <a@b.de>' };
const realFetch = globalThis.fetch;
async function send(lang) {
    let sent = null;
    globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true }; };
    await sendCode(env, 'x@y.de', '123456', lang);
    globalThis.fetch = realFetch;
    return sent;
}
let m = await send('en');
check('English mail: subject and text', m.subject === 'Your login code: 123456' && m.text.includes('valid for 10 minutes'), m);
m = await send('de');
check('German mail', m.subject === 'Dein Anmeldecode: 123456' && m.text.includes('Er gilt 10 Minuten'), m);
m = await send(undefined);
check('no language given: German', m.subject.startsWith('Dein Anmeldecode'), m);
m = await send('fr');
check('unknown language: German', m.subject.startsWith('Dein Anmeldecode'), m);
console.log('\nRESULT: ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
