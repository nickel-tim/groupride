# Liga auf Cloudflare bringen

Die Liga ist ein zusätzlicher Teil im selben Worker wie die App (`/api/*`). Die Live-Gruppe
(MQTT/Relay) ist davon unabhängig und läuft weiter wie bisher. **Ohne diese Schritte bleibt die
Liga in der App auf „nicht verfügbar", alles andere funktioniert.**

Einmalig, vom Projektordner aus. Node 20+ wird gebraucht (nodejs.org), `npx` holt wrangler selbst.

## 1. Datenbank anlegen

```bash
npx wrangler login
npx wrangler d1 create groupride
```

Die ausgegebene `database_id` brauchst du gleich. Sie ist kein Geheimnis.

## 2. Konfiguration umstellen

Der Inhalt von [wrangler.example.jsonc](wrangler.example.jsonc) ersetzt die `wrangler.jsonc` im
Projektstamm. Trage die `database_id` ein und ändere `MAIL_FROM` auf eine Adresse deiner Domain.

## 3. Geheimnisse setzen

```bash
# irgendein langer Zufallstext (mind. 32 Zeichen); NIE ändern, sonst erkennt der Server alle Konten nicht mehr
npx wrangler secret put AUTH_SECRET
# Schlüssel des Mail-Dienstes (siehe Schritt 4)
npx wrangler secret put RESEND_API_KEY
```

Zufallstext erzeugen: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.

## 4. E-Mail-Versand einrichten (Resend)

Die Anmeldung schickt einen 6-stelligen Code per Mail. Dafür ist ein Mail-Dienst nötig;
vorbereitet ist **Resend** (resend.com, kostenlos: 100 Mails/Tag, 3000/Monat):

1. Konto anlegen, unter *Domains* deine Domain hinzufügen (z. B. `nickeltim.de`). Resend zeigt
   DNS-Einträge (SPF, DKIM); diese trägst du in Cloudflare unter *DNS* ein und wartest, bis die
   Domain „verified" ist.
2. Unter *API Keys* einen Schlüssel mit Recht „Sending access" erzeugen → das ist `RESEND_API_KEY`.
3. `MAIL_FROM` in der `wrangler.jsonc` z. B. `Gruppenausfahrt <login@nickeltim.de>`.

Ein anderer Anbieter geht auch: nur die Funktion `sendCode` in [../api/mail.js](../api/mail.js)
tauschen. Ohne Mail-Versand gibt es keine Anmeldung.

## 5. Tabellen anlegen und veröffentlichen

```bash
npx wrangler d1 migrations apply groupride --remote
```

Die Migration in `migrations/` ist absichtlich **kommentarfrei** (D1 lehnt sonst mit „SQL code did not
contain a statement" ab). Die kommentierte Fassung steht in `schema.annotated.sql`; nach Änderungen dort
`python3 liga/tools/strip_sql.py` ausführen.

Danach wie bisher: committen und pushen (Cloudflare baut automatisch), oder `npx wrangler deploy`.
Die Migration einmalig von Hand ausführen und nur bei Schema-Änderungen wiederholen; im
automatischen Build fehlt dem Token meist das Recht für D1.

## 6. Prüfen

```bash
curl https://groupride.nickeltim.de/api/health
```

Erwartet: `{"ok":true,"db":true,"secret":true,"mail":"resend"}`. Steht bei `mail` `none`, fehlt
`RESEND_API_KEY` oder `MAIL_FROM`; bei `secret` `false` fehlt `AUTH_SECRET`. **Steht bei `mail`
`dev`, ist die Entwicklungskonfiguration deployt worden – sofort korrigieren** (dann steht der
Anmeldecode in der Antwort).

Danach in der App: Reiter **Liga** → E-Mail → Code aus der Mail → Konto ist angelegt.

## Lokal ausprobieren (ohne Cloudflare, ohne Mail)

```bash
npx wrangler d1 migrations apply groupride --local -c liga/wrangler.dev.jsonc
npx wrangler dev -c liga/wrangler.dev.jsonc
```

Öffnet die App auf http://localhost:8787 mit lokaler Datenbank. Der Anmeldecode wird direkt
angezeigt („Entwicklungsmodus"). Diese Konfiguration **niemals deployen**.

Tests (bei laufendem `wrangler dev`):

```bash
node liga/test/api_test.mjs          # API: Anmeldung, Fahrten, Ligen, Zeiträume, Rechte
python3 liga/test/ui_check.py        # Oberfläche im Browser, zwei "Handys"
python3 liga/test/metrics_check.py   # Kennzahlen mit bekannten Werten (ohne Server)
python3 liga/test/schema_check.py    # Datenbank-Schema
```

## Grenzen des Gratis-Tarifs (Stand meines Wissens – bitte gegenprüfen)

- Worker: 100 000 Anfragen/Tag, **10 ms CPU je Anfrage**. Ein Upload braucht ca. 2–6 ms
  (Track entpacken und prüfen), ein 10-Stunden-Track etwas mehr. Bei Überschreitung bricht Cloudflare
  die Anfrage ab; die App versucht es später erneut.
- D1: 500 MB je Datenbank, 5 Mio. gelesene Zeilen/Tag. Eine 50-km-Fahrt braucht etwa 20 KB.
- Resend: 100 Mails/Tag. Der Server begrenzt zusätzlich auf 90 Codes/Tag und 5 je Adresse und Stunde.
