/* mail.js -- send the login code by e-mail
 *
 * Three modes, in this order:
 *   DEV_MAIL=1      Local only (.dev.vars): the code is in the response. NEVER set in production.
 *   RESEND_API_KEY  Sending via resend.com (secret, not in the repo). MAIL_FROM = sender.
 *   otherwise       503 -- without sending there is no login.
 */
import { HttpError } from './util.js';

/* The mail is written in the language the app is set to ("de" or "en"). */
const TEXTS = {
    de: {
        subject: code => 'Dein Anmeldecode: ' + code,
        body: code => 'Dein Code für die Gruppenausfahrt-Liga: ' + code + '\n\n' +
                      'Er gilt 10 Minuten. Falls du ihn nicht angefordert hast, ignoriere diese Mail einfach.\n'
    },
    en: {
        subject: code => 'Your login code: ' + code,
        body: code => 'Your code for the Gruppenausfahrt league: ' + code + '\n\n' +
                      'It is valid for 10 minutes. If you did not request it, simply ignore this e-mail.\n'
    }
};

export async function sendCode(env, email, code, lang) {
    const tx = TEXTS[lang] || TEXTS.de;
    if (env.DEV_MAIL === '1') return { dev: true, code };
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
        throw new HttpError(503, 'E-Mail-Versand ist auf dem Server nicht eingerichtet.');
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [email],
            subject: tx.subject(code),
            text: tx.body(code)
        })
    });
    if (!res.ok) throw new HttpError(502, 'E-Mail konnte nicht gesendet werden.');
    return { dev: false };
}
