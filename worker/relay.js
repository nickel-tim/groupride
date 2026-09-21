/* ============================================================
 * relay.js -- Cloudflare Worker als WebSocket-Relay
 * ============================================================
 * Absichtlich dumm: verteilt Bytes an alle anderen im selben Raum und
 * speichert nichts. Lesen kann er ohnehin nichts -- die Nutzlast ist
 * schon auf dem Handy AES-GCM-verschluesselt, der Schluessel steht im
 * URL-Fragment und erreicht nie einen Server.
 *
 * Hibernation-API (ctx.acceptWebSocket): Zwischen zwei Nachrichten
 * darf Cloudflare das Objekt aus dem Speicher werfen, die Verbindungen
 * bleiben trotzdem offen. Das haelt die abgerechnete Laufzeit klein --
 * wichtig im Free Plan.
 *
 * Deployment: siehe DEPLOY.md
 * ============================================================ */

import { DurableObject } from 'cloudflare:workers';

export class Room extends DurableObject {
    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('websocket erwartet', { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0], server = pair[1];
        this.ctx.acceptWebSocket(server);      // hibernierbar
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        // Groessenbremse gegen versehentliche Fluten
        if (typeof message === 'string' && message.length > 4096) return;
        for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;             // kein Echo an den Absender
            try { other.send(message); } catch (e) { /* Socket schon zu */ }
        }
    }

    async webSocketClose(ws, code, reason) {
        try { ws.close(code, reason); } catch (e) {}
    }

    async webSocketError(ws) {
        try { ws.close(1011, 'error'); } catch (e) {}
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response(
                'Gruppenausfahrt-Relay laeuft.\n' +
                'In der App eintragen: wss://' + url.host + '\n',
                { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }

        // Die Raum-ID ist bereits ein Hash aus dem Gruppenschluessel.
        const room = (url.searchParams.get('room') || 'default').slice(0, 128);
        const stub = env.ROOM.get(env.ROOM.idFromName(room));
        return stub.fetch(request);
    }
};
