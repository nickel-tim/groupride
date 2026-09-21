/* ============================================================
 * app.js -- Verdrahtung
 * ============================================================
 * Eine Eigenschaft ist wichtig zu verstehen: Es gibt KEINEN Server,
 * der die Wahrheit kennt. Jedes Handy baut seine eigene Streckenachse
 * und rechnet selbst. Die absoluten Bogenlaengen unterscheiden sich
 * deshalb von Geraet zu Geraet (jede Achse startet dort, wo dieses
 * Handy die erste Position gesehen hat) -- die DIFFERENZEN, und damit
 * Reihenfolge, Luecken und Bergzeiten, sind auf allen Geraeten gleich.
 *
 * Der Preis: Bei Funkloechern koennen zwei Handys kurz
 * unterschiedliche Staende zeigen. Der Gewinn: kein Backend, keine
 * Registrierung, kein Datenabfluss.
 * ============================================================ */

(function () {
    'use strict';

    var SEND_MS   = 2000;     // Sendetakt: oefter braucht niemand, und der
                              // oeffentliche Broker soll nicht leiden
    var RENDER_MS = 200;

    var route = new Route();
    var an    = new Analytics(route);

    var me = { id: null, name: null, colorIdx: 0, emoji: null };     // emoji: Nummer aus UI.EMOJIS oder null
    var secret = null, key = null, topic = null;
    var running = false;
    var lastSend = 0;
    var myFix = null;         // letzte eigene Position
    var myTrack = [];         // fuer den GPX-Export
    var seenEvents = 0, seenClimbs = 0;
    var relayUrl = null;
    // Kartenansicht: "Alle" passt den Ausschnitt an die Gruppe an, "Ich" haelt
    // dich in der Mitte; "Kurs" dreht die Karte so, dass deine Fahrtrichtung oben liegt.
    var liveMap = null;                               // Karte (MapCtl), wird beim Laden aufgebaut
    var lastMap = null;                               // letzter Stand fuer die Zeichenschleife

    // Geplante Route (Ueberlagerung): eine gespeicherte Fahrt/GPX-Strecke als Linie auf der Karte
    //   { id, name, route (Route), overlay {name,len,pts,route}, climbs, gain }
    var plan = null;
    var profMode = null;                              // 'all' | 'ahead' (null = automatisch)
    var planHint = {};                                // letzte Position je Fahrer auf der Route

    // Simulation: eigener Zustand, sie ersetzt GPS und Netz komplett
    var sim = null, simTimer = null, simWarp = 1, simHeading = null, simSaved = false;

    // Ghost: eine gespeicherte Fahrt als virtueller Mitfahrer (siehe ghost.js)
    //   state: 'armed' wartet auf den Start, 'running' faehrt, danach faellt er weg
    var ghost = null;
    var GHOST_START_M = 40;       // so nah am Ghost-Start muss man sein, damit er losfaehrt
    var GHOST_COLOR = '#9aa7ad';  // mittleres Grau: auf dunklem und hellem Grund lesbar

    function $(id) { return document.getElementById(id); }
    function store(k, v) { try { if (v === undefined) return localStorage.getItem(k);
                                 localStorage.setItem(k, v); } catch (e) { return null; } }

    /* ---------------- Identitaet ---------------- */
    function initIdentity() {
        me.id = store('rid');
        if (!me.id) { me.id = Math.random().toString(36).slice(2, 10); store('rid', me.id); }
        me.name = store('rname') || 'Fahrer ' + me.id.slice(0, 3);
        me.colorIdx = parseInt(store('rcol') || '0', 10) % UI.COLORS.length;
        var em = store('remoji');
        me.emoji = (em === null || em === '') ? null : UI.validEmoji(parseInt(em, 10));
        $('inName').value = me.name;
    }

    function myColor() { return UI.COLORS[me.colorIdx]; }

    /* ---------------- Raum aus dem URL-Fragment ----------------
       Das Fragment (hinter dem #) wird vom Browser NICHT an Server
       gesendet. Der Schluessel bleibt deshalb zwischen den Handys. */
    async function initRoom() {
        var frag = new URLSearchParams(location.hash.replace(/^#/, ''));
        secret = frag.get('k');
        if (!secret || secret.length < 20) {
            secret = Crypt.newSecret();
            frag.set('k', secret);
            history.replaceState(null, '', location.pathname + location.search +
                                 '#' + frag.toString());
        }
        var q = new URLSearchParams(location.search);
        relayUrl = q.get('relay') || store('relay') || null;
        if (relayUrl) $('inRelay').value = relayUrl;

        topic = 'groupride/v1/' + (await Crypt.roomId(secret));
        key   = await Crypt.aesKey(secret);
        renderLinkNote();
        renderNetNote();
    }

    /* Der Relay MUSS im geteilten Link stehen: Wer auf dem oeffentlichen
       Broker landet, waehrend andere den eigenen Relay nutzen, sieht
       niemanden -- beide Wege sind getrennte Welten. */
    function shareLink() {
        var q = new URLSearchParams(location.search);
        if (relayUrl) q.set('relay', relayUrl); else q.delete('relay');
        q.delete('sim');
        var qs = q.toString();
        return location.origin + location.pathname + (qs ? '?' + qs : '') + location.hash;
    }

    function renderLinkNote() {
        $('linkNote').innerHTML =
            'Wer diesen Link öffnet, ist in der Gruppe – ohne Installation, ohne Konto.' +
            '<br><br><code>' + UI.escapeHtml(shareLink()) + '</code>';
    }

    function renderNetNote() {
        var m = Net.mode();
        $('netNote').innerHTML = m === 'relay'
            ? 'Eigener Relay: <code>' + UI.escapeHtml(relayUrl) + '</code>'
            : 'Öffentlicher MQTT-Broker. Kein Konto nötig, aber auch keine ' +
              'Verfügbarkeitsgarantie. Fällt einer aus, wird automatisch der nächste probiert.';
        $('privacyNote').innerHTML =
            '<b>Zur Vertraulichkeit:</b> Positionen verlassen das Handy nur ' +
            'AES-GCM-verschlüsselt. Der Schlüssel steht hinter dem <code>#</code> der ' +
            'Adresse und wird von Browsern nie an einen Server gesendet – der Broker ' +
            'sieht ausschließlich Zufallsbytes. Wer den Link weitergibt, gibt allerdings ' +
            'auch den Schlüssel weiter.<br><br><b>Straßenkarte:</b> Nur wenn du sie unter „Karte“ ' +
            'einschaltest, lädt dein Handy Kartenbilder von tile.openstreetmap.org. Der Anbieter ' +
            'sieht dann IP-Adresse und ungefähren Ausschnitt, nichts von der Gruppe.';
    }

    /* ---------------- Netz ---------------- */
    function startNet() {
        Net.start({
            topic: topic,
            relayUrl: relayUrl,
            onMessage: onWire,
            onState: function (s, detail) {
                if (s === 'online')      UI.renderNet('online', 'verbunden');
                else if (s === 'loading')  UI.renderNet('wait', 'lade Netzwerkteil …');
                else if (s === 'connecting')UI.renderNet('wait', 'verbinde …');
                else if (s === 'retry')    UI.renderNet('wait', 'nächster Broker …');
                else if (s === 'error')    UI.renderNet('off', UI.escapeHtml(detail || 'Fehler'));
            }
        });
    }

    async function onWire(str) {
        var m = await Crypt.open(key, str);
        // null = fremde Gruppe oder beschaedigt. Verwerfen, nicht melden.
        if (!m || !m.i || m.i === me.id) return;
        if (m.q) { Msg.receive(m); return; }                      // Kurznachricht statt Position
        if (typeof m.la !== 'number' || typeof m.lo !== 'number') return;

        var emo = UI.validEmoji(m.j);                        // unbekannte/ungueltige Nummer = kein Symbol
        Recorder.add(m.i, typeof m.n === 'string' ? m.n.slice(0, 14) : null, UI.COLORS[(m.c | 0) % UI.COLORS.length],
                     (typeof m.t === 'number') ? m.t : Date.now(), m.la, m.lo, (typeof m.e === 'number') ? m.e : null, emo);
        an.ingest(m.i, {
            lat: m.la, lon: m.lo,
            ele: (typeof m.e === 'number') ? m.e : null,
            speed: (typeof m.v === 'number') ? m.v : 0,
            heading: (typeof m.h === 'number') ? m.h : null,
            acc: (typeof m.a === 'number') ? m.a : null,
            t: (typeof m.t === 'number') ? m.t : Date.now(),
            name: typeof m.n === 'string' ? m.n.slice(0, 14) : null,
            color: UI.COLORS[(m.c | 0) % UI.COLORS.length],
            emoji: emo
        });
    }

    /* Kurznachricht senden: 'sent' | 'sim' | 'offline'. Der Kanal ist "einmal senden, keine
       Bestaetigung" -- ein verlorenes "Halt!" waere schlimm, deshalb nach 1,5 s noch einmal;
       die Nachrichten-ID sorgt dafuer, dass sie beim Empfaenger nur einmal zaehlt. */
    function sendMsgWire(code, mid) {
        if (sim) return 'sim';                                     // in der Simulation geht nichts raus
        if (!key || !running || !Net.online()) return 'offline';
        var payload = { i: me.id, n: me.name, c: me.colorIdx, t: Date.now(), q: code, mid: mid };
        if (me.emoji !== null) payload.j = me.emoji;
        Crypt.seal(key, payload).then(Net.publish);
        setTimeout(function () { Crypt.seal(key, payload).then(Net.publish); }, 1500);
        return 'sent';
    }

    function sendMine() {
        if (!myFix || !key) return;
        var c = myFix.coords;
        var h = Sensors.heading();
        var pkt = {
            i: me.id, n: me.name, c: me.colorIdx,
            la: +c.latitude.toFixed(6), lo: +c.longitude.toFixed(6),
            e: (c.altitude !== null && !isNaN(c.altitude)) ? Math.round(c.altitude) : null,
            v: Math.round((c.speed || 0) * 100) / 100,
            h: h.deg === null ? null : Math.round(h.deg),
            a: c.accuracy !== null ? Math.round(c.accuracy) : null,
            t: myFix.timestamp || Date.now()
        };
        if (me.emoji !== null) pkt.j = me.emoji;             // nur die Nummer; ohne Symbol bleibt die Meldung wie bisher
        Crypt.seal(key, pkt).then(Net.publish);
    }

    /* ---------------- GPS ---------------- */
    function onFix(pos) {
        myFix = pos;
        var c = pos.coords;
        var h = Sensors.heading();

        an.ingest(me.id, {
            lat: c.latitude, lon: c.longitude,
            ele: (c.altitude !== null && !isNaN(c.altitude)) ? c.altitude : null,
            speed: (c.speed !== null && !isNaN(c.speed) && c.speed > 0) ? c.speed : 0,
            heading: h.deg, acc: c.accuracy,
            t: pos.timestamp || Date.now(),
            name: me.name, color: myColor(), emoji: me.emoji
        });
        an.riders[me.id].self = true;

        SegUI.feed({ lat: c.latitude, lon: c.longitude, t: pos.timestamp || Date.now() });
        Recorder.add(me.id, me.name, myColor(), pos.timestamp || Date.now(), c.latitude, c.longitude,
                     (c.altitude !== null && !isNaN(c.altitude)) ? c.altitude : null, me.emoji);
        var last = myTrack[myTrack.length - 1];
        if (!last || (pos.timestamp - last.t) > 1500) {
            myTrack.push({ lat: c.latitude, lon: c.longitude,
                           ele: (c.altitude !== null && !isNaN(c.altitude)) ? c.altitude : null,
                           t: pos.timestamp || Date.now() });
        }

        var now = Date.now();
        if (now - lastSend >= SEND_MS) { lastSend = now; sendMine(); }
    }

    /* ---------------- Renderloop ---------------- */
    function render() {
        var ord = an.tick(sim ? sim.now() : undefined);
        var mine = an.riders[me.id];
        var h = sim ? { deg: simHeading, src: 'Sim' } : Sensors.heading();

        UI.renderHeadingSrc(h);
        UI.renderSpeed(mine && mine.lat !== null ? mine.speed : null,
                       mine ? !an.isStale(mine) : false);

        var pos = 0;
        for (var i = 0; i < ord.length; i++) if (ord[i].id === me.id) pos = i + 1;
        UI.renderRank(pos, ord.length);

        // --- Kompass und Karte: gezeichnet in eigenen Schleifen (glatt, siehe smooth.js);
        //     hier nur der aktuelle Stand fuer sie ---
        lastCompass = { ord: ord, heading: h.deg };
        ensureCompassLoop();
        lastMap = { ord: ord, heading: h.deg };
        if (isActive('map')) liveMap.ensureLoop();
        renderProfiles();

        // --- Liste: Luecke immer relativ zu MIR, das ist die Zahl,
        //     die man beim Fahren wissen will ---
        var rows = ord.map(function (r) {
            var gapM = null, gapS = null;
            if (mine && mine.s !== null && r.s !== null && r.id !== me.id) {
                gapM = r.s - mine.s;
                gapS = gapM / Math.max(2, r.s > mine.s ? mine.speed : r.speed);
            }
            return {
                name: r.name || r.id, color: r.color || UI.COLORS[1], emoji: UI.emojiOf(r.emoji),
                me: r.id === me.id, speed: r.lat === null ? null : r.speed,
                gapM: gapM, gapS: gapS, ghost: !!r.ghost,
                dropped: r.dropped, stale: r.ghost ? false : an.isStale(r)
            };
        });
        UI.renderRiders(rows);

        // --- Führungsarbeit ---
        var tot = 0; ord.forEach(function (r) { if (!r.ghost) tot += r.frontMs; });
        UI.renderFrontWork(ord.filter(function (r) { return r.frontMs > 0 && !r.ghost; })
            .sort(function (a, b) { return b.frontMs - a.frontMs; })
            .map(function (r) {
                return { name: r.name || r.id, color: r.color || UI.COLORS[1],
                         frontMs: r.frontMs, share: tot ? r.frontMs / tot : 0 };
            }));

        // --- Ereignisse ---
        UI.renderEvents(an.events.map(function (e) { return { t: e.t, type: e.type,
                                                              text: eventText(e) }; }));

        // --- Berge ---
        UI.renderClimbs(an.climbs.map(function (c) {
            return { no: c.no, gain: c.gain || 0, len: c.len || 0, grade: c.grade || 0,
                     ranking: an.climbRanking(c).map(function (x) {
                         var rr = an.riders[x.id];
                         return { name: x.name, ms: x.ms, vam: x.vam,
                                  color: (rr && rr.color) || UI.COLORS[1] };
                     }) };
        }));

        if (an.events.length > seenEvents && !isActive('log'))
            UI.badge('bdgLog', an.events.length - seenEvents);
        if (an.climbs.length > seenClimbs && !isActive('climbs'))
            UI.badge('bdgClimbs', an.climbs.length - seenClimbs);

        if (running && !Net.online()) UI.renderNet('wait', 'kein Netz – nur eigene Daten');
    }

    /* ---------------- Kompass ----------------
       Wie die Karte: Positionen ~1x pro Sekunde, gezeichnet wird mit ~30 Bildern
       (glatt, siehe smooth.js). Der Kompass rechnet in Distanz und Peilung von
       DIR aus; beides kommt hier aus den geglaetteten Positionen, nicht aus den
       rohen Meldungen -- sonst wackeln Punkte und Nadel im Sekundentakt und mit
       dem GPS-Rauschen. */
    var lastCompass = null, compassTrk = Smooth.create(), compassTmpFrame = null;
    var compassLoopOn = false, compassLoopT = 0;

    function drawCompass(ord, heading) {
        var mine = an.riders[me.id], now = performance.now();
        if (!mine || mine.fLat === null) {
            UI.renderCompass(mine, [], Smooth.heading(compassTrk, heading, now));
            return;
        }
        // Bezugssystem der Meter: das der Route, sonst ein vorlaeufiges um dich
        if (!route.frame && !compassTmpFrame) compassTmpFrame = Geo.frame(mine.fLat, mine.fLon);
        var frame = route.frame || compassTmpFrame;
        Smooth.reset(compassTrk, frame);

        var seen = {}, pos = {};
        ord.forEach(function (r) {
            if (r.fLat === null) return;
            var sm = Smooth.follow(compassTrk, r, frame.toXY(r.fLat, r.fLon), now,
                                   !r.ghost && an.isStale(r));
            seen[r.id] = true; pos[r.id] = sm;
        });
        Smooth.prune(compassTrk, seen);

        var m = pos[me.id], peers = [];
        if (m) {
            ord.forEach(function (r) {
                var p = pos[r.id];
                if (!p || r.id === me.id) return;
                var dx = p.x - m.x, dy = p.y - m.y;      // x = Ost, y = Nord
                peers.push({
                    color: r.color || UI.COLORS[1], emoji: UI.emojiOf(r.emoji),
                    short: (r.name || r.id).slice(0, 6),
                    dist: Math.hypot(dx, dy),
                    bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
                    ahead: (r.s !== null && mine.s !== null) ? (r.s > mine.s) : null,
                    stale: r.ghost ? false : an.isStale(r)
                });
            });
        }
        UI.renderCompass(mine, peers, Smooth.heading(compassTrk, heading, now));
    }

    function compassLoop(ts) {
        if (!isActive('tacho') || document.hidden) { compassLoopOn = false; return; }
        if (ts - compassLoopT >= 33 && lastCompass) { compassLoopT = ts; drawCompass(lastCompass.ord, lastCompass.heading); }
        requestAnimationFrame(compassLoop);
    }
    function ensureCompassLoop() {
        if (compassLoopOn || !isActive('tacho')) return;
        compassLoopOn = true;
        requestAnimationFrame(compassLoop);
    }

    function showQr() {
        var url = shareLink();
        try {
            $('qrBox').innerHTML = QR.svg(url);
        } catch (e) {
            // Link zu lang fuer die groesste QR-Version (Relay-URL mit Riesenpfad)
            $('qrBox').innerHTML = '<div class="empty">Der Link ist zu lang für einen QR-Code. ' +
                                   'Bitte „Link zum Mitfahren teilen“ nutzen.</div>';
        }
        $('qrOverlay').hidden = false;
    }

    function eventText(e) { return UI.eventText(an, e); }

    /* ---------------- Simulation ---------------- */
    function simStart() {
        if (running) { alert('Erst die laufende Ausfahrt beenden.'); return; }
        route = new Route(); an = new Analytics(route);
        seenEvents = 0; seenClimbs = 0;
        myTrack = []; simSaved = false; Recorder.reset(me.id);
        SegUI.startLive('sim'); SegUI.setWorld('sim');
        armGhostAgain();
        var others = UI.COLORS.filter(function (c, i) { return i !== me.colorIdx; });
        sim = SimMode.create({ meId: me.id, meName: me.name, meColor: myColor(), meEmoji: me.emoji,
                               colors: others.slice(0, 4) });
        simWarp = 1;
        $('simbar').hidden = false;
        $('btnSim').textContent = 'Simulation beenden';
        $('btnSim').className = 'btn stop';
        UI.renderNet('wait', 'Simulation – nichts wird gesendet');
        /* Vorlauf: erst ab ~150 m Streckenachse sind Reihenfolge und Luecken
           belastbar. Ohne ihn stuenden beim Start alle bei "0 m". */
        simAdvance(25);
        syncSimBar();
        simTimer = setInterval(simTick, 1000);
        render();
        showView('tacho');
    }

    function simStop() {
        clearInterval(simTimer); simTimer = null; SegUI.stopLive();
        if (!simSaved && sim && sim.t >= 60) { simSaved = true; finishRecording('sim'); }
        armGhostAgain();
        sim = null; simHeading = null;
        // Zustand der Simulation nicht in eine echte Ausfahrt mitnehmen
        route = new Route(); an = new Analytics(route);
        seenEvents = 0; seenClimbs = 0;
        $('simbar').hidden = true;
        $('btnSim').textContent = 'Simulation starten';
        $('btnSim').className = 'btn';
        UI.renderNet('off', 'bereit – unter „Gruppe“ starten');
        renderGhostUi();
        render();
    }

    /* Jede Wall-Sekunde: warp simulierte Sekunden. Eine Meldung pro
       simulierter Sekunde (1 Hz wie echtes GPS), damit die Auswertung
       im Zeitraffer nicht anders rechnet als in Echtzeit. */
    function simAdvance(n) {
        for (var i = 0; i < n && !sim.done; i++) {
            sim.step().forEach(function (m) {
                an.ingest(m.id, { lat: m.lat, lon: m.lon, ele: m.ele, speed: m.speed,
                                  heading: m.heading, acc: m.acc, t: m.t,
                                  name: m.name, color: m.color, emoji: m.me ? me.emoji : m.emoji });
                Recorder.add(m.id, m.name, m.color, m.t, m.lat, m.lon, m.ele, m.me ? me.emoji : m.emoji);
                if (m.me) {
                    SegUI.feed({ lat: m.lat, lon: m.lon, t: m.t });
                    an.riders[m.id].self = true; simHeading = m.heading;
                    myTrack.push({ lat: m.lat, lon: m.lon, ele: m.ele, t: m.t });
                }
            });
            ghostStep(sim.now(), sim.t * 1000);
            an.tick(sim.now());
            sim.dueMessages().forEach(function (m) { Msg.receive(m); });
        }
        if (sim.done && !simSaved) { simSaved = true; finishRecording('sim'); }
    }

    function simTick() {
        if (!sim) return;
        simAdvance(simWarp);
        syncSimBar();
        render();
    }

    function syncSimBar() {
        if (!sim) return;
        $('simEffort').textContent = Math.round(sim.effort * 100) + ' %';
        $('btnSimAttack').classList.toggle('on', sim.boosting());
        document.querySelectorAll('#simbar [data-warp]').forEach(function (b) {
            b.classList.toggle('on', +b.dataset.warp === simWarp);
        });
        var km = (sim.meS() / 1000).toFixed(1), tot = (sim.length / 1000).toFixed(1);
        $('simMsg').textContent = sim.done
            ? 'Ziel erreicht – Simulation zu Ende. Beenden und neu starten zum Wiederholen.'
            : 'Du: km ' + km + ' von ' + tot + ' · Zeit ' + UI.fmtDur(sim.t * 1000);
    }

    /* ---------------- Aufzeichnung ---------------- */
    function setRideMsg(t) { $('rideMsg').textContent = t || ''; }

    function finishRecording(src) {
        if (myTrack.length < Rides.MIN_POINTS) { Rides.clearDraft(); return; }
        var r = Rides.save({ src: src, pts: myTrack, group: Recorder.riderCount() >= 2 ? Recorder.pack() : null });
        Rides.clearDraft();
        setRideMsg(r.ok ? '„' + r.rec.name + '“ gespeichert – ' + UI.fmtDist(r.rec.dist) + ', ' +
                          UI.fmtDur(r.rec.dur) + '. Unten als Ghost verwendbar.'
                        : r.err);
        renderRides();
        if (r.ok) analyseRide(r.rec);
    }

    /* Nach der Fahrt: Segmente finden, Bestzeiten und Rekorde nachfuehren. Laeuft in kleinen
       Happen im Hintergrund (bei langen Fahrten einige Sekunden), Ergebnis in lastReport. */
    var lastReport = null;
    function analyseRide(rec) {
        lastReport = null;
        setRideMsg('„' + rec.name + '“ gespeichert. Auswertung läuft …');
        return Segments.processRide(rec).then(function (rep) {
            lastReport = rep ? { rideId: rec.id, rep: rep } : null;
            if (rep) SegUI.setReport(rep);
            var note = '„' + rec.name + '“ gespeichert';
            if (rep) {
                var pb = rep.efforts.filter(function (e) { return e.isPB && !e.first; }).length;
                var firsts = rep.efforts.filter(function (e) { return e.first; }).length;
                if (pb) note += ' · ' + pb + ' neue Bestzeit' + (pb > 1 ? 'en' : '');
                if (firsts) note += ' · ' + firsts + (firsts > 1 ? ' neue Segmente' : ' neues Segment');
                if (rep.records.length) note += ' · ' + rep.records.length + ' Rekord' + (rep.records.length > 1 ? 'e' : '');
            }
            setRideMsg(note + '.');
            if (typeof SegUI !== 'undefined') SegUI.refresh();
            // Echte Fahrten: die Bilanz gleich zeigen. Simulationen nur auf Knopfdruck.
            if (rec.src === 'ride' && rec.dur > 120000 && rec.dist > 500) openSummary(rec.id);
        }, function (e) { setRideMsg('Auswertung fehlgeschlagen: ' + (e && e.message || e)); });
    }

    /* ---------------- Bilanz ---------------- */
    var sumData = null;
    function openSummary(id) {
        $('sumOverlay').hidden = false; $('sumBusy').hidden = false; $('sumBody').innerHTML = ''; $('sumMsg').textContent = '';
        sumData = null;
        Summary.forRide(id, function (f) { $('sumBusy').textContent = 'Bilanz wird berechnet … ' + Math.round(f * 100) + ' %'; }).then(function (d) {
            sumData = d;
            $('sumBusy').hidden = true;
            $('sumBody').innerHTML = Summary.html(d);
            $('sumThumb').innerHTML = '<svg viewBox="0 0 340 190" preserveAspectRatio="xMidYMid meet">' + Summary.thumbSvg(d, 340, 190) + '</svg>';
        }, function (e) { $('sumBusy').hidden = true; $('sumBody').textContent = 'Bilanz nicht möglich: ' + (e && e.message || e); });
    }

    /* Entwurf alle 60 s: Faellt der Akku waehrend der Fahrt aus oder stuerzt
       der Browser ab, ist die Fahrt beim naechsten Oeffnen nicht weg. */
    function saveDraftNow() {
        if ((running || sim) && myTrack.length) Rides.saveDraft(sim ? 'sim' : 'ride', myTrack);
    }

    function recoverDraft() {
        var d = Rides.draft();
        if (!d) return;
        Rides.clearDraft();
        var pts = Rides.unpack(d);
        if (pts.length < Rides.MIN_POINTS) return;
        var r = Rides.save({ src: d.src || 'ride', pts: pts,
                             name: 'Wiederhergestellt ' + Rides.fmtDate(pts[0].t) });
        setRideMsg(r.ok ? 'Eine nicht beendete Fahrt wurde wiederhergestellt.' : r.err);
    }

    /* ---------------- Ghost ---------------- */
    function ghostFactor() { return parseFloat($('ghostPace').value) || 1; }

    function armGhost(id) {
        var rec = Rides.get(id);
        if (!rec) { setRideMsg('Diese Ausfahrt ist nicht mehr gespeichert.'); return; }
        dropGhostRider();
        ghost = { rec: rec, g: Ghost.make(rec, ghostFactor()), state: 'armed', t0: null };
        renderGhostUi(); renderRides();
    }

    // Beim Start einer neuen Fahrt/Simulation wartet der Ghost wieder am Start
    function armGhostAgain() {
        if (!ghost) return;
        dropGhostRider();
        ghost.g = Ghost.make(ghost.rec, ghostFactor());
        ghost.state = 'armed'; ghost.t0 = null;
        renderGhostUi();
    }

    function dropGhost() {
        dropGhostRider(); ghost = null;
        renderGhostUi(); renderRides();
    }

    function dropGhostRider() { if (an && an.riders && an.riders.ghost) delete an.riders.ghost; }

    /* Ein Schritt: stamp = Zeitstempel der Meldung, clock = Ghost-Uhr in ms
       (Echtzeit, oder Simulationszeit -- dann laeuft der Ghost im Zeitraffer mit). */
    function ghostStep(stamp, clock) {
        if (!ghost || ghost.state === 'done') return;
        if (ghost.state === 'armed') {
            var mine = an.riders[me.id];
            if (!mine || mine.lat === null) return;
            if (Geo.distance(mine.lat, mine.lon, ghost.g.start.lat, ghost.g.start.lon) > GHOST_START_M) return;
            ghost.state = 'running'; ghost.t0 = clock;
        }
        var r = ghost.g.at((clock - ghost.t0) / 1000);
        if (r.done) {
            ghost.state = 'done'; ghost.doneAt = (clock - ghost.t0) / 1000;
            dropGhostRider();
            return;
        }
        an.ingest('ghost', { lat: r.lat, lon: r.lon, ele: r.ele, speed: r.speed,
                             heading: r.heading, acc: 5, t: stamp,
                             name: 'Ghost', color: GHOST_COLOR });
        an.riders.ghost.ghost = true;
    }

    function startGhostNow() {
        if (!ghost || ghost.state !== 'armed') return;
        if (!running && !sim) { setRideMsg('Erst eine Ausfahrt oder die Simulation starten.'); return; }
        ghost.state = 'running';
        ghost.t0 = sim ? sim.t * 1000 : Date.now();
        renderGhostUi();
    }

    function renderGhostUi() {
        var st = $('ghostState'), now = $('btnGhostNow'), off = $('btnGhostOff');
        $('ghostPace').disabled = !!ghost && ghost.state === 'running';
        if (!ghost) {
            st.innerHTML = 'Kein Ghost gewählt. Unter „Gespeicherte Ausfahrten“ eine Fahrt als ' +
                           'Ghost wählen, dann fährt sie als grauer Mitfahrer mit – mit Rang, Lücke ' +
                           'und Karte wie jeder andere.';
            now.hidden = off.hidden = true;
            return;
        }
        off.hidden = false;
        var nm = '<b>' + UI.escapeHtml(ghost.rec.name) + '</b>';
        if (ghost.state === 'armed') {
            var mine = an.riders[me.id], txt;
            if (!running && !sim) {
                txt = 'wartet. Er startet, sobald du die Ausfahrt startest und am Startpunkt bist (' + GHOST_START_M + ' m).';
            } else if (mine && mine.lat !== null) {
                var d = Geo.distance(mine.lat, mine.lon, ghost.g.start.lat, ghost.g.start.lon);
                txt = 'wartet am Startpunkt – noch ' + UI.fmtDist(d) + ' entfernt. Er startet automatisch ab ' +
                      GHOST_START_M + ' m.';
            } else { txt = 'wartet auf deine Position.'; }
            st.innerHTML = 'Ghost ' + nm + ' ' + txt;
            now.hidden = !(running || sim);
        } else if (ghost.state === 'running') {
            var t = ((sim ? sim.t * 1000 : Date.now()) - ghost.t0) / 1000;
            st.innerHTML = 'Ghost ' + nm + ' fährt: ' + UI.fmtDur(t * 1000) + ' von ' + UI.fmtDur(ghost.g.dur * 1000) + '.';
            now.hidden = true;
        } else {
            st.innerHTML = 'Ghost ' + nm + ' ist nach ' + UI.fmtDur(ghost.doneAt * 1000) + ' im Ziel.';
            now.hidden = true;
        }
    }

    /* ---------------- Geplante Route (Ueberlagerung) ----------------
       Jede gespeicherte Strecke -- eigene Fahrt, GPX-Import, Trainingsplan -- laesst sich
       als Linie unter die Karte legen. Es gibt keine Warnung bei Abweichung: die Linie
       ist ein Wegweiser, keine Vorschrift. Mit einer Route kennt das Hoehenprofil auch
       das Stueck VOR dem Fuehrenden (die Live-Achse endet ja bei ihm). */
    function setPlan(id) {
        var rec = Rides.get(id);
        if (!rec) { plan = null; return; }
        var pts = Track.thin(Rides.unpack(rec), 8);
        var rt = Route.fromPoints(pts, 10);
        rt.smoothElevation();
        plan = {
            id: id, name: rec.name, route: rt,
            climbs: new Analytics(rt).scanClimbs(),
            gain: Track.gain(pts),
            overlay: { name: rec.name, len: rt.length(), route: rt,
                       pts: rt.pts.map(function (p) { return { lat: p.lat, lon: p.lon, ele: p.ele, s: p.s }; }) }
        };
        store('plan', id);
        planHint = {};
        syncProfMode();
    }
    function clearPlan() { plan = null; store('plan', ''); planHint = {}; syncProfMode(); }

    /* ---------------- Hoehenprofil ----------------
       Mit Route: das Profil der ganzen Route, die Fahrer darauf projiziert (auch vor dem
       Fuehrenden). Ohne: die Live-Achse, sie endet beim Fuehrenden. */
    function planS(r) {
        var pr = plan.route.project(r.fLat, r.fLon, planHint[r.id]);
        if (!pr || pr.offset > 150) return null;            // weit ab der Route: nicht darauf zeigen
        planHint[r.id] = pr.s;
        return Math.max(0, Math.min(plan.route.length(), pr.s));
    }

    function profileInput() {
        var ord = lastMap ? lastMap.ord : [], riders = [], meS = null;
        function add(r, sv) {
            if (sv === null || sv === undefined) return;
            riders.push({ id: r.id, name: r.name, color: r.color, emoji: UI.emojiOf(r.emoji), s: sv, self: r.id === me.id,
                          ghost: !!r.ghost, stale: !r.ghost && an.isStale(r) });
            if (r.id === me.id) meS = sv;
        }
        if (plan) {
            ord.forEach(function (r) { if (r.fLat !== null) add(r, planS(r)); });
            return { route: plan.route, riders: riders, climbs: plan.climbs, meS: meS };
        }
        ord.forEach(function (r) { add(r, r.s); });
        return { route: route, riders: riders, climbs: an.climbs, meS: meS };
    }

    function renderProfiles() {
        var onClimbs = isActive('climbs') && !$('sub-now').hidden;
        var onMap = isActive('map') && !$('mapProf').hidden;
        if (!onClimbs && !onMap) return;
        var inp = profileInput();
        inp.mode = profMode || (plan ? 'ahead' : 'all');
        if (onClimbs) {
            var i1 = Profile.render($('climbProfSvg'), inp);
            if (i1) $('climbProfInfo').textContent = Profile.describe(i1.next) ||
                (plan ? 'Route „' + plan.name + '“ · ' + UI.fmtDist(plan.route.length()) + ' · +' + Math.round(plan.gain) + ' Hm' : '');
        }
        if (onMap) {
            var i2 = Profile.render($('mapProfSvg'), inp);
            if (i2) $('mapProfInfo').textContent = Profile.describe(i2.next);
        }
    }

    function syncProfMode() {
        var m = profMode || (plan ? 'ahead' : 'all');
        document.querySelectorAll('[data-pm]').forEach(function (b) { b.classList.toggle('on', b.dataset.pm === m); });
    }

    function onSubShown(name) { if (name === 'seg' || name === 'rec') SegUI.refresh(); }

    function showSub(name) {
        ['now', 'seg', 'rec'].forEach(function (x) { $('sub-' + x).hidden = x !== name; });
        document.querySelectorAll('[data-sub]').forEach(function (b) { b.classList.toggle('on', b.dataset.sub === name); });
        if (name === 'now') renderProfiles();
        if (typeof onSubShown === 'function') onSubShown(name);
    }

    /* ---------------- Gespeicherte Ausfahrten ---------------- */
    var SRC = { ride: 'gefahren', sim: 'Simulation', gpx: 'GPX', plan: 'Plan' };

    function renderRides() {
        var l = Rides.list();
        $('rideList').innerHTML = l.map(function (r) {
            var on = ghost && ghost.rec.id === r.id;
            return '<div class="ride" data-id="' + r.id + '">' +
                '<div class="rt"><b>' + UI.escapeHtml(r.name) + '</b>' +
                '<span class="rm">' + UI.fmtDist(r.dist) + ' · ' + UI.fmtDur(r.dur) + ' · ' +
                (SRC[r.src] || r.src) + '</span></div>' +
                '<div class="rb">' + (r.src === 'plan' ? '' : '<button data-act="replay">Replay</button><button data-act="sum">Bilanz</button>') +
                '<button data-act="ghost" class="' + (on ? 'on' : '') + '">' + (on ? 'Ghost ✓' : 'Ghost') + '</button>' +
                '<button data-act="route" class="' + (plan && plan.id === r.id ? 'on' : '') + '">' + (plan && plan.id === r.id ? 'Route ✓' : 'Route') + '</button>' +
                '<button data-act="gpx">GPX</button><button data-act="del" aria-label="Löschen">✕</button></div></div>';
        }).join('') || '<div class="empty">Noch nichts gespeichert. Jede beendete Ausfahrt und Simulation ' +
                       'wird automatisch hier abgelegt.</div>';
        if (l.length) {
            $('rideList').insertAdjacentHTML('beforeend', '<div class="note">' + l.length +
                (l.length === 1 ? ' Ausfahrt' : ' Ausfahrten') + ', rund ' + Rides.usage() +
                ' KB – nur auf diesem Gerät. Der Browser kann sie löschen; „GPX“ sichert sie.</div>');
        }
        $('rideList').querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
                var id = b.closest('.ride').dataset.id, act = b.dataset.act;
                if (act === 'ghost') { if (ghost && ghost.rec.id === id) dropGhost(); else armGhost(id); }
                else if (act === 'route') {
                    if (plan && plan.id === id) clearPlan(); else setPlan(id);
                    renderRides(); liveMap.sync(); liveMap.draw();
                }
                else if (act === 'replay') ReplayUI.open(id);
                else if (act === 'sum') openSummary(id);
                else if (act === 'gpx') exportRide(id);
                else if (act === 'del') {
                    if (!confirm('Diese Ausfahrt löschen?')) return;
                    if (ghost && ghost.rec.id === id) dropGhost();
                    if (plan && plan.id === id) { clearPlan(); liveMap.sync(); }
                    var gone = Rides.list().filter(function (x) { return x.id === id; })[0];
                    Rides.remove(id);
                    if (gone) Segments.forgetRide(id, gone.src);
                    SegUI.refresh(); renderRides();
                }
            });
        });
    }

    function exportRide(id) {
        var rec = Rides.get(id);
        if (!rec) return;
        download(rec.name.replace(/[^\w\-]+/g, '_') + '.gpx', Rides.gpx(rec.name, Rides.unpack(rec)), 'application/gpx+xml');
    }

    /* Import: GPX (mit oder ohne Zeit) oder ein Trainingsplan als JSON. */
    async function importFile(file) {
        var text = await file.text(), res;
        try {
            if (/\.json$/i.test(file.name)) {
                var plan = Rides.parsePlan(text), route;
                if (typeof plan.gpx === 'string') {
                    route = Rides.parseGpx(plan.gpx).pts;
                } else {
                    var last = Rides.list()[0];
                    if (!last) throw new Error('Der Plan hat keine Strecke. Erst eine GPX-Route importieren oder eine Fahrt aufzeichnen.');
                    if (!confirm('Der Plan enthält keine Strecke. Als Strecke wird „' + last.name + '“ verwendet. Weiter?')) return;
                    route = Rides.unpack(Rides.get(last.id));
                }
                var pts = Rides.fromPlan(route, plan.segments);
                res = Rides.save({ src: 'plan', pts: pts, name: plan.name || file.name.replace(/\.json$/i, '') });
            } else {
                var g = Rides.parseGpx(text), name = g.name || file.name.replace(/\.gpx$/i, '');
                var use = g.pts;
                if (g.timed) {
                    use = g.pts.filter(function (q) { return q.t !== null; });
                } else {
                    var v = parseFloat((prompt('Die Datei hat keine Zeitstempel. Mit welchem Tempo (km/h) soll der Ghost fahren?', '25') || '').replace(',', '.'));
                    if (!(v > 0)) return;
                    use = Rides.withPace(g.pts, v);
                    name += ' @ ' + v + ' km/h';
                }
                res = Rides.save({ src: 'gpx', pts: use, name: name });
            }
        } catch (e) { setRideMsg(e.message || String(e)); return; }
        setRideMsg(res.ok ? '„' + res.rec.name + '“ importiert – ' + UI.fmtDist(res.rec.dist) + ', ' +
                            UI.fmtDur(res.rec.dur) + '.' : res.err);
        renderRides();
        if (res.ok && res.rec.src === 'gpx') analyseRide(res.rec);      // Segmente/Rekorde aus alten Fahrten
    }

    /* ---------------- Reiter ---------------- */
    function isActive(v) { return $('v-' + v).classList.contains('active'); }

    function showView(v) {
        ['tacho', 'map', 'log', 'climbs', 'group'].forEach(function (x) {
            $('v-' + x).classList.toggle('active', x === v);
        });
        document.querySelectorAll('nav button').forEach(function (b) {
            b.classList.toggle('on', b.dataset.v === v);
        });
        if (v === 'map')    { render(); liveMap.ensureLoop(); }
        if (v === 'climbs') { renderProfiles(); }
        if (v === 'tacho')  { ensureCompassLoop(); }
        if (v === 'log')    { seenEvents = an.events.length; UI.badge('bdgLog', 0); }
        if (v === 'climbs') { seenClimbs = an.climbs.length; UI.badge('bdgClimbs', 0); }
    }

    /* ---------------- Download ---------------- */
    function download(name, text, mime) {
        var b = new Blob([text], { type: mime || 'application/octet-stream' });
        var u = URL.createObjectURL(b);
        var a = document.createElement('a');
        a.href = u; a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1500);
    }

    /* ---------------- Bedienung ---------------- */
    function wire() {
        document.querySelectorAll('nav button').forEach(function (b) {
            b.addEventListener('click', function () { showView(b.dataset.v); });
        });

        $('inName').addEventListener('change', function () {
            me.name = (this.value || '').trim().slice(0, 14) || me.name;
            this.value = me.name;
            store('rname', me.name);
            if (an.riders[me.id]) an.riders[me.id].name = me.name;
            sendMine();
        });

        // Symbol: feste Auswahl, getippt wird nichts. "–" = keins.
        var ep = $('emojiPick');
        function drawEmojiPick() {
            ep.innerHTML = '<button data-e="-1" class="' + (me.emoji === null ? 'sel' : '') + '" aria-label="Kein Symbol">–</button>' +
                UI.EMOJIS.map(function (e, i) {
                    return '<button data-e="' + i + '" class="' + (me.emoji === i ? 'sel' : '') + '" aria-label="Symbol ' + (i + 1) + '">' + Emo.img(e) + '</button>';
                }).join('');
        }
        drawEmojiPick();
        ep.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b) return;
            var i = parseInt(b.dataset.e, 10);
            me.emoji = i < 0 ? null : UI.validEmoji(i);
            store('remoji', me.emoji === null ? '' : String(me.emoji));
            if (an.riders[me.id]) an.riders[me.id].emoji = me.emoji;
            drawEmojiPick();
            sendMine();                                   // die anderen sehen es beim naechsten Takt
        });

        var sw = $('swatches');
        UI.COLORS.forEach(function (c, i) {
            var b = document.createElement('button');
            b.className = 'sw' + (i === me.colorIdx ? ' sel' : '');
            b.style.background = c;
            b.addEventListener('click', function () {
                me.colorIdx = i; store('rcol', String(i));
                sw.querySelectorAll('.sw').forEach(function (x, j) {
                    x.classList.toggle('sel', j === i);
                });
                if (an.riders[me.id]) an.riders[me.id].color = myColor();
                sendMine();
            });
            sw.appendChild(b);
        });

        /* Start MUSS aus einer Nutzergeste kommen: iOS gibt den
           Kompass nur so frei, und Wake Lock ebenfalls. */
        $('btnStart').addEventListener('click', async function () {
            if (running) {
                running = false;
                Sensors.stopGps(); Sensors.keepAwake(false); Net.stop();
                finishRecording('ride');
                SegUI.stopLive();
                armGhostAgain();          // Ghost wartet wieder am Start
                this.textContent = 'Ausfahrt starten';
                this.className = 'btn go';
                UI.renderNet('off', 'gestoppt');
                return;
            }
            if (sim) simStop();
            myTrack = []; Recorder.reset(me.id);      // jede Fahrt wird einzeln aufgezeichnet
            SegUI.startLive('real'); SegUI.setWorld('real');
            armGhostAgain();
            running = true;
            this.textContent = 'Ausfahrt beenden';
            this.className = 'btn stop';

            await Sensors.startCompass();
            Sensors.keepAwake(true);
            var ok = Sensors.startGps(onFix, function (msg) {
                UI.renderNet('off', UI.escapeHtml(msg));
            });
            if (!ok) UI.renderNet('off', 'Kein GPS verfügbar');
            startNet();
            showView('tacho');
        });

        $('btnShare').addEventListener('click', async function () {
            var url = shareLink();
            try {
                if (navigator.share) {
                    await navigator.share({ title: 'Gruppenausfahrt', url: url });
                    return;
                }
            } catch (e) { /* abgebrochen */ }
            try {
                await navigator.clipboard.writeText(url);
                this.textContent = 'Link kopiert';
                var b = this;
                setTimeout(function () { b.textContent = 'Link zum Mitfahren teilen'; }, 1800);
            } catch (e) {
                prompt('Diesen Link weitergeben:', url);
            }
        });

        $('btnSim').addEventListener('click', function () { if (sim) simStop(); else simStart(); });
        $('btnSimAttack').addEventListener('click', function () { if (sim) { sim.attack(); syncSimBar(); } });
        $('simLess').addEventListener('click', function () {
            if (sim) { sim.effort = Math.max(0.5, Math.round((sim.effort - 0.1) * 10) / 10); syncSimBar(); } });
        $('simMore').addEventListener('click', function () {
            if (sim) { sim.effort = Math.min(1.6, Math.round((sim.effort + 0.1) * 10) / 10); syncSimBar(); } });
        document.querySelectorAll('#simbar [data-warp]').forEach(function (b) {
            b.addEventListener('click', function () { simWarp = +b.dataset.warp; syncSimBar(); });
        });

        ReplayUI.wire(); SegUI.init();
        Msg.init({
            send: sendMsgWire,
            meId: function () { return me.id; }, meName: function () { return me.name; },
            log: function (id, name, code, t) { an._event(t, 'msg', { id: id, q: code, name: name }); }
        });
        $('sumClose').addEventListener('click', function () { $('sumOverlay').hidden = true; });
        $('sumOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
        $('sumShare').addEventListener('click', function () {
            if (!sumData) return;
            $('sumMsg').textContent = 'Bild wird erzeugt …';
            Summary.share(sumData).then(function () { $('sumMsg').textContent = ''; },
                                        function (e) { $('sumMsg').textContent = 'Teilen nicht möglich: ' + (e && e.message || e); });
        });
        document.querySelectorAll('[data-sub]').forEach(function (b) {
            b.addEventListener('click', function () { showSub(b.dataset.sub); });
        });
        document.querySelectorAll('[data-pm]').forEach(function (b) {
            b.addEventListener('click', function () { profMode = b.dataset.pm; store('profmode', profMode); syncProfMode(); renderProfiles(); });
        });
        $('mapProfBtn').addEventListener('click', function () {
            var hide = !$('mapProf').hidden;
            $('mapProf').hidden = hide;
            this.classList.toggle('on', !hide); this.setAttribute('aria-pressed', hide ? 'false' : 'true');
            store('mapprof', hide ? '0' : '1');
            renderProfiles(); liveMap.draw();
        });
        $('btnGhostNow').addEventListener('click', startGhostNow);
        $('btnGhostOff').addEventListener('click', dropGhost);
        $('ghostPace').addEventListener('change', function () {
            store('gpace', this.value);
            if (ghost && ghost.state === 'armed') ghost.g = Ghost.make(ghost.rec, ghostFactor());
        });
        $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
        $('fileImport').addEventListener('change', function () {
            var f = this.files && this.files[0];
            this.value = '';
            if (f) importFile(f);
        });

        $('btnQr').addEventListener('click', showQr);
        $('btnQrClose').addEventListener('click', function () { $('qrOverlay').hidden = true; });
        $('qrOverlay').addEventListener('click', function (e) {
            if (e.target === this) this.hidden = true;      // Klick neben die Karte schliesst
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') $('qrOverlay').hidden = true;
        });


        $('btnNewRoom').addEventListener('click', function () {
            if (!confirm('Neue Gruppe öffnen? Der alte Link funktioniert dann nicht mehr ' +
                         'für dich, und die bisherige Auswertung wird verworfen.')) return;
            location.hash = 'k=' + Crypt.newSecret();
            location.reload();
        });

        $('btnTheme').addEventListener('click', function () {
            var sun = document.documentElement.getAttribute('data-theme') === 'sun';
            document.documentElement.setAttribute('data-theme', sun ? 'dark' : 'sun');
            store('theme', sun ? 'dark' : 'sun');
            var mt = document.querySelector('meta[name=theme-color]');
            if (mt) mt.setAttribute('content', sun ? '#0d1214' : '#eceff1');
        });

        $('btnExport').addEventListener('click', function () {
            var s = an.summary();
            s.myId = me.id;
            download('gruppenausfahrt_' + new Date().toISOString().slice(0, 16)
                        .replace(/[-:T]/g, '') + '.json',
                     JSON.stringify(s, null, 2), 'application/json');
        });

        $('btnGpx').addEventListener('click', function () {
            if (!myTrack.length) { alert('Noch keine eigene Spur aufgezeichnet.'); return; }
            download('spur_' + new Date().toISOString().slice(0, 10) + '.gpx',
                     Rides.gpx('Gruppenausfahrt ' + new Date(myTrack[0].t).toISOString().slice(0, 10), myTrack),
                     'application/gpx+xml');
        });

        $('btnRelay').addEventListener('click', function () {
            var v = ($('inRelay').value || '').trim();
            if (v && !/^wss:\/\//.test(v)) {
                alert('Der Relay muss mit wss:// beginnen (verschlüsseltes WebSocket).');
                return;
            }
            if (v) store('relay', v); else { try { localStorage.removeItem('relay'); } catch (e) {} }
            location.reload();
        });
    }

    /* ---------------- Start ---------------- */
    window.addEventListener('load', async function () {
        var th = store('theme');
        if (th) document.documentElement.setAttribute('data-theme', th);

        initIdentity();
        liveMap = MapCtl.mount($('liveMap'), {
            prefix: 'map', persist: true, extras: [{ id: 'ProfBtn', label: 'Profil' }],
            isActive: function () { return isActive('map'); },
            hasRoute: function () { return !!plan; },
            getData: function () {
                if (!lastMap) return null;
                return { route: route, riders: lastMap.ord, meId: me.id, climbs: an.climbs,
                         heading: lastMap.heading, overlay: plan ? plan.overlay : null };
            }
        });
        wire();
        try {
            await initRoom();
        } catch (e) {
            UI.renderNet('off', 'Verschlüsselung nicht verfügbar – ist die Seite ' +
                                'über https:// geladen?');
        }
        UI.renderNet('off', 'bereit – unter „Gruppe“ starten');
        var gp = store('gpace');
        if (gp) $('ghostPace').value = gp;
        recoverDraft();
        var pid = store('plan');
        if (pid && Rides.get(pid)) setPlan(pid); else if (pid) clearPlan();
        profMode = store('profmode') || null;
        if (store('mapprof') === '1') { $('mapProf').hidden = false; $('mapProfBtn').classList.add('on'); $('mapProfBtn').setAttribute('aria-pressed', 'true'); }
        syncProfMode();
        renderRides(); renderGhostUi(); liveMap.sync();
        setInterval(function () {                        // Ghost in Echtzeit (die Simulation treibt ihn selbst)
            if (running && !sim) ghostStep(Date.now(), Date.now());
            renderGhostUi();
        }, 1000);
        setInterval(saveDraftNow, 60000);
        window.addEventListener('pagehide', saveDraftNow);
        showView('group');
        setInterval(render, RENDER_MS);
        render();
        if (new URLSearchParams(location.search).has('sim')) simStart();
    });
})();
