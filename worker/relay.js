/* ============================================================
 * relay.js -- Cloudflare Worker as a WebSocket relay
 * ============================================================
 * Deliberately dumb: distributes bytes to everybody else in the same room and
 * stores nothing. It cannot read anything anyway -- the payload is
 * already AES-GCM-encrypted on the phone, the key is in the
 * URL fragment and never reaches a server.
 *
 * Hibernation API (ctx.acceptWebSocket): between two messages
 * Cloudflare may evict the object from memory, the connections
 * stay open nevertheless. That keeps the billed runtime small --
 * important on the free plan.
 *
 * Deployment: see DEPLOY.md
 * ============================================================ */

import { DurableObject } from 'cloudflare:workers';

export class Room extends DurableObject {
    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('websocket erwartet', { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0], server = pair[1];
        this.ctx.acceptWebSocket(server);      // hibernatable
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        // Size brake against accidental floods
        if (typeof message === 'string' && message.length > 4096) return;
        for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;             // no echo to the sender
            try { other.send(message); } catch (e) { /* Socket already closed */ }
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

        // The room ID is already a hash of the group key.
        const room = (url.searchParams.get('room') || 'default').slice(0, 128);
        const stub = env.ROOM.get(env.ROOM.idFromName(room));
        return stub.fetch(request);
    }
};
