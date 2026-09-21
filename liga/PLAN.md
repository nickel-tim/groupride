# Liga – Plan

Wettbewerbe im Freundeskreis: Monats-, Wochen- oder frei wählbare Ligen mit Ranglisten,
Ruhmeshalle, Team-Zielen und Liga-Stand im Tacho. Die Live-Gruppe (MQTT/Relay) bleibt
unverändert. **Ohne Anmeldung ändert sich nichts.**

**Stand: gebaut und getestet, aber nicht deployt.** `wrangler.jsonc` im Projektstamm ist unverändert,
damit dein laufendes Deployment nicht bricht. Zum Einschalten: [DEPLOY.md](DEPLOY.md).

Gebaut (alle Kategorien und Funktionen aus diesem Plan): Server in [../api/](../api/), App-Module
`js/liga-*.js`, Schema [migrations/0001_init.sql](migrations/0001_init.sql), Tests in [test/](test/)
(164 API-Prüfungen, 41 Oberflächen-Prüfungen im Browser, 23 Kennzahlen-Prüfungen, Schema).
Nicht möglich hier: echter Cloudflare-Betrieb, echter Mail-Versand, echte Handys/GPS.

Entschieden (Gespräch):
- Anmeldung per **E-Mail-Code** von Anfang an (Konto überlebt gelöschte Browserdaten und Gerätewechsel), dazu ein **Geräteschlüssel** je Gerät, der jede Anfrage signiert.
- **Ganzer Track** wird gespeichert, für andere aber **unsichtbar**; **Teilen** pro Fahrt und Liga möglich.
- Liga-Modus frei einstellbar (Woche, Monat, 3 Monate, Jahr, N Tage, einmalig von–bis).
  Wiederkehrende Ligen frieren am Ende ein und füllen die **Ruhmeshalle** (Standard: an).
- Mehrere Ligen gleichzeitig. Ersteller ist **Admin**, keine weiteren Rollen.
- Nur echte Fahrten (`ride`) und GPX-Import (`gpx`) zählen. Simulation, Ghost und Plan werden abgelehnt.
- **Alle** besprochenen Kategorien werden gebaut (Abschnitt 4), in Etappen (Abschnitt 8).

---

## 1. Architektur

```
Handy (statische App, unverändert)
  ├─ Live-Gruppe: MQTT / Relay-Worker      ← bleibt wie heute
  └─ Liga (optional): HTTPS /api/…         ← neu, gleiche Domain
                          │
                 Worker "groupride"  (bisher nur statische Dateien)
                          │
                       D1 (SQLite)
```

- **Ein Worker, gleiche Domain.** `wrangler.jsonc` bekommt `main` und ein D1-Binding. Die
  statischen Dateien werden weiter direkt von Cloudflare ausgeliefert, der Worker-Code läuft
  nur für `/api/*` (`assets.run_worker_first: ["/api/*"]`). Kein CORS, kein zweites Deployment.
- Der **Relay-Worker** in `worker/` bleibt getrennt und unberührt.
- Die App braucht **kein** Konto zum Fahren, Aufzeichnen, Ghost, Segmente usw. Die Liga ist
  ein zusätzlicher Reiter „Liga", der erst nach dem Beitritt etwas tut.
- **Der Browser rechnet, der Server speichert und sortiert.** Grund: Free Plan erlaubt nur
  10 ms CPU je Request. Der Server prüft nur Plausibilität (Abschnitt 6).
- Was hochgeladen wird: **nur die eigene Spur** und daraus berechnete Kennzahlen.
  **Gruppenaufzeichnungen bleiben lokal** – sie enthalten Positionen anderer Fahrer, die
  nicht zugestimmt haben.

### Was du selbst tun musst (einmalig)

Datenbank anlegen, Geheimnisse setzen, Mail-Dienst einrichten, `wrangler.jsonc` umstellen: alles Schritt
für Schritt in [DEPLOY.md](DEPLOY.md). Das Beispiel für die neue Konfiguration steht in
[wrangler.example.jsonc](wrangler.example.jsonc); `wrangler deploy --dry-run` damit lief fehlerfrei.

---

## 2. Identität: E-Mail-Code + Geräteschlüssel

Ursprünglich war nur ein Geräteschlüssel geplant. Weil Browserdaten (besonders Safari nach ca. 7 Tagen
ohne Nutzung) verloren gehen können, ist die **E-Mail von Anfang an** dabei:

- **Anmelden:** E-Mail eingeben → 6-stelliger Code per Mail (10 min gültig, 5 Versuche) → fertig. Beim
  ersten Mal entsteht das Konto (Name, Symbol, Farbe kommen aus der App), sonst wird das Gerät dem
  bestehenden Konto zugeordnet.
- **Geräteschlüssel:** Beim Anmelden erzeugt der Browser ein ECDSA-P-256-Schlüsselpaar. Der private
  Schlüssel ist **nicht auslesbar** (`extractable: false`, IndexedDB) und verlässt das Gerät nie. Jede
  Anfrage trägt eine Signatur (`X-Key`, `X-Ts`, `X-Sig` über Methode, Pfad, Zeit, SHA-256 des Bodys;
  ±5 min). Es gibt keine Cookies und keine Sitzungen.
- **Datenverlust / neues Handy:** E-Mail und Code, neuer Schlüssel, dasselbe Konto. Alte Geräte lassen
  sich unter „Konto → Geräte" abmelden.
- **Die Adresse wird nicht gespeichert**, nur ein HMAC-Wert (`AUTH_SECRET`). Zum Anmelden tippt man sie
  ein, der Code geht an die getippte Adresse. Nebenwirkung: der Server kann niemanden ungefragt anschreiben
  und `AUTH_SECRET` darf nie geändert werden.
- **Schutz:** höchstens 5 Codes je Adresse und Stunde, 90 je Tag insgesamt (Resend: 100/Tag), 5 Fehlversuche
  sperren den Code, der Code ist an den Schlüssel gebunden, der ihn angefordert hat.
- **Mail-Versand:** Resend (siehe DEPLOY.md), austauschbar in `api/mail.js`.

---

## 3. Ligen

**Zeitraum** (`unit`, `every`, `start_ts`, `end_ts`, Zeitzone `tz`, Standard Europe/Berlin):

| Einstellung | unit / every | Beispiel |
|---|---|---|
| Woche | week / 1 | Mo–So |
| Monat | month / 1 | 1.–Monatsende |
| 3 Monate | month / 3 | ab Startdatum |
| Jahr | year / 1 | |
| Alle N Tage | day / N | 10 Tage |
| Einmalig | once, `end_ts` | „Sommer-Challenge 1.7.–31.8." |

- Eine Fahrt zählt für den Zeitraum ihres **Starts**.
- **Nachfrist** `grace_h` (48 h): Erst danach wird der Stand eingefroren
  (`league_periods` + `league_results`), beim ersten Zugriff, ohne Cron. In der Nachfrist
  zählen spät hochgeladene Fahrten (Funkloch, GPX-Import) noch mit.
- **Einladung:** Link `…/#l=<ligaId>.<geheimnis>` und QR, wie beim Gruppen-Sharing. Der Server
  kennt nur den Hash. Der Admin kann das Geheimnis erneuern (alter Link wird ungültig).
- **Admin** (Ersteller): Name, Zeitraum, aktive Kategorien, Team-Ziele ändern; Mitglieder
  entfernen; Liga schließen/löschen. Änderungen wirken auf den laufenden Zeitraum
  (live berechnet); eingefrorene Zeiträume bleiben.
- **Gesamtwertung** (Option): Platzpunkte je aktiver Kategorie = `Mitglieder − Platz + 1`,
  bei Gleichstand geteilt. Kategorien, die nur der Spaß sind (z. B. Kaffeepausen), kann der
  Admin aus der Gesamtwertung nehmen.
- **Mehrere Ligen:** Eine Fahrt wird einmal gespeichert; jede Liga liest sie über ihren Zeitraum.
- **Ruhmeshalle:** je Zeitraum Top 3 pro Kategorie, plus Anzahl Titel je Mitglied.
- **Team-Ziel:** `goals` an der Liga, z. B. „Zusammen 3 000 km" mit Fortschrittsbalken.
  Fortschritt = Summe aller Mitglieder im Zeitraum (nur summierbare Kategorien).
  **Persönliche Ziele** stehen in `memberships.goals` und sind für die Liga sichtbar.

---

## 4. Kategorien

Alle Werte entstehen im Browser aus der **eigenen** Spur (und bei Gruppenfahrten aus der
Analyse dieser Fahrt) und werden als `ride_values` gespeichert. Eine neue Kategorie braucht
Code, keine Migration. `agg`: wie die Rangliste aus den Fahrten zusammenrechnet.

| Schlüssel | Kategorie | agg | Berechnung / Regel |
|---|---|---|---|
| `dist` | Kilometer | Summe | `Track.stats().dist` (geglättet, sonst ~25 % zu lang) |
| `time` | Fahrzeit | Summe | Bewegungszeit (`movingMs`, Stillstand zählt nicht) |
| `gain` | Höhenmeter | Summe | `Track.gain` (Höhe über 100 m geglättet) |
| `rides` | Anzahl Fahrten | Anzahl | |
| `days` | Fahrtage | Tage | verschiedene lokale Kalendertage |
| `streak` | Serie | Spezial | längste Folge aufeinanderfolgender Tage mit ≥ 5 km im Zeitraum |
| `long_dist` | Längste Fahrt | Max | km einer Fahrt |
| `long_time` | Längste Fahrzeit | Max | Bewegungszeit einer Fahrt |
| `gain_day` | Meiste Höhenmeter an einem Tag | Spezial | Summe je Tag, davon das Maximum |
| `top` | Topspeed | Max | schnellstes **5-s-Fenster**; Fahrten über 108 km/h zählen dafür nicht (GPS-Fehler) |
| `avg20` | Schnellster Schnitt | Max | Fahrten ab 20 km, Bewegungsschnitt |
| `t10k` `t20k` `t40k` | Bestzeit 10/20/40 km | Min | `Segments.computeRecords` (existiert schon) |
| `avg1h` | Beste Stunde | Max | Durchschnittsgeschwindigkeit über beste 60 min am Stück (neu: 3 600 000 ms in `computeRecords`) |
| `vam` | Steigrate | Max | beste Höhenmeter/Stunde über ≥ 5 min mit ≥ 3 % mittlerer Steigung |
| `kom` | Kletterkönig | Spezial | Punkte aus Liga-Segmenten der Art „Anstieg" (Platz 1/2/3 → 3/2/1 je Segment) |
| `seg:<id>` | Segment-Bestzeit | Min | Zeit auf einem Liga-Segment (s. u.) |
| `front` | Wasserträger | Summe | Führungszeit (`Analytics.frontMs`) |
| `attacks` | Angriffe | Summe | Anzahl `attack`-Ereignisse dieses Fahrers |
| `escape` | Ausreißer | Max | längste Zeit an der Spitze mit ≥ 50 m Vorsprung auf den Zweiten (Zähler kommt in `Analytics`) |
| `together` | Gemeinsam gefahren | Summe | Meter, in denen mindestens ein anderer Fahrer < 100 m entfernt war |
| `coffee` | Kaffeepausen | Summe | gesendete ☕-Nachrichten, höchstens eine je 15 min (sonst tippt man sich zum Sieg) |
| `explore` | Entdecken | Spezial | **neue** Kacheln (Zoom 15, ca. 0,8 km) im Zeitraum, die das Konto vorher nie besucht hat |

- „Summe/Max/Min" über alle Fahrten im Zeitraum; Zeiten (Bestzeiten) sind **Min**, alles andere Max/Summe.
- Nur **Zeitfenster-Werte**, keine Leistung in Watt (kein Sensor).
- `top`, `escape`, `together`, `front`, `attacks`, `coffee` gibt es nur, wenn die Fahrt in einer
  Gruppe aufgezeichnet wurde (Solo-Fahrten haben `top` trotzdem).
- **Versionierung:** `rides.algo` speichert, mit welcher Berechnung die Werte entstanden.
  Verbessern wir einen Algorithmus, rechnet der Client eigene Fahrten neu und schickt die
  Werte per `PUT /api/rides/:id/values`. Der Track liegt ja auf dem Server (und lokal).
- **Liga-Segmente:** Ein Mitglied legt aus einer Fahrt einen Abschnitt an (gleicher Editor
  wie die lokalen Segmente). Jeder Client gleicht seine eigenen Fahrten dagegen ab
  (`Segments.match`) und meldet die Zeit; ohne Server-Rechnung. Neue Segmente werden beim
  nächsten App-Start rückwirkend auf die eigenen Fahrten angewendet.
- **Kacheln** (`explore`): Der Client schickt die besuchten Kacheln als Varint-Liste (ca.
  100–200 Byte je Fahrt). Der Server trägt sie mit `first_ts = MIN(...)` in `account_tiles` ein.
  Die Rangliste zählt nur Zeilen im Zeitraum über den Index. Wird eine Fahrt gelöscht,
  baut der Server die Kacheln des Kontos aus den restlichen Fahrten neu.

---

## 5. Liga-Stand im Tacho

- Eine schmale Zeile unter dem Tempo: **„Distanz  ▲ Anna +12,4 km · du 314 km · ▼ Ben −8,1 km"**.
- Kategorie wechseln per **Tippen** (Zyklus durch die aktiven Kategorien), kein Tippen von Text.
- Datenquelle: beim Fahrtstart (und danach alle ~10 min, wenn online) holt der Client den
  Stand einmal und legt ihn in `localStorage`. **Dein eigener Wert läuft live mit** (Stand +
  bisherige Kilometer dieser Fahrt), die Nachbarn sind der zuletzt geholte Stand.
  Offline funktioniert es weiter mit dem letzten Stand.
- Für Kategorien, die sich unterwegs nicht sinnvoll hochrechnen lassen (Bestzeiten), zeigt
  die Zeile stattdessen deinen aktuellen Rang.

---

## 6. Regeln beim Upload

`POST /api/rides` lehnt mit Grund ab (`422 { reason }`, die App zeigt ihn an):

- `src` nicht `ride`/`gpx` (Simulation, Ghost, Plan, unbekannt).
- Weniger als 40 Punkte, Dauer < 2 min oder Strecke < 500 m.
- Mehr als 40 000 Punkte oder Body > 200 KB.
- Sprung > 100 m/s zwischen zwei Punkten, Bewegungsschnitt > 60 km/h, Höhe außerhalb −500…9 000 m.
- **Überschneidung:** ein anderer Upload desselben Kontos, dessen Zeitfenster sich um mehr als
  50 % überlappt (dieselbe Fahrt aus App **und** GPX-Import zählt nicht doppelt).
- Mehr als 20 Uploads je Konto und Tag.
- Zeitstempel in der Zukunft oder länger als 400 Tage her.

Vertrauen ist bewusst der Kern (Freundeskreis). Importierte Fahrten sind mit `src: gpx`
gekennzeichnet; sie später auszublenden wäre eine Zeile Code.

---

## 7. Datenschutz

- **Tracks sind privat.** Andere Mitglieder sehen nur Kennzahlen und den Fahrtnamen.
- **Teilen** je Fahrt und Liga (`POST /api/rides/:id/share`): der Client lädt eine Kopie hoch,
  bei der **Anfang und Ende (Standard 300 m) fehlen**, damit Wohn- und Arbeitsort nicht
  auftauchen. Die Kopie erscheint bei den Mitgliedern in „Geteilte Fahrten" und lässt sich
  als **Ghost**, Karte oder Replay öffnen. Beim Zurücknehmen wird die Kopie gelöscht.
- Löschen: einzelne Fahrt, „Liga verlassen" (Kennzahlen bleiben im Konto, verschwinden aus
  der Liga), „**Alles löschen**" (Konto samt Fahrten, Tracks, Kacheln – kaskadiert).
- Transport HTTPS. Am Server (Cloudflare D1) liegen Tracks **nicht Ende-zu-Ende verschlüsselt**;
  das sagt die App beim Beitritt in einem Satz. Im Freundeskreis ist das ein kleines Risiko,
  wächst die Nutzung darüber hinaus, braucht es Datenschutzerklärung und Impressum
  (keine Rechtsberatung, aber ein Punkt für später).
- Keine Cookies, kein Tracking, keine Weitergabe an Dritte.

---

## 8. Umsetzung in Etappen

Alle Etappen sind umgesetzt und getestet (Ausnahme: echter Betrieb, siehe oben).

| Etappe | Inhalt |
|---|---|
| **A Grundlage** | D1 + Worker-Routen, Auth (Schlüssel, Signatur), Konto/Sicherungs-QR, Fahrt-Upload mit Regeln, Ligen anlegen/beitreten/konfigurieren, Rangliste der einfachen Kategorien (`dist time gain rides days long_dist long_time top avg20`), Reiter „Liga", automatischer Upload mit Warteschlange, GPX-Import zählt |
| **B Ergebnis** | Zeitraum-Engine (alle Modi, Zeitzone), Einfrieren + Ruhmeshalle, Gesamtwertung, Team- und persönliche Ziele, `streak gain_day t10k t20k t40k avg1h vam`, Liga-Stand im Tacho |
| **C Gruppe & Entdecken** | `front attacks escape together coffee` (Kennzahlen aus der Gruppenanalyse), `explore` mit Kacheln |
| **D Teilen** | gekürzte Kopie, „Geteilte Fahrten", als Ghost öffnen, eigene Fahrten auf neues Gerät laden (Sync) |
| **E Liga-Segmente** | Segment anlegen/teilen, Zeiten melden, Kletterkönig |
| später | E-Mail-Anmeldung, Track-Nachprüfung auf dem Server, Strava-Import |

### Wie getestet wurde

- **Schema:** gegen SQLite (D1 ist SQLite), inklusive Index-Nutzung der Ranglisten-Abfragen.
- **Server:** echter Worker (`wrangler dev`, lokale D1) und ein Testskript, das wie mehrere Handys signierte
  Anfragen schickt: Anmeldung inkl. Fehl- und Missbrauchsfälle, alle Ablehnungsgründe, Ranglisten, Zeiträume
  (Sommerzeit, Zeitzonen), Einfrieren, Ruhmeshalle, Rechte, Teilen, Segmente, Löschen.
- **Oberfläche:** echtes Chrome, zwei Handys (getrennte Browser-Kontexte), der ganze Weg von der Anmeldung
  bis zum Löschen des Kontos, inkl. Tacho-Zeile und Ghost.
- **Kennzahlen:** Fahrten mit bekanntem Ergebnis (6 % Steigung → 648 m/h usw.).
- **Nicht getestet:** Cloudflare selbst (echte Limits, CPU-Zeit), echter Mail-Versand, echte Handys und GPS,
  Safari-Eigenheiten. Den ersten echten Deploy und einen Probelauf mit Freunden musst du machen.

---

## 9. Datenmenge (gemessen, [test/track_size.py](test/track_size.py))

Simulierte 50-km-Fahrt: 2 h, 1 Hz, 7 200 Punkte, GPS-Rauschen ±1,5 m.

| Format | Größe |
|---|---|
| JSON wie `rides.js` | 237 KB (gzip 76 KB) |
| Varint-Delta, 1e-5° (≈ 1,1 m) | 21,6 KB (**gzip 12,5 KB**) |
| Varint-Delta, 1e-6° (≈ 0,11 m) | 25,2 KB (gzip 20,9 KB) |

Gewählt: **1e-5°, Format 1** (≈ 13–20 KB je 50-km-Fahrt; echte Strecken sind glatter als
mein Rauschen). Auf ca. 1 m gerundet ist das für Ranglisten und Segmente genau genug – die
Kennzahlen kommen ohnehin aus dem Browser und werden dort geglättet.

Hochrechnung 10 Freunde × 15 Fahrten/Monat ≈ 150 Fahrten ≈ **2–3 MB/Monat**. Das 500-MB-Limit
je D1-Datenbank (Free) hält damit über 15 Jahre. Tracks bleiben deshalb in D1; erst bei
starkem Wachstum würden sie nach R2 wandern.

Zeilen-Lesekosten (D1 Free: 5 Mio./Tag): eine Rangliste liest die Zeilen der Kategorie im
Zeitraum aus `ride_values` (bei 10 Mitgliedern und einem Monat rund 150 Zeilen; bei einem Jahr
1 800). Schema-Test bestätigt die Index-Nutzung. Kein Problem, solange nicht Tausende
Nutzer dazukommen. Grenzen der Cloudflare-Pläne bitte vor dem Start auf cloudflare.com prüfen,
sie ändern sich.

---

## 10. API (Entwurf)

Alle Aufrufe signiert (Abschnitt 2), Antworten JSON.

| Methode Pfad | Zweck |
|---|---|
| `POST /api/account` | Konto anlegen (Schlüssel, Name, Emoji, Farbe) |
| `PUT /api/account` | Name/Emoji/Farbe ändern |
| `DELETE /api/account` | alles löschen |
| `POST /api/leagues` | Liga anlegen → `{ id, invite }` |
| `POST /api/leagues/join` | mit Einladungsgeheimnis beitreten |
| `GET /api/leagues` | meine Ligen |
| `GET /api/leagues/:id` | Einstellungen, Mitglieder, aktueller Zeitraum |
| `PATCH /api/leagues/:id` | (Admin) Zeitraum, Kategorien, Ziele, Einladung erneuern |
| `DELETE /api/leagues/:id/members/:acc` | (Admin) entfernen; jeder darf sich selbst entfernen |
| `GET /api/leagues/:id/board?cat=…&period=…` | Rangliste (Standard: laufender Zeitraum) |
| `GET /api/leagues/:id/standing?cat=…` | schlank für den Tacho: Nachbarn und eigener Rang |
| `GET /api/leagues/:id/hall` | Ruhmeshalle |
| `POST /api/rides` | Fahrt: Metadaten + Werte + Track (gzip) + Kacheln; idempotent |
| `GET /api/rides` / `GET /api/rides/:id/track` | eigene Fahrten (Sync auf neues Gerät) |
| `PUT /api/rides/:id/values` | neu berechnete Werte (nach Algorithmus-Update) |
| `DELETE /api/rides/:id` | Fahrt löschen |
| `POST /api/rides/:id/share` / `DELETE …/share/:league` | Teilen (gekürzte Kopie) |
| `GET /api/leagues/:id/shared` / `…/shared/:ride/track` | geteilte Fahrten der Liga |
| `POST /api/leagues/:id/segments`, `GET …`, `PUT …/segments/:sid/efforts` | Liga-Segmente |

---

## 11. Änderungen in der App (Überblick)

Neue Module (alle nach demselben Muster wie bisher, ES5-IIFE, danach `python3 build.py`):
`liga-id.js` (Schlüssel, Signatur, Sicherung), `liga-api.js` (Requests, Warteschlange),
`liga-metrics.js` (Werte je Fahrt, nutzt `Track`, `Segments.computeRecords`, `Summary`-Analyse),
`liga-ui.js` (Reiter „Liga", Ranglisten, Ruhmeshalle, Ziele, Einstellungen), dazu die Tacho-Zeile
und die Knöpfe „Für Liga zählen" / „Teilen" in der Fahrtenliste und der Bilanz.

Bestehende Module ändern sich nur an wenigen Stellen: `app.js` (nach `analyseRide` die Werte
berechnen und einreihen), `analytics.js` (Zähler `soloMs`, `togetherM`), `segments.js`
(`t3600000`), `index.html`/`css`.

Bedienung ohne Tippen: Beitritt per Link/QR, Kategorie per Tippen, Zeitraum per Auswahlknöpfen.
Getippt wird nur beim **Anlegen** einer Liga (Name); das passiert nie auf dem Rad.

---

## 12. Offene Punkte / Risiken

- **Mail-Zustellung:** ohne verifizierte Domain bei Resend kommen keine Codes an (DEPLOY.md, Schritt 4).
- **Codes verbrauchen das Tageskontingent:** wer viele Anmeldungen anstößt, kann die 90 Codes/Tag
  aufbrauchen und andere für einen Tag aussperren. Im Freundeskreis kein Thema; später Cloudflare Turnstile.
- **10 ms CPU im Free Plan:** gemessen ca. 2–6 ms je Upload (Node, nicht Cloudflare). Sehr lange Fahrten
  (> 8 h) sind knapp; sie werden clientseitig auf 39 000 Punkte ausgedünnt.
- **Zeitzonen und Sommerzeit:** getestet (Monat, Woche, Jahr, 3 Monate, N Tage, New York), aber nicht
  über mehrere Jahre im Live-Betrieb.
- **Fälschbarkeit** (Freunde, GPX-Import) bewusst akzeptiert; die Regeln fangen nur grobe Fehler.
- **Kaffeepausen** zählen höchstens eine je 15 Minuten.
- **Lokal gelöschte Fahrten** bleiben auf dem Server (unter „Liga → Meine Fahrten" löschbar), das ist Absicht.
- **Einladungslink** kennt der Server nur als Hash: er lässt sich nur direkt nach dem Anlegen oder nach
  „neu erzeugen" anzeigen.
- **Worker-Umbau:** von „nur Dateien" zu „Dateien + Code" ändert das Deployment; `wrangler deploy --dry-run`
  mit der Beispiel-Konfiguration lief fehlerfrei.
