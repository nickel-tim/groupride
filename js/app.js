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

    var me = { id: null, name: null, colorIdx: 0 };
    var secret = null, key = null, topic = null;
    var running = false;
    var lastSend = 0;
    var myFix = null;         // letzte eigene Position
    var myTrack = [];         // fuer den GPX-Export
    var seenEvents = 0, seenClimbs = 0;
    var relayUrl = null;

    function $(id) { return document.getElementById(id); }
    function store(k, v) { try { if (v === undefined) return localStorage.getItem(k);
                                 localStorage.setItem(k, v); } catch (e) { return null; } }

    /* ---------------- Identitaet ---------------- */
    function initIdentity() {
        me.id = store('rid');
        if (!me.id) { me.id = Math.random().toString(36).slice(2, 10); store('rid', me.id); }
        me.name = store('rname') || 'Fahrer ' + me.id.slice(0, 3);
        me.colorIdx = parseInt(store('rcol') || '0', 10) % UI.COLORS.length;
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
            'auch den Schlüssel weiter.';
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
        if (typeof m.la !== 'number' || typeof m.lo !== 'number') return;

        an.ingest(m.i, {
            lat: m.la, lon: m.lo,
            ele: (typeof m.e === 'number') ? m.e : null,
            speed: (typeof m.v === 'number') ? m.v : 0,
            heading: (typeof m.h === 'number') ? m.h : null,
            acc: (typeof m.a === 'number') ? m.a : null,
            t: (typeof m.t === 'number') ? m.t : Date.now(),
            name: typeof m.n === 'string' ? m.n.slice(0, 14) : null,
            color: UI.COLORS[(m.c | 0) % UI.COLORS.length]
        });
    }

    function sendMine() {
        if (!myFix || !key) return;
        var c = myFix.coords;
        var h = Sensors.heading();
        Crypt.seal(key, {
            i: me.id, n: me.name, c: me.colorIdx,
            la: +c.latitude.toFixed(6), lo: +c.longitude.toFixed(6),
            e: (c.altitude !== null && !isNaN(c.altitude)) ? Math.round(c.altitude) : null,
            v: Math.round((c.speed || 0) * 100) / 100,
            h: h.deg === null ? null : Math.round(h.deg),
            a: c.accuracy !== null ? Math.round(c.accuracy) : null,
            t: myFix.timestamp || Date.now()
        }).then(Net.publish);
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
            name: me.name, color: myColor()
        });
        an.riders[me.id].self = true;

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
        var ord = an.tick();
        var mine = an.riders[me.id];
        var h = Sensors.heading();

        UI.renderHeadingSrc(h);
        UI.renderSpeed(mine && mine.lat !== null ? mine.speed : null,
                       mine ? !an.isStale(mine) : false);

        var pos = 0;
        for (var i = 0; i < ord.length; i++) if (ord[i].id === me.id) pos = i + 1;
        UI.renderRank(pos, ord.length);

        // --- Kompass ---
        var peers = [];
        if (mine && mine.lat !== null) {
            for (var k = 0; k < ord.length; k++) {
                var r = ord[k];
                if (r.id === me.id || r.lat === null) continue;
                peers.push({
                    color: r.color || UI.COLORS[1],
                    short: (r.name || r.id).slice(0, 6),
                    dist: Geo.distance(mine.lat, mine.lon, r.lat, r.lon),
                    bearing: Geo.bearing(mine.lat, mine.lon, r.lat, r.lon),
                    ahead: (r.s !== null && mine.s !== null) ? (r.s > mine.s) : null,
                    stale: an.isStale(r)
                });
            }
        }
        UI.renderCompass(mine, peers, h.deg);

        // --- Liste: Luecke immer relativ zu MIR, das ist die Zahl,
        //     die man beim Fahren wissen will ---
        var rows = ord.map(function (r) {
            var gapM = null, gapS = null;
            if (mine && mine.s !== null && r.s !== null && r.id !== me.id) {
                gapM = r.s - mine.s;
                gapS = gapM / Math.max(2, r.s > mine.s ? mine.speed : r.speed);
            }
            return {
                name: r.name || r.id, color: r.color || UI.COLORS[1],
                me: r.id === me.id, speed: r.lat === null ? null : r.speed,
                gapM: gapM, gapS: gapS,
                dropped: r.dropped, stale: an.isStale(r)
            };
        });
        UI.renderRiders(rows);

        // --- Führungsarbeit ---
        var tot = 0; ord.forEach(function (r) { tot += r.frontMs; });
        UI.renderFrontWork(ord.filter(function (r) { return r.frontMs > 0; })
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

    function nameOf(id) {
        var r = an.riders[id];
        return UI.escapeHtml((r && r.name) || id);
    }

    function eventText(e) {
        switch (e.type) {
            case 'pass':   return nameOf(e.id) + ' überholt ' + nameOf(e.over);
            case 'attack': return nameOf(e.id) + ' tritt an – ' + e.gain + ' m gewonnen' +
                                  (e.surge ? ' (+' + e.surge + ' km/h)' : '');
            case 'drop':   return nameOf(e.id) + (e.standing ? ' steht' : ' ist abgerissen') +
                                  (e.gap ? ' – ' + UI.fmtDist(e.gap) + ' zurück' : '');
            case 'rejoin': return nameOf(e.id) + ' ist wieder dran';
            case 'lead':   return nameOf(e.id) + ' übernimmt die Führung' +
                                  (e.from ? ' von ' + nameOf(e.from) : '');
            default:       return e.type;
        }
    }

    /* ---------------- Reiter ---------------- */
    function isActive(v) { return $('v-' + v).classList.contains('active'); }

    function showView(v) {
        ['tacho', 'log', 'climbs', 'group'].forEach(function (x) {
            $('v-' + x).classList.toggle('active', x === v);
        });
        document.querySelectorAll('nav button').forEach(function (b) {
            b.classList.toggle('on', b.dataset.v === v);
        });
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

    function gpx() {
        function iso(t) { return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'); }
        var o = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<gpx version="1.1" creator="Gruppenausfahrt" ' +
            'xmlns="http://www.topografix.com/GPX/1/1">',
            '<trk><name>Gruppenausfahrt ' +
            (myTrack.length ? iso(myTrack[0].t).slice(0, 10) : '') + '</name>',
            '<type>cycling</type><trkseg>'];
        myTrack.forEach(function (p) {
            o.push('<trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '">' +
                   (p.ele !== null ? '<ele>' + p.ele.toFixed(1) + '</ele>' : '') +
                   '<time>' + iso(p.t) + '</time></trkpt>');
        });
        o.push('</trkseg></trk></gpx>');
        return o.join('\n');
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
                this.textContent = 'Ausfahrt starten';
                this.className = 'btn go';
                UI.renderNet('off', 'gestoppt');
                return;
            }
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
                     gpx(), 'application/gpx+xml');
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
        wire();
        try {
            await initRoom();
        } catch (e) {
            UI.renderNet('off', 'Verschlüsselung nicht verfügbar – ist die Seite ' +
                                'über https:// geladen?');
        }
        UI.renderNet('off', 'bereit – unter „Gruppe“ starten');
        showView('group');
        setInterval(render, RENDER_MS);
        render();
    });
})();
