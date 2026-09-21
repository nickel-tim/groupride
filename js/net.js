/* ============================================================
 * net.js -- Transport: oeffentlicher MQTT-Broker ODER eigener Relay
 * ============================================================
 * Zwei Wege, gleiche Schnittstelle:
 *
 *   mqtt   Oeffentlicher Broker ueber WSS. Kein Account, kein Deploy.
 *          Nutzlast ist verschluesselt (crypto.js), der Broker sieht
 *          nur Zufallsbytes. Keine Verfuegbarkeitsgarantie.
 *
 *   relay  Eigener Cloudflare Worker (worker/relay.js), schlichtes
 *          WebSocket. Stabiler und unter eigener Kontrolle.
 *          Aktivierung per ?relay=wss://...
 *
 * Beides bewusst "fire and forget": Positionen sind nur Sekunden lang
 * interessant. Eine verlorene Meldung wird nicht nachgesendet, die
 * naechste ist schon unterwegs. Deshalb MQTT QoS 0 und kein Retain --
 * Retain waere sogar schaedlich, weil neue Teilnehmer dann veraltete
 * Positionen als aktuell angezeigt bekaemen.
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
            s.onerror = function () { rej(new Error('Skript nicht ladbar: ' + src)); };
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
                state('error', 'MQTT-Bibliothek nicht ladbar. Ohne Netz laeuft die ' +
                               'App weiter, du siehst nur dich selbst.');
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
                reconnectPeriod: 0,          // eigene Broker-Rotation
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

    /* ---------------- eigener Relay ---------------- */
    function connectRelay() {
        if (closed) return;
        var url = relayUrl + (relayUrl.indexOf('?') >= 0 ? '&' : '?') +
                  'room=' + encodeURIComponent(topic);
        state('connecting', url);
        try {
            ws = new WebSocket(url);
        } catch (e) {
            state('error', 'Relay-Adresse ungueltig');
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

    /* ---------------- Schnittstelle ---------------- */
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
        } catch (e) { /* stillschweigend: naechste Meldung kommt gleich */ }
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
