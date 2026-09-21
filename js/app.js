/* ============================================================
 * app.js -- wiring
 * ============================================================
 * One property is important to understand: there is NO server
 * that knows the truth. Every phone builds its own route axis
 * and computes on its own. The absolute arc lengths therefore differ
 * from device to device (each axis starts where this phone saw
 * its first position) -- the DIFFERENCES, and with them
 * order, gaps and climb times, are the same on all devices.
 *
 * The price: with radio gaps two phones may briefly show
 * different states. The gain: no backend, no
 * registration, no data leakage.
 * ============================================================ */

(function () {
    'use strict';

    var SEND_MS   = 2000;     // Send interval: nobody needs it more often, and the
                              // public broker should not suffer
    var RENDER_MS = 200;

    var route = new Route();
    var an    = new Analytics(route);

    var me = { id: null, name: null, colorIdx: 0, emoji: null };     // emoji: number from UI.EMOJIS or null
    var secret = null, key = null, topic = null;
    var running = false;
    var lastSend = 0;
    var myFix = null;         // last own position
    var myTrack = [];         // for the GPX export
    var coffeeStamps = [];    // times of own coffee messages in this ride (league category)
    var seenEvents = 0, seenClimbs = 0;
    var relayUrl = null;
    // Map view: "All" fits the section to the group, "Me" keeps
    // you in the centre; "Heading" rotates the map so that your direction of travel is up.
    var liveMap = null;                               // map (MapCtl), built on load
    var lastMap = null;                               // last state for the drawing loop

    // Planned route (overlay): a saved ride/GPX track as a line on the map
    //   { id, name, route (Route), overlay {name,len,pts,route}, climbs, gain }
    var plan = null;
    var profMode = null;                              // 'all' | 'ahead' (null = automatic)
    var planHint = {};                                // last position per rider on the route

    // Simulation: own state, it replaces GPS and network completely
    var sim = null, simTimer = null, simWarp = 1, simHeading = null, simSaved = false;

    // Ghost: a saved ride as a virtual fellow rider (see ghost.js)
    //   state: 'armed' waits for the start, 'running' rides, afterwards it drops away
    var ghost = null;
    var GHOST_START_M = 40;       // you have to be this close to the ghost start for it to set off
    var GHOST_COLOR = '#9aa7ad';  // mid grey: readable on dark and light backgrounds

    function $(id) { return document.getElementById(id); }
    function store(k, v) { try { if (v === undefined) return localStorage.getItem(k);
                                 localStorage.setItem(k, v); } catch (e) { return null; } }

    /* ---------------- Identity ---------------- */
    function initIdentity() {
        me.id = store('rid');
        if (!me.id) { me.id = Math.random().toString(36).slice(2, 10); store('rid', me.id); }
        me.name = store('rname') || T('Fahrer {id}', { id: me.id.slice(0, 3) });
        me.colorIdx = parseInt(store('rcol') || '0', 10) % UI.COLORS.length;
        var em = store('remoji');
        me.emoji = (em === null || em === '') ? null : UI.validEmoji(parseInt(em, 10));
        $('inName').value = me.name;
    }

    function myColor() { return UI.COLORS[me.colorIdx]; }

    /* ---------------- Room from the URL fragment ----------------
       The fragment (after the #) is NOT sent to servers by the browser.
       The key therefore stays between the phones. */
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

    /* The relay MUST be in the shared link: whoever ends up on the public
       broker while others use their own relay sees
       nobody -- the two ways are separate worlds. */
    function shareLink() {
        var q = new URLSearchParams(location.search);
        if (relayUrl) q.set('relay', relayUrl); else q.delete('relay');
        q.delete('sim');
        q.delete('lang');                  // the language is each person's own choice, not part of the link
        var qs = q.toString();
        return location.origin + location.pathname + (qs ? '?' + qs : '') + location.hash;
    }

    function renderLinkNote() {
        $('linkNote').innerHTML =
            T('Wer diesen Link öffnet, ist in der Gruppe – ohne Installation, ohne Konto.') +
            '<br><br><code>' + UI.escapeHtml(shareLink()) + '</code>';
    }

    function renderNetNote() {
        var m = Net.mode();
        $('netNote').innerHTML = m === 'relay'
            ? T('Eigener Relay:') + ' <code>' + UI.escapeHtml(relayUrl) + '</code>'
            : T('Öffentlicher MQTT-Broker. Kein Konto nötig, aber auch keine Verfügbarkeitsgarantie. Fällt einer aus, wird automatisch der nächste probiert.');
        $('privacyNote').innerHTML = T('<b>Zur Vertraulichkeit:</b> Positionen verlassen das Handy nur AES-GCM-verschlüsselt. Der Schlüssel steht hinter dem <code>#</code> der Adresse und wird von Browsern nie an einen Server gesendet – der Broker sieht ausschließlich Zufallsbytes. Wer den Link weitergibt, gibt allerdings auch den Schlüssel weiter.<br><br><b>Straßenkarte:</b> Nur wenn du sie unter „Karte“ einschaltest, lädt dein Handy Kartenbilder von tile.openstreetmap.org. Der Anbieter sieht dann IP-Adresse und ungefähren Ausschnitt, nichts von der Gruppe.');
    }

    /* ---------------- Network ---------------- */
    /* Status line in the header: remember it, so that a language switch can write it again */
    var lastNet = null;
    function netStatus(state, key, vars) { lastNet = { s: state, k: key, v: vars }; UI.renderNet(state, T(key, vars)); }

    function startNet() {
        Net.start({
            topic: topic,
            relayUrl: relayUrl,
            onMessage: onWire,
            onState: function (s, detail) {
                if (s === 'online')      netStatus('online', 'verbunden');
                else if (s === 'loading')  netStatus('wait', 'lade Netzwerkteil …');
                else if (s === 'connecting')netStatus('wait', 'verbinde …');
                else if (s === 'retry')    netStatus('wait', 'nächster Broker …');
                else if (s === 'error')  { lastNet = null; UI.renderNet('off', UI.escapeHtml(detail || T('Fehler'))); }
            }
        });
    }

    async function onWire(str) {
        var m = await Crypt.open(key, str);
        // null = foreign group or corrupted. Discard, do not report.
        if (!m || !m.i || m.i === me.id) return;
        if (m.q) { Msg.receive(m); return; }                      // short message instead of a position
        if (typeof m.la !== 'number' || typeof m.lo !== 'number') return;

        var emo = UI.validEmoji(m.j);                        // unknown/invalid number = no symbol
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

    /* Send a short message: 'sent' | 'sim' | 'offline'. The channel is "send once, no
       confirmation" -- a lost "Stop!" would be bad, so once more after 1.5 s;
       the message ID makes sure it only counts once at the receiver. */
    function sendMsgWire(code, mid) {
        if (sim) return 'sim';                                     // in the simulation nothing goes out
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
        if (me.emoji !== null) pkt.j = me.emoji;             // only the number; without a symbol the report stays as before
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

    /* ---------------- Render loop ---------------- */
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

        // --- Compass and map: drawn in their own loops (smooth, see smooth.js);
        //     here only the current state for them ---
        lastCompass = { ord: ord, heading: h.deg };
        ensureCompassLoop();
        lastMap = { ord: ord, heading: h.deg };
        if (isActive('map')) liveMap.ensureLoop();
        renderProfiles();

        // --- List: gap always relative to ME, that is the number
        //     you want to know while riding ---
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

        // --- Front work ---
        var tot = 0; ord.forEach(function (r) { if (!r.ghost) tot += r.frontMs; });
        UI.renderFrontWork(ord.filter(function (r) { return r.frontMs > 0 && !r.ghost; })
            .sort(function (a, b) { return b.frontMs - a.frontMs; })
            .map(function (r) {
                return { name: r.name || r.id, color: r.color || UI.COLORS[1],
                         frontMs: r.frontMs, share: tot ? r.frontMs / tot : 0 };
            }));

        // --- Events ---
        UI.renderEvents(an.events.map(function (e) { return { t: e.t, type: e.type,
                                                              text: eventText(e) }; }));

        // --- Climbs ---
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

        if (running && !Net.online()) netStatus('wait', 'kein Netz – nur eigene Daten');
    }

    /* ---------------- Compass ----------------
       Like the map: positions ~1x per second, drawing happens with ~30 frames
       (smooth, see smooth.js). The compass computes in distance and bearing from
       DIR on; both come from the smoothed positions here, not from the
       raw reports -- otherwise dots and needle wobble every second and with
       the GPS noise. */
    var lastCompass = null, compassTrk = Smooth.create(), compassTmpFrame = null;
    var compassLoopOn = false, compassLoopT = 0;

    function drawCompass(ord, heading) {
        var mine = an.riders[me.id], now = performance.now();
        if (!mine || mine.fLat === null) {
            UI.renderCompass(mine, [], Smooth.heading(compassTrk, heading, now));
            return;
        }
        // Reference frame of the metres: that of the route, otherwise a provisional one around you
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
                var dx = p.x - m.x, dy = p.y - m.y;      // x = east, y = north
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
            // Link too long for the largest QR version (relay URL with a huge path)
            $('qrBox').innerHTML = '<div class="empty">' + T('Der Link ist zu lang für einen QR-Code. Bitte „Link zum Mitfahren teilen“ nutzen.') + '</div>';
        }
        $('qrOverlay').hidden = false;
    }

    function eventText(e) { return UI.eventText(an, e); }

    /* ---------------- Simulation ---------------- */
    function simStart() {
        if (running) { alert(T('Erst die laufende Ausfahrt beenden.')); return; }
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
        $('btnSim').textContent = T('Simulation beenden');
        $('btnSim').className = 'btn stop';
        netStatus('wait', 'Simulation – nichts wird gesendet');
        /* Lead-in: only from ~150 m of route axis are order and gaps
           reliable. Without it everybody would stand at "0 m" at the start. */
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
        // Do not carry the simulation state over into a real ride
        route = new Route(); an = new Analytics(route);
        seenEvents = 0; seenClimbs = 0;
        $('simbar').hidden = true;
        $('btnSim').textContent = T('Simulation starten');
        $('btnSim').className = 'btn';
        netStatus('off', 'bereit – unter „Gruppe“ starten');
        renderGhostUi();
        render();
    }

    /* Every wall-clock second: warp simulated seconds. One report per
       simulated second (1 Hz like real GPS), so that the analysis
       in time lapse does not compute differently than in real time. */
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
        var km = I18n.num(sim.meS() / 1000, 1), tot = I18n.num(sim.length / 1000, 1);
        $('simMsg').textContent = sim.done
            ? T('Ziel erreicht – Simulation zu Ende. Beenden und neu starten zum Wiederholen.')
            : T('Du: km {a} von {b} · Zeit {t}', { a: km, b: tot, t: UI.fmtDur(sim.t * 1000) });
    }

    /* ---------------- Recording ---------------- */
    function setRideMsg(t) { $('rideMsg').textContent = t || ''; }

    function finishRecording(src) {
        if (myTrack.length < Rides.MIN_POINTS) { Rides.clearDraft(); return; }
        var cof = LigaMetrics.countCoffee(coffeeStamps);
        var r = Rides.save({ src: src, pts: myTrack, group: Recorder.riderCount() >= 2 ? Recorder.pack() : null, x: cof ? { coffee: cof } : null });
        Rides.clearDraft();
        setRideMsg(r.ok ? T('„{name}“ gespeichert – {d}, {t}. Unten als Ghost verwendbar.', { name: r.rec.name, d: UI.fmtDist(r.rec.dist), t: UI.fmtDur(r.rec.dur) })
                        : r.err);
        renderRides();
        if (r.ok) { analyseRide(r.rec); if (src === 'ride') LigaSync.rideSaved(r.rec); }
    }

    /* After the ride: find segments, update best times and records. Runs in small
       chunks in the background (a few seconds for long rides), result in lastReport. */
    var lastReport = null;
    function analyseRide(rec) {
        lastReport = null;
        setRideMsg(T('„{name}“ gespeichert. Auswertung läuft …', { name: rec.name }));
        return Segments.processRide(rec).then(function (rep) {
            lastReport = rep ? { rideId: rec.id, rep: rep } : null;
            if (rep) SegUI.setReport(rep);
            var note = T('„{name}“ gespeichert', { name: rec.name });
            if (rep) {
                var pb = rep.efforts.filter(function (e) { return e.isPB && !e.first; }).length;
                var firsts = rep.efforts.filter(function (e) { return e.first; }).length;
                if (pb) note += ' · ' + (pb > 1 ? T('{n} neue Bestzeiten', { n: pb }) : T('1 neue Bestzeit'));
                if (firsts) note += ' · ' + (firsts > 1 ? T('{n} neue Segmente', { n: firsts }) : T('1 neues Segment'));
                if (rep.records.length) note += ' · ' + (rep.records.length > 1 ? T('{n} Rekorde', { n: rep.records.length }) : T('1 Rekord'));
            }
            setRideMsg(note + '.');
            if (typeof SegUI !== 'undefined') SegUI.refresh();
            // Real rides: show the summary right away. Simulations only on button press.
            if (rec.src === 'ride' && rec.dur > 120000 && rec.dist > 500) openSummary(rec.id);
        }, function (e) { setRideMsg(T('Auswertung fehlgeschlagen: {e}', { e: e && e.message || e })); });
    }

    /* ---------------- Summary ---------------- */
    var sumData = null;
    function openSummary(id) {
        $('sumOverlay').hidden = false; $('sumBusy').hidden = false; $('sumBody').innerHTML = ''; $('sumMsg').textContent = '';
        sumData = null;
        Summary.forRide(id, function (f) { $('sumBusy').textContent = T('Bilanz wird berechnet … {p} %', { p: Math.round(f * 100) }); }).then(function (d) {
            sumData = d;
            $('sumBusy').hidden = true;
            $('sumBody').innerHTML = Summary.html(d);
            $('sumThumb').innerHTML = '<svg viewBox="0 0 340 190" preserveAspectRatio="xMidYMid meet">' + Summary.thumbSvg(d, 340, 190) + '</svg>';
        }, function (e) { $('sumBusy').hidden = true; $('sumBody').textContent = T('Bilanz nicht möglich: {e}', { e: e && e.message || e }); });
    }

    /* Draft every 60 s: if the battery dies during the ride or the
       browser crashes, the ride is not gone the next time it is opened. */
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
                             name: T('Wiederhergestellt') + ' ' + Rides.fmtDate(pts[0].t) });
        setRideMsg(r.ok ? T('Eine nicht beendete Fahrt wurde wiederhergestellt.') : r.err);
    }

    /* ---------------- Ghost ---------------- */
    function ghostFactor() { return parseFloat($('ghostPace').value) || 1; }

    function armGhost(id) {
        var rec = Rides.get(id);
        if (!rec) { setRideMsg(T('Diese Ausfahrt ist nicht mehr gespeichert.')); return; }
        dropGhostRider();
        ghost = { rec: rec, g: Ghost.make(rec, ghostFactor()), state: 'armed', t0: null };
        renderGhostUi(); renderRides();
    }

    // When a new ride/simulation starts, the ghost waits at the start again
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

    /* One step: stamp = timestamp of the report, clock = ghost clock in ms
       (real time, or simulation time -- then the ghost runs along in time lapse). */
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
        if (!running && !sim) { setRideMsg(T('Erst eine Ausfahrt oder die Simulation starten.')); return; }
        ghost.state = 'running';
        ghost.t0 = sim ? sim.t * 1000 : Date.now();
        renderGhostUi();
    }

    function renderGhostUi() {
        var st = $('ghostState'), now = $('btnGhostNow'), off = $('btnGhostOff');
        $('ghostPace').disabled = !!ghost && ghost.state === 'running';
        if (!ghost) {
            st.innerHTML = T('Kein Ghost gewählt. Unter „Gespeicherte Ausfahrten“ eine Fahrt als Ghost wählen, dann fährt sie als grauer Mitfahrer mit – mit Rang, Lücke und Karte wie jeder andere.');
            now.hidden = off.hidden = true;
            return;
        }
        off.hidden = false;
        var nm = '<b>' + UI.escapeHtml(ghost.rec.name) + '</b>';
        if (ghost.state === 'armed') {
            var mine = an.riders[me.id], txt;
            if (!running && !sim) {
                txt = T('wartet. Er startet, sobald du die Ausfahrt startest und am Startpunkt bist ({m} m).', { m: GHOST_START_M });
            } else if (mine && mine.lat !== null) {
                var d = Geo.distance(mine.lat, mine.lon, ghost.g.start.lat, ghost.g.start.lon);
                txt = T('wartet am Startpunkt – noch {d} entfernt. Er startet automatisch ab {m} m.', { d: UI.fmtDist(d), m: GHOST_START_M });
            } else { txt = T('wartet auf deine Position.'); }
            st.innerHTML = 'Ghost ' + nm + ' ' + txt;
            now.hidden = !(running || sim);
        } else if (ghost.state === 'running') {
            var t = ((sim ? sim.t * 1000 : Date.now()) - ghost.t0) / 1000;
            st.innerHTML = 'Ghost ' + nm + ' ' + T('fährt: {a} von {b}.', { a: UI.fmtDur(t * 1000), b: UI.fmtDur(ghost.g.dur * 1000) });
            now.hidden = true;
        } else {
            st.innerHTML = 'Ghost ' + nm + ' ' + T('ist nach {t} im Ziel.', { t: UI.fmtDur(ghost.doneAt * 1000) });
            now.hidden = true;
        }
    }

    /* Language switch: draw again what scripts have written into the page */
    function relang() {
        renderLinkNote(); renderNetNote();
        if (lastNet) UI.renderNet(lastNet.s, T(lastNet.k, lastNet.v));
        $('btnStart').textContent = running ? T('Ausfahrt beenden') : T('Ausfahrt starten');
        $('btnSim').textContent = sim ? T('Simulation beenden') : T('Simulation starten');
        renderRides(); renderGhostUi(); syncSimBar(); renderProfiles();
        Msg.render(); liveMap.relabel(); SegUI.refresh(); LigaUI.relang(); ReplayUI.relang();
        if (!$('sumOverlay').hidden && sumData) $('sumBody').innerHTML = Summary.html(sumData);
        render();
    }

    /* ---------------- Planned route (overlay) ----------------
       Every saved track -- own ride, GPX import, training plan -- can be put
       under the map as a line. There is no warning on deviation: the line
       is a signpost, not a rule. With a route the elevation profile also knows
       the part AHEAD of the leader (the live axis ends at him, after all). */
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

    /* ---------------- Elevation profile ----------------
       With a route: the profile of the whole route, the riders projected onto it (also ahead of
       the leader). Without: the live axis, it ends at the leader. */
    function planS(r) {
        var pr = plan.route.project(r.fLat, r.fLon, planHint[r.id]);
        if (!pr || pr.offset > 150) return null;            // far off the route: do not point at it
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
                (plan ? T('Route „{name}“ · {d} · +{g} Hm', { name: plan.name, d: UI.fmtDist(plan.route.length()), g: Math.round(plan.gain) }) : '');
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

    /* ---------------- Saved rides ---------------- */
    var SRC = { ride: 'gefahren', sim: 'Simulation', gpx: 'GPX', plan: 'Plan' };

    function renderRides() {
        var l = Rides.list();
        $('rideList').innerHTML = l.map(function (r) {
            var on = ghost && ghost.rec.id === r.id;
            return '<div class="ride" data-id="' + r.id + '">' +
                '<div class="rt"><b>' + UI.escapeHtml(r.name) + '</b>' +
                '<span class="rm">' + UI.fmtDist(r.dist) + ' · ' + UI.fmtDur(r.dur) + ' · ' +
                T(SRC[r.src] || r.src) + '</span></div>' +
                '<div class="rb">' + (r.src === 'plan' ? '' : '<button data-act="replay">' + T('Replay') + '</button><button data-act="sum">' + T('Bilanz') + '</button>') +
                '<button data-act="ghost" class="' + (on ? 'on' : '') + '">' + (on ? T('Ghost') + ' ✓' : T('Ghost')) + '</button>' +
                '<button data-act="route" class="' + (plan && plan.id === r.id ? 'on' : '') + '">' + (plan && plan.id === r.id ? T('Route') + ' ✓' : T('Route')) + '</button>' +
                '<button data-act="gpx">GPX</button><button data-act="del" aria-label="' + T('Löschen') + '">✕</button></div></div>';
        }).join('') || '<div class="empty">' + T('Noch nichts gespeichert. Jede beendete Ausfahrt und Simulation wird automatisch hier abgelegt.') + '</div>';
        if (l.length) {
            $('rideList').insertAdjacentHTML('beforeend', '<div class="note">' +
                (l.length === 1 ? T('1 Ausfahrt, rund {kb} KB – nur auf diesem Gerät. Der Browser kann sie löschen; „GPX“ sichert sie.', { kb: Rides.usage() })
                                : T('{n} Ausfahrten, rund {kb} KB – nur auf diesem Gerät. Der Browser kann sie löschen; „GPX“ sichert sie.', { n: l.length, kb: Rides.usage() })) + '</div>');
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
                    if (!confirm(T('Diese Ausfahrt löschen?'))) return;
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

    /* Import: GPX (with or without time) or a training plan as JSON. */
    async function importFile(file) {
        var text = await file.text(), res;
        try {
            if (/\.json$/i.test(file.name)) {
                var plan = Rides.parsePlan(text), route;
                if (typeof plan.gpx === 'string') {
                    route = Rides.parseGpx(plan.gpx).pts;
                } else {
                    var last = Rides.list()[0];
                    if (!last) throw new Error(T('Der Plan hat keine Strecke. Erst eine GPX-Route importieren oder eine Fahrt aufzeichnen.'));
                    if (!confirm(T('Der Plan enthält keine Strecke. Als Strecke wird „{name}“ verwendet. Weiter?', { name: last.name }))) return;
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
                    var v = parseFloat((prompt(T('Die Datei hat keine Zeitstempel. Mit welchem Tempo (km/h) soll der Ghost fahren?'), '25') || '').replace(',', '.'));
                    if (!(v > 0)) return;
                    use = Rides.withPace(g.pts, v);
                    name += ' @ ' + v + ' km/h';
                }
                res = Rides.save({ src: 'gpx', pts: use, name: name });
            }
        } catch (e) { setRideMsg(e.message || String(e)); return; }
        setRideMsg(res.ok ? T('„{name}“ importiert – {d}, {t}.', { name: res.rec.name, d: UI.fmtDist(res.rec.dist), t: UI.fmtDur(res.rec.dur) }) : res.err);
        renderRides();
        if (res.ok && res.rec.src === 'gpx') { analyseRide(res.rec); LigaSync.rideSaved(res.rec); }   // segments/records and league from old rides
    }

    /* ---------------- Tabs ---------------- */
    function isActive(v) { return $('v-' + v).classList.contains('active'); }

    function showView(v) {
        ['tacho', 'map', 'log', 'climbs', 'liga', 'group'].forEach(function (x) {
            $('v-' + x).classList.toggle('active', x === v);
        });
        document.querySelectorAll('nav button').forEach(function (b) {
            b.classList.toggle('on', b.dataset.v === v);
        });
        if (v === 'map')    { render(); liveMap.ensureLoop(); }
        if (v === 'climbs') { renderProfiles(); }
        if (v === 'tacho')  { ensureCompassLoop(); LigaUI.tachoTick(); }
        if (v === 'liga')   { LigaUI.opened(); }
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

    /* ---------------- Controls ---------------- */
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
            LigaUI.profileChanged();
        });

        // Symbol: fixed choice, nothing is typed. "–" = none.
        var ep = $('emojiPick');
        function drawEmojiPick() {
            ep.innerHTML = '<button data-e="-1" class="' + (me.emoji === null ? 'sel' : '') + '" aria-label="' + T('Kein Symbol') + '">–</button>' +
                UI.EMOJIS.map(function (e, i) {
                    return '<button data-e="' + i + '" class="' + (me.emoji === i ? 'sel' : '') + '" aria-label="' + T('Symbol {n}', { n: i + 1 }) + '">' + Emo.img(e) + '</button>';
                }).join('');
        }
        drawEmojiPick();
        // Language: the button switches, everything dynamic is redrawn
        function syncLangBtn() { $('btnLang').textContent = I18n.lang() === 'de' ? 'Sprache: Deutsch – auf English umstellen' : 'Language: English – switch to German'; }
        $('btnLang').addEventListener('click', function () { I18n.set(I18n.lang() === 'de' ? 'en' : 'de'); });
        I18n.onChange(function () { syncLangBtn(); drawEmojiPick(); relang(); });
        syncLangBtn();
        ep.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b) return;
            var i = parseInt(b.dataset.e, 10);
            me.emoji = i < 0 ? null : UI.validEmoji(i);
            store('remoji', me.emoji === null ? '' : String(me.emoji));
            if (an.riders[me.id]) an.riders[me.id].emoji = me.emoji;
            drawEmojiPick();
            sendMine();                                   // the others see it at the next beat
            LigaUI.profileChanged();
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
                LigaUI.profileChanged();
            });
            sw.appendChild(b);
        });

        /* Start MUST come from a user gesture: iOS only releases the
           compass that way, and Wake Lock as well. */
        $('btnStart').addEventListener('click', async function () {
            if (running) {
                running = false;
                Sensors.stopGps(); Sensors.keepAwake(false); Net.stop();
                finishRecording('ride');
                SegUI.stopLive();
                armGhostAgain();          // ghost waits at the start again
                this.textContent = T('Ausfahrt starten');
                this.className = 'btn go';
                netStatus('off', 'gestoppt');
                return;
            }
            if (sim) simStop();
            myTrack = []; coffeeStamps = []; Recorder.reset(me.id);      // every ride is recorded individually
            SegUI.startLive('real'); SegUI.setWorld('real');
            armGhostAgain();
            running = true;
            this.textContent = T('Ausfahrt beenden');
            this.className = 'btn stop';

            await Sensors.startCompass();
            Sensors.keepAwake(true);
            var ok = Sensors.startGps(onFix, function (msg) {
                UI.renderNet('off', UI.escapeHtml(msg));
            });
            if (!ok) netStatus('off', 'Kein GPS verfügbar');
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
            } catch (e) { /* cancelled */ }
            try {
                await navigator.clipboard.writeText(url);
                this.textContent = T('Link kopiert');
                var b = this;
                setTimeout(function () { b.textContent = T('Link zum Mitfahren teilen'); }, 1800);
            } catch (e) {
                prompt(T('Diesen Link weitergeben:'), url);
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
        LigaUI.init({
            me: function () { return { name: me.name, emoji: me.emoji, color: myColor() }; },
            live: function () { return running && !sim && myTrack.length > 1 ? { dist: Rides.distanceOf(myTrack), moving: Track.movingMs(myTrack) } : null; },
            ridesChanged: function () { renderRides(); }
        });
        Msg.init({
            send: sendMsgWire,
            meId: function () { return me.id; }, meName: function () { return me.name; },
            log: function (id, name, code, t) {
                an._event(t, 'msg', { id: id, q: code, name: name });
                if (id === me.id && code === 'coffee' && running) coffeeStamps.push(t);
            }
        });
        $('sumClose').addEventListener('click', function () { $('sumOverlay').hidden = true; });
        $('sumOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
        $('sumShare').addEventListener('click', function () {
            if (!sumData) return;
            $('sumMsg').textContent = T('Bild wird erzeugt …');
            Summary.share(sumData).then(function () { $('sumMsg').textContent = ''; },
                                        function (e) { $('sumMsg').textContent = T('Teilen nicht möglich: {e}', { e: e && e.message || e }); });
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
            if (e.target === this) this.hidden = true;      // a click next to the map closes it
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') $('qrOverlay').hidden = true;
        });


        $('btnNewRoom').addEventListener('click', function () {
            if (!confirm(T('Neue Gruppe öffnen? Der alte Link funktioniert dann nicht mehr für dich, und die bisherige Auswertung wird verworfen.'))) return;
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
            if (!myTrack.length) { alert(T('Noch keine eigene Spur aufgezeichnet.')); return; }
            download('spur_' + new Date().toISOString().slice(0, 10) + '.gpx',
                     Rides.gpx('Gruppenausfahrt ' + new Date(myTrack[0].t).toISOString().slice(0, 10), myTrack),
                     'application/gpx+xml');
        });

        $('btnRelay').addEventListener('click', function () {
            var v = ($('inRelay').value || '').trim();
            if (v && !/^wss:\/\//.test(v)) {
                alert(T('Der Relay muss mit wss:// beginnen (verschlüsseltes WebSocket).'));
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
            netStatus('off', 'Verschlüsselung nicht verfügbar – ist die Seite über https:// geladen?');
        }
        netStatus('off', 'bereit – unter „Gruppe“ starten');
        var gp = store('gpace');
        if (gp) $('ghostPace').value = gp;
        recoverDraft();
        var pid = store('plan');
        if (pid && Rides.get(pid)) setPlan(pid); else if (pid) clearPlan();
        profMode = store('profmode') || null;
        if (store('mapprof') === '1') { $('mapProf').hidden = false; $('mapProfBtn').classList.add('on'); $('mapProfBtn').setAttribute('aria-pressed', 'true'); }
        syncProfMode();
        renderRides(); renderGhostUi(); liveMap.sync();
        setInterval(function () {                        // ghost in real time (the simulation drives it itself)
            if (running && !sim) ghostStep(Date.now(), Date.now());
            renderGhostUi();
        }, 1000);
        setInterval(saveDraftNow, 60000);
        window.addEventListener('pagehide', saveDraftNow);
        showView(LigaUI.hasInvite() ? 'liga' : 'group');
        setInterval(render, RENDER_MS);
        render();
        if (new URLSearchParams(location.search).has('sim')) simStart();
    });
})();
