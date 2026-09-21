/* mail.js -- Anmeldecode per E-Mail verschicken
 *
 * Drei Modi, in dieser Reihenfolge:
 *   DEV_MAIL=1      Nur lokal (.dev.vars): der Code steht in der Antwort. NIE in Produktion setzen.
 *   RESEND_API_KEY  Versand ueber resend.com (Geheimnis, nicht im Repo). MAIL_FROM = Absender.
 *   sonst           503 -- ohne Versand gibt es keine Anmeldung.
 */
import { HttpError } from './util.js';

export async function sendCode(env, email, code) {
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
            subject: 'Dein Anmeldecode: ' + code,
            text: 'Dein Code für die Gruppenausfahrt-Liga: ' + code + '\n\n' +
                  'Er gilt 10 Minuten. Falls du ihn nicht angefordert hast, ignoriere diese Mail einfach.\n'
        })
    });
    if (!res.ok) throw new HttpError(502, 'E-Mail konnte nicht gesendet werden.');
    return { dev: false };
}
