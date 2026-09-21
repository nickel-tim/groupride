# Gruppenausfahrt — Web-App für gemeinsame Radtouren

Eine Seite, ein Link. Wer ihn öffnet, ist dabei: keine Installation, kein Konto, kein App Store. Läuft auf iPhone und Android im Browser.

## Was sie zeigt

Unten vier Reiter – nach dem Moment geordnet, in dem du sie brauchst: **Ausfahrt · Fahrten · Liga · Mehr**.

**Ausfahrt** – der Bildschirm für unterwegs, in zwei Zuständen:

- *Bereit* (vor dem Start): ein großer **Ausfahrt starten**-Knopf, darunter die Gruppe (Link teilen, QR-Code, neue Gruppe), ein **Ghost** (eine gespeicherte Fahrt als grauer Mitfahrer), eine **Route** (als Linie auf Karte und Profil) und **Ausprobieren** (Simulation). Ein Streifen zeigt, als wer du fährst; ein Tipp öffnet das Profil.
- *Unterwegs*: oben immer dein Tempo und dein Rang (und eine Zeile mit Segment bzw. Liga-Stand, wenn es etwas zu zeigen gibt), darunter ein Umschalter **Kompass · Karte · Profil · Ereignisse**, unten die Schnellnachrichten und **Ausfahrt beenden** (Tipp plus Rückfrage). Die Ansicht bleibt beim nächsten Start gewählt.
  - **Kompass** – Richtung und Entfernung zu jedem, darunter alle Fahrer mit Tempo und Lücke in Metern *und* Sekunden. ▲/▼ sagt, wer vor und wer hinter dir ist. Unter der Liste: **Einladen** und **QR-Code**.
  - **Karte** – die Streckenachse als glatte Kurve, darauf jeder Fahrer mit Rang, Richtungsmarke und Lücke. „Alle“ zeigt die ganze Gruppe, „Ich“ hält dich in der Mitte, „Nord“/„Kurs“ legt die Ausrichtung fest, optional mit Straßenkarte und Profilstreifen.
  - **Profil** – Höhenprofil mit allen Fahrern und die Bergsprints (Zeit und Höhenmeter pro Stunde je Anstieg).
  - **Ereignisse** – Führungsarbeit pro Fahrer, dazu Überholvorgänge, Antritte, Abrisse und Nachrichten mit Uhrzeit.

**Fahrten** – alles, was du schon gefahren bist. Drei Unterseiten: **Fahrten** (Liste, Import von GPX oder Trainingsplan), **Segmente** (automatisch erkannte Anstiege und eigene) und **Rekorde**. Ein Tipp auf eine Fahrt öffnet ihre Karte mit allen Aktionen: Bilanz, Replay, als Ghost fahren, als Route zeigen, als GPX sichern, Liga-Upload und Löschen.

**Liga** – der optionale Wettbewerb mit Freunden (siehe unten).

**Mehr** – **Ich** (Name, Farbe, Symbol), **Anzeige** (Sonnenmodus, Sprache), **Liga-Konto** (Geräte, Abmelden, Konto löschen), **Daten sichern** (GPX, JSON), **Verbindung und Datenschutz** (unter „Erweitert“ der eigene Relay).

---

## Aufspielen

Lade **eine** dieser Varianten auf deinen Webspace:

- **`ausfahrt.html`** — alles in einer Datei. Hochladen, fertig.
- **Der Ordner** (`index.html`, `css/`, `js/`) — wenn du am Code weiterbasteln willst. `python3 build.py` baut daraus wieder die Einzeldatei.

**HTTPS ist Pflicht.** Ohne verschlüsselte Verbindung geben Browser weder GPS noch Kompass frei, und die Verschlüsselung (`crypto.subtle`) fehlt ebenfalls. Kein Sonderfall der App — das ist Browser-Politik.

---

## Erste Ausfahrt

1. Seite öffnen. Beim ersten Aufruf wird automatisch ein Gruppenschlüssel erzeugt und an die Adresse gehängt (hinter dem `#`).
2. Unter **Mehr → Ich** Namen, Farbe und Symbol setzen.
3. Auf **Ausfahrt** unter „Gruppe“ **Link teilen** — per WhatsApp, Signal, wie auch immer. Alle öffnen ihn. Steht jemand neben dir: **QR-Code zeigen** und die Kamera des anderen Handys draufhalten.
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

Der Preis: Nach einem Funkloch können zwei Handys kurz leicht verschiedene Stände zeigen. Der Gewinn: kein Backend, keine Registrierung, kein Datenabfluss. (Ausnahme: die optionale **Liga**, siehe unten – die Live-Gruppe bleibt davon unberührt.)

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

### Kreisverkehr, enge Kehre, Kreuzungen und Rückwege

Die Streckenachse baut sich beim Fahren aus dem Weg des Führenden auf (der „Routensetzer“). Früher riss sie an vier Stellen ab und fand nie wieder Anschluss:

| Situation | Was schiefging | Jetzt |
|---|---|---|
| **enge Kehre, Kreisverkehr** | Der Knickschutz (Richtung kippt > 100°) hielt den echten Knick für einen GPS-Ausreißer und lehnte jeden Punkt ab. | Bei kurzem Schritt (≤ 30 m) zählt ein scharfer Knick nicht als Ausreißer; bei größerem Schritt darf er zweimal ablehnen, dann gilt er als echte Kurve. In Kurven werden die Punkte dichter (ab 8 m, wenn die Richtung um 40° kippt). |
| **Acht, zweite Runde, Kreuzung** | Wer eine ältere Stelle der Achse kreuzt, galt als „nicht vorn“ und verlängerte sie nicht mehr. | Der Fahrer, der die Achse bisher gebaut hat, setzt sie mit seiner eigenen Spur fort – ohne Rückfrage bei der Projektion. Nur ein *neuer* Setzer nach einem Wechsel muss vorn und nahe an der Achse liegen. |
| **Hin und zurück, Abzweig** | Wie oben: auf dem Rückweg liegt man auf alten Achsenstücken. | Derselbe Weg: Die Achse wächst mit dem Rückweg mit. |
| **Funkloch, Tunnel** | Ein Sprung über 250 m wurde abgelehnt – für immer. | Hält er über fünf Meldungen an, setzt die Achse dort neu an. Die Verbindung zum alten Ende wird nicht gezeichnet (kein Strich über das Nichts) und nicht zur Positionsbestimmung benutzt. |

**Kreuzungen und Überlagerungen bei der Positionsbestimmung.** Für alle anderen Fahrer wird die Position auf der Achse per Projektion bestimmt („s“ = Meter seit dem Start). Wo sich die Strecke kreuzt oder überlagert, liegen zwei Achsenstücke gleich nah; das „nächste“ wäre Zufall, und der Fahrer sprang um eine Runde vor oder zurück (in der Messung schwankte der Abstand zwischen Führendem und einem Fahrer 30 m dahinter zwischen −651 und +745 m). Jetzt zählen alle Stücke, die nicht deutlich weiter weg sind als das nächste, und unter ihnen gilt das, das zur bisherigen Position passt („Kontinuität“). Nahe am Achsenende zählt der Querabstand zur verlängerten Linie, denn der Fahrer liegt dort meist ein Stück davor.

**Wie das geprüft wurde:** mit synthetischen Spuren (GPS-Rauschen 3 m, 1 Hz) – Kreisverkehr (r = 16 und 20 m, 1,25 und 2 Runden), Kehre (r = 7 und 10 m), Hin-und-zurück mit Abzweig, Funkloch, Acht, Rundkurs mit zwei Runden – jeweils mit einem zweiten Fahrer 30 m dahinter, über mehrere Zufallsmuster. Vorher endete die Achse in fünf der acht Fälle Hunderte Meter vor dem Fahrer; jetzt sind es in allen acht weniger als 35 m, und der Abstand zum Nachfahrer bleibt zwischen −6 und 44 m (Soll: 30 m ± Rauschen). Die bisherige Prüfung mit bekannter Wahrheit (`test/sim.js`: Serpentine, zwei Berge, vier Fahrer) besteht weiterhin.

**Was noch nicht abgedeckt ist:** Zwei *verschiedene* Straßen, die sich auf weniger als etwa 25 m annähern und dabei parallel laufen, kann die Achse nur über die Kontinuität auseinanderhalten. Ein Fahrer, der die Achse auf einer Parallelstraße „mitten im Feld“ verlässt und erst viel später zurückkehrt, wird erst nach fünf Meldungen als abgehängt behandelt. Echte GPX-Dateien aus Tunneln und Hochhausschluchten habe ich nicht getestet.

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

Danach die `wss://…`-Adresse in der App unter **Mehr → Verbindung → Erweitert** eintragen. Der Worker ist absichtlich dumm — er verteilt Bytes und speichert nichts. Lesen kann er ohnehin nichts: Die Nutzlast ist schon auf dem Handy verschlüsselt. Selbst als Betreiber siehst du in den Logs nur Zufallsbytes.

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

**Straßenkarte (optional).** Standardmäßig hat die Karte keinen Hintergrund – nur Achse und Fahrer. Der Knopf **Straßenkarte** legt eine offene Karte (OpenStreetMap) darunter. Sie ist aus, bis man sie einschaltet, weil ein Kachelserver dabei die **IP-Adresse und den ungefähren Ausschnitt** sieht. Name, Gruppe und Gruppenschlüssel erfährt er nicht: Die Anfrage enthält nur Zoom und Kachelnummer, und der Schlüssel steht im Fragment (`#…`) der Adresse, das nie an einen Server geht. Beim ersten Einschalten fragt die App deshalb nach; die Wahl bleibt gespeichert. Ohne Netz bleibt der Hintergrund leer, alles andere funktioniert weiter.

Die Kacheln werden passend zu Ausschnitt und Drehung auf den Bildschirm gelegt (im Modus „Kurs“ dreht sich die Straßenkarte mit), im dunklen Theme abgedunkelt, und es werden höchstens 30 Kacheln je Bild geladen. Die Quellenangabe „© OpenStreetMap-Mitwirkende“ steht unten rechts – sie ist Pflicht.

**Eigener Kartenanbieter.** Die öffentlichen OSM-Kacheln sind für gelegentliche Nutzung gedacht ([Nutzungsrichtlinie](https://operations.osmfoundation.org/policies/tiles/)). Wird die App von vielen genutzt, gehört ein eigener oder kommerzieller Anbieter her. Die Adresse lässt sich ohne Codeänderung ersetzen: in der Browser-Konsole `localStorage.setItem('tileurl','https://…/{z}/{x}/{y}.png')` (und die Quellenangabe des Anbieters beachten).

**Bedienung wie bei jeder Karte.** Mit einem Finger (oder der Maus) verschieben, mit zwei Fingern zoomen – der Punkt zwischen den Fingern bleibt dabei stehen –, Doppeltippen zoomt hinein, das Mausrad zoomt um den Zeiger, und nach einem schnellen Wisch läuft die Karte kurz aus. Der Knopf **⌖** oben links erscheint, sobald man die Ansicht verändert hat, und stellt sie zurück (ebenso ein Tipp auf „Alle“ oder „Ich“). Verschiebung und Zoom liegen über dem automatischen Ausschnitt: Die Karte folgt der Gruppe weiter, nur eben mit deinem Versatz. Der Zoom ist auf 250 m bis 3 cm je Pixel begrenzt.

**Ruckelfreie Bewegung.** Positionen kommen nur etwa einmal pro Sekunde, die der anderen Fahrer alle zwei; gezeichnet wird mit 30 Bildern pro Sekunde. Karte und Kompass rechnen deshalb zwischen den Meldungen weiter: Aus den letzten beiden Positionen wird ein Tempo geschätzt, der Punkt gleitet damit bis zur nächsten Meldung (höchstens 2,6 s, danach steht er), und trifft sie ein, nähert er sich der echten Position in etwa einer Viertelsekunde an, statt zu springen. Dasselbe gilt für Fahrtrichtung und die Drehung im Modus „Kurs“. In einer Messung mit der Simulation sank der größte Sprung eines Punktes von 4,0 auf 0,5 px (Karte) bzw. von 1,9 auf 0,5 px (Kompass).

Das ist reine Darstellung. Rang, Lücken und Überholvorgänge rechnen weiter mit den gemeldeten Positionen. Der Preis: Die Anzeige hängt einen Sekundenbruchteil hinter der Wirklichkeit, und wer plötzlich stark bremst, rollt auf dem Bildschirm noch bis zu 2,6 s weiter, bis die nächste Meldung ihn einholt. Zum Vergleich lässt sich die Glättung in der Browser-Konsole mit `Smooth.enabled = false` abschalten. Die Zeichenschleifen laufen nur, solange Karte bzw. Kompass sichtbar sind und die Seite im Vordergrund ist.

**Die Achse ist ein Spline.** Durch die Stützpunkte (alle 20 m) läuft eine Catmull-Rom-Kurve, ohne dass ein Punkt verschoben wird. Das Achsenende liegt meist ein Stück hinter dem Führenden; die gestrichelte Verbindung schließt diese Lücke.

**Beschriftungen weichen aus.** Fahren mehrere dicht beisammen, probiert jeder Name nacheinander unten, oben, rechts, links – du zuerst, dann nach Rang. Findet sich kein Platz, bleibt die Rangzahl im Punkt.

**QR-Code:** Er kodiert denselben Link wie „Link teilen“ (inklusive Relay und Gruppenschlüssel), immer schwarz auf weiß mit Ruhezone, Fehlerkorrektur M. Erzeugt wird er lokal (Bibliothek *qrcode-generator*, MIT, in `js/qrcode.js`); es wird nichts nachgeladen. Da der Code den Schlüssel enthält, gilt dasselbe wie für den Link: nur zeigen, wenn jemand wirklich mitfahren soll.

Die Prüfbilder dazu liegen in `test/debug/` (`tiles-*.png` zeigen die Straßenkarte, `gest-*.png` die Gesten, `smooth-*.png` die Glättung).

---

## Simulation zum Ausprobieren

Unter **Ausfahrt → Ausprobieren → Simulation starten** (oder direkt mit `…/index.html?sim`) fährst du mit vier virtuellen Mitfahrern – Anna, Ben, Carla und Dirk – eine 6-km-Testrunde mit Kurven, zwei Serpentinen und drei Anstiegen. Du bist der Fünfte. Es braucht weder GPS noch Netz, und es wird nichts gesendet.

Die Leiste unten bleibt in jedem Reiter sichtbar:

| | |
|---|---|
| **×1 / ×5 / ×20** | Zeitraffer. Die Auswertung rechnet dabei mit derselben Taktung von 1 Hz wie in Echtzeit. |
| **− / +** | Deine Leistung in 10-%-Schritten (50 bis 160 %). Damit hängst du dich an oder lässt dich abhängen. |
| **Antritt!** | 15 Sekunden mit mindestens 150 %, um zu überholen oder eine Lücke aufzureißen. |

Die Positionen laufen durch denselben Weg wie echte Meldungen, samt GPS-Rauschen von rund 4 m. Kompass, Karte, Profil und Ereignisse zeigen deshalb, was sie auch bei einer echten Ausfahrt zeigen würden. Anna klettert am besten, Ben tritt vor dem ersten Berg an, Dirk baut nach etwa vier Minuten ein und wird abgerissen. Ist der Führende im Ziel, endet die Simulation; **Simulation beenden** (Knopf unten auf dem Ausfahrt-Bildschirm) setzt alles zurück.

Die Bilder zur Simulation und das Prüfskript liegen in `test/debug/`.

---

## Ghost: gegen eine frühere Fahrt oder einen Plan fahren

Der Ghost ist ein grauer Mitfahrer, der eine gespeicherte Fahrt noch einmal abfährt – mit seiner damaligen Zeit. Er erscheint überall wie ein echter Fahrer: in der Liste (mit **GHOST**-Marke), auf dem Kompass, auf der Karte (als „G“) und mit Rang und Lücke in Metern und Sekunden. „Du überholst Ghost“ taucht im Verlauf auf. Er wird nicht gesendet, und er zählt nicht zur Führungsarbeit.

**Speichern.** Jede beendete Ausfahrt und jede Simulation wird automatisch abgelegt (ab 40 Punkten, also rund einer Minute). Alle 60 Sekunden entsteht außerdem ein Entwurf: Ist der Akku leer oder der Browser abgestürzt, wird die Fahrt beim nächsten Öffnen wiederhergestellt.

**Losfahren.** Unter *Ausfahrt → Ghost → Fahrt als Ghost wählen* (oder in *Fahrten* eine Fahrt öffnen → **Als Ghost fahren**) wählen, dann die Ausfahrt starten. Der Ghost wartet an seinem Startpunkt und fährt los, sobald du näher als 40 m bist. Wer nicht exakt am selben Ort startet, nimmt **Jetzt starten** in der Ghost-Zeile auf dem Ausfahrt-Bildschirm. Mit **Ghost-Tempo** läuft er schneller oder langsamer als damals (z. B. 102 % für einen kleinen Aufschlag auf die Bestzeit). Nach dem Beenden wartet er wieder am Start.

**Quellen für einen Ghost**

| Quelle | So geht’s |
|---|---|
| eigene Fahrt | automatisch gespeichert |
| GPX **mit** Zeitstempeln | *GPX oder Trainingsplan importieren* – z. B. Export aus Strava, Garmin, Wahoo |
| GPX-Route **ohne** Zeit | dieselbe Schaltfläche, danach fragt die App nach einem Zieltempo (km/h) |
| Trainingsplan | JSON-Datei mit Abschnitten, s. u. |

**Trainingsplan.** Eine JSON-Datei mit Abschnitten aus Dauer (`min`) und Tempo (`kmh`), siehe `beispiele/intervall-4x4.json`:

```json
{ "name": "4x4 Intervalle",
  "segments": [ { "min": 10, "kmh": 24 }, { "min": 4, "kmh": 34 } ] }
```

Der Ghost fährt die Abschnitte nacheinander auf einer Strecke ab. Die Strecke kommt aus einem Feld `"gpx"` mit dem GPX-Text in der Plandatei, sonst aus der zuletzt gespeicherten Ausfahrt (die App fragt vorher nach). Endet die Strecke oder der Plan, kommt der Ghost ins Ziel. Aus einer Trainingsplattform brauchst du dafür Dauer und Zieltempo je Intervall – Leistungswerte (Watt) rechnet die App nicht in Tempo um, das hängt von Strecke und Fahrer ab.

**Grenzen, die man kennen sollte**
- Ein Ghost ist eine Ortsspur: Er fährt **dort**, wo die Aufzeichnung war. Zum Mitfahren musst du dieselbe Strecke fahren; sonst ist er einfach weit weg.
- Gespeichert wird im Browser dieses Geräts (localStorage, etwa 5 MB, das reicht für rund 15 Drei-Stunden-Fahrten). Löscht der Browser die Seitendaten, sind die Ausfahrten weg – **GPX** sichert sie.
- Der Ghost fährt seine aufgezeichnete Zeit, samt Pausen. Wer damals eine Viertelstunde am Café stand, dem steht der Ghost auch eine Viertelstunde.

Die Prüfbilder und -skripte liegen in `test/debug/`.

---

## Höhenprofil, Route, Replay, Segmente, Rekorde, Bilanz

### Höhenprofil (Ausfahrt → Profil, oder Karte → Profil)
Die Strecke „abgerollt“: waagerecht die Strecke, senkrecht die Höhe, Anstiege farbig hinterlegt, jeder Fahrer als Punkt mit Anfangsbuchstabe an seiner Stelle (grau „G“ = Ghost, Pfeil am Rand = außerhalb des Ausschnitts). Darunter steht in Worten, was als Nächstes kommt: *„Nächster Anstieg 1 in 410 m · 580 m · +33 Hm · 5,7 %“*. **Alles** zeigt die ganze Strecke, **Voraus** ein Fenster von 400 m zurück bis 4 km voraus.

Ohne Route endet das Profil beim Führenden, denn die Live-Achse entsteht erst beim Fahren. Mit einer geladenen Route (nächster Abschnitt) kennt es auch das Stück *vor* dir – dann sind die Anstiege voraus sichtbar.

### Route auf der Karte
Unter *Ausfahrt → Route → Route wählen* (oder in *Fahrten* eine Fahrt öffnen → **Als Route zeigen**): Die Strecke (eigene Fahrt, GPX-Import oder Plan) liegt dann als Linie unter der Karte, mit Start (Kreis) und Ziel (Quadrat). Ohne Positionen zeigt die Karte die Route; der Knopf **Route** in der Leiste passt den Ausschnitt an sie an. Es gibt bewusst keine Warnung bei Abweichung. Die Wahl bleibt gespeichert.

### Gruppen-Replay
**Replay** (in der Karte einer Fahrt unter *Fahrten*) spielt die Gruppenfahrt noch einmal ab: Karte, Profil, Rangliste mit Lücken und das jeweils letzte Ereignis. Die Fahrt läuft durch dieselbe Auswertung wie live – Rang, Überholen, Antritte und Abrisse sind also nicht nachgestellt, sondern zum jeweiligen Zeitpunkt berechnet. Tempo ×1/×10/×60/×300, Schieberegler zum Vor- und Zurückspulen (rückwärts wird von vorn neu gerechnet, das dauert bei langen Fahrten einen Moment; „berechne …“ zeigt es an).

Aufgezeichnet wird jeder Fahrer, dessen Meldungen ankommen, alle 2 s, kompakt (rund 12 Byte je Punkt, fünf Fahrer über drei Stunden ≈ 170 KB). Fährt man allein, gibt es nur die eigene Spur. Wer erst mitten in der Fahrt dazukam, erscheint ab dann. Ein Absturz während der Fahrt rettet die eigene Spur (Entwurf), nicht die der anderen.

### Segmente und Rekorde (Fahrten → Segmente / Rekorde)
**Segmente.** Nach jeder Fahrt werden die Anstiege automatisch als Segment gespeichert; fährst du sie wieder, wird die Zeit verglichen (Bestzeit, letzte Zeit, Verlauf, Tempo, Hm/h). Eigene Segmente legst du mit **Segment aus einer Fahrt anlegen** an: Fahrt wählen, Anfang und Ende mit den Reglern setzen, Namen vergeben – die App sucht es dann in allen gespeicherten Fahrten. Auch aus alten GPX-Dateien (Strava, Garmin), die du importierst.

*Wiedererkennen:* Die Fahrt muss in der Nähe (35 m) des Anfangs beginnen und des Endes ankommen, dazwischen dem Verlauf folgen (mittlere Abweichung ≤ 32 m) und die Länge muss ungefähr stimmen. Die Zeit wird aus dem Punkt kürzester Annäherung interpoliert; das ist auf etwa ±1–2 s genau. Die erkannten Grenzen eines Anstiegs schwanken von Fahrt zu Fahrt um einige Dutzend Meter – deshalb gilt Überlappung, nicht der Anfangspunkt, als „dasselbe Segment“.

**Rekorde ohne Ort:** schnellste 1 / 5 / 10 / 20 / 40 km, beste 5 und 20 Minuten, Spitzentempo (5 s), meiste Höhenmeter, längste Fahrt.

**Live auf dem Ausfahrt-Bildschirm:** Kommst du an ein bekanntes Segment, erscheint ein Banner mit deiner Zeit und dem Vorsprung oder Rückstand auf die Bestzeit (verglichen an zehn Zwischenzeiten). Am Ende steht das Ergebnis, bei einer Bestzeit gibt es Vibration (Android). Der Live-Wert ist vorläufig (±1–3 s); maßgeblich ist die Auswertung nach der Fahrt.

**Warum die Spur vorher geglättet wird:** Ein GPS-Fix springt um ±4 m; bei 1 Hz addieren diese Zacken rund 20–25 % Weg dazu (eine 6-km-Runde „ist“ dann 7,4 km lang). Ohne Glättung wären Distanz-Rekorde und Segmentlängen zu groß und das Wiederfinden scheiterte an der Längenprüfung. Rohdaten und GPX-Export bleiben unverändert.

**Simulation und echte Fahrten sind getrennte Welten** (Umschalter oben in Segmente/Rekorde): eine erfundene Runde soll keine echten Bestzeiten verdrängen.

### Bilanz (Bilanz in der Fahrtenliste, nach echten Fahrten automatisch)
Strecke, Fahrzeit, Ø- und Spitzentempo, Höhenmeter; eine kleine Karte der gefahrenen Linien; Führungsarbeit je Fahrer; Highlights (meiste und längste Führung, größter Antritt, höchstes Tempo, Überholmanöver und Abrisse); Anstiege mit den drei Schnellsten; deine Bestzeiten und Rekorde dieser Fahrt. **Als Bild teilen** erzeugt ein PNG (Web Share auf dem Handy, sonst Download). Das Bild enthält nur die gefahrenen Linien, keine Straßenkarte – es verrät die Form der Strecke, aber keinen Ort.

### Grenzen
- Segmente, Rekorde und Bilanz gelten für **dieses Gerät** (localStorage, ~5 MB). Löscht der Browser die Seitendaten, sind sie weg; GPX sichert nur die Fahrten selbst.
- Sehr kurze Anstiege (unter 300 m oder 20 Hm) werden nicht automatisch angelegt – die GPS-Höhe gibt das nicht her. Eigene Segmente gehen beliebig kurz (ab 150 m).
- Simulierte Höhen und GPS-Rauschen sind eine Näherung; die Genauigkeit der Segmentzeiten auf echten Straßen ist nicht gemessen.

---

## Kurznachrichten per Knopf (ohne Tippen)

Auf dem Ausfahrt-Bildschirm steht unter der Ansicht, in jeder der vier Ansichten, eine Reihe großer Knöpfe: 🛑 **Halt!**, ⏳ **Bitte warten**, 🔧 **Panne**, ⚠️ **Vorsicht!** und 💬 für das Panel mit allen neun (dazu 🚨 **Hilfe!**, 🐢 **Langsamer**, 🚀 **Schneller**, ☕ **Pause?**, 👍 **Alles klar**). Ein Tipp sendet die Nachricht an die Gruppe. Tippen muss niemand.

**Beim Empfänger** erscheint oben ein Banner mit Emoji und Name („🔧 Anja – Panne“), dringende Nachrichten (Halt, Panne, Vorsicht, Hilfe) rot und 20 Sekunden lang, die anderen 8 Sekunden. Ein Tipp aufs Banner schließt es. Dazu gibt es Vibration (nur Android; iPhone-Browser können das nicht) und einen Eintrag im **Verlauf**.

**Schutz vor Fehlbedienung**
- Nach dem Senden 2,5 Sekunden Pause, damit ein Wackeln am Lenker keine Serie auslöst.
- **Hilfe!** braucht zwei Tipps kurz hintereinander: Der erste macht den Knopf nur rot („Nochmal tippen“), der zweite sendet.
- Ohne Netz oder ohne gestartete Ausfahrt sagt die App **„Nicht gesendet“**, statt still zu scheitern.

**Was über die Leitung geht:** nur ein kurzer Code („flat“), dein Name und die Zeit – kein Text, kein Emoji, keine Position. Sender und Empfänger ordnen den Code selbst zu. Das hält die Nachricht klein, und eine neuere App mit weiteren Nachrichten stört eine ältere nicht (unbekannte Codes werden verworfen). Sie läuft durch denselben verschlüsselten Kanal wie die Positionen: Broker oder Relay sehen nur Zufallsbytes.

**Zuverlässigkeit:** Der Kanal sendet einmal und bekommt keine Bestätigung. Ein verlorenes „Halt!“ wäre schlimm, deshalb wird jede Nachricht nach 1,5 Sekunden noch einmal gesendet; eine Nachrichten-ID sorgt dafür, dass sie beim Empfänger nur einmal zählt. Nachrichten, die älter als 90 Sekunden sind, werden ignoriert.

**Simulation:** Die virtuellen Mitfahrer schicken zum Ausprobieren ein paar Nachrichten (Ben 👍, Dirk ⏳, Anna ☕, Carla ⚠️). Eigene Nachrichten bleiben in der Simulation lokal („Simulation“).

**Grenzen:** Nachrichten werden nicht gespeichert und erscheinen nicht im Replay. Wer die Seite gerade nicht geöffnet hat, verpasst sie.

---

## Symbol (Emoji) als Icon

Unter *Mehr → Ich → Symbol* wählst du aus 24 festen Symbolen (🚴 🦊 🐻 🐼 🐯 🦁 🐸 🐵 🦄 🐺 🦅 🐝 🦉 🐧 🐢 🐇 🔥 ⚡ ⭐ 🍀 🚀 🍕 ☕ 🎸) oder „–“ für keins. Getippt wird nichts. Die Farbe bleibt; das Symbol kommt dazu.

**Wo es erscheint**
- **Karte:** das Symbol steht im (etwas größeren) Punkt, der Rang wandert vor den Namen („2 Anna“) – die Rangfolge geht nicht verloren.
- **Kompass:** das Symbol im Punkt, ▲/▼ (vorne/hinten) als kleines Dreieck daneben.
- **Fahrerliste** im Kompass, **Höhenprofil** (statt des Anfangsbuchstabens), **Replay**, **Nachrichten-Banner** („🐢 Dirk – Bitte warten“) und **Bilanz** (Anzeige und Bild).

**Die Emoji sind Bilder, keine Schrift.** Ob ein Emoji als Zeichen erscheint, hängt von einer Schrift des Geräts ab. Fehlt sie (manche Linux-Systeme, Browser in WSL), bleiben Kästchen oder Lücken. Deshalb liefert die App die benötigten 33 Symbole (die 24 zur Auswahl plus die der Nachrichten und der Bestzeiten) selbst mit, als kleine SVG-Grafiken in `js/emoji.js`, zusammen rund 45 KB. Sie sehen überall gleich aus, funktionieren auch in Karte, Kompass und Profil (SVG) und im Bild der Bilanz. Sie brauchen kein Netz.

**Lizenz:** Die Grafiken sind [Twemoji](https://github.com/jdecked/twemoji), © Twitter, Inc. und Mitwirkende, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) – unverändert übernommen, nur Leerraum entfernt. Die Quellenangabe steht in der App unter „Mehr → Info“ und im Kopf von `js/emoji.js`. Wer die App weitergibt, muss sie beibehalten.

**Was über die Leitung geht:** nur die **Nummer** aus der Liste (`"j": 5`), kein Text und kein Emoji. Wer kein Symbol gewählt hat, sendet nichts Zusätzliches – die Meldung bleibt wie bisher. Beim Empfänger wird die Nummer geprüft: Eine Zahl außerhalb der Liste, ein Bruch, ein Text oder ein Objekt gelten als „kein Symbol“. Damit lässt sich nichts einschleusen (getestet mit `<img src=x onerror=…>` als „Symbol“; jedes Bild im Dokument ist ein mitgeliefertes Symbol). Die Liste darf nur hinten wachsen, sonst zeigen ältere Apps ein falsches Symbol.

**Grenzen:** Der Ghost behält sein „G“. Ältere Fahrten ohne Symbol zeigen weiter die Rangzahl. Sollen weitere Symbole dazukommen, muss die Grafik in `js/emoji.js` ergänzt werden; die Auswahl selbst steht in `UI.EMOJIS` in `js/ui.js`.

---

## Liga: Wettbewerbe im Freundeskreis (optional)

Wer mag, meldet sich unter **Liga** an und misst sich mit Freunden: Wer fährt im Monat die meisten Kilometer,
die meisten Höhenmeter, das höchste Tempo, führt am längsten? Die Live-Gruppe braucht das nicht und läuft
weiter ohne Konto.

**Anmeldung:** E-Mail eingeben, Code aus der Mail eintippen, fertig. Ein neues Handy oder gelöschte Browserdaten
sind kein Problem: gleiche Adresse, neuer Code, dasselbe Konto. Die Adresse selbst wird auf dem Server nicht
gespeichert, nur ein Prüfwert.

**Ligen:** Du legst eine an (Name, Zeitraum, Kategorien) und verschickst den Einladungslink oder QR-Code.
Zeiträume: Woche, Monat, 3 Monate, Jahr, alle N Tage oder einmalig von–bis. Am Ende jedes Zeitraums wird
der Stand festgehalten (**Ruhmeshalle**, Titel-Zähler). Fahrten dürfen bis zu 48 Stunden nach Ende noch
nachgeliefert werden. Du kannst in mehreren Ligen gleichzeitig sein; der Ersteller ist Admin.

**Fahrten:** Nach jeder Fahrt werden Kennzahlen und die Strecke hochgeladen (automatisch, wenn du das
möchtest; ohne Netz später). Auch importierte GPX-Dateien zählen. Simulation, Ghost und Pläne nie. Der Server
lehnt Unmögliches ab (GPS-Sprünge, über 72 km/h im Schnitt, doppelte Fahrten) und sagt warum.

**Kategorien (alle einzeln wählbar):**
Kilometer, Fahrzeit, Höhenmeter, Anzahl Fahrten, Fahrtage, Serie (Tage in Folge), längste Fahrt, längste
Fahrzeit, Höhenmeter an einem Tag · Topspeed, schnellster Schnitt ab 20 km, Bestzeit 10/20/40 km, beste Stunde ·
Steigrate, Kletterkönig (Punkte aus Liga-Segmenten) · Wasserträger (Führungszeit), Angriffe, Ausreißer,
gemeinsam gefahrene Kilometer, Kaffeepausen · Entdecken (neue Kartenkacheln von ca. 0,8 km).
Dazu eine **Gesamtwertung** nach Platzpunkten, **Team-Ziele** („zusammen 3000 km") und **persönliche Ziele**.

**Liga-Stand auf dem Ausfahrt-Bildschirm:** Unter dem Tempo (und auf dem Bereit-Bildschirm unter dem Startknopf) steht eine Zeile, z. B. „▲ Anna +12,4 km · Du 314 km · ▼ Ben −8,1 km".
Tippen wechselt die Kategorie. Kilometer und Fahrzeit laufen während der Fahrt live mit; die anderen zeigen
den Stand vom letzten Abruf.

**Datenschutz:** Deine Strecken sieht **nur du**. Die anderen sehen Zahlen und Fahrtnamen. Willst du eine
Fahrt zeigen, teilst du sie ausdrücklich („Fahrten → Fahrt öffnen → In der Liga teilen"); dann fehlen die ersten und letzten
300 m, damit dein Zuhause nicht auftaucht, und die anderen können sie als Ghost laden. Gruppenaufzeichnungen
(mit Positionen anderer) werden nie hochgeladen. Alles ist jederzeit löschbar (Fahrt, Liga verlassen, Konto).
Die Daten liegen bei Cloudflare, nicht Ende-zu-Ende verschlüsselt.

**Einrichten (für dich als Betreiber):** [liga/DEPLOY.md](liga/DEPLOY.md). Ohne diese Schritte zeigt die App
„Die Liga gibt es auf diesem Server nicht". Hintergrund und Entscheidungen: [liga/PLAN.md](liga/PLAN.md).

---

## Sprache: Deutsch / English

Unter **Mehr → Anzeige** schaltet der Knopf „Sprache“ zwischen Deutsch und Englisch um. Die Wahl wird auf dem
Gerät gemerkt; der Startzustand ist Deutsch. Mit `?lang=en` (oder `?lang=de`) im Link geht es auch direkt.
Der Gruppenlink zum Teilen enthält die Sprache absichtlich nicht – jeder wählt selbst.

Übersetzt ist alles, was die App anzeigt: alle Ansichten, Meldungen, Bilanz (auch das Bild), Replay, Liga, Fehlermeldungen
des Liga-Servers und die Anmelde-Mail (sie wird in der Sprache der App verschickt). Zahlen und Datumsangaben folgen der
Sprache (12,4 km / 12.4 km). Gespeicherte Ausfahrten behalten den Namen, den sie beim Speichern bekommen haben.

**Für Entwickler:** Der deutsche Text ist der Schlüssel. Im Code steht `T('Nicht verbunden')`, mit Platzhaltern
`T('noch {n} Tage', { n: 3 })`; die englischen Texte stehen in `js/i18n-en.js`. Fehlt ein Eintrag, bleibt der deutsche Text
stehen – nichts geht kaputt. Der statische Text von `index.html` wird automatisch erfasst und braucht keine Markierung.
`python3 test/i18n_check.py` (mit laufendem `wrangler dev`) findet fehlende und überzählige Einträge, klickt im englischen
Modus durch alle Ansichten und meldet Texte ohne Übersetzung oder mit deutschen Wörtern.

