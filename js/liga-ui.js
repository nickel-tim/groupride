/* ============================================================
 * liga-ui.js -- the "League" tab and the league line on the speedometer
 * ============================================================
 * Typing only happens at login (e-mail, code) and when setting up a league (name) --
 * never on the bike. On the road there is only tapping: switching the category of the speedometer line.
 *
 * Everything is assembled as HTML text and attached via data-act to ONE click handler;
 * every input is treated with UI.escapeHtml before being inserted.
 * ============================================================ */

var LigaUI = (function () {
    'use strict';

    var cfg = null;                 // connection to app.js: { me, live, showView, ridesChanged }
    var root = null;
    var st = {
        page: 'home', league: null, tab: 'stand', period: null,
        ov: null, hall: null, shared: null, segs: null, mine: null,      // loaded from the server
        login: { step: 1, email: '', dev: '' }, msg: '', err: '', busy: false,
        form: null, shareFor: null, invite: null, devices: null
    };
    var tachoTimer = null, lastStandingAt = 0;

    function esc(s) { return UI.escapeHtml(String(s === null || s === undefined ? '' : s)); }
    function $(id) { return document.getElementById(id); }
    function num2(n) { return (n < 10 ? '0' : '') + n; }
    function emo(i) { var e = UI.emojiOf(i); return e ? '<span class="lg-em">' + Emo.img(e) + '</span>' : '<span class="lg-em"></span>'; }

    /* ---------- Time ---------- */
    function fmtDay(ts, tz) { return new Date(ts).toLocaleDateString(I18n.locale(), { day: '2-digit', month: '2-digit', timeZone: tz }); }
    function fmtDayY(ts, tz) { return new Date(ts).toLocaleDateString(I18n.locale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }); }
    function periodLabel(lg, p) {
        if (!lg || !p) return '';
        if (lg.unit === 'month' && lg.every === 1) return new Date(p.start + 43200000).toLocaleDateString(I18n.locale(), { month: 'long', year: 'numeric', timeZone: lg.tz });
        if (lg.unit === 'year' && lg.every === 1) return new Date(p.start + 43200000).toLocaleDateString(I18n.locale(), { year: 'numeric', timeZone: lg.tz });
        return fmtDay(p.start, lg.tz) + ' – ' + fmtDayY(p.end - 3600000, lg.tz);
    }
    function periodState(p) {
        var now = Date.now();
        if (p.frozen) return T('abgeschlossen');
        if (p.upcoming) return T('beginnt am {d}', { d: fmtDayY(p.start) });
        if (p.open) { var d = Math.ceil((p.end - now) / 86400000); return d <= 1 ? T('endet heute') : T('noch {n} Tage', { n: d }); }
        return T('Nachfrist läuft – spät hochgeladene Fahrten zählen noch');
    }
    function unitLabel(lg) {
        if (lg.unit === 'once') return T('einmalig');
        if (lg.every === 1) return lg.unit === 'week' ? T('wöchentlich') : lg.unit === 'month' ? T('monatlich') : lg.unit === 'year' ? T('jährlich') : T('täglich');
        var n = { n: lg.every };
        return lg.unit === 'week' ? T('alle {n} Wochen', n) : lg.unit === 'month' ? T('alle {n} Monate', n) : lg.unit === 'year' ? T('alle {n} Jahre', n) : T('alle {n} Tage', n);
    }

    /* ---------- Building blocks ---------- */
    function btn(act, label, extra, cls) {
        return '<button class="btn ' + (cls || '') + '" data-act="' + act + '"' + (extra ? ' ' + extra : '') + '>' + label + '</button>';
    }
    function msgBox() {
        return (st.err ? '<div class="note lg-err">' + esc(st.err) + '</div>' : '') + (st.msg ? '<div class="note lg-ok">' + esc(st.msg) + '</div>' : '');
    }
    function catLabel(key) {
        var c = LigaCats.get(key);
        if (c && c.agg === 'seg' && st.segs) { var s = st.segs.filter(function (x) { return 'seg:' + x.id === key; })[0]; return s ? T('Segment: {n}', { n: s.name }) : T('Segment'); }
        if (key === '_total') return T('Gesamtwertung');
        return c ? T(c.label) : key;
    }
    function bar(progress, target, cat) {
        var pct = Math.max(0, Math.min(100, Math.round(progress / target * 100)));
        return '<div class="lg-goal"><div class="lg-bar"><i style="width:' + pct + '%"></i></div><span class="num">' +
               LigaCats.format(cat, progress) + ' / ' + LigaCats.format(cat, target) + ' · ' + pct + ' %</span></div>';
    }
    function setMsg(ok, err) { st.msg = ok || ''; st.err = err || ''; }

    /* ---------- Rendering ---------- */
    function render() {
        if (!root) return;
        var acct = LigaApi.account();
        var html;
        if (!acct) html = renderLogin();
        else if (st.page === 'league' && st.league) html = renderLeague();
        else if (st.page === 'form') html = renderForm();
        else html = renderHome();
        var keep = root.scrollTop;
        root.innerHTML = html;
        root.scrollTop = keep;
        renderAccountBox();
    }

    /* ---- Login ---- */
    function renderLogin() {
        var l = st.login, h = T('<h2>Liga</h2>') +
            T('<div class="note">Monats- oder Wochen-Wettbewerbe mit Freunden: Kilometer, Höhenmeter, Topspeed, Führungsarbeit und mehr. ') +
            T('Dafür werden deine <b>Fahrten samt Strecke</b> auf dem Server gespeichert. Den Verlauf sieht nur du, die anderen sehen nur Zahlen ') +
            T('(und Fahrten, die du ausdrücklich teilst). Die Live-Gruppe funktioniert weiter ohne Konto.</div>') + msgBox();
        if (st.invite) h += T('<div class="note lg-ok">Du wurdest zu einer Liga eingeladen. Melde dich an, dann kannst du beitreten.</div>');
        if (l.step === 1) {
            h += T('<label for="lgEmail">E-Mail-Adresse</label>') +
                 T('<input type="email" id="lgEmail" autocomplete="email" inputmode="email" placeholder="du@beispiel.de" value="') + esc(l.email) + '">' +
                 btn('login-start', T('Code per E-Mail senden'), '', 'go') +
                 T('<div class="note">Die Adresse dient nur dazu, dir einen Code zu schicken und dich auf einem neuen Gerät wiederzuerkennen. ') +
                 T('Gespeichert wird nur ein Prüfwert, nicht die Adresse. Dein Name, dein Symbol und deine Farbe kommen aus „Mehr“.</div>');
        } else {
            h += T('<div class="note">Ein 6-stelliger Code wurde an <b>') + esc(l.email) + T('</b> geschickt (10 Minuten gültig).</div>') +
                 (l.dev ? T('<div class="note lg-ok">Entwicklungsmodus: Code ') + esc(l.dev) + '</div>' : '') +
                 T('<label for="lgCode">Code</label>') +
                 '<input type="text" id="lgCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="123456" value="' + esc(l.dev) + '">' +
                 btn('login-verify', T('Anmelden'), '', 'go') + btn('login-back', T('Andere Adresse'));
        }
        return h;
    }

    /* ---- Home page ---- */
    function renderHome() {
        var a = LigaApi.account(), lgs = LigaSync.leagues(), h = T('<h2>Liga</h2>') + msgBox();
        if (st.invite) {
            h += T('<div class="lg-card"><b>Einladung zu einer Liga</b><div class="note">Möchtest du beitreten? Die anderen Mitglieder sehen danach deinen Namen und deine Zahlen.</div>') +
                 btn('join', T('Beitreten'), '', 'go') + btn('join-no', T('Ablehnen')) + '</div>';
        }
        h += T('<h2>Ligen</h2>');
        if (!lgs.length) h += T('<div class="note">Noch in keiner Liga. Lege eine an oder öffne den Einladungslink eines Freundes.</div>');
        lgs.forEach(function (l) {
            var p = l.period;
            h += '<button class="lg-league" data-act="open" data-id="' + esc(l.id) + '"><b>' + esc(l.name) + '</b>' +
                 '<span>' + esc(unitLabel(l)) + (p ? ' · ' + esc(periodLabel(l, p)) : '') + (l.isAdmin ? ' · ' + T('Admin') : '') + '</span></button>';
        });
        h += btn('new', T('Neue Liga anlegen'), '', 'go') +
             T('<label for="lgInvite">Einladungslink einfügen</label><input type="text" id="lgInvite" placeholder="https://…#l=…" autocomplete="off">') +
             btn('paste-join', T('Beitreten'));

        h += T('<h2>Uploads</h2>') + renderRides();
        return h;
    }

    /* ---- Account: shown under "More" ---- */
    function renderAccount() {
        var a = LigaApi.account();
        if (!a) return T('<div class="note">Nicht angemeldet. Die Liga ist freiwillig – die Live-Gruppe funktioniert ohne Konto.</div>') + btn('goto-liga', T('Zur Liga …'));
        return T('<div class="lg-card"><div class="lg-me">') + emo(a.emoji) + '<b>' + esc(a.name) + '</b></div>' +
               T('<div class="note">Angemeldet auf diesem Gerät. Name, Symbol und Farbe änderst du oben unter „Ich“.</div>') + msgBox() +
               btn('devices', T('Geräte anzeigen')) + (st.devices ? renderDevices() : '') +
               btn('logout', T('Auf diesem Gerät abmelden')) + btn('delete-account', T('Konto und alle Daten löschen'), '', 'danger') + '</div>';
    }
    function renderAccountBox() { var el = $('accountRoot'); if (el) el.innerHTML = renderAccount(); }

    function renderDevices() {
        return '<div class="lg-devs">' + st.devices.map(function (d) {
            return '<div class="lg-row"><span class="lg-nm">' + esc(d.label || T('Gerät')) + (d.current ? ' (' + T('dieses') + ')' : '') + '</span>' +
                   '<span class="lg-v">' + T('seit') + ' ' + esc(new Date(d.created_at).toLocaleDateString(I18n.locale())) + '</span>' +
                   (d.current ? '' : '<button class="lg-mini" data-act="dev-rm" data-id="' + esc(d.id) + T('">abmelden</button>')) + '</div>';
        }).join('') + '</div>';
    }

    function renderRides() {
        var rides = Rides.list().filter(LigaSync.eligible), up = LigaSync.up();
        var ok = 0, wait = 0, rej = 0, none = 0;
        rides.forEach(function (r) { var s = up[r.id]; if (!s) none++; else if (s.state === 'ok') ok++; else if (s.state === 'wait') wait++; else rej++; });
        var h = '<div class="note">' + T('{n} hochgeladen', { n: ok }) + (wait ? ' · ' + T('{n} warten auf Netz', { n: wait }) : '') + (rej ? ' · ' + T('{n} abgelehnt', { n: rej }) : '') + (none ? ' · ' + T('{n} noch nicht gesendet', { n: none }) : '') + '</div>' +
                '<label class="lg-check"><input type="checkbox" id="lgAuto"' + (LigaSync.auto() ? ' checked' : '') + T('> Neue Fahrten automatisch hochladen</label>');
        if (none || wait) h += btn('backfill', none ? T('Bisherige Fahrten hochladen ({n})', { n: none }) : T('Jetzt erneut versuchen'));
        rides.slice(0, 12).forEach(function (r) {
            var s = up[r.id], badge = !s ? T('nicht gesendet') : s.state === 'ok' ? T('hochgeladen') : s.state === 'wait' ? T('wartet') : T('abgelehnt');
            h += '<div class="lg-ride"><div class="lg-rt"><b>' + esc(r.name) + '</b><span>' + esc(UI.fmtDist(r.dist)) + ' · ' + esc(badge) + '</span></div>' +
                 (s && s.state === 'rej' ? '<div class="note lg-err">' + esc(T(s.reason || '')) + '</div>' : '') +
                 (s && s.state === 'ok' ? '<button class="lg-mini" data-act="share-open" data-id="' + esc(r.id) + T('">Teilen …</button>') +
                                          '<button class="lg-mini" data-act="ride-rm" data-id="' + esc(r.id) + T('">Vom Server löschen</button>') : '') +
                 (s && s.state === 'rej' ? '<button class="lg-mini" data-act="ride-retry" data-id="' + esc(r.id) + T('">Erneut versuchen</button>') : '') +
                 (st.shareFor === r.id ? renderSharePanel(r.id) : '') + '</div>';
        });
        if (rides.length > 12) h += '<div class="note">' + T('… und {n} ältere Fahrten.', { n: rides.length - 12 }) + '</div>';
        return h;
    }

    function renderSharePanel(localId) {
        var sid = (LigaSync.status(localId) || {}).sid, lgs = LigaSync.leagues();
        var mine = st.mine && st.mine.filter(function (r) { return r.id === sid; })[0];
        var shared = mine ? mine.shared : [];
        if (!lgs.length) return T('<div class="note">Du bist in keiner Liga.</div>');
        return T('<div class="lg-share"><div class="note">Andere Mitglieder sehen die Strecke ohne die ersten und letzten 300 m (damit dein Zuhause nicht auftaucht) und können sie als Ghost laden.</div>') +
            lgs.map(function (l) {
                var on = shared.indexOf(l.id) >= 0;
                return '<div class="lg-row"><span class="lg-nm">' + esc(l.name) + '</span><button class="lg-mini ' + (on ? 'on' : '') + '" data-act="' + (on ? 'unshare' : 'share') + '" data-id="' + esc(localId) + '" data-league="' + esc(l.id) + '">' + (on ? T('zurücknehmen') : T('teilen')) + '</button></div>';
            }).join('') + '</div>';
    }

    /* ---- League ---- */
    var TABS = [['stand', 'Stand'], ['halle', 'Halle'], ['strecken', 'Strecken'], ['mehr', 'Verwalten']];

    function renderLeague() {
        var ov = st.ov, h = T('<button class="lg-back" data-act="home">‹ Ligen</button>');
        if (!ov) return h + T('<div class="note">Lade …</div>') + msgBox();
        var lg = ov.league, p = ov.period;
        h += '<h2>' + esc(lg.name) + '</h2>' +
             '<div class="lg-period"><button class="lg-nav" data-act="prev"' + (p.prev === null ? ' disabled' : '') + T(' aria-label="Voriger Zeitraum">‹</button>') +
             '<div><b>' + esc(periodLabel(lg, p)) + '</b><span>' + esc(periodState(p)) + '</span></div>' +
             '<button class="lg-nav" data-act="next"' + (p.next === null ? ' disabled' : '') + T(' aria-label="Nächster Zeitraum">›</button></div>');
        h += '<div class="seg lg-tabs" role="tablist">' + TABS.map(function (t) {
            return '<button data-act="tab" data-tab="' + t[0] + '" class="' + (st.tab === t[0] ? 'on' : '') + '">' + T(t[1]) + '</button>';
        }).join('') + '</div>' + msgBox();
        if (st.tab === 'stand') h += tabGoals(ov) + tabStand(ov);
        else if (st.tab === 'halle') h += tabHall();
        else if (st.tab === 'strecken') h += tabSegs(ov) + T('<h2>Geteilte Fahrten</h2>') + tabShared();
        else h += tabMore(ov);
        return h;
    }

    function rowsHtml(rows, cat, meId, limit) {
        var ranked = rows.filter(function (r) { return r.rank !== null; }), none = rows.filter(function (r) { return r.rank === null; });
        var h = ranked.slice(0, limit || 50).map(function (r) {
            return '<div class="lg-row' + (r.id === meId ? ' me' : '') + '"><span class="lg-rk num">' + r.rank + '</span>' + emo(r.emoji) +
                   '<span class="lg-nm">' + esc(r.name) + '</span><span class="lg-v num">' + esc(cat === '_total' ? T('{n} P.', { n: Math.round(r.points) }) : LigaCats.format(cat, r.v)) + '</span></div>';
        }).join('');
        if (!ranked.length) h = T('<div class="lg-none">Noch keine Wertung.</div>');
        else if (none.length) h += '<div class="lg-none">' + T('ohne Wertung:') + ' ' + none.map(function (r) { return esc(r.name); }).join(', ') + '</div>';
        return h;
    }

    function tabStand(ov) {
        var meId = LigaApi.account().id, h = '', tacho = LigaSync.tacho();
        if (ov.total) h += T('<div class="lg-card"><div class="lg-ct">Gesamtwertung</div>') + rowsHtml(ov.total, '_total', meId) +
                           T('<div class="note">Je Kategorie gibt es Punkte: Mitglieder − Platz + 1.</div></div>');
        var order = LigaCats.LIST.map(function (c) { return c.key; });
        Object.keys(ov.boards).sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }).forEach(function (key) {
            var pinned = tacho && tacho.league === ov.league.id && tacho.cat === key;
            h += '<div class="lg-card"><div class="lg-ct">' + esc(catLabel(key)) +
                 (ov.period.open ? '<button class="lg-mini ' + (pinned ? 'on' : '') + '" data-act="pin" data-cat="' + esc(key) + T('" aria-label="Im Tacho anzeigen">') + (pinned ? T('★ im Tacho') : T('☆ Tacho')) + '</button>' : '') +
                 '</div>' + rowsHtml(ov.boards[key], key, meId, 10) + '</div>';
        });
        if (!Object.keys(ov.boards).length) h += T('<div class="note">Der Admin hat noch keine Kategorien gewählt.</div>');
        return h;
    }

    function tabGoals(ov) {
        var g = ov.goals || { team: [], personal: [] }, meId = LigaApi.account().id, h = '';
        if (ov.period.frozen) return '';
        var mem = ov.members.reduce(function (o, m) { o[m.id] = m; return o; }, {});
        var any = g.team.length || g.personal.length;
        if (any) h += T('<div class="lg-card"><div class="lg-ct">Ziele</div>');
        g.team.forEach(function (t) { h += '<div class="lg-gl">' + T('Team') + ' · ' + esc(catLabel(t.cat)) + '</div>' + bar(t.progress, t.target, t.cat); });
        g.personal.forEach(function (p) {
            h += '<div class="lg-gl">' + emo(mem[p.id] && mem[p.id].emoji) + esc(mem[p.id] ? mem[p.id].name : '?') + (p.id === meId ? ' (' + T('du') + ')' : '') + '</div>';
            p.goals.forEach(function (x) { h += '<div class="lg-gsub">' + esc(catLabel(x.cat)) + '</div>' + bar(x.progress, x.target, x.cat); });
        });
        if (st.editGoals) {
            h += (any ? '' : T('<div class="lg-card"><div class="lg-ct">Ziele</div>')) + T('<div class="lg-gl">Mein Ziel setzen</div>') + goalEditor(meGoals(ov), 'my', false) + btn('goals-save', T('Meine Ziele speichern')) + btn('goals-edit', T('Abbrechen'));
            return h + '</div>';
        }
        if (any) return h + '<button class="lg-mini" data-act="goals-edit">' + T('Mein Ziel setzen') + '</button></div>';
        return '<button class="lg-mini" data-act="goals-edit">' + T('Ziel setzen') + '</button>';
    }
    function meGoals(ov) {
        var meId = LigaApi.account().id, p = (ov.goals.personal || []).filter(function (x) { return x.id === meId; })[0];
        return st.form && st.form.myGoals ? st.form.myGoals : (p ? p.goals.map(function (x) { return { cat: x.cat, target: x.target }; }) : []);
    }

    function tabHall() {
        var hall = st.hall;
        if (!hall) return T('<div class="note">Lade …</div>');
        if (!hall.periods.length) return T('<div class="note">Die Ruhmeshalle füllt sich, sobald ein Zeitraum abgeschlossen ist.</div>');
        var h = '';
        if (hall.titles.length) {
            h += T('<div class="lg-card"><div class="lg-ct">Titel</div>') + hall.titles.map(function (t) {
                return '<div class="lg-row">' + emo(t.emoji) + '<span class="lg-nm">' + esc(t.name) + '</span><span class="lg-v num">' + T('{a}× Gesamt · {b}× Kategorie', { a: t.total, b: t.cats }) + '</span></div>';
            }).join('') + '</div>';
        }
        var lg = st.ov.league;
        hall.periods.forEach(function (p) {
            h += '<div class="lg-card"><div class="lg-ct">' + esc(periodLabel(lg, p)) + '</div>';
            if (p.total.length) h += T('<div class="lg-gl">Gesamt</div>') + p.total.map(function (e) { return medal(e, '_total'); }).join('');
            Object.keys(p.cats).forEach(function (k) {
                h += '<div class="lg-gl">' + esc(catLabel(k)) + '</div>' + p.cats[k].map(function (e) { return medal(e, k); }).join('');
            });
            h += '</div>';
        });
        return h;
    }
    function medal(e, cat) {
        return '<div class="lg-row"><span class="lg-rk num">' + e.rank + '</span>' + emo(e.emoji) + '<span class="lg-nm">' + esc(e.name) + '</span><span class="lg-v num">' +
               esc(cat === '_total' ? T('{n} P.', { n: Math.round(e.points) }) : LigaCats.format(cat, e.v)) + '</span></div>';
    }

    function tabShared() {
        if (!st.shared) return T('<div class="note">Lade …</div>');
        if (!st.shared.length) return T('<div class="note">Noch hat niemand eine Fahrt geteilt. Teilen geht unter „Fahrten“ → Fahrt öffnen → „In der Liga teilen“.</div>');
        return st.shared.map(function (r) {
            return '<div class="lg-card"><div class="lg-me">' + emo(r.emoji) + '<b>' + esc(r.name) + '</b></div>' +
                   '<div class="note">' + esc(r.owner_name) + ' · ' + esc(UI.fmtDist(r.dist_m)) + ' · ' + esc(fmtDayY(r.start_ts)) + '</div>' +
                   btn('ghost', T('Als Ghost speichern'), 'data-ride="' + esc(r.id) + '" data-owner="' + esc(r.owner_name) + '" data-name="' + esc(r.name) + '"') + '</div>';
        }).join('') + T('<div class="note">Der Ghost liegt danach unter „Fahrten“ und lässt sich auf dem Ausfahrt-Bildschirm als Gegner wählen.</div>');
    }

    function tabSegs(ov) {
        if (!st.segs) return T('<div class="note">Lade …</div>');
        var lg = ov.league, meId = LigaApi.account().id, h = '';
        h += T('<div class="note">Liga-Segmente sind Strecken, auf denen sich alle messen (z. B. ein Anstieg). Sobald eins angelegt ist, gleicht jedes Mitglied seine Fahrten damit ab. ') +
             T('Anstiegs-Segmente zählen für den Kletterkönig; jedes Segment kann außerdem eine eigene Rangliste bekommen.</div>');
        st.segs.forEach(function (s) {
            var on = lg.cats.indexOf('seg:' + s.id) >= 0;
            h += '<div class="lg-card"><div class="lg-ct">' + esc(s.name) + '</div><div class="note">' + esc(s.kind === 'climb' ? T('Anstieg') : s.kind === 'sprint' ? T('Sprint') : T('Segment')) + ' · ' +
                 esc(UI.fmtDist(s.len)) + (s.gain ? ' · ' + T('{n} m hoch', { n: Math.round(s.gain) }) : '') + '</div>' +
                 (lg.isAdmin ? '<button class="lg-mini ' + (on ? 'on' : '') + '" data-act="seg-board" data-id="' + esc(s.id) + '">' + (on ? T('hat eine Rangliste') : T('Rangliste anlegen')) + '</button>' : '') +
                 (lg.isAdmin || s.created_by === meId ? '<button class="lg-mini" data-act="seg-rm" data-id="' + esc(s.id) + T('">löschen</button>') : '') + '</div>';
        });
        var mine = (typeof Segments !== 'undefined' ? Segments.list() : []).filter(function (m) { return m.poly && m.poly.length > 1; });
        h += T('<div class="lg-card"><div class="lg-ct">Aus meinen Segmenten übernehmen</div>');
        if (!mine.length) h += T('<div class="lg-none">Du hast noch keine Segmente. Lege welche unter „Fahrten → Segmente“ an.</div>');
        mine.slice(0, 20).forEach(function (m) {
            h += '<div class="lg-row"><span class="lg-nm">' + esc(m.name) + '</span><span class="lg-v">' + esc(UI.fmtDist(m.len)) + '</span>' +
                 '<button class="lg-mini" data-act="seg-add" data-id="' + esc(m.id) + T('">hinzufügen</button></div>');
        });
        return h + '</div>';
    }

    function tabMore(ov) {
        var lg = ov.league, meId = LigaApi.account().id, h = '';
        h += '<div class="lg-card"><div class="lg-ct">' + T('Mitglieder ({n})', { n: ov.members.length }) + '</div>' + ov.members.map(function (m) {
            return '<div class="lg-row">' + emo(m.emoji) + '<span class="lg-nm">' + esc(m.name) + (m.id === lg.admin ? ' · ' + T('Admin') : '') + (m.me ? ' · ' + T('du') : '') + '</span>' +
                   (lg.isAdmin && !m.me ? '<button class="lg-mini" data-act="member-rm" data-id="' + esc(m.id) + T('">entfernen</button>') : '') + '</div>';
        }).join('') + '</div>';
        h += T('<div class="lg-card"><div class="lg-ct">Freunde einladen</div>');
        if (st.invite_link) {
            h += '<div class="lg-qr">' + QR.svg(st.invite_link) + '</div><div class="note"><code>' + esc(st.invite_link) + '</code></div>' +
                 btn('invite-share', T('Link teilen')) + btn('invite-copy', T('Link kopieren'));
        } else if (lg.isAdmin) {
            h += T('<div class="note">Aus Sicherheitsgründen kennt der Server den Einladungslink nicht. Erzeuge einen neuen; der alte wird ungültig.</div>') + btn('invite-new', T('Neuen Einladungslink erzeugen'));
        } else h += T('<div class="note">Den Einladungslink kann nur der Admin erzeugen.</div>');
        h += '</div>';
        if (lg.isAdmin) h += T('<div class="lg-card"><div class="lg-ct">Einstellungen</div><div class="note">') + esc(unitLabel(lg)) + ' · ' + T('{n} Kategorien', { n: lg.cats.length }) + '</div>' + btn('edit', T('Liga bearbeiten')) + '</div>';
        h += '<div class="lg-card">' + btn('leave', T('Liga verlassen'), '', 'danger') + (lg.isAdmin ? btn('delete-league', T('Liga löschen'), '', 'danger') : '') + '</div>';
        return h;
    }

    /* ---- Form: create / edit a league ---- */
    var PRESETS = [['week', 'Woche'], ['month', 'Monat'], ['quarter', '3 Monate'], ['year', 'Jahr'], ['days', 'Alle N Tage'], ['once', 'Einmalig von – bis']];
    var GOAL_UNITS = { km: { f: 1000, l: 'km' }, dur: { f: 3600000, l: 'Stunden' }, m: { f: 1, l: 'm' }, count: { f: 1, l: '' }, kmh: { f: 1, l: '' }, time: { f: 1, l: '' } };
    function ymd(ts) { var d = new Date(ts); return d.getFullYear() + '-' + num2(d.getMonth() + 1) + '-' + num2(d.getDate()); }
    function ts(ymdStr) { var p = ymdStr.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).getTime(); }

    function presetOf(lg) {
        if (lg.unit === 'once') return 'once';
        if (lg.unit === 'week' && lg.every === 1) return 'week';
        if (lg.unit === 'month' && lg.every === 1) return 'month';
        if (lg.unit === 'month' && lg.every === 3) return 'quarter';
        if (lg.unit === 'year' && lg.every === 1) return 'year';
        return 'days';
    }
    function newForm() {
        return { id: null, name: '', preset: 'month', n: 10, start: ymd(Date.now()), end: ymd(Date.now() + 30 * 86400000),
                 cats: LigaCats.DEFAULT_ON.slice(), noPts: [], scoring: true, goals: [], grace: 48 };
    }
    function formOf(lg) {
        var f = newForm();
        f.id = lg.id; f.name = lg.name; f.preset = presetOf(lg); f.n = lg.unit === 'day' ? lg.every : 10;
        f.start = ymd(lg.start_ts); f.end = lg.end_ts ? ymd(lg.end_ts - 86400000) : f.end;
        f.cats = lg.cats.filter(function (k) { return k.indexOf('seg:') !== 0; }); f.segCats = lg.cats.filter(function (k) { return k.indexOf('seg:') === 0; });
        f.noPts = lg.no_points.slice(); f.scoring = lg.scoring; f.grace = lg.grace_h;
        f.goals = lg.goals.map(function (g) { return { cat: g.cat, target: g.target }; });
        f.orig = timeKey(f);
        return f;
    }
    function goalEditor(goals, prefix, teamOnly) {
        var cats = LigaCats.LIST.filter(function (c) { return !teamOnly || c.team; });
        return '<div id="' + prefix + 'Goals">' + goals.map(function (g, i) {
            var c = LigaCats.get(g.cat) || cats[0], u = GOAL_UNITS[c.unit] || GOAL_UNITS.count;
            return '<div class="lg-grow"><select data-goal="' + i + '" data-f="cat">' + cats.map(function (k) { return '<option value="' + k.key + '"' + (k.key === g.cat ? ' selected' : '') + '>' + esc(T(k.label)) + '</option>'; }).join('') + '</select>' +
                   '<input type="number" inputmode="decimal" min="0" step="any" data-goal="' + i + '" data-f="target" value="' + esc(+(g.target / u.f).toFixed(2)) + '"><span>' + esc(T(u.l)) + '</span>' +
                   '<button class="lg-mini" data-act="goal-rm" data-scope="' + prefix + '" data-i="' + i + T('" aria-label="Ziel entfernen">✕</button></div>');
        }).join('') + '</div>' + '<button class="lg-mini" data-act="goal-add" data-scope="' + prefix + T('">+ Ziel</button>');
    }

    function renderForm() {
        var f = st.form, h = '<button class="lg-back" data-act="' + (f.id ? 'open-back' : 'home') + T('">‹ Zurück</button><h2>') + (f.id ? T('Liga bearbeiten') : T('Neue Liga')) + '</h2>' + msgBox();
        h += T('<label for="fName">Name</label><input type="text" id="fName" maxlength="40" placeholder="z. B. Feierabendrunde" value="') + esc(f.name) + '">';
        h += T('<label for="fPreset">Zeitraum</label><select id="fPreset">') + PRESETS.map(function (p) { return '<option value="' + p[0] + '"' + (f.preset === p[0] ? ' selected' : '') + '>' + esc(T(p[1])) + '</option>'; }).join('') + '</select>';
        if (f.preset === 'days') h += T('<label for="fN">Anzahl Tage</label><input type="number" id="fN" min="1" max="366" inputmode="numeric" value="') + esc(f.n) + '">';
        h += '<label for="fStart">' + (f.preset === 'once' ? T('Erster Tag') : T('Beginn')) + '</label><input type="date" id="fStart" value="' + esc(f.start) + '">';
        if (f.preset === 'once') h += T('<label for="fEnd">Letzter Tag</label><input type="date" id="fEnd" value="') + esc(f.end) + '">';
        else h += T('<div class="note">Wochen beginnen am Montag, Monate am 1., Jahre am 1. Januar; Ergebnisse werden am Ende jedes Zeitraums festgehalten (Ruhmeshalle).</div>');
        h += T('<label for="fGrace">Nachfrist für spät hochgeladene Fahrten</label><select id="fGrace">') + [0, 24, 48, 72, 168].map(function (g) { return '<option value="' + g + '"' + (f.grace === g ? ' selected' : '') + '>' + (g ? T('{n} Stunden', { n: g }) : T('keine')) + '</option>'; }).join('') + '</select>';
        h += '<label class="lg-check"><input type="checkbox" id="fScoring"' + (f.scoring ? ' checked' : '') + T('> Gesamtwertung nach Punkten</label>');

        h += T('<h2>Kategorien</h2><div class="note">Häkchen links = Kategorie ist aktiv. „P.“ = zählt für die Gesamtwertung.</div>');
        var grp = '';
        LigaCats.LIST.forEach(function (c) {
            if (c.grp !== grp) { grp = c.grp; h += '<div class="lg-gl">' + esc(T(grp)) + '</div>'; }
            h += '<div class="lg-cat"><label><input type="checkbox" data-cat="' + c.key + '"' + (f.cats.indexOf(c.key) >= 0 ? ' checked' : '') + '> ' + esc(T(c.label)) + (c.gp ? ' <em>(' + T('Gruppenfahrt') + ')</em>' : '') + '</label>' +
                 '<label class="lg-pts"><input type="checkbox" data-pts="' + c.key + '"' + (f.noPts.indexOf(c.key) < 0 ? ' checked' : '') + '> ' + T('P.') + '</label></div>';
        });
        h += T('<h2>Team-Ziele</h2><div class="note">Alle zusammen, z. B. 3000 km im Zeitraum.</div>') + goalEditor(f.goals, 'team', true);
        h += btn('form-save', f.id ? T('Speichern') : T('Liga anlegen'), '', 'go');
        return h;
    }

    /* Copy the form fields into the state (before every redraw) */
    function readForm() {
        var f = st.form; if (!f || !$('fName')) return;
        f.name = $('fName').value; f.preset = $('fPreset').value; if ($('fN')) f.n = +$('fN').value || 10;
        f.start = $('fStart').value || f.start; if ($('fEnd')) f.end = $('fEnd').value || f.end;
        f.grace = +$('fGrace').value; f.scoring = $('fScoring').checked;
        f.cats = []; f.noPts = [];
        root.querySelectorAll('[data-cat]').forEach(function (c) { if (c.checked) f.cats.push(c.dataset.cat); });
        root.querySelectorAll('[data-pts]').forEach(function (c) { if (!c.checked) f.noPts.push(c.dataset.pts); });
        f.goals = readGoals('team', f.goals);
    }
    function readGoals(scope, old) {
        var box = $(scope + 'Goals'); if (!box) return old;
        var out = [];
        box.querySelectorAll('.lg-grow').forEach(function (row) {
            var cat = row.querySelector('select').value, v = parseFloat(row.querySelector('input').value), c = LigaCats.get(cat), u = GOAL_UNITS[c.unit] || GOAL_UNITS.count;
            out.push({ cat: cat, target: v > 0 ? Math.round(v * u.f) : 0 });
        });
        return out;
    }

    function timeKey(f) { return [f.preset, f.preset === 'days' ? f.n : '', f.start, f.preset === 'once' ? f.end : ''].join('|'); }

    function formBody() {
        var f = st.form, body = { name: f.name.trim(), scoring: f.scoring, no_points: f.noPts, grace_h: f.grace,
            cats: f.cats.concat(f.segCats || []), goals: f.goals.filter(function (g) { return g.target > 0; }),
            tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'Europe/Berlin'; } })() };
        // When editing, only send the period if it was really changed (after the first close it is fixed)
        if (f.id && f.orig === timeKey(f)) { delete body.tz; return body; }
        var map = { week: ['week', 1], month: ['month', 1], quarter: ['month', 3], year: ['year', 1], days: ['day', Math.max(1, f.n | 0)], once: ['once', 1] };
        body.unit = map[f.preset][0]; body.every = map[f.preset][1];
        body.start_ts = ts(f.start);
        if (f.preset === 'once') body.end_ts = ts(f.end) + 86400000;
        return body;
    }

    /* ---------- Loading data ---------- */
    function loadLeague(id, periodStart) {
        st.busy = true; st.ov = null; render();
        var q = periodStart ? '?p=' + periodStart : '';
        return LigaApi.call('GET', '/api/leagues/' + id + q).then(function (r) {
            st.busy = false;
            if (r.status !== 200) { setMsg('', r.error); st.page = 'home'; render(); return; }
            st.ov = r; st.league = id; st.period = periodStart || null;
            render();
            if (st.tab === 'halle') loadTab('halle'); if (st.tab === 'strecken') loadTab('strecken');
        });
    }
    function loadTab(tab) {
        var id = st.league;
        if (tab === 'halle') return LigaApi.call('GET', '/api/leagues/' + id + '/hall').then(function (r) { if (r.status === 200) { st.hall = r; render(); } });
        if (tab === 'strecken') {
            LigaApi.call('GET', '/api/leagues/' + id + '/shared').then(function (r) { if (r.status === 200) { st.shared = r.rides; render(); } });
            return LigaApi.call('GET', '/api/leagues/' + id + '/segments').then(function (r) {
                if (r.status === 200) { st.segs = r.segments; render(); LigaSync.syncSegments(id, r.segments); }
            });
        }
    }
    function reload() { return loadLeague(st.league, st.period); }

    function refreshHome() {
        return LigaSync.loadLeagues().then(function () {
            return LigaApi.call('GET', '/api/rides').then(function (r) { if (r.status === 200) st.mine = r.rides; render(); });
        });
    }

    /* ---------- Actions ---------- */
    function act(a, el) {
        var d = el ? el.dataset : {};
        setMsg('', '');
        switch (a) {
            case 'login-start': return loginStart();
            case 'login-verify': return loginVerify();
            case 'login-back': st.login = { step: 1, email: st.login.email, dev: '' }; return render();
            case 'home': st.page = 'home'; st.ov = null; st.invite_link = null; render(); return refreshHome();
            case 'open': st.page = 'league'; st.tab = 'stand'; st.editGoals = false; st.hall = st.shared = st.segs = null; st.invite_link = null; return loadLeague(d.id);
            case 'open-back': st.page = 'league'; render(); return;
            case 'prev': return loadLeague(st.league, st.ov.period.prev);
            case 'next': return loadLeague(st.league, st.ov.period.next);
            case 'tab': st.tab = d.tab; render(); return loadTab(d.tab);
            case 'pin': LigaSync.setTacho({ league: st.league, cat: d.cat }); LigaSync.fetchStanding().then(tachoRender); setMsg(T('Wird im Tacho angezeigt. Dort wechselst du die Kategorie per Tippen.')); return render();
            case 'new': st.form = newForm(); st.page = 'form'; return render();
            case 'edit': st.form = formOf(st.ov.league); st.page = 'form'; return render();
            case 'form-save': return formSave();
            case 'goal-add': return goalAdd(d.scope);
            case 'goal-rm': return goalRm(d.scope, +d.i);
            case 'goals-edit': st.editGoals = !st.editGoals; st.form = null; return render();
            case 'goals-save': return goalsSave();
            case 'goto-liga': if (cfg && cfg.showView) cfg.showView('liga'); return;
            case 'join': return join(st.invite);
            case 'join-no': st.invite = null; try { sessionStorage.removeItem('liga:inv'); } catch (e) {} return render();
            case 'paste-join': return pasteJoin();
            case 'backfill': var n = LigaSync.backfill(); setMsg(n ? T('{n} Fahrten werden hochgeladen …', { n: n }) : ''); render(); return LigaSync.flush().then(refreshHome);
            case 'ride-retry': LigaSync.setUp(d.id, null); LigaSync.enqueue(d.id); render(); return LigaSync.flush().then(refreshHome);
            case 'ride-rm': return rideRemove(d.id);
            case 'share-open': st.shareFor = st.shareFor === d.id ? null : d.id; render(); return;
            case 'share': return shareRide(d.id, d.league);
            case 'unshare': return unshareRide(d.id, d.league);
            case 'ghost': return ghostFrom(d);
            case 'seg-add': return segAdd(d.id);
            case 'seg-rm': return segRemove(d.id);
            case 'seg-board': return segBoard(d.id);
            case 'invite-new': return inviteNew();
            case 'invite-share': return inviteShare();
            case 'invite-copy': try { navigator.clipboard.writeText(st.invite_link); setMsg(T('Link kopiert.')); } catch (e) { setMsg('', T('Kopieren nicht möglich – Link von Hand markieren.')); } return render();
            case 'member-rm': return memberRemove(d.id);
            case 'leave': return leave();
            case 'delete-league': return deleteLeague();
            case 'devices': return LigaApi.call('GET', '/api/me').then(function (r) { if (r.status === 200) { st.devices = r.devices; render(); } });
            case 'dev-rm': return LigaApi.call('DELETE', '/api/devices/' + d.id).then(function (r) { if (r.status === 200) return act('devices'); setMsg('', r.error); render(); });
            case 'logout': if (!confirm(T('Auf diesem Gerät abmelden? Deine Fahrten und dein Konto bleiben erhalten, du meldest dich später per E-Mail-Code wieder an.'))) return; return LigaApi.logout().then(function () { st = freshState(st); render(); tachoRender(); });
            case 'delete-account': return deleteAccount();
        }
    }
    function freshState(old) { return { page: 'home', league: null, tab: 'stand', period: null, ov: null, hall: null, shared: null, segs: null, mine: null, login: { step: 1, email: '', dev: '' }, msg: '', err: '', busy: false, form: null, shareFor: null, invite: old.invite, devices: null }; }

    function loginStart() {
        var email = ($('lgEmail').value || '').trim();
        st.login.email = email;
        return LigaApi.start(email).then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            st.login = { step: 2, email: email, dev: r.devCode || '' }; render();
        });
    }
    function loginVerify() {
        var code = ($('lgCode').value || '').trim(), me = cfg.me();
        return LigaApi.verify(st.login.email, code, { name: me.name, emoji: me.emoji, color: me.color }).then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            st.login = { step: 1, email: '', dev: '' };
            profileChanged(true);
            setMsg(r.created ? T('Konto angelegt.') : T('Angemeldet.'));
            render(); return refreshHome().then(function () { return LigaSync.flush(); });
        });
    }

    function goalAdd(scope) {
        if (scope === 'team') { readForm(); st.form.goals.push({ cat: 'dist', target: 100000 }); }
        else { st.form = st.form || {}; st.form.myGoals = readGoals('my', meGoals(st.ov)); st.form.myGoals.push({ cat: 'dist', target: 100000 }); }
        render();
    }
    function goalRm(scope, i) {
        if (scope === 'team') { readForm(); st.form.goals.splice(i, 1); }
        else { st.form = st.form || {}; st.form.myGoals = readGoals('my', meGoals(st.ov)); st.form.myGoals.splice(i, 1); }
        render();
    }
    function goalsSave() {
        var goals = readGoals('my', meGoals(st.ov)).filter(function (g) { return g.target > 0; });
        return LigaApi.call('PUT', '/api/leagues/' + st.league + '/goals', { goals: goals }).then(function (r) {
            if (r.status === 200) { st.form = null; st.editGoals = false; setMsg(T('Ziele gespeichert.')); return reload(); }
            setMsg('', r.error); render();
        });
    }

    function formSave() {
        readForm();
        var body = formBody(), f = st.form;
        if (!body.name) { setMsg('', T('Bitte einen Namen eingeben.')); return render(); }
        if (!body.cats.length) { setMsg('', T('Mindestens eine Kategorie wählen.')); return render(); }
        var p = f.id ? LigaApi.call('PATCH', '/api/leagues/' + f.id, body) : LigaApi.call('POST', '/api/leagues', body);
        return p.then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            st.form = null; st.page = 'league';
            if (!f.id) { st.league = r.id; st.tab = 'mehr'; st.invite_link = inviteUrl(r.invite); setMsg(T('Liga angelegt. Lade jetzt Freunde ein.')); }
            else { setMsg(T('Gespeichert.')); if (r.invite) st.invite_link = inviteUrl(r.invite); }
            return LigaSync.loadLeagues().then(function () { return loadLeague(st.league); }).then(function () {
                if (LigaSync.auto()) { LigaSync.backfill(); LigaSync.flush(); }
            });
        });
    }

    function inviteUrl(inv) { return location.origin + location.pathname + '#l=' + inv; }
    function inviteNew() {
        if (!confirm(T('Einen neuen Einladungslink erzeugen? Der bisherige Link wird ungültig.'))) return;
        return LigaApi.call('PATCH', '/api/leagues/' + st.league, { rotateInvite: true }).then(function (r) {
            if (r.status === 200 && r.invite) { st.invite_link = inviteUrl(r.invite); render(); } else { setMsg('', r.error); render(); }
        });
    }
    function inviteShare() {
        var url = st.invite_link, name = st.ov.league.name;
        if (navigator.share) return navigator.share({ title: T('Gruppenausfahrt-Liga „{n}“', { n: name }), text: T('Komm in meine Liga „{n}“:', { n: name }), url: url }).catch(function () {});
        act('invite-copy');
    }

    function parseInvite(text) {
        var m = /(?:^|[#&?])l=([\w-]{6,40})\.([\w-]{8,64})/.exec(String(text || ''));
        return m ? m[1] + '.' + m[2] : null;
    }
    function pasteJoin() {
        var inv = parseInvite($('lgInvite').value);
        if (!inv) { setMsg('', T('In diesem Link steckt keine Einladung.')); return render(); }
        return join(inv);
    }
    function join(inv) {
        if (!inv) return;
        var parts = inv.split('.');
        return LigaApi.call('POST', '/api/leagues/join', { id: parts[0], secret: parts[1] }).then(function (r) {
            st.invite = null; try { sessionStorage.removeItem('liga:inv'); } catch (e) {}
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            setMsg(r.already ? T('Du bist schon in „{n}“.', { n: r.name }) : T('Beigetreten: „{n}“.', { n: r.name }));
            return LigaSync.loadLeagues().then(function () { if (LigaSync.auto()) { LigaSync.backfill(); LigaSync.flush(); } return refreshHome(); });
        });
    }

    function leave() {
        if (!confirm(T('Liga wirklich verlassen? Deine Fahrten bleiben im Konto.'))) return;
        return LigaApi.call('DELETE', '/api/leagues/' + st.league + '/members/' + LigaApi.account().id).then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            return LigaSync.loadLeagues().then(function () { act('home'); });
        });
    }
    function deleteLeague() {
        if (!confirm(T('Liga für ALLE löschen? Das lässt sich nicht rückgängig machen.'))) return;
        return LigaApi.call('DELETE', '/api/leagues/' + st.league).then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            return LigaSync.loadLeagues().then(function () { act('home'); });
        });
    }
    function memberRemove(id) {
        if (!confirm(T('Mitglied aus der Liga entfernen?'))) return;
        return LigaApi.call('DELETE', '/api/leagues/' + st.league + '/members/' + id).then(function (r) { if (r.status !== 200) setMsg('', r.error); return reload(); });
    }
    function deleteAccount() {
        if (!confirm(T('Konto, alle hochgeladenen Fahrten und deine Ligen-Mitgliedschaften unwiderruflich löschen?'))) return;
        return LigaApi.call('DELETE', '/api/me', { confirm: true }).then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            return LigaApi.logout().then(function () { st = freshState(st); setMsg(T('Konto gelöscht.')); render(); tachoRender(); });
        });
    }

    function rideRemove(localId) {
        var s = LigaSync.status(localId);
        if (!s || !s.sid || !confirm(T('Diese Fahrt vom Server löschen? Sie zählt danach in keiner Liga mehr. Auf deinem Gerät bleibt sie erhalten.'))) return;
        return LigaApi.call('DELETE', '/api/rides/' + s.sid).then(function (r) {
            if (r.status === 200) { LigaSync.setUp(localId, null); setMsg(T('Vom Server gelöscht.')); } else setMsg('', r.error);
            return refreshHome();
        });
    }
    function shareRide(localId, leagueId) {
        var s = LigaSync.status(localId), rec = Rides.get(localId);
        if (!s || !rec) return;
        var pts = LigaMetrics.trimmed(rec, 300);
        if (pts.length < 10) { setMsg('', T('Die Fahrt ist zu kurz zum Teilen.')); return render(); }
        return LigaCodec.encode(pts).then(function (track) {
            return LigaApi.call('POST', '/api/rides/' + s.sid + '/share', { league: leagueId, track: track, trim: 300 });
        }).then(function (r) { if (r.status === 200) setMsg(T('Geteilt.')); else setMsg('', r.error); return refreshHome(); });
    }
    function unshareRide(localId, leagueId) {
        var s = LigaSync.status(localId);
        return LigaApi.call('DELETE', '/api/rides/' + s.sid + '/share/' + leagueId).then(function (r) { if (r.status === 200) setMsg(T('Zurückgenommen.')); else setMsg('', r.error); return refreshHome(); });
    }
    function ghostFrom(d) {
        return LigaApi.call('GET', '/api/leagues/' + st.league + '/shared/' + d.ride + '/track').then(function (r) {
            if (r.status !== 200) { setMsg('', r.error); return render(); }
            return LigaCodec.decode(r.track).then(function (tr) {
                // src "plan": never counts as an own ride and is never uploaded
                var res = Rides.save({ src: 'plan', name: T('Liga:') + ' ' + d.owner + ' – ' + d.name, pts: tr.pts });
                setMsg(res.ok ? T('Gespeichert. Unter „Gruppe → Gespeicherte Ausfahrten“ als Ghost wählbar.') : '', res.ok ? '' : res.err);
                if (res.ok && cfg.ridesChanged) cfg.ridesChanged();
                render();
            });
        });
    }

    function segAdd(localId) {
        var m = Segments.get(localId); if (!m) return;
        var pts = m.poly.map(function (q, i) { return { t: 1e12 + i * 1000, lat: q[0], lon: q[1], ele: null }; });
        return LigaCodec.encode(pts).then(function (poly) {
            var kind = m.len > 0 && m.gain / m.len >= 0.03 ? 'climb' : 'other';
            return LigaApi.call('POST', '/api/leagues/' + st.league + '/segments', { name: m.name, kind: kind, len: m.len, gain: m.gain, poly: poly });
        }).then(function (r) { if (r.status === 200) setMsg(T('Segment hinzugefügt. Deine Fahrten werden damit abgeglichen.')); else setMsg('', r.error); return loadTab('strecken'); });
    }
    function segRemove(id) {
        if (!confirm(T('Segment für die ganze Liga löschen?'))) return;
        return LigaApi.call('DELETE', '/api/leagues/' + st.league + '/segments/' + id).then(function (r) { if (r.status !== 200) setMsg('', r.error); return loadTab('strecken').then(reload); });
    }
    function segBoard(id) {
        var lg = st.ov.league, key = 'seg:' + id, cats = lg.cats.slice(), i = cats.indexOf(key);
        if (i >= 0) cats.splice(i, 1); else cats.push(key);
        return LigaApi.call('PATCH', '/api/leagues/' + st.league, { cats: cats }).then(function (r) { if (r.status !== 200) setMsg('', r.error); return reload().then(function () { return loadTab('strecken'); }); });
    }

    /* ---------- Profile ---------- */
    function profileChanged(force) {
        var a = LigaApi.account(); if (!a || !cfg) return;
        var me = cfg.me();
        if (!force && a.name === me.name && a.emoji === me.emoji && a.color === me.color) return;
        LigaApi.call('PUT', '/api/me', { name: me.name, emoji: me.emoji, color: me.color }).then(function (r) { if (r.status === 200) LigaApi.setAccount(r.account); });
    }

    /* ---------- Speedometer line ---------- */
    function tachoRender(liveOverride) {
        var els = [$('ligaRow'), $('ligaRowReady')].filter(Boolean);
        if (!els.length) return;
        var t = LigaSync.tacho(), a = LigaApi.account();
        function put(html, title) { els.forEach(function (el) { el.hidden = false; el.innerHTML = html; el.title = title || ''; }); }
        if (!t || !a) { els.forEach(function (el) { el.hidden = true; }); return; }
        var s = LigaSync.standing(), c = LigaCats.get(t.cat), lg = LigaSync.leagues().filter(function (l) { return l.id === t.league; })[0];
        if (!s || s.cat !== t.cat || !s.standing) { put('<span class="lg-tl">' + esc(catLabel(t.cat)) + '</span> <span class="lg-tm">' + T('lädt …') + '</span>', ''); return; }
        var sd = s.standing, live = liveOverride || (cfg.live ? cfg.live() : null), add = 0;
        if (live && c) { if (t.cat === 'dist') add = live.dist; else if (t.cat === 'time') add = live.moving; }
        var mine = sd.me && sd.me.v !== null && sd.me.v !== undefined ? sd.me.v : (c && c.agg === 'sum' ? 0 : null);
        var myV = mine === null ? null : mine + add, smaller = c && LigaCats.smaller(c);
        function gap(o) { return Math.abs(o.v - myV); }
        var parts = [];
        if (sd.above && myV !== null) {
            var ahead = smaller ? sd.above.v < myV : sd.above.v > myV;
            parts.push(ahead ? '<span class="lg-up">▲ ' + esc(sd.above.name) + ' +' + esc(LigaCats.format(t.cat, gap(sd.above)).replace(/ (P\.|pts)$/, '')) + '</span>' : '<span class="lg-pass">' + T('✓ {n} überholt', { n: esc(sd.above.name) }) + '</span>');
        }
        parts.push('<b>' + T('Du {v}', { v: esc(myV === null ? '–' : LigaCats.format(t.cat, myV)) }) + (sd.me && sd.me.rank && !add ? ' · ' + T('Platz {n}', { n: sd.me.rank }) : '') + '</b>');
        if (sd.below && myV !== null) parts.push('<span class="lg-dn">▼ ' + esc(sd.below.name) + ' −' + esc(LigaCats.format(t.cat, gap(sd.below)).replace(/ (P\.|pts)$/, '')) + '</span>');
        put('<span class="lg-tl">' + esc(catLabel(t.cat)) + '</span> ' + parts.join(' · '), lg ? lg.name : '');
    }
    function tachoCycle() {
        var t = LigaSync.tacho(); if (!t) return;
        var lg = LigaSync.leagues().filter(function (l) { return l.id === t.league; })[0]; if (!lg) return;
        var cats = lg.cats.slice(); if (lg.scoring) cats.unshift('_total');
        var i = cats.indexOf(t.cat), next = cats[(i + 1) % cats.length];
        LigaSync.setTacho({ league: t.league, cat: next });
        tachoRender();
        LigaSync.fetchStanding().then(tachoRender);
    }
    function tachoTick() {
        tachoRender();
        var now = Date.now(), t = LigaSync.tacho();
        if (!t || !LigaApi.account()) return;
        var s = LigaSync.standing();
        if (!s || s.cat !== t.cat || now - s.t > 600000) LigaSync.fetchStanding().then(tachoRender);
    }

    /* ---------- Start ---------- */
    function init(c) {
        cfg = c; root = $('ligaRoot');
        // Invitation from the link: remember it and take it out of the address bar (otherwise it ends up in the group link)
        var frag = new URLSearchParams(location.hash.replace(/^#/, '')), inv = frag.get('l');
        if (inv && parseInvite('l=' + inv)) {
            st.invite = inv; try { sessionStorage.setItem('liga:inv', inv); } catch (e) {}
            frag.delete('l'); history.replaceState(null, '', location.pathname + location.search + (frag.toString() ? '#' + frag.toString() : ''));
        } else { try { st.invite = sessionStorage.getItem('liga:inv'); } catch (e) { st.invite = null; } }

        function onClick(e) {
            var b = e.target.closest('[data-act]');
            if (b && !b.disabled) act(b.dataset.act, b);
        }
        root.addEventListener('click', onClick);
        if ($('accountRoot')) $('accountRoot').addEventListener('click', onClick);
        root.addEventListener('change', function (e) {
            if (e.target.id === 'lgAuto') { LigaSync.setAuto(e.target.checked); if (e.target.checked) { LigaSync.backfill(); LigaSync.flush().then(refreshHome); } render(); return; }
            if (e.target.id === 'fPreset') { readForm(); render(); }
        });
        ['ligaRow', 'ligaRowReady'].forEach(function (id) { var row = $(id); if (row) row.addEventListener('click', tachoCycle); });

        LigaApi.onChange(function () { tachoRender(); renderAccountBox(); if (isOpen()) render(); });
        LigaSync.onChange(function () { if (st.page === 'home' && isOpen()) render(); });
        window.addEventListener('online', function () { LigaSync.flush(); });
        setInterval(tachoTick, 5000);
        setInterval(function () { if (LigaSync.pending()) LigaSync.flush(); }, 120000);

        LigaApi.refresh().then(function () { return LigaSync.loadLeagues(); }).then(function () { render(); tachoRender(); LigaSync.flush(); });
        render();
    }
    function isOpen() { var v = $('v-liga'); return v && v.classList.contains('active'); }
    /* Language switch: draw the tab and the speedometer line again */
    function relang() { render(); tachoRender(); }

    /* Called on tab change */
    function opened() {
        render();
        if (LigaApi.account()) {
            if (st.page === 'league' && st.league) reload(); else refreshHome();
        }
    }
    function hasInvite() { return !!st.invite; }
    /* Opening the ride details from the history: jump to the upload / share panel of this ride */
    function showRide(localId) { st.page = 'home'; st.ov = null; st.shareFor = localId; render(); refreshHome(); }
    /* "More" tab was opened: refresh the account box */
    function accountOpened() { renderAccountBox(); }

    return { init: init, opened: opened, relang: relang, showRide: showRide, accountOpened: accountOpened, profileChanged: profileChanged, tachoTick: tachoTick, hasInvite: hasInvite,
             _tachoRender: tachoRender, _st: function () { return st; } };
})();
