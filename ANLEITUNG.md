# Gruppenausfahrt — Web-App für gemeinsame Radtouren

Eine Seite, ein Link. Wer ihn öffnet, ist dabei: keine Installation, kein Konto, kein App Store. Läuft auf iPhone und Android im Browser.

## Was sie zeigt

**Tacho** — eigenes Tempo groß, eigene Position in der Gruppe, Kompass mit Richtung und Entfernung zu jedem, darunter alle Fahrer mit Tempo und Lücke in Metern *und* Sekunden. ▲/▼ sagt, wer vor und wer hinter dir ist.

**Verlauf** — Führungsarbeit pro Fahrer (wer wie lange vorne war), Ablösungen, sowie Überholvorgänge, Antritte, Abrisse mit Uhrzeit.

**Berge** — automatisch erkannte Anstiege mit Rangliste: Zeit und Höhenmeter pro Stunde für jeden, der oben angekommen ist.

**Gruppe** — Name, Farbe, Link teilen, Sonnenmodus, Export.

---

## Aufspielen

Lade **eine** dieser Varianten auf deinen Webspace:

- **`ausfahrt.html`** — alles in einer Datei. Hochladen, fertig.
- **Der Ordner** (`index.html`, `css/`, `js/`) — wenn du am Code weiterbasteln willst. `python3 build.py` baut daraus wieder die Einzeldatei.

**HTTPS ist Pflicht.** Ohne verschlüsselte Verbindung geben Browser weder GPS noch Kompass frei, und die Verschlüsselung (`crypto.subtle`) fehlt ebenfalls. Kein Sonderfall der App — das ist Browser-Politik.

---

## Erste Ausfahrt

1. Seite öffnen. Beim ersten Aufruf wird automatisch ein Gruppenschlüssel erzeugt und an die Adresse gehängt (hinter dem `#`).
2. Unter **Gruppe** Namen und Farbe setzen.
3. **Link zum Mitfahren teilen** — per WhatsApp, Signal, wie auch immer. Alle öffnen ihn.
4. Jeder tippt **Ausfahrt starten** und erlaubt Standort (iOS fragt zusätzlich nach Bewegungssensoren).
5. Losfahren.

**Tipp fürs iPhone:** Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm". Dann startet sie ohne Adressleiste, fast wie eine echte App — und der Link mit dem Gruppenschlüssel ist gleich mit gespeichert.

---

## Zwei Entscheidungen, die du kennen solltest

### Der Kompass nimmt bewusst *nicht* den Magnetsensor

Naheliegend wäre der Magnetometer. Auf dem Rad ist er die schlechtere Wahl: Die meisten Lenkerhalterungen sind **magnetisch**, und Lenker, Vorbau und Bremszüge sind Stahl. Der Kompass zeigt dann verlässlich falsch, teils um 90° und mehr.

`coords.heading` aus dem GNSS-Chip hat das Problem nicht — es kommt aus der Doppler-Verschiebung und ist rein kinematisch. Dafür existiert es nur bei Bewegung.

Also: **oberhalb von 2,5 m/s der GPS-Kurs, darunter der Magnetometer als Rückfall.** Die Kopfzeile zeigt jederzeit, welche Quelle gerade aktiv ist. Im Stand an der Ampel darf der Kompass also ruhig spinnen — sobald du rollst, übernimmt das GPS.

### Es gibt keinen Server, der die Wahrheit kennt

Jedes Handy rechnet selbst. Die absoluten Streckenpositionen unterscheiden sich deshalb von Gerät zu Gerät — jede Achse beginnt dort, wo *dieses* Handy die erste Position gesehen hat. Die **Differenzen** sind auf allen Geräten gleich, und nur die zählen: Reihenfolge, Lücken, Bergzeiten.

Der Preis: Nach einem Funkloch können zwei Handys kurz leicht verschiedene Stände zeigen. Der Gewinn: kein Backend, keine Registrierung, kein Datenabfluss.

---

## Wie „wer ist vorne" berechnet wird

Das ist der eigentliche Kern, und es ist nicht offensichtlich: **Aus paarweisen Abständen lässt sich keine Reihenfolge ableiten.** Zwei Fahrer 50 m voneinander entfernt — wer führt? Die Distanz sagt es nicht.

Also baut die App eine gemeinsame **Streckenachse**: eine Polylinie, die sich selbst organisiert. Wer am weitesten vorne liegt, verlängert sie; alle anderen werden darauf projiziert und bekommen eine Position als Bogenlänge. Damit fallen ab:

| | |
|---|---|
| Reihenfolge | nach Bogenlänge sortieren |
| Lücke | Differenz der Bogenlängen |
| Überholvorgang | Vorzeichenwechsel einer Differenz |
| Bergsprint | Steigungsintervall der Achse, Zeit je Fahrer darin |

### Drei Fallen, die dabei eingebaut wurden

**Nur *ein* Fahrer darf die Achse verlängern.** Bauen abwechselnd verschiedene Fahrer daran, unterscheiden sich ihre Positionen seitlich um mehrere Meter bei nur 20 m Längsfortschritt. Die Linie zickzackt, die Segmentrichtungen werden falsch, und irgendwann **faltet sie sich auf sich selbst zurück** — ab da laufen die Bogenlängen rückwärts und die Reihenfolge ist für alle kaputt. Genau das ist beim Bauen passiert, bevor der „Routensetzer" eingeführt wurde.

**Der Seitwärts-Schutz gilt nur *innerhalb* der Achse.** Jenseits des Endes wird entlang der letzten Richtung extrapoliert; in einer Kurve wächst der scheinbare Querabstand dann zwangsläufig. Würde die Schutzschwelle dort greifen, entstünde eine Todesspirale: Der Führende käme nicht mehr in die Achse, liefe dadurch weiter voraus, wodurch der Abstand weiter wächst.

**Überholen wird entprellt.** ±4 m GPS-Rauschen erzeugen sonst im Sekundentakt Fantasie-Manöver zwischen zwei Fahrern, die nebeneinander rollen. Ein Wechsel zählt erst ab 8 m Unterschied und muss 3 Sekunden halten.

### Was gemessen wurde

Gegen eine simulierte Ausfahrt mit bekannter Wahrheit — vier Fahrer, ±4 m Positionsrauschen, ±6 m Höhenrauschen, echte Alpenkehre mit 30 m Radius, zwei Anstiege:

| | Ergebnis |
|---|---|
| Reihenfolge korrekt | **100 %** (370 eindeutige Stichproben) |
| Achsenlänge | 3806 m von 3914 m wahr |
| Größter Querabstand | 2,8 m |
| Anstieg 1 Höhengewinn | +62,0 m (wahr: +60) |
| Anstieg 2 Höhengewinn | +47,9 m (wahr: +48) |
| Bergrangliste | Bergziege gewinnt beide, wie vorgegeben |
| Überholvorgänge | 4 erkannt bei 3 wahren Kreuzungen |
| Abriss des Schwächsten | erkannt |

Nachvollziehbar mit `node test/sim.js`. `node test/smoke.js` fährt zusätzlich die echte Seite im Browser durch.

---

## Vertraulichkeit

Im Standardbetrieb läuft der Austausch über einen **öffentlichen** MQTT-Broker. Deshalb verlässt keine Position das Handy im Klartext: Alles ist AES-GCM-verschlüsselt.

Der Schlüssel steht im **URL-Fragment**, hinter dem `#`. Fragmente werden von Browsern grundsätzlich **nicht an Server gesendet** — weder an den Broker, noch an deinen Webspace, noch in irgendein Log dazwischen. Der Broker sieht ausschließlich Zufallsbytes.

Raum-ID und Schlüssel werden per HKDF getrennt aus demselben Geheimnis abgeleitet, damit die öffentlich sichtbare Raum-ID nichts über den Schlüssel verrät.

**Die Kehrseite:** Wer den Link weitergibt, gibt den Schlüssel weiter. Für eine neue, saubere Gruppe: **Neue Gruppe öffnen**.

---

## Optional: eigener Relay

Der öffentliche Broker kostet nichts und braucht kein Konto, garantiert aber auch nichts. Fällt einer aus, rotiert die App automatisch zum nächsten (EMQX → HiveMQ → Mosquitto). Wenn du es verlässlicher willst:

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler deploy
```

Danach die `wss://…`-Adresse in der App unter **Gruppe → Eigener Relay** eintragen. Der Worker ist absichtlich dumm — er verteilt Bytes und speichert nichts. Lesen kann er ohnehin nichts: Die Nutzlast ist schon auf dem Handy verschlüsselt. Selbst als Betreiber siehst du in den Logs nur Zufallsbytes.

---

## Grenzen — ehrlich

**Akku.** Dauer-GPS plus aktives Display: grob 4–6 Stunden. Für lange Touren eine Powerbank ans Oberrohr.

**Bildschirmsperre.** Die App fordert einen Wake Lock an, den unterstützen aber nicht alle Browser. Sperrt der Bildschirm, drosseln viele Browser das GPS oder stoppen es. Es ist eine Web-App — das ist die Grenze gegenüber einer nativen App, und sie lässt sich nicht wegprogrammieren.

**Höhenmeter.** GPS-Höhe rauscht um mehrere Meter. Deshalb werden nur Anstiege ab etwa **200 m Länge und 12 Höhenmetern** erkannt. Eine kurze steile Rampe fällt durch. Ein Barometer könnte das, aber der Browser gibt darauf keinen Zugriff.

**Serpentinen.** Hin- und Rückweg müssen weiter auseinanderliegen als das GPS-Rauschen. Eine normale Alpenkehre (~60 m zwischen den Schenkeln) ist unproblematisch; eine extrem enge Spitzkehre kann kurz verwirren.

**Erste 150 m.** Solange die Achse zu kurz ist, schweigen Reihenfolge und Ereigniserkennung bewusst — sonst gäbe es reine Startartefakte.

**Funklöcher.** Positionen werden nicht nachgesendet. Ein verlorenes Paket ist verloren; nach spätestens 15 Sekunden erscheint „KEIN SIGNAL" am Fahrer, nach 3 Minuten fällt er aus der Liste.

---

## Wenn du weiterbasteln willst

Die Module sind bewusst getrennt und ohne Browser testbar:

| Datei | Inhalt |
|---|---|
| `js/geo.js` | Haversine, Peilung, Projektion auf Segmente |
| `js/route.js` | die Streckenachse — das Herzstück |
| `js/analytics.js` | Reihenfolge, Überholen, Antritte, Berge, Abriss |
| `js/crypto.js` | HKDF-Ableitung, AES-GCM |
| `js/net.js` | MQTT bzw. eigener Relay |
| `js/sensors.js` | GPS, Kursquelle, Wake Lock |
| `js/ui.js` / `js/app.js` | Darstellung und Verdrahtung |

Naheliegende Erweiterungen: ein QR-Code zum Link (praktisch am Treffpunkt), Sprachausgabe bei Abriss („Dirk ist 200 m zurück"), Zwischensprints auf frei gesetzten Marken, oder die Achse aus einer importierten GPX-Route vorbelegen statt sie erst zu lernen — dann stünden Reihenfolge und Berge ab Meter eins.
