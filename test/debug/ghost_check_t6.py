import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8131),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
ROWS="""() => [...document.querySelectorAll('.rrow')].map(r => (r.querySelector('.rname').textContent.trim().replace(/\\s+/g,' ')) + ' | ' + r.querySelector('.rgap').textContent.trim().replace(/\\s+/g,' '))"""
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, permissions=['geolocation'], geolocation={'latitude':47.8021,'longitude':11.0912,'accuracy':5}, locale='de-DE')
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8131/index.html'); pg.wait_for_timeout(400)
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.click('[data-warp="20"]'); pg.wait_for_timeout(6000); pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(300)
    # Plan-Ghost auf dieser Strecke: 1 min 20 km/h, dann 40 km/h
    import json; open(S+'/plan.json','w').write(json.dumps({"name":"Plan 25 km/h","segments":[{"min":3,"kmh":25}]}))
    pg.on('dialog', lambda d: d.accept())
    pg.set_input_files('#fileImport', S+'/plan.json'); pg.wait_for_timeout(400)
    start=pg.evaluate("(()=>{var l=JSON.parse(localStorage.getItem('rides:index')); var r=JSON.parse(localStorage.getItem('rides:r:'+l.sort((a,b)=>b.start-a.start)[0].id)); return r.p[0].slice(1,3)})()")
    print('ghost start:', start)
    pg.click('#rideList [data-act="ghost"]')           # neueste = Plan
    # Fahrer steht 25 m entfernt (nord) und faehrt Richtung Ghost-Start
    lat,lon=start[0]+0.000225, start[1]
    ctx.set_geolocation({'latitude':lat,'longitude':lon,'accuracy':5})
    pg.click('#btnStart'); pg.wait_for_timeout(2500)
    print('state    :', pg.evaluate("document.getElementById('ghostState').textContent"))
    for i in range(6):
        lat+=0.00003; ctx.set_geolocation({'latitude':lat,'longitude':lon+0.00004*i,'accuracy':5}); pg.wait_for_timeout(1200)
    print('rows     :', pg.evaluate(ROWS)); print('state    :', pg.evaluate("document.getElementById('ghostState').textContent"))
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(400); pg.click('nav button[data-v="tacho"]'); pg.wait_for_timeout(300)
    # jetzt starten Knopf
    pg.click('nav button[data-v="group"]'); pg.click('#rideList [data-act="ghost"]'); pg.click('#rideList [data-act="ghost"]')
    print('nach neu waehlen:', pg.evaluate("document.getElementById('ghostState').textContent"), '| jetzt-Knopf sichtbar:', pg.evaluate("!document.getElementById('btnGhostNow').hidden"))
    pg.click('#btnGhostNow'); pg.wait_for_timeout(1500); print('nach jetzt:', pg.evaluate("document.getElementById('ghostState').textContent"))
    pg.click('#btnStart'); pg.wait_for_timeout(300)   # stoppen
    print('ghost-Reiter:', pg.evaluate("document.getElementById('ghostState').textContent"))
    print('errors   :', errs); b.close()
