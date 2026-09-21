"""End-to-end test of the league interface in a real Chrome against a running worker.

  Terminal 1:  npx wrangler d1 migrations apply groupride --local -c liga/wrangler.dev.jsonc
               npx wrangler dev -c liga/wrangler.dev.jsonc
  Terminal 2:  python3 liga/test/ui_check.py           (needs Playwright + Chrome)

Two "phones" (separate browser contexts): Anna creates a league, Ben joins via link.
Images end up in test/debug/liga-*.png.
"""
import os, sys, time, json, random
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'test', 'debug')
os.makedirs(OUT, exist_ok=True)
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
ok = []
def check(name, cond, info=''):
    ok.append(bool(cond)); print(('OK    ' if cond else 'FEHLER '), name, info if (info != '' and not cond) or os.environ.get('VERBOSE') else '')
def shot(pg, name): pg.screenshot(path=os.path.join(OUT, 'liga-' + name + '.png'))

MKRIDE = """(o) => {
  const pts = [], M = 111320; let la = o.lat, lo = o.lon, d = 0, t = 0, s = o.seed;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  while (d < o.km * 1000) {
    pts.push({ t: o.start + t * 1000, lat: la + r() * 0.5 / M, lon: lo + r() * 0.5 / M, ele: 500 + 25 * Math.sin(d / 2500) + r() });
    la += Math.cos(0.6) * o.v / M; lo += Math.sin(0.6) * o.v / (M * Math.cos(la * Math.PI / 180)); d += o.v; t += 1;
  }
  const res = Rides.save({ src: o.src || 'ride', pts: pts, name: o.name });
  return res.ok ? res.rec.id : ('ERR ' + res.err);
}"""

def login(pg, email, name):
    pg.click('nav button[data-v="more"]'); pg.fill('#inName', name); pg.press('#inName', 'Tab'); pg.wait_for_timeout(200)
    pg.click('nav button[data-v="liga"]'); pg.wait_for_selector('#lgEmail')
    pg.fill('#lgEmail', email); pg.click('[data-act="login-start"]'); pg.wait_for_selector('#lgCode')
    check(name + ': Entwicklungsmodus zeigt den Code', '#lgCode' and pg.input_value('#lgCode').isdigit() and len(pg.input_value('#lgCode')) == 6)
    pg.click('[data-act="login-verify"]'); pg.wait_for_selector('[data-act="new"]'); pg.wait_for_timeout(300)

def ymd(days):
    return time.strftime('%Y-%m-%d', time.localtime(time.time() - days * 86400))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    def phone():
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'favicon' not in m.text else None)
        pg.on('dialog', lambda d: d.accept())
        return ctx, pg, errs
    ctxA, A, errA = phone(); ctxB, B, errB = phone()
    S = str(random.randint(10000, 99999))

    print('--- Anmeldung')
    A.goto(BASE + '/'); A.wait_for_timeout(800)
    A.click('nav button[data-v="liga"]'); A.wait_for_selector('#lgEmail')
    check('Liga-Reiter vorhanden, Anmeldung sichtbar', A.inner_text('#ligaRoot').find('E-Mail') >= 0)
    shot(A, '1-login')
    A.fill('#lgEmail', 'kaputt'); A.click('[data-act="login-start"]'); A.wait_for_timeout(500)
    check('ungueltige Adresse: Fehler statt Absturz', 'E-Mail-Adresse' in A.inner_text('#ligaRoot') and A.locator('.lg-err').count() == 1)
    login(A, f'anna-{S}@example.com', 'Anna')
    check('angemeldet: Konto mit Namen aus der App', A.evaluate("LigaApi.account().name") == 'Anna')
    shot(A, '2-home')
    annaId = A.evaluate("LigaApi.account().id")

    print('--- Liga anlegen')
    A.click('[data-act="new"]'); A.wait_for_selector('#fName'); A.fill('#fName', 'Testliga')
    A.select_option('#fPreset', 'days'); A.wait_for_selector('#fN'); A.fill('#fN', '30')
    A.fill('#fStart', ymd(10))
    check('Kategorien gruppiert, Standardauswahl gesetzt', A.locator('[data-cat="dist"]').is_checked() and not A.locator('[data-cat="vam"]').is_checked() and A.locator('[data-cat]').count() >= 22)
    A.check('[data-cat="explore"]'); A.check('[data-cat="streak"]'); A.check('[data-cat="top"]')
    A.click('[data-act="goal-add"][data-scope="team"]'); A.wait_for_selector('#teamGoals input'); A.fill('#teamGoals input', '500')
    shot(A, '3-form')
    A.click('[data-act="form-save"]'); A.wait_for_selector('.lg-qr svg'); A.wait_for_timeout(300)
    inv = A.inner_text('.lg-card code')
    check('Liga angelegt: QR-Code und Einladungslink', '#l=' in inv and A.locator('.lg-qr svg').count() == 1, inv)
    shot(A, '4-invite')

    print('--- Fahrten hochladen')
    t0 = int(time.time() * 1000)
    ids = [A.evaluate(MKRIDE, dict(start=t0 - d * 86400000, km=km, lat=48.1 + i * 0.3, lon=11.5, v=7.5, seed=i + 1, name=n))
           for i, (d, km, n) in enumerate([(6, 30, 'Feierabend'), (4, 40, 'Langer Ritt'), (3, 20, 'Kurze Runde')])]
    check('drei Fahrten lokal gespeichert', all(not str(i).startswith('ERR') for i in ids), ids)
    A.evaluate("LigaSync.backfill()"); A.evaluate("LigaSync.flush()")
    A.wait_for_function("Object.values(LigaSync.up()).filter(u => u.state === 'ok').length === 3", timeout=30000)
    check('alle drei hochgeladen', True)
    up = A.evaluate("LigaSync.up()")
    check('Werte kamen an (Topspeed, Hoehenmeter)', all(v['state'] == 'ok' and not v.get('dropped') for v in up.values()), up)

    print('--- Ben tritt per Link bei')
    B.goto(inv.strip()); B.wait_for_timeout(900)
    check('Einladungslink oeffnet den Liga-Reiter', B.locator('#v-liga.active').count() == 1)
    check('Einladung wird nicht in den Gruppenlink uebernommen', 'l=' not in B.evaluate("location.hash"))
    B.click('nav button[data-v="more"]'); B.fill('#inName', 'Ben'); B.press('#inName', 'Tab'); B.click('nav button[data-v="liga"]')
    B.wait_for_selector('#lgEmail'); B.fill('#lgEmail', f'ben-{S}@example.com'); B.click('[data-act="login-start"]'); B.wait_for_selector('#lgCode')
    B.click('[data-act="login-verify"]'); B.wait_for_selector('[data-act="join"]')
    check('nach der Anmeldung wartet die Einladung', 'Einladung zu einer Liga' in B.inner_text('#ligaRoot'))
    shot(B, '5-ben-invite')
    B.click('[data-act="join"]'); B.wait_for_selector('.lg-league'); B.wait_for_timeout(300)
    check('Ben ist in der Liga', 'Testliga' in B.inner_text('.lg-league'))
    B.evaluate(MKRIDE, dict(start=t0 - 5 * 86400000, km=60, lat=48.1, lon=11.5, v=8, seed=9, name='Ben lang'))
    B.evaluate("LigaSync.backfill()"); B.evaluate("LigaSync.flush()")
    B.wait_for_function("Object.values(LigaSync.up()).filter(u => u.state === 'ok').length === 1", timeout=30000)
    check('Bens Fahrt hochgeladen', True)

    print('--- Rangliste')
    A.click('[data-act="home"]'); A.wait_for_selector('.lg-league'); A.click('.lg-league'); A.wait_for_selector('.lg-tabs'); A.wait_for_timeout(500)
    txt = A.inner_text('#ligaRoot')
    check('Stand: Gesamtwertung und Kategorien', 'GESAMTWERTUNG' in txt.upper() and 'KILOMETER' in txt.upper() and 'FAHRTAGE' in txt.upper(), txt[:300])
    rows = A.locator('.lg-card').nth(1).inner_text()
    check('Kilometer: Anna (~85) vor Ben (~58)', 'Anna' in rows and 'Ben' in rows and rows.index('Anna') < rows.index('Ben'), rows)
    check('Anna ist markiert', A.locator('.lg-row.me').count() >= 1)
    shot(A, '6-stand')
    check('Zeitraum-Anzeige mit Restzeit', 'noch' in A.inner_text('.lg-period') and A.locator('[data-act="prev"]').is_disabled())

    print('--- Tacho-Zeile')
    A.locator('[data-act="pin"][data-cat="dist"]').click(); A.wait_for_timeout(800)
    A.click('nav button[data-v="ride"]'); A.wait_for_timeout(500)
    A.evaluate("LigaUI.tachoTick()"); A.wait_for_timeout(600)
    row = A.inner_text('#ligaRowReady')
    check('Tacho zeigt Liga-Zeile mit Nachbarn', A.locator('#ligaRowReady').is_visible() and 'Du' in row and ('Ben' in row), row)
    shot(A, '7-tacho')
    A.click('#ligaRowReady'); A.wait_for_timeout(700)
    row2 = A.inner_text('#ligaRowReady')
    check('Tippen wechselt die Kategorie', row2 != row and row2.split('\n')[0] != row.split('\n')[0], (row, row2))
    # live: a ride in progress counts immediately (kilometres are added to the standing)
    A.evaluate("LigaSync.setTacho({league: LigaSync.tacho().league, cat: 'dist'})"); A.evaluate("LigaSync.fetchStanding().then(LigaUI.tachoTick)"); A.wait_for_timeout(700)
    live = A.evaluate("""() => { const el = document.getElementById('ligaRowReady'); return el.innerText; }""")
    check('Tacho-Zeile nach Rueckwechsel wieder Kilometer', 'Kilometer' in live or 'KILOMETER' in live.upper(), live)

    # Ben is 30 km behind Anna. A ride in progress counts immediately, overtaking is reported.
    B.evaluate("LigaSync.setTacho({league: LigaSync.leagues()[0].id, cat: 'dist'})"); B.evaluate("LigaSync.fetchStanding()"); B.wait_for_timeout(900)
    B.evaluate("LigaUI._tachoRender({dist: 10000, moving: 1})"); rb = B.inner_text('#ligaRowReady')
    check('Ben liegt hinter Anna (Abstand schrumpft mit der laufenden Fahrt)', 'Anna' in rb and '▲' in rb and 'Du 69' in rb, rb)
    B.evaluate("LigaUI._tachoRender({dist: 40000, moving: 1})"); rb2 = B.inner_text('#ligaRowReady')
    check('Ben ueberholt Anna waehrend der Fahrt: Meldung', 'überholt' in rb2 and 'Du 99' in rb2, rb2)
    B.evaluate("LigaSync.setTacho(null)")

    print('--- Ziele')
    A.click('nav button[data-v="liga"]'); A.wait_for_timeout(500)
    A.click('[data-act="tab"][data-tab="stand"]'); A.wait_for_timeout(300)
    check('Team-Ziel mit Fortschrittsbalken', A.locator('.lg-bar').count() >= 1 and '500' in A.inner_text('.lg-goal'), A.inner_text('#ligaRoot')[:400])
    A.click('[data-act="goals-edit"]'); A.click('[data-act="goal-add"][data-scope="my"]'); A.wait_for_selector('#myGoals input'); A.fill('#myGoals input', '200')
    A.click('[data-act="goals-save"]'); A.wait_for_timeout(700)
    check('persoenliches Ziel gespeichert und sichtbar', A.locator('.lg-bar').count() >= 2 and '(du)' in A.inner_text('#ligaRoot'))
    shot(A, '8-ziele')

    print('--- Segmente')
    seg = A.evaluate("""() => {
        const rec = Rides.get(Object.keys(LigaSync.up())[0]); const pts = Track.smooth(Rides.unpack(rec), 2);
        const s = Segments.fromSection(pts, 300, 900, 'Testberg', 'custom'); Segments.addSegment(s); return s.len; }""")
    check('lokales Segment angelegt', seg > 1000, seg)
    A.click('[data-act="tab"][data-tab="strecken"]'); A.wait_for_selector('[data-act="seg-add"]'); A.click('[data-act="seg-add"]'); A.wait_for_timeout(900)
    check('Segment ist in der Liga', 'Testberg' in A.inner_text('#ligaRoot') and A.locator('[data-act="seg-board"]').count() == 1)
    A.click('[data-act="seg-board"]'); A.wait_for_timeout(1500)
    A.click('[data-act="tab"][data-tab="stand"]'); A.wait_for_timeout(400)
    check('Segment-Rangliste mit Annas Zeit', 'SEGMENT: TESTBERG' in A.inner_text('#ligaRoot').upper(), A.inner_text('#ligaRoot')[-400:])
    shot(A, '9-segment')

    print('--- Teilen und Ghost')
    A.click('[data-act="tab"][data-tab="mehr"]'); A.wait_for_timeout(200)
    A.click('[data-act="home"]'); A.wait_for_selector('.lg-ride'); A.wait_for_timeout(400)
    A.locator('[data-act="share-open"]').first.click(); A.wait_for_selector('[data-act="share"]'); A.click('[data-act="share"]'); A.wait_for_timeout(900)
    check('Fahrt geteilt', A.locator('[data-act="unshare"]').count() == 1, A.inner_text('#ligaRoot')[:200])
    shot(A, '10-teilen')
    B.click('.lg-league'); B.wait_for_selector('.lg-tabs'); B.click('[data-act="tab"][data-tab="strecken"]'); B.wait_for_selector('[data-act="ghost"]')
    check('Ben sieht Annas geteilte Fahrt', 'Anna' in B.inner_text('#ligaRoot'))
    shot(B, '11-geteilt')
    B.click('[data-act="ghost"]'); B.wait_for_timeout(900)
    g = B.evaluate("Rides.list().filter(r => r.name.indexOf('Liga:') === 0).map(r => [r.name, r.src, r.dist])")
    check('als Ghost gespeichert (src plan)', len(g) == 1 and g[0][1] == 'plan', g)
    check('...und wird nie als eigene Fahrt hochgeladen', B.evaluate("LigaSync.backfill()") == 0 and B.evaluate("LigaSync.eligible(Rides.get(Rides.list().filter(r => r.name.indexOf('Liga:') === 0)[0].id))") is False)
    check('geteilte Strecke ist gekuerzt (Anfang/Ende fehlen)', 0 < g[0][2] < 29500, g)

    print('--- Ruhmeshalle')
    r = A.evaluate("""async () => {
        const c = await LigaApi.call('POST', '/api/leagues', { name: 'Sommer', unit: 'once', start_ts: Date.now() - 60*86400000, end_ts: Date.now() - 30*86400000, grace_h: 0, cats: ['dist', 'top'] });
        return c.status; }""")
    A.evaluate(MKRIDE, dict(start=t0 - 45 * 86400000, km=25, lat=47.0, lon=11.0, v=7, seed=21, name='Sommerfahrt'))
    A.evaluate("LigaSync.backfill()"); A.evaluate("LigaSync.flush()")
    A.wait_for_function("Object.values(LigaSync.up()).filter(u => u.state === 'ok').length === 4", timeout=30000)
    A.evaluate("LigaSync.loadLeagues()")
    if A.locator('[data-act="home"]').count(): A.click('[data-act="home"]')
    A.wait_for_timeout(800)
    A.locator('.lg-league', has_text='Sommer').click(); A.wait_for_selector('.lg-tabs'); A.wait_for_timeout(500)
    check('abgeschlossener Zeitraum', 'abgeschlossen' in A.inner_text('.lg-period'), A.inner_text('.lg-period'))
    A.click('[data-act="tab"][data-tab="halle"]'); A.wait_for_timeout(900)
    txt = A.inner_text('#ligaRoot')
    check('Ruhmeshalle: Titel und Sieger', 'TITEL' in txt.upper() and 'Anna' in txt, txt[:300])
    shot(A, '12-halle')

    print('--- Abmelden und neues Geraet')
    if A.locator('[data-act="home"]').count(): A.click('[data-act="home"]')
    A.click('nav button[data-v="more"]'); A.wait_for_selector('[data-act="logout"]'); A.click('[data-act="logout"]')
    A.click('nav button[data-v="liga"]'); A.wait_for_selector('#lgEmail')
    check('abgemeldet: Schluessel und Liga-Daten lokal weg', A.evaluate("LigaApi.account()") is None and A.evaluate("Object.keys(localStorage).filter(k => k.indexOf('liga:') === 0 && k !== 'liga:base').length") == 0)
    A.fill('#lgEmail', f'anna-{S}@example.com'); A.click('[data-act="login-start"]'); A.wait_for_selector('#lgCode'); A.click('[data-act="login-verify"]'); A.wait_for_selector('[data-act="new"]'); A.wait_for_timeout(600)
    check('gleiche E-Mail: gleiches Konto, neuer Schluessel', A.evaluate("LigaApi.account().id") == annaId)
    check('Ligen sind wieder da', A.locator('.lg-league').count() == 2)
    A.click('nav button[data-v="more"]'); A.click('[data-act="devices"]'); A.wait_for_selector('.lg-devs'); n = A.locator('.lg-devs .lg-row').count()
    check('zwei Geraete (altes und neues), altes abmeldbar', n == 2 and A.locator('[data-act="dev-rm"]').count() == 1)
    A.click('[data-act="dev-rm"]'); A.wait_for_timeout(600)
    shot(A, '13-konto')
    check('Fahrten des Kontos liegen auf dem Server', A.evaluate("LigaApi.call('GET','/api/rides').then(r => r.rides.length)") == 4)

    print('--- Konto loeschen')
    B.click('nav button[data-v="more"]'); B.wait_for_selector('[data-act="delete-account"]'); B.click('[data-act="delete-account"]')
    B.click('nav button[data-v="liga"]'); B.wait_for_selector('#lgEmail')
    check('Konto geloescht: Anmeldung wieder sichtbar', B.evaluate("LigaApi.account()") is None)

    print('\n--- Fehler auf den Seiten')
    # Anna deliberately sent an invalid address: exactly this one 400 is expected
    for n, e, erlaubt in (('Anna', errA, 1), ('Ben', errB, 0)):
        rest = [x for x in e if 'status of 400' not in x]
        check(n + ': keine JavaScript-Fehler', not rest and len(e) - len(rest) <= erlaubt, e[:3])
    b.close()

print('\nERGEBNIS:', 'alle bestanden' if all(ok) else f'{ok.count(False)} von {len(ok)} FEHLGESCHLAGEN')
sys.exit(0 if all(ok) else 1)
