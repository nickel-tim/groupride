/* ============================================================
 * crypto.js -- end-to-end encryption of the positions
 * ============================================================
 * Why at all: in standard operation the exchange runs over a PUBLIC
 * MQTT broker. Anyone who knows the topic can listen in. That is why
 * no position leaves the phone in plain text.
 *
 * The key lives in the URL fragment (after the #). Browsers do NOT
 * send fragments to servers -- the broker, your web host and every log
 * in between never see it. Whoever has the link is in the group;
 * whoever does not sees only noise on the broker.
 *
 * Two things are derived separately from a single secret:
 *   room ID (= MQTT topic)  from HKDF info "room"
 *   AES key                 from HKDF info "key"
 * Separate derivation so that the publicly visible room ID
 * reveals nothing about the key.
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

    /* HKDF-SHA256 -- separate derivation per purpose. */
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
        return b64urlEncode(b);                      // 16 characters, URL-safe
    }

    async function aesKey(secretB64) {
        var b = await derive(secretB64, 'key', 256);
        return crypto.subtle.importKey('raw', b, { name: 'AES-GCM' }, false,
                                       ['encrypt', 'decrypt']);
    }

    /* Every message gets a fresh IV. AES-GCM additionally authenticates --
       tampered packets fail on decryption instead of silently
       yielding nonsense. */
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
            return null;        // foreign group or corrupted: just ignore
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
