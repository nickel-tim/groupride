/* ============================================================
 * net.js -- transport: public MQTT broker OR own relay
 * ============================================================
 * Two ways, same interface:
 *
 *   mqtt   Public broker over WSS. No account, no deploy.
 *          Payload is encrypted (crypto.js), the broker sees
 *          only random bytes. No availability guarantee.
 *
 *   relay  Own Cloudflare Worker (worker/relay.js), plain
 *          WebSocket. More stable and under your own control.
 *          Enabled via ?relay=wss://...
 *
 * Both deliberately "fire and forget": positions are only interesting
 * for seconds. A lost report is not resent, the next one is already
 * on its way. That is why MQTT QoS 0 and no retain --
 * retain would even be harmful, because new participants would then
 * be shown stale positions as current.
 * ============================================================ */

var Net = (function () {
    'use strict';

    var BROKERS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
        'wss://test.mosquitto.org:8081/'
    ];
    var MQTT_LIB = 'https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.min.js';

    var mode = 'mqtt';
    var client = null, ws = null;
    var topic = null;
    var onMsg = null, onState = null;
    var brokerIdx = 0;
    var relayUrl = null;
    var closed = false;

    function state(s, detail) { if (onState) onState(s, detail); }

    function loadScript(src) {
        return new Promise(function (res, rej) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = res;
            s.onerror = function () { rej(new Error(T('Skript nicht ladbar: {src}', { src: src }))); };
            document.head.appendChild(s);
        });
    }

    /* ---------------- MQTT ---------------- */
    async function connectMqtt() {
        if (typeof window.mqtt === 'undefined') {
            state('loading');
            try {
                await loadScript(MQTT_LIB);
            } catch (e) {
                state('error', T('MQTT-Bibliothek nicht ladbar. Ohne Netz läuft die App weiter, du siehst nur dich selbst.'));
                return;
            }
        }
        openBroker();
    }

    function openBroker() {
        if (closed) return;
        var url = BROKERS[brokerIdx % BROKERS.length];
        state('connecting', url);

        try {
            client = window.mqtt.connect(url, {
                clientId: 'gr_' + Math.random().toString(36).slice(2, 10),
                keepalive: 30,
                reconnectPeriod: 0,          // own broker rotation
                connectTimeout: 8000,
                clean: true
            });
        } catch (e) {
            nextBroker();
            return;
        }

        client.on('connect', function () {
            state('online', url);
            client.subscribe(topic, { qos: 0 });
        });
        client.on('message', function (t, payload) {
            if (onMsg) onMsg(payload.toString());
        });
        client.on('error', function () { try { client.end(true); } catch (e) {} });
        client.on('close', function () { nextBroker(); });
    }

    function nextBroker() {
        if (closed) return;
        client = null;
        brokerIdx++;
        state('retry', BROKERS[brokerIdx % BROKERS.length]);
        setTimeout(openBroker, 2500);
    }

    /* ---------------- own relay ---------------- */
    function connectRelay() {
        if (closed) return;
        var url = relayUrl + (relayUrl.indexOf('?') >= 0 ? '&' : '?') +
                  'room=' + encodeURIComponent(topic);
        state('connecting', url);
        try {
            ws = new WebSocket(url);
        } catch (e) {
            state('error', T('Relay-Adresse ungültig'));
            return;
        }
        ws.onopen    = function () { state('online', url); };
        ws.onmessage = function (ev) { if (onMsg) onMsg(String(ev.data)); };
        ws.onclose   = function () {
            ws = null;
            if (closed) return;
            state('retry', url);
            setTimeout(connectRelay, 2500);
        };
        ws.onerror   = function () { try { ws.close(); } catch (e) {} };
    }

    /* ---------------- interface ---------------- */
    function start(opts) {
        closed = false;
        topic  = opts.topic;
        onMsg  = opts.onMessage;
        onState= opts.onState;
        relayUrl = opts.relayUrl || null;
        mode = relayUrl ? 'relay' : 'mqtt';
        if (mode === 'relay') connectRelay(); else connectMqtt();
    }

    function publish(payloadStr) {
        try {
            if (mode === 'relay') {
                if (ws && ws.readyState === 1) ws.send(payloadStr);
            } else if (client && client.connected) {
                client.publish(topic, payloadStr, { qos: 0, retain: false });
            }
        } catch (e) { /* silent: the next report comes right away */ }
    }

    function stop() {
        closed = true;
        try { if (client) client.end(true); } catch (e) {}
        try { if (ws) ws.close(); } catch (e) {}
        client = null; ws = null;
    }

    function online() {
        return mode === 'relay' ? !!(ws && ws.readyState === 1)
                                : !!(client && client.connected);
    }

    return { start: start, publish: publish, stop: stop, online: online,
             mode: function () { return mode; } };
})();
