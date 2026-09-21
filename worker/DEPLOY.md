# Deploying the relay to Cloudflare

You need this only if you want your own relay instead of the public MQTT broker. It runs on the free Workers plan.

## One-time setup

1. **Create a free Cloudflare account** at dash.cloudflare.com.
2. **Install Node.js 20 or newer** (nodejs.org).
3. In a terminal, from this `worker` folder:

```bash
npm install            # installs wrangler locally
npx wrangler login     # opens the browser, click "Allow"
npx wrangler deploy
```

On your first deploy, Wrangler asks you to pick a `workers.dev` subdomain. At the end it prints your URL, for example:

```
https://gruppenausfahrt-relay.yourname.workers.dev
```

4. **Check it:** open that URL in a browser. You should see "Gruppenausfahrt-Relay laeuft".

## Using it

The app needs the WebSocket form of the URL: same address, but `wss://` instead of `https://`.

**Best:** put it in the link you share, **before** the `#`:

```
https://your-site.de/ausfahrt.html?relay=wss://gruppenausfahrt-relay.yourname.workers.dev#k=…
```

Or enter it under **Gruppe → Eigener Relay**. The "Link zum Mitfahren teilen" button then includes it automatically.

**Important:** everyone in a group has to use the same transport. Someone on the public broker and someone on your relay won't see each other.

## Updating

After changing `relay.js`, run `npx wrangler deploy` again. Logs are live with `npx wrangler tail`.

## Why the config looks the way it does

- `new_sqlite_classes` in `wrangler.toml`: on the free plan, Durable Objects must use the SQLite backend. The older `new_classes` gets rejected with error 10097.
- The WebSocket hibernation API (`ctx.acceptWebSocket`): Cloudflare can evict the object from memory between messages while the connections stay open, so it uses less billed time.
- One Durable Object per room: that's the only way connections from different phones end up in the same place.

A few riders sending every 2 seconds for a few hours is far below the free-plan limits.
