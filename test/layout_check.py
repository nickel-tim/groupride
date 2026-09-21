"""Checks the structure of the app: four tabs, ready state / live screen of the ride tab, the
history with its detail card, the pickers for ghost and route, and the settings page.

Needs Playwright + Chrome; serves the repository itself (no server, no league API needed):
  python3 test/layout_check.py

Images end up in test/debug/layout-*.png.
"""
import os, sys, http.server, threading, functools, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'test' / 'debug'
OUT.mkdir(parents=True, exist_ok=True)
ok = []
def check(name, cond, info=''):
    ok.append(bool(cond)); print(('OK    ' if cond else 'FAIL  '), name, '' if cond else info)

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]

VIS = "s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; }"
INSIDE = "s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5; }"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    def phone(w=390, h_=844, **kw):
        ctx = b.new_context(viewport={'width': w, 'height': h_}, device_scale_factor=2, has_touch=True, locale='de-DE', **kw)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
        return ctx, pg, errs
    def vis(pg, s): return pg.evaluate(VIS, s)

    ctx, pg, errs = phone()
    dialogs = []
    def on_dialog(d): dialogs.append(d.message); d.accept() if answer[0] else d.dismiss()
    answer = [True]
    pg.on('dialog', on_dialog)
    pg.goto(BASE); pg.wait_for_timeout(800)

    print('--- Tab bar')
    navs = pg.evaluate("[...document.querySelectorAll('nav button')].map(b => [b.dataset.v, b.innerText.trim()])")
    check('four tabs', [n[0] for n in navs] == ['ride', 'rides', 'liga', 'more'], navs)
    check('German labels', [n[1].lower() for n in navs] == ['ausfahrt', 'fahrten', 'liga', 'mehr'], navs)
    check('ride tab is active at start', pg.evaluate("document.getElementById('v-ride').classList.contains('active')"))

    print('--- Ready state')
    check('start button is the first thing', vis(pg, '#btnStart') and pg.evaluate("document.querySelector('#rideReady').firstElementChild.id") == 'btnStart')
    check('live screen is hidden', not vis(pg, '#rideLive') and not vis(pg, '#btnStop'))
    for sel, what in (('#btnShare', 'share link'), ('#btnQr', 'QR'), ('#btnGhostPick', 'ghost picker'), ('#btnRoutePick', 'route picker'), ('#btnSim', 'simulation'), ('#meChip', 'profile chip')):
        check('ready screen offers: ' + what, vis(pg, sel))
    check('ghost / route removal buttons hidden without a choice', not vis(pg, '#btnGhostOff') and not vis(pg, '#btnRouteOff'))
    check('ghost pace select only with a ghost', not vis(pg, '#ghostPace'))
    check('no relay / theme / import clutter on the ride tab', not any(vis(pg, s) for s in ('#inRelay', '#btnTheme', '#btnImport', '#btnExport', '#rideList')))
    check('link is folded away', pg.evaluate("!document.querySelector('#rideReady details').open"))
    pg.screenshot(path=str(OUT / 'layout-ready.png'))
    pg.click('#btnGhostPick'); pg.wait_for_timeout(200)
    check('ghost picker opens with an empty hint', vis(pg, '#pickOverlay') and 'Noch keine Fahrt' in pg.inner_text('#pickList'))
    pg.click('#pickClose'); check('picker closes', not vis(pg, '#pickOverlay'))
    pg.click('#meChip'); check('profile chip leads to More', pg.evaluate("document.getElementById('v-more').classList.contains('active')") and vis(pg, '#inName'))
    pg.click('nav button[data-v="ride"]')

    print('--- Simulation: live screen')
    pg.click('#btnSim'); pg.wait_for_timeout(2500)
    check('live screen replaces the ready screen', vis(pg, '#rideLive') and not vis(pg, '#rideReady'))
    check('speed and rank on top', vis(pg, '#mySpeed') and vis(pg, '#myRank'))
    check('switcher with four views', pg.evaluate("[...document.querySelectorAll('.switcher [data-lv]')].map(b => b.dataset.lv).join()") == 'compass,map,prof,log')
    check('compass view is the default', vis(pg, '#compass') and vis(pg, '#riderList') and not vis(pg, '#mapSvg'))
    check('quick messages and end button always there', vis(pg, '#quickRow') and vis(pg, '#btnStop'))
    check('rider list shows the four others + me', pg.evaluate("document.querySelectorAll('#riderList .rrow').length") == 5)
    check('invite buttons below the rider list', pg.evaluate("document.querySelectorAll('#riderList [data-share]').length") == 2)
    check('simulation bar visible', vis(pg, '#simbar'))
    check('stop button says what it stops', 'Simulation' in pg.inner_text('#btnStop'))
    pg.screenshot(path=str(OUT / 'layout-live-compass.png'))
    for lv, must, hide in (('map', '#mapSvg', '#compass'), ('prof', '#climbProfSvg', '#mapSvg'), ('log', '#eventList', '#climbProfSvg'), ('compass', '#compass', '#eventList')):
        pg.click('[data-lv="%s"]' % lv); pg.wait_for_timeout(500)
        check('view "%s" shows its content and hides the previous one' % lv, vis(pg, must) and not vis(pg, hide) and vis(pg, '#quickRow'))
        pg.screenshot(path=str(OUT / ('layout-live-%s.png' % lv)))
    pg.click('[data-lv="map"]'); pg.wait_for_timeout(300)
    check('map keeps its tools', all(vis(pg, s) for s in ('#mapAll', '#mapMe', '#mapNorth', '#mapCourse', '#mapIn', '#mapOut', '#mapTilesBtn', '#mapProfBtn')))
    pg.reload(); pg.wait_for_timeout(600)
    check('a reload leaves the simulation (ready state)', vis(pg, '#btnStart') and not vis(pg, '#rideLive'))
    check('the chosen view is remembered', pg.evaluate("localStorage.getItem('lpane')") == 'map')

    print('--- Other tabs while riding')
    pg.goto(BASE + '?sim'); pg.wait_for_timeout(1500)
    pg.click('nav button[data-v="more"]'); pg.wait_for_timeout(200)
    check('a dot on the ride tab shows that a ride is running', pg.evaluate("document.querySelector('nav [data-v=ride]').classList.contains('riding')"))
    check('More: profile, display, account, data, connection, info', all(vis(pg, s) for s in ('#inName', '#swatches', '#emojiPick', '#btnTheme', '#btnLang', '#accountRoot', '#btnGpx', '#btnExport', '#netNote', '#privacyNote')))
    check('More: the relay is folded away', pg.evaluate("!document.querySelector('#v-more details').open"))
    pg.click('#v-more summary'); check('More: the relay opens', vis(pg, '#inRelay'))
    pg.screenshot(path=str(OUT / 'layout-more.png'))
    pg.click('nav button[data-v="ride"]'); pg.wait_for_timeout(300)
    check('coming back shows the running ride', vis(pg, '#rideLive') and vis(pg, '#btnStop'))

    print('--- End the simulation, then the history')
    pg.click('[data-warp="20"]'); pg.wait_for_timeout(5000)
    pg.click('#btnStop'); pg.wait_for_timeout(600)
    check('after the end the ready state is back', vis(pg, '#btnStart') and not vis(pg, '#rideLive') and not vis(pg, '#simbar'))
    check('the dot is gone again', not pg.evaluate("document.querySelector('nav [data-v=ride]').classList.contains('riding')"))
    pg.click('nav button[data-v="rides"]'); pg.wait_for_timeout(300)
    check('rides: three sub-tabs', pg.evaluate("[...document.querySelectorAll('[data-sub]')].map(b => b.dataset.sub).join()") == 'rides,seg,rec')
    check('rides: import on top', vis(pg, '#btnImport'))
    n = pg.evaluate("document.querySelectorAll('#rideList .ride').length")
    check('the simulation was saved', n == 1, n)
    check('a ride row has no crowd of buttons', pg.evaluate("document.querySelectorAll('#rideList .ride button').length") == 0)
    pg.screenshot(path=str(OUT / 'layout-rides.png'))
    pg.click('#rideList .ride'); pg.wait_for_timeout(200)
    acts = pg.evaluate("[...document.querySelectorAll('#rideActs [data-act]')].map(b => b.dataset.act).join()")
    check('detail card: all actions in one place', acts == 'sum,replay,ghost,route,gpx,del', acts)
    pg.screenshot(path=str(OUT / 'layout-ride-detail.png'))
    pg.click('#rideActs [data-act="ghost"]'); pg.wait_for_timeout(200)
    check('choosing the ghost closes the card and marks the ride', not vis(pg, '#rideOverlay') and 'Ghost' in pg.inner_text('#rideList .ride'))
    pg.click('#rideList .ride'); pg.click('#rideActs [data-act="route"]'); pg.wait_for_timeout(200)
    chips = pg.evaluate("[...document.querySelectorAll('#rideList .rchip')].map(c => c.textContent.trim()).join()")
    check('route + ghost chips on the row', 'Ghost' in chips and 'Route' in chips, chips)
    pg.click('[data-sub="seg"]'); pg.wait_for_timeout(200); check('segments pane', vis(pg, '#segPane') and not vis(pg, '#rideList'))
    pg.click('[data-sub="rec"]'); pg.wait_for_timeout(200); check('records pane', vis(pg, '#recPane'))
    pg.click('[data-sub="rides"]')

    print('--- Ready state with ghost and route')
    pg.click('nav button[data-v="ride"]'); pg.wait_for_timeout(200)
    check('ghost is shown with its state and pace', vis(pg, '#btnGhostOff') and vis(pg, '#ghostPace') and 'wartet' in pg.inner_text('#ghostState'))
    check('route is shown and removable', vis(pg, '#btnRouteOff') and 'Route' in pg.inner_text('#routeState'))
    pg.click('#btnRouteOff'); check('route removed', not vis(pg, '#btnRouteOff'))
    pg.click('#btnGhostPick'); pg.wait_for_timeout(200)
    check('picker lists the saved ride', pg.evaluate("document.querySelectorAll('#pickList .pickrow').length") == 1)
    pg.click('#pickList .pickrow'); check('picking sets the ghost again', not vis(pg, '#pickOverlay') and vis(pg, '#btnGhostOff'))
    pg.click('#btnSim'); pg.wait_for_timeout(1500)
    check('while riding: the ghost (same start) rides along as a grey rider', pg.evaluate("document.querySelectorAll('#riderList .tag.ghost').length") == 1 and not vis(pg, '#ghostLive'))
    pg.click('#btnStop'); pg.wait_for_timeout(400)
    pg.click('nav button[data-v="rides"]'); pg.click('#rideList .ride'); pg.click('#rideActs [data-act="del"]'); pg.wait_for_timeout(300)
    check('deleting asks first', any('löschen' in m.lower() for m in dialogs))

    print('--- A real ride: ending needs a confirmation')
    geo = {'latitude': 49.0, 'longitude': 8.4}
    ctx2, pr, errs2 = phone(permissions=['geolocation'], geolocation=geo)
    pr.on('dialog', on_dialog)
    pr.goto(BASE); pr.wait_for_timeout(600)
    pr.click('#btnStart'); pr.wait_for_timeout(1500)
    check('the live screen opens', vis(pr, '#rideLive') and vis(pr, '#btnStop'))
    check('button says: end ride', 'Ausfahrt beenden' in pr.inner_text('#btnStop'))
    dialogs.clear(); answer[0] = False
    pr.click('#btnStop'); pr.wait_for_timeout(300)
    check('cancelling the confirmation keeps the ride going', dialogs and vis(pr, '#rideLive'), dialogs)
    answer[0] = True
    pr.click('#btnStop'); pr.wait_for_timeout(500)
    check('confirming ends it', not vis(pr, '#rideLive') and vis(pr, '#btnStart'))
    ctx2.close()

    print('--- Small phone (360 x 640)')
    ctx3, ps, errs3 = phone(360, 640)
    ps.on('dialog', on_dialog)
    ps.goto(BASE); ps.wait_for_timeout(600)
    check('ready screen: no sideways scrolling', ps.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check('ready screen: start button in the first screen', ps.evaluate(INSIDE, '#btnStart'))
    ps.click('#btnSim'); ps.wait_for_timeout(2500)
    for lv in ('compass', 'map', 'prof', 'log'):
        ps.click('[data-lv="%s"]' % lv); ps.wait_for_timeout(300)
        check('live / %s: quick messages and end button inside the screen' % lv, ps.evaluate(INSIDE, '#quickRow') and ps.evaluate(INSIDE, '#btnStop'))
    ps.click('[data-lv="compass"]'); ps.wait_for_timeout(300)
    check('live / compass: the compass is fully visible', ps.evaluate(INSIDE, '#compass'))
    ps.screenshot(path=str(OUT / 'layout-small-live.png'))
    ps.click('#btnStop')
    ctx3.close()

    print('--- Errors')
    check('no JavaScript errors', not (errs or errs2 or errs3), (errs + errs2 + errs3)[:3])
    b.close()

print('\n%d of %d checks passed' % (sum(ok), len(ok)))
sys.exit(0 if all(ok) else 1)
