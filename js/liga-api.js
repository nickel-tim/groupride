/* ============================================================
 * liga-api.js -- Anfragen an die Liga (signiert) und Anmeldung
 * ============================================================
 * Nichts hier wird ohne Anmeldung benutzt: die Live-Gruppe kennt die Liga nicht.
 * call() wirft nie: Netzfehler und Serverfehler kommen als { status, error } zurueck,
 * damit die Oberflaeche sie anzeigen kann. status 0 = keine Verbindung.
 * ============================================================ */

var LigaApi = (function () {
    'use strict';

    var K_ACCT = 'liga:acct';
    var listeners = [];

    function read(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    var acct = read(K_ACCT);

    function base() { try { return localStorage.getItem('liga:base') || ''; } catch (e) { return ''; } }
    function changed() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
    function onChange(f) { listeners.push(f); }
    function account() { return acct; }
    function setAccount(a) { acct = a; write(K_ACCT, a); changed(); }

    function sha256hex(bytes) {
        return crypto.subtle.digest('SHA-256', bytes).then(function (b) {
            return Array.prototype.map.call(new Uint8Array(b), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
        });
    }

    /* method path body -> Promise<{status, ...json}> */
    function call(method, path, body) {
        var text = body === undefined ? '' : JSON.stringify(body), bytes = new TextEncoder().encode(text), ts = Date.now();
        return LigaId.ensure().then(function (k) {
            return sha256hex(bytes).then(function (h) {
                return LigaId.sign(method + '\n' + path + '\n' + ts + '\n' + h).then(function (sig) {
                    var headers = { 'x-key': k.pub, 'x-ts': String(ts), 'x-sig': sig };
                    if (text) headers['content-type'] = 'application/json';
                    return fetch(base() + path, { method: method, headers: headers, body: text || undefined });
                });
            });
        }).then(function (res) {
            return res.text().then(function (t) {
                var out;
                try { out = JSON.parse(t); } catch (e) { out = null; }
                if (!out) return { status: res.status, unavailable: true, error: 'Die Liga gibt es auf diesem Server nicht.' };
                out.status = res.status;
                if (res.status === 401 && (out.code === 'unknown_key' || out.code === 'bad_sig') && acct) { setAccount(null); }
                if (res.status >= 400 && !out.error) out.error = 'Fehler ' + res.status;
                return out;
            });
        }, function () { return { status: 0, offline: true, error: 'Keine Verbindung.' }; });
    }

    /* ---- Anmeldung ---- */
    function start(email) { return call('POST', '/api/auth/start', { email: email }); }
    function verify(email, code, profile) {
        var b = { email: email, code: code };
        if (profile) { b.name = profile.name; b.emoji = profile.emoji; b.color = profile.color; }
        return call('POST', '/api/auth/verify', b).then(function (r) {
            if (r.status === 200 && r.account) setAccount(r.account);
            return r;
        });
    }
    /* Dieses Geraet abmelden: Schluessel und alle lokalen Liga-Daten weg. Das Konto bleibt bestehen. */
    function logout() {
        return LigaId.reset().then(function () {
            try {
                var del = [];
                for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('liga:') === 0 && k !== 'liga:base') del.push(k); }
                del.forEach(function (k) { localStorage.removeItem(k); });
            } catch (e) {}
            setAccount(null);
        });
    }
    /* Beim Start pruefen, ob dieses Geraet noch angemeldet ist (Schluessel da, Konto bekannt) */
    function refresh() {
        return LigaId.peek().then(function (k) {
            if (!k) { if (acct) setAccount(null); return null; }
            if (!acct) return null;
            return call('GET', '/api/me').then(function (r) {
                if (r.status === 200) { setAccount(r.account); return r; }
                return r;
            });
        });
    }

    return { call: call, start: start, verify: verify, logout: logout, refresh: refresh,
             account: account, setAccount: setAccount, onChange: onChange, read: read, write: write, sha256hex: sha256hex };
})();
