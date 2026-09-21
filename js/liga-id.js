/* ============================================================
 * liga-id.js -- Geraeteschluessel fuer die Liga
 * ============================================================
 * Ein ECDSA-P-256-Schluesselpaar pro Geraet, im Browser erzeugt. Der private Schluessel ist
 * NICHT auslesbar (extractable = false) und liegt in IndexedDB; er verlaesst das Geraet nie.
 * Jede Anfrage an die Liga wird damit signiert (siehe api/auth.js).
 *
 * Gehen die Browserdaten verloren, ist der Schluessel weg -- das Konto nicht: man meldet sich
 * per E-Mail-Code neu an und bekommt einen neuen Schluessel fuer dasselbe Konto.
 *
 * Ohne IndexedDB (privates Fenster) haelt die App den Schluessel nur bis zum Neuladen.
 * ============================================================ */

var LigaId = (function () {
    'use strict';

    var DB = 'groupride-liga', STORE = 'kv', KEY = 'device';
    var mem = null, pending = null;

    function open() {
        return new Promise(function (res, rej) {
            try {
                var r = indexedDB.open(DB, 1);
                r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
                r.onsuccess = function () { res(r.result); };
                r.onerror = function () { rej(r.error); };
            } catch (e) { rej(e); }
        });
    }
    function idb(mode, fn) {
        return open().then(function (db) {
            return new Promise(function (res, rej) {
                var tx = db.transaction(STORE, mode), out = fn(tx.objectStore(STORE));
                tx.oncomplete = function () { db.close(); res(out && out.result); };
                tx.onerror = tx.onabort = function () { db.close(); rej(tx.error); };
            });
        });
    }
    function load() { return idb('readonly', function (s) { return s.get(KEY); }).catch(function () { return null; }); }
    function put(v) { return idb('readwrite', function (s) { return s.put(v, KEY); }).catch(function () {}); }

    /* Vorhandenen Schluessel laden, ohne einen neuen zu erzeugen. -> {priv, pub} | null */
    function peek() {
        if (mem) return Promise.resolve(mem);
        return load().then(function (v) { if (v && v.priv && v.pub) mem = v; return mem; });
    }

    /* Schluessel holen, sonst erzeugen. */
    function ensure() {
        if (mem) return Promise.resolve(mem);
        if (pending) return pending;
        pending = peek().then(function (v) {
            if (v) return v;
            return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']).then(function (kp) {
                return crypto.subtle.exportKey('raw', kp.publicKey).then(function (raw) {
                    mem = { priv: kp.privateKey, pub: LigaCodec.toB64(new Uint8Array(raw)) };
                    return put(mem).then(function () { return mem; });
                });
            });
        }).then(function (v) { pending = null; return v; }, function (e) { pending = null; throw e; });
        return pending;
    }

    /* Text signieren -> base64url (r||s, 64 Byte) */
    function sign(text) {
        return ensure().then(function (k) {
            return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, new TextEncoder().encode(text));
        }).then(function (sig) { return LigaCodec.toB64(new Uint8Array(sig)); });
    }

    function reset() {
        mem = null;
        return idb('readwrite', function (s) { return s.delete(KEY); }).catch(function () {});
    }

    return { ensure: ensure, peek: peek, sign: sign, reset: reset };
})();
