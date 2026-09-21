/* ============================================================
 * analytics.js -- was auf einer Gruppenausfahrt wirklich zaehlt
 * ============================================================
 * Alles hier baut auf der Bogenlaenge s aus route.js auf.
 * Ohne gemeinsame Achse gaebe es keine dieser Zahlen.
 *
 *   Reihenfolge      nach s sortieren
 *   Fuehrungsarbeit  Zeit als order[0], plus einzelne Ablosungen
 *   Ueberholvorgang  Vorzeichenwechsel von (sA - sB), entprellt
 *   Antritt          jemand gewinnt >15 m auf die Gruppe in <20 s
 *   Bergsprint       Steigungsintervall der Achse + Zeit je Fahrer darin
 *   Abgerissen       Luecke zur Spitze ueber Schwelle / steht
 *
 * Entprellung ist hier nicht Kosmetik: GPS-Rauschen von +-3 m
 * erzeugt sonst im Sekundentakt Fantasie-Ueberholmanoever
 * zwischen zwei Fahrern, die nebeneinander rollen.
 * ============================================================ */

var Analytics = (function () {
    'use strict';

    // --- Ueberholen ---
    var PASS_DEADBAND = 8;       // m, innerhalb davon gilt: gleichauf
    var PASS_SUSTAIN  = 3000;    // ms, so lange muss die neue Lage halten

    // --- Antritt ---
    var ATTACK_GAIN   = 15;      // m Vorsprungsgewinn auf den Schnitt
    var ATTACK_WIN    = 20000;   // ms Fenster
    var ATTACK_COOLDOWN = 45000; // ms, nicht dauerhaft neu melden

    // --- Berge ---
    var CLIMB_START   = 0.030;   // 3 % Steigung startet
    var CLIMB_END     = 0.010;   // unter 1 % endet
    /* CLIMB_END_RUN ist Hysterese IM RAUM: ein kurzer Rauschdip in der
       Steigung darf einen Anstieg nicht beenden, sonst zerfaellt ein
       Berg in ein Dutzend Schnipsel. */
    var CLIMB_END_RUN = 120;     // m, so lange muss es flach bleiben
    var CLIMB_MIN_GAIN= 12;      // m Hoehengewinn
    var CLIMB_MIN_LEN = 200;     // m Laenge
    var GRADE_WIN     = 150;     // m, Fenster fuer die Steigungsmessung

    // --- Abriss ---
    var DROP_GAP      = 200;     // m zur Spitze
    var STOP_SPEED    = 1.5;     // m/s
    var STOP_TIME     = 30000;   // ms

    var STALE_MS      = 15000;   // ohne Update gilt ein Fahrer als veraltet
    var GONE_MS       = 180000;  // danach ganz raus

    /* Positionsglaettung. Rohe Fixes wackeln um +-4 m; genau dieses
       Wackeln erzeugt die Fantasie-Ueberholmanoever. Die Verzoegerung
       (ca. 20 m bei 10 m/s) trifft ALLE Fahrer gleich und aendert die
       Reihenfolge deshalb nicht -- sie verschiebt nur die Achse als
       Ganzes ein wenig nach hinten. */
    var POS_TAU       = 2.0;     // s

    /* Antritt: nicht "ist dauerhaft stärker", sondern "beschleunigt
       jetzt". Deshalb zwei Bedingungen gleichzeitig. */
    var ATTACK_SURGE  = 1.5;     // m/s Tempozuwachs gegenueber eigenem Schnitt
    var ATTACK_REF    = 30000;   // ms Referenzfenster fuer diesen Schnitt

    /* Abriss mit Hysterese, sonst flattert es im Sekundentakt. */
    var REJOIN_GAP    = 120;     // m, erst darunter gilt man als zurueck

    /* Routensetzer-Wechsel: erst wenn jemand klar vorne ist, sonst
       wechselt die Zustaendigkeit im GPS-Rauschen hin und her -- und
       genau das erzeugt den Zickzack, den der Setzer verhindern soll. */
    var HANDOVER      = 25;      // m Vorsprung vor dem Routenende
    var SETTER_TIMEOUT= 10000;   // ms ohne Meldung -> Achse uebernehmen

    function A(route) {
        this.route   = route;
        this.riders  = {};
        this.events  = [];
        this.stints  = [];      // Ablosungen: {id, tStart, tEnd, ms, meters}
        this.climbs  = [];
        this.pairs   = {};
        this.setterId = null;
        this.leader  = null;
        this.leaderSince = null;
        this.leaderStartS = null;
        this.lastTick = null;
        this.lastClimbScan = 0;
        this.startedAt = null;
    }

    A.prototype.rider = function (id) {
        if (!this.riders[id]) {
            this.riders[id] = {
                id: id, name: null, color: null,
                lat: null, lon: null, ele: null, acc: null,
                fLat: null, fLon: null,   // geglaettete Position
                s: null, offset: null, speed: 0, heading: null,
                t: 0, lastSeen: 0,
                frontMs: 0, maxSpeed: 0,
                hist: [],                 // {t, s} fuer Bergzeiten
                vHist: [],                // {t, v} fuer Antritts-Erkennung
                stoppedSince: null,
                dropped: false,
                lastAttack: 0,
                self: false
            };
        }
        return this.riders[id];
    };

    /* ---- Position einarbeiten ------------------------------------ */
    A.prototype.ingest = function (id, p) {
        var r = this.rider(id);
        if (this.startedAt === null) this.startedAt = p.t;
        if (p.name) r.name = p.name;
        if (p.color) r.color = p.color;

        var dtS = (r.t && p.t > r.t) ? (p.t - r.t) / 1000 : 0;

        r.lat = p.lat; r.lon = p.lon;
        r.ele = (p.ele === undefined ? null : p.ele);
        r.acc = (p.acc === undefined ? null : p.acc);
        r.speed = p.speed || 0;
        if (p.heading !== undefined && p.heading !== null) r.heading = p.heading;
        r.t = p.t;
        r.lastSeen = Date.now();
        if (r.speed > r.maxSpeed) r.maxSpeed = r.speed;

        // --- Position glaetten ---
        if (r.fLat === null || dtS === 0 || dtS > 10) {
            r.fLat = p.lat; r.fLon = p.lon;
        } else {
            var k = POS_TAU / (POS_TAU + dtS);
            r.fLat = k * r.fLat + (1 - k) * p.lat;
            r.fLon = k * r.fLon + (1 - k) * p.lon;
        }

        /* --- Routensetzer bestimmen ---
           Nur EIN Fahrer verlaengert die Achse (siehe route.js: sonst
           faltet sie sich). Uebernommen wird sie, wenn jemand klar
           vorne ist, oder wenn der bisherige Setzer nicht mehr sendet
           (Handy leer, Funkloch) -- sonst stuende die Achse still. */
        if (this.route.pts.length === 0) {
            this.setterId = id;
        } else if (this.setterId !== id) {
            var setter = this.riders[this.setterId];
            var setterGone = !setter || (p.t - setter.t) > SETTER_TIMEOUT;
            var probe = this.route.project(r.fLat, r.fLon, r.s);
            if (setterGone || (probe && probe.s > this.route.length() + HANDOVER)) {
                this.setterId = id;
            }
        }

        // Achse pflegen bzw. darauf projizieren -- mit der geglaetteten
        // Position, sonst zackt die Polylinie und die Segmentrichtung
        // wird unbrauchbar.
        var pr = this.route.consider(r.fLat, r.fLon, r.ele, r.s,
                                     this.setterId === id, id);
        if (pr) {
            r.s = pr.s;
            r.offset = pr.offset;
        }

        // Tempoverlauf fuer die Antritts-Erkennung
        r.vHist.push({ t: p.t, v: r.speed });
        if (r.vHist.length > 600) r.vHist.splice(0, 200);

        // Verlauf fuer Bergzeiten -- dezimiert, damit es nicht ausufert
        if (r.s !== null) {
            var h = r.hist;
            var lastH = h.length ? h[h.length - 1] : null;
            if (!lastH || Math.abs(r.s - lastH.s) > 3 || p.t - lastH.t > 2000) {
                h.push({ t: p.t, s: r.s });
                if (h.length > 20000) h.splice(0, 5000);
            }
        }

        // Stillstand
        if (r.speed < STOP_SPEED) {
            if (r.stoppedSince === null) r.stoppedSince = p.t;
        } else {
            r.stoppedSince = null;
        }
    };

    /* ---- aktive Fahrer, sortiert von vorne nach hinten ----------- */
    A.prototype.order = function () {
        var now = Date.now();
        var out = [];
        for (var id in this.riders) {
            var r = this.riders[id];
            if (r.s === null) continue;
            if (now - r.lastSeen > GONE_MS) continue;
            out.push(r);
        }
        out.sort(function (a, b) { return b.s - a.s; });
        return out;
    };

    A.prototype.isStale = function (r) {
        return Date.now() - r.lastSeen > STALE_MS;
    };

    /* ---- periodische Auswertung --------------------------------- */
    A.prototype.tick = function (now) {
        now = now || Date.now();
        var dt = this.lastTick === null ? 0 : now - this.lastTick;
        this.lastTick = now;
        if (dt < 0 || dt > 30000) dt = 0;

        var ord = this.order();
        if (!ord.length) return ord;

        // --- Fuehrungsarbeit + Ablosungen ---
        var lead = ord[0];
        if (dt) lead.frontMs += dt;

        if (this.leader !== lead.id) {
            if (this.leader !== null) {
                var prev = this.riders[this.leader];
                this.stints.push({
                    id: this.leader,
                    tStart: this.leaderSince,
                    tEnd: now,
                    ms: now - this.leaderSince,
                    meters: (prev && prev.s !== null && this.leaderStartS !== null)
                                ? Math.max(0, prev.s - this.leaderStartS) : 0
                });
                this._event(now, 'lead', { id: lead.id, from: this.leader });
            }
            this.leader = lead.id;
            this.leaderSince = now;
            this.leaderStartS = lead.s;
        }

        /* Aufwaermphase: solange die Achse noch kurz ist, sind die
           s-Werte nicht belastbar. Wer hier schon Ueberholvorgaenge
           meldet, produziert reine Startartefakte. */
        var warm = this.route.length() > 150;

        // --- Ueberholvorgaenge ---
        if (warm) this._detectPasses(ord, now);

        // --- Antritte ---
        if (warm) this._detectAttacks(ord, now);

        // --- Abriss ---
        for (var i = 0; i < ord.length; i++) {
            var r = ord[i];
            var gapToLead = lead.s - r.s;
            var standing = r.stoppedSince !== null && (r.t - r.stoppedSince) > STOP_TIME;
            /* Hysterese: abgerissen ab DROP_GAP, zurueck erst unter
               REJOIN_GAP. Mit einer einzigen Schwelle flattert der
               Zustand im Sekundentakt, sobald jemand genau dort pendelt. */
            var nowDropped = r.dropped
                ? (gapToLead > REJOIN_GAP || (standing && r !== lead))
                : ((gapToLead > DROP_GAP) || (standing && ord.length > 1 && r !== lead));
            if (nowDropped && !r.dropped) {
                this._event(now, 'drop', { id: r.id, gap: Math.round(gapToLead),
                                           standing: standing });
            }
            if (!nowDropped && r.dropped) {
                this._event(now, 'rejoin', { id: r.id });
            }
            r.dropped = nowDropped;
        }

        // --- Berge (nicht jede Runde, das kostet) ---
        if (now - this.lastClimbScan > 8000) {
            this.lastClimbScan = now;
            this._scanClimbs();
            this._scoreClimbs();
        }

        return ord;
    };

    A.prototype._event = function (t, type, data) {
        data = data || {};
        data.t = t; data.type = type;
        this.events.push(data);
        if (this.events.length > 500) this.events.splice(0, 100);
        return data;
    };

    /* ---- Ueberholen, entprellt ---------------------------------- */
    A.prototype._detectPasses = function (ord, now) {
        for (var i = 0; i < ord.length; i++) {
            for (var j = i + 1; j < ord.length; j++) {
                var a = ord[i], b = ord[j];
                // kanonische Paarreihenfolge, damit das Vorzeichen stabil ist
                var first = a.id < b.id ? a : b;
                var second = a.id < b.id ? b : a;
                var key = first.id + '|' + second.id;
                var diff = first.s - second.s;

                var st = this.pairs[key];
                if (!st) { st = this.pairs[key] = { sign: 0, cand: 0, since: now }; }

                var sign = 0;
                if (diff > PASS_DEADBAND) sign = 1;
                else if (diff < -PASS_DEADBAND) sign = -1;

                if (sign === 0) continue;          // gleichauf: nichts entscheiden

                if (sign !== st.cand) {
                    st.cand = sign;
                    st.since = now;
                    continue;
                }
                // Kandidat haelt sich lange genug?
                if (now - st.since < PASS_SUSTAIN) continue;

                if (st.sign !== 0 && st.sign !== sign) {
                    var passer = sign === 1 ? first : second;
                    var passed = sign === 1 ? second : first;
                    this._event(now, 'pass', { id: passer.id, over: passed.id });
                }
                st.sign = sign;
            }
        }
    };

    /* ---- Antritt: Vorsprungsgewinn auf den Gruppenschnitt -------- */
    A.prototype._detectAttacks = function (ord, now) {
        if (ord.length < 2) return;
        var mean = 0;
        for (var i = 0; i < ord.length; i++) mean += ord[i].s;
        mean /= ord.length;

        for (var k = 0; k < ord.length; k++) {
            var r = ord[k];
            if (now - r.lastAttack < ATTACK_COOLDOWN) continue;
            // s relativ zum Schnitt, vor ATTACK_WIN und jetzt
            var relNow = r.s - mean;
            var past = this._sAt(r, r.t - ATTACK_WIN);
            if (past === null) continue;
            var meanPast = 0, cnt = 0;
            for (var m = 0; m < ord.length; m++) {
                var sp = this._sAt(ord[m], ord[m].t - ATTACK_WIN);
                if (sp !== null) { meanPast += sp; cnt++; }
            }
            if (!cnt) continue;
            meanPast /= cnt;
            var relPast = past - meanPast;
            if (relNow - relPast < ATTACK_GAIN) continue;

            /* Zweite Bedingung: der Fahrer muss JETZT schneller sein als
               er selbst zuletzt war. Ohne das meldet jeder Bergfahrer
               auf jeder Steigung dauernd "Antritt", nur weil er
               konstant staerker ist -- das ist kein Antritt. */
            var vNow = this._vMean(r, r.t - 8000, r.t);
            var vRef = this._vMean(r, r.t - ATTACK_REF, r.t - 10000);
            if (vNow === null || vRef === null) continue;
            if (vNow - vRef < ATTACK_SURGE) continue;

            r.lastAttack = now;
            this._event(now, 'attack', {
                id: r.id,
                gain: Math.round(relNow - relPast),
                surge: Math.round((vNow - vRef) * 36) / 10   // km/h
            });
        }
    };

    /* Mittleres Tempo eines Fahrers im Zeitfenster [t0, t1]. */
    A.prototype._vMean = function (r, t0, t1) {
        var sum = 0, cnt = 0;
        for (var i = r.vHist.length - 1; i >= 0; i--) {
            var e = r.vHist[i];
            if (e.t < t0) break;
            if (e.t <= t1) { sum += e.v; cnt++; }
        }
        return cnt ? sum / cnt : null;
    };

    /* Bogenlaenge eines Fahrers zum Zeitpunkt t, linear interpoliert. */
    A.prototype._sAt = function (r, t) {
        var h = r.hist;
        if (!h.length) return null;
        if (t <= h[0].t) return null;
        if (t >= h[h.length - 1].t) return h[h.length - 1].s;
        var lo = 0, hi = h.length - 1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (h[mid].t <= t) lo = mid; else hi = mid - 1;
        }
        var p = h[lo], q = h[Math.min(h.length - 1, lo + 1)];
        if (q.t === p.t) return p.s;
        var f = (t - p.t) / (q.t - p.t);
        return p.s + f * (q.s - p.s);
    };

    /* Zeitpunkt, zu dem ein Fahrer die Bogenlaenge sTarget aufwaerts
       passiert hat -- die LETZTE solche Kreuzung vor beforeT.

       Bewusst die letzte, nicht die erste: Solange die Achse noch
       waechst, extrapoliert project() ueber das Routenende hinaus und
       kann kurzzeitig ueberschiessen. Die erste Kreuzung ist dann ein
       Artefakt aus der Aufwaermphase -- damit "gewinnt" der schwaechste
       Fahrer den Berg in 30 Sekunden. Die letzte Kreuzung ist die
       echte Auffahrt (und bei zwei Runden ueber denselben Berg die
       aktuelle). */
    A.prototype._tCross = function (r, sTarget, beforeT) {
        var h = r.hist, res = null;
        for (var i = 1; i < h.length; i++) {
            if (beforeT !== null && h[i].t > beforeT) break;
            if (h[i - 1].s <= sTarget && h[i].s >= sTarget) {
                var span = h[i].s - h[i - 1].s;
                var f = span < 1e-6 ? 0 : (sTarget - h[i - 1].s) / span;
                res = h[i - 1].t + f * (h[i].t - h[i - 1].t);
            }
        }
        return res;
    };

    /* ---- Steigungen auf der Achse finden ------------------------ */
    A.prototype._scanClimbs = function () {
        var rt = this.route;
        rt.smoothElevation();
        var pts = rt.pts;
        if (pts.length < 10) return;

        var found = [];
        var cur = null;
        var flatRun = 0;

        for (var i = 0; i < pts.length; i++) {
            var s0 = pts[i].s;
            var e0 = rt.eleAt(s0);
            var e1 = rt.eleAt(s0 + GRADE_WIN);
            if (e0 === null || e1 === null) continue;
            var grade = (e1 - e0) / GRADE_WIN;

            if (cur === null) {
                if (grade >= CLIMB_START) {
                    cur = { sStart: s0, eStart: e0, sEnd: s0, eEnd: e0 };
                    flatRun = 0;
                }
            } else {
                if (grade >= CLIMB_END) {
                    cur.sEnd = s0 + GRADE_WIN;
                    cur.eEnd = e1;
                    flatRun = 0;
                } else {
                    flatRun += (i > 0 ? (pts[i].s - pts[i - 1].s) : 0);
                    if (flatRun >= CLIMB_END_RUN) {
                        var gain = cur.eEnd - cur.eStart;
                        var len = cur.sEnd - cur.sStart;
                        if (gain >= CLIMB_MIN_GAIN && len >= CLIMB_MIN_LEN) found.push(cur);
                        cur = null;
                    }
                }
            }
        }
        if (cur !== null) {
            var g2 = cur.eEnd - cur.eStart, l2 = cur.sEnd - cur.sStart;
            if (g2 >= CLIMB_MIN_GAIN && l2 >= CLIMB_MIN_LEN) found.push(cur);
        }

        // Bestehende Berge anhand von sStart wiedererkennen, damit die
        // gemessenen Zeiten nicht bei jedem Scan verloren gehen.
        var merged = [];
        for (var f = 0; f < found.length; f++) {
            var nf = found[f];
            var old = null;
            for (var o = 0; o < this.climbs.length; o++) {
                if (Math.abs(this.climbs[o].sStart - nf.sStart) < 80) { old = this.climbs[o]; break; }
            }
            if (old) {
                old.sEnd = nf.sEnd; old.eStart = nf.eStart; old.eEnd = nf.eEnd;
                merged.push(old);
            } else {
                merged.push({
                    sStart: nf.sStart, sEnd: nf.sEnd,
                    eStart: nf.eStart, eEnd: nf.eEnd,
                    times: {}, no: merged.length + 1
                });
            }
        }
        merged.forEach(function (c, i) { c.no = i + 1; });
        this.climbs = merged;
    };

    /* ---- Zeiten der Fahrer auf jedem Berg ----------------------- */
    /* Anstiege einer fertigen Achse finden (ohne Fahrer), z. B. einer
       geplanten Route: Laenge, Hoehengewinn und Steigung sind danach gesetzt. */
    A.prototype.scanClimbs = function () {
        this._scanClimbs();
        this._scoreClimbs();
        return this.climbs;
    };

    A.prototype._scoreClimbs = function () {
        for (var c = 0; c < this.climbs.length; c++) {
            var cl = this.climbs[c];
            cl.gain = cl.eEnd - cl.eStart;
            cl.len  = cl.sEnd - cl.sStart;
            cl.grade = cl.len > 0 ? cl.gain / cl.len : 0;

            for (var id in this.riders) {
                var r = this.riders[id];
                if (r.s === null || r.s < cl.sEnd) continue;   // noch nicht oben
                if (cl.times[id] && cl.times[id].done) continue;
                var tOut = this._tCross(r, cl.sEnd, null);
                if (tOut === null) continue;
                var tIn  = this._tCross(r, cl.sStart, tOut);
                if (tIn === null || tOut <= tIn) continue;
                var dur = tOut - tIn;
                /* Plausibilitaet: bergauf ist niemand mit 20 m/s
                   unterwegs und niemand langsamer als Schieben. */
                var avgMs = cl.len / (dur / 1000);
                if (avgMs > 20 || avgMs < 0.5) continue;
                cl.times[id] = {
                    ms: dur,
                    vam: cl.gain / (dur / 3600000),        // Hoehenmeter pro Stunde
                    avg: cl.len / (dur / 1000),            // m/s
                    done: true
                };
            }
        }
    };

    /* ---- Rangliste eines Berges --------------------------------- */
    A.prototype.climbRanking = function (climb) {
        var out = [];
        for (var id in climb.times) {
            out.push({ id: id, name: (this.riders[id] && this.riders[id].name) || id,
                       ms: climb.times[id].ms, vam: climb.times[id].vam });
        }
        out.sort(function (a, b) { return a.ms - b.ms; });
        return out;
    };

    /* ---- Luecken zwischen benachbarten Fahrern ------------------ */
    A.prototype.gaps = function (ord) {
        var out = [];
        for (var i = 1; i < ord.length; i++) {
            var front = ord[i - 1], back = ord[i];
            var m = front.s - back.s;
            out.push({ front: front.id, back: back.id, meters: m,
                       seconds: m / Math.max(2, back.speed) });
        }
        return out;
    };

    /* ---- Zusammenfassung fuer den Export ------------------------ */
    A.prototype.summary = function () {
        var self = this;
        var ord = this.order();
        var totalFront = 0;
        ord.forEach(function (r) { totalFront += r.frontMs; });

        return {
            startedAt: this.startedAt,
            endedAt: Date.now(),
            routeLength: Math.round(this.route.length()),
            riders: ord.map(function (r) {
                return {
                    id: r.id, name: r.name || r.id,
                    frontMs: Math.round(r.frontMs),
                    frontShare: totalFront ? r.frontMs / totalFront : 0,
                    maxSpeed: r.maxSpeed,
                    finalS: Math.round(r.s)
                };
            }),
            stints: this.stints.map(function (s) {
                return { id: s.id, name: (self.riders[s.id] && self.riders[s.id].name) || s.id,
                         tStart: s.tStart, ms: Math.round(s.ms),
                         meters: Math.round(s.meters) };
            }),
            climbs: this.climbs.map(function (c) {
                return {
                    no: c.no,
                    startS: Math.round(c.sStart), length: Math.round(c.len),
                    gain: Math.round(c.gain * 10) / 10,
                    gradePct: Math.round(c.grade * 1000) / 10,
                    ranking: self.climbRanking(c).map(function (x) {
                        return { name: x.name, seconds: Math.round(x.ms / 100) / 10,
                                 vam: Math.round(x.vam) };
                    })
                };
            }),
            events: this.events.map(function (e) {
                var o = { t: e.t, type: e.type };
                if (e.id)   o.who  = (self.riders[e.id]   && self.riders[e.id].name)   || e.id;
                if (e.over) o.whom = (self.riders[e.over] && self.riders[e.over].name) || e.over;
                if (e.from) o.from = (self.riders[e.from] && self.riders[e.from].name) || e.from;
                if (e.gain !== undefined) o.gain = e.gain;
                if (e.gap  !== undefined) o.gap  = e.gap;
                return o;
            })
        };
    };

    A.PASS_DEADBAND = PASS_DEADBAND;
    A.PASS_SUSTAIN  = PASS_SUSTAIN;
    A.DROP_GAP      = DROP_GAP;
    A.STALE_MS      = STALE_MS;
    return A;
})();

if (typeof module !== 'undefined') module.exports = Analytics;
