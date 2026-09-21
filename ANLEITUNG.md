# Gruppenausfahrt — Web-App für gemeinsame Radtouren

Eine Seite, ein Link. Wer ihn öffnet, ist dabei: keine Installation, kein Konto, kein App Store. Läuft auf iPhone und Android im Browser.

## Was sie zeigt

**Tacho** — eigenes Tempo groß, eigene Position in der Gruppe, Kompass mit Richtung und Entfernung zu jedem, darunter alle Fahrer mit Tempo und Lücke in Metern *und* Sekunden. ▲/▼ sagt, wer vor und wer hinter dir ist.

**Karte** — die Streckenachse als glatte Kurve, darauf jeder Fahrer mit Rang, Richtungsmarke und Lücke in Metern zu dir. Anstiege liegen farbig auf der Achse, unten steht der Maßstab. „Alle“ zeigt die ganze Gruppe, „Ich“ hält dich in der Mitte (± zoomt). „Nord“ oder „Kurs“ legt fest, ob Norden oder deine Fahrtrichtung oben liegt. Fahrer außerhalb des Bildes erscheinen als Pfeil am Rand.

**Verlauf** — Führungsarbeit pro Fahrer (wer wie lange vorne war), Ablösungen, sowie Überholvorgänge, Antritte, Abrisse mit Uhrzeit.

**Berge** — automatisch erkannte Anstiege mit Rangliste: Zeit und Höhenmeter pro Stunde für jeden, der oben angekommen ist.

**Gruppe** — Name, Farbe, Link teilen, QR-Code zum Einscannen, Simulation, Sonnenmodus, Export.

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
3. **Link zum Mitfahren teilen** — per WhatsApp, Signal, wie auch immer. Alle öffnen ihn. Steht jemand neben dir: **QR-Code zum Einscannen zeigen** und die Kamera des anderen Handys draufhalten.
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

---

## Karte und QR-Code: was dahintersteckt

**Keine Kartenkacheln.** Eine Kachel-Anfrage würde dem Kartenserver verraten, wo die Gruppe fährt – und damit die Ende-zu-Ende-Verschlüsselung der Positionen unterlaufen. Die Karte zeichnet deshalb nur, was die App ohnehin weiß: die Streckenachse und die Fahrer. Sie funktioniert auch im Funkloch. Der Preis: keine Straßennamen, kein Hintergrund.

**Die Achse ist ein Spline.** Durch die Stützpunkte (alle 20 m) läuft eine Catmull-Rom-Kurve, ohne dass ein Punkt verschoben wird. Das Achsenende liegt meist ein Stück hinter dem Führenden; die gestrichelte Verbindung schließt diese Lücke.

**Beschriftungen weichen aus.** Fahren mehrere dicht beisammen, probiert jeder Name nacheinander unten, oben, rechts, links – du zuerst, dann nach Rang. Findet sich kein Platz, bleibt die Rangzahl im Punkt.

**QR-Code:** Er kodiert denselben Link wie „Link teilen“ (inklusive Relay und Gruppenschlüssel), immer schwarz auf weiß mit Ruhezone, Fehlerkorrektur M. Erzeugt wird er lokal (Bibliothek *qrcode-generator*, MIT, in `js/qrcode.js`); es wird nichts nachgeladen. Da der Code den Schlüssel enthält, gilt dasselbe wie für den Link: nur zeigen, wenn jemand wirklich mitfahren soll.

Die Prüfbilder dazu liegen in `test/debug/`.

---

## Simulation zum Ausprobieren

Unter **Gruppe → Simulation starten** (oder direkt mit `…/index.html?sim`) fährst du mit vier virtuellen Mitfahrern – Anna, Ben, Carla und Dirk – eine 6-km-Testrunde mit Kurven, zwei Serpentinen und drei Anstiegen. Du bist der Fünfte. Es braucht weder GPS noch Netz, und es wird nichts gesendet.

Die Leiste unten bleibt in jeder Ansicht sichtbar:

| | |
|---|---|
| **×1 / ×5 / ×20** | Zeitraffer. Die Auswertung rechnet dabei mit derselben Taktung von 1 Hz wie in Echtzeit. |
| **− / +** | Deine Leistung in 10-%-Schritten (50 bis 160 %). Damit hängst du dich an oder lässt dich abhängen. |
| **Antritt!** | 15 Sekunden mit mindestens 150 %, um zu überholen oder eine Lücke aufzureißen. |

Die Positionen laufen durch denselben Weg wie echte Meldungen, samt GPS-Rauschen von rund 4 m. Tacho, Karte, Verlauf und Berge zeigen deshalb, was sie auch bei einer echten Ausfahrt zeigen würden. Anna klettert am besten, Ben tritt vor dem ersten Berg an, Dirk baut nach etwa vier Minuten ein und wird abgerissen. Ist der Führende im Ziel, endet die Simulation; **Simulation beenden** setzt alles zurück.

Die Bilder zur Simulation und das Prüfskript liegen in `test/debug/`.
