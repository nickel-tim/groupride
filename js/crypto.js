/* ============================================================
 * crypto.js -- Ende-zu-Ende-Verschluesselung der Positionen
 * ============================================================
 * Warum ueberhaupt: Im Standardbetrieb laeuft der Austausch ueber
 * einen OEFFENTLICHEN MQTT-Broker. Wer das Topic kennt, liest mit.
 * Deshalb verlaesst keine Position das Handy im Klartext.
 *
 * Der Schluessel steht im URL-Fragment (hinter dem #). Fragmente
 * werden von Browsern NICHT an Server gesendet -- der Broker, dein
 * Webspace und jedes Log dazwischen sehen ihn also nie. Wer den Link
 * hat, ist in der Gruppe; wer ihn nicht hat, sieht auf dem Broker nur
 * Rauschen.
 *
 * Aus einem einzigen Geheimnis werden zwei Dinge getrennt abgeleitet:
 *   Raum-ID (= MQTT-Topic)  aus HKDF-Info "room"
 *   AES-Schluessel          aus HKDF-Info "key"
 * Getrennte Ableitung, damit die oeffentlich sichtbare Raum-ID
 * nichts ueber den Schluessel verraet.
 * ============================================================ */

var Crypt = (function () {
    'use strict';

    var enc = new TextEncoder();
    var dec = new TextDecoder();

    function b64urlEncode(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function b64urlDecode(str) {
        var s = str.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var raw = atob(s);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function newSecret() {
        var b = new Uint8Array(32);
        crypto.getRandomValues(b);
        return b64urlEncode(b);
    }

    /* HKDF-SHA256 -- getrennte Ableitung pro Verwendungszweck. */
    async function derive(secretB64, info, bits) {
        var raw = b64urlDecode(secretB64);
        var base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({
            name: 'HKDF', hash: 'SHA-256',
            salt: enc.encode('groupride.v1'),
            info: enc.encode(info)
        }, base, bits));
    }

    async function roomId(secretB64) {
        var b = await derive(secretB64, 'room', 96);
        return b64urlEncode(b);                      // 16 Zeichen, URL-tauglich
    }

    async function aesKey(secretB64) {
        var b = await derive(secretB64, 'key', 256);
        return crypto.subtle.importKey('raw', b, { name: 'AES-GCM' }, false,
                                       ['encrypt', 'decrypt']);
    }

    /* Jede Nachricht bekommt eine frische IV. AES-GCM authentifiziert
       zusaetzlich -- manipulierte Pakete schlagen beim Entschluesseln
       fehl statt stillschweigend Unsinn zu liefern. */
    async function seal(key, obj) {
        var iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        var ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(obj))));
        var out = new Uint8Array(iv.length + ct.length);
        out.set(iv, 0); out.set(ct, iv.length);
        return b64urlEncode(out);
    }

    async function open(key, b64) {
        try {
            var all = b64urlDecode(b64);
            if (all.length < 13) return null;
            var iv = all.slice(0, 12), ct = all.slice(12);
            var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
            return JSON.parse(dec.decode(pt));
        } catch (e) {
            return null;        // fremde Gruppe oder beschaedigt: einfach ignorieren
        }
    }

    return {
        newSecret: newSecret,
        roomId: roomId,
        aesKey: aesKey,
        seal: seal,
        open: open,
        b64urlEncode: b64urlEncode
    };
})();
