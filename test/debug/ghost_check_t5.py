import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools, json
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8130),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
ROWS="""() => [...document.querySelectorAll('.rrow')].map(r => (r.querySelector('.rname').textContent.trim().replace(/\\s+/g,' ')) + ' | ' + r.querySelector('.rgap').textContent.trim().replace(/\\s+/g,' '))"""
LIST="""() => [...document.querySelectorAll('#rideList .ride')].map(r => r.querySelector('b').textContent + ' | ' + r.querySelector('.rm').textContent)"""
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, permissions=['geolocation'], geolocation={'latitude':47.8021,'longitude':11.0912,'accuracy':5}, locale='de-DE', accept_downloads=True)
    pg=ctx.new_page(); errs=[]; dialogs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    def on_dialog(d):
        dialogs.append(d.type+': '+d.message[:80]); d.accept('30' if d.type=='prompt' else None)
    pg.on('dialog', on_dialog)
    pg.goto('http://127.0.0.1:8130/index.html'); pg.wait_for_timeout(500)
    pg.click('nav button[data-v="group"]')
    print('leer     :', pg.evaluate("document.getElementById('rideList').textContent.trim().slice(0,60)"))

    # 1) Simulation aufzeichnen und beenden -> automatisch gespeichert
    pg.click('#btnSim'); pg.click('[data-warp="20"]'); pg.wait_for_timeout(8000)
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(300)
    print('gespeichert:', pg.evaluate(LIST), '|', pg.evaluate("document.getElementById('rideMsg').textContent"))

    # 2) als Ghost waehlen, neue Simulation
    pg.click('#rideList [data-act="ghost"]'); print('ghost ui :', pg.evaluate("document.getElementById('ghostState').textContent"))
    pg.click('#btnSim'); pg.wait_for_timeout(2500)
    print('ghost x1 :', pg.evaluate("document.getElementById('ghostState').textContent"))
    print('  rows   :', pg.evaluate(ROWS))
    pg.click('[data-warp="5"]'); pg.wait_for_timeout(9000)
    print('  rows5x :', pg.evaluate(ROWS))
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(500)
    print('  map G  :', pg.evaluate("[...document.querySelectorAll('#mapSvg .mrank')].map(e=>e.textContent).join(',')"), 'ghostdots:', pg.evaluate("document.querySelectorAll('#mapSvg .mdot.ghost').length"))
    pg.screenshot(path=S+'/ghost-map.png')
    pg.click('nav button[data-v="tacho"]'); pg.wait_for_timeout(300); pg.screenshot(path=S+'/ghost-tacho.png')
    front=pg.evaluate("[...document.querySelectorAll('#frontWork .rdot')].length")
    pg.click('nav button[data-v="log"]'); pg.wait_for_timeout(300)
    print('  fuehrungsarbeit ohne Ghost:', 'Ghost' not in pg.evaluate("document.getElementById('frontWork').textContent"))
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(300)   # beenden (speichert 2. Sim falls >= 60 s)
    print('liste    :', pg.evaluate(LIST))

    # 3) GPX exportieren und wieder importieren (mit Zeit)
    with pg.expect_download() as dl: pg.click('#rideList [data-act="gpx"]')
    path=dl.value.path(); gpx=open(path,encoding='utf-8').read(); print('gpx export:', len(gpx), 'B,', gpx.count('<trkpt'), 'Punkte, Zeit:', '<time>' in gpx)
    open(S+'/exp.gpx','w').write(gpx)
    pg.set_input_files('#fileImport', S+'/exp.gpx'); pg.wait_for_timeout(500)
    print('import gpx:', pg.evaluate("document.getElementById('rideMsg').textContent"))
    # 4) GPX ohne Zeit -> Tempo-Abfrage
    nt=__import__('re').sub(r'<time>[^<]*</time>','',gpx); open(S+'/notime.gpx','w').write(nt)
    pg.set_input_files('#fileImport', S+'/notime.gpx'); pg.wait_for_timeout(500)
    print('import ohne Zeit:', pg.evaluate("document.getElementById('rideMsg').textContent"))
    # 5) Trainingsplan
    open(S+'/plan.json','w').write(json.dumps({"name":"Intervall 1+1","segments":[{"min":1,"kmh":20},{"min":1,"kmh":40}]}))
    pg.set_input_files('#fileImport', S+'/plan.json'); pg.wait_for_timeout(500)
    print('import plan:', pg.evaluate("document.getElementById('rideMsg').textContent"))
    open(S+'/bad.json','w').write('{"segments":[]}')
    pg.set_input_files('#fileImport', S+'/bad.json'); pg.wait_for_timeout(300)
    print('kaputter plan:', pg.evaluate("document.getElementById('rideMsg').textContent"))
    print('liste    :', pg.evaluate(LIST))
    print('dialoge  :', dialogs)
    pg.screenshot(path=S+'/ghost-liste.png', full_page=False)

    # 6) Entwurf: 70 s simulieren, ohne zu beenden -> pagehide -> neu laden
    pg.evaluate("localStorage.setItem('rides:draft','')")
    pg.click('#btnSim'); pg.click('[data-warp="20"]'); pg.wait_for_timeout(4500)
    pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
    print('entwurf  :', pg.evaluate("(localStorage.getItem('rides:draft')||'').length"), 'Zeichen')
    n0=pg.evaluate("document.querySelectorAll('#rideList .ride').length")
    pg.reload(); pg.wait_for_timeout(600); pg.click('nav button[data-v="group"]')
    print('wiederhergestellt:', pg.evaluate("document.getElementById('rideMsg').textContent"), '| Fahrten', n0,'->',pg.evaluate("document.querySelectorAll('#rideList .ride').length"))

    # 7) Ghost in einer ECHTEN Fahrt (GPS-Mock am Ghost-Start)
    pg.click('#rideList [data-act="ghost"]')   # neueste Fahrt
    ctx.set_geolocation({'latitude':47.8021,'longitude':11.0912,'accuracy':5})
    pg.click('#btnStart'); pg.wait_for_timeout(2500)
    print('echt     :', pg.evaluate("document.getElementById('ghostState').textContent"))
    print('  rows   :', pg.evaluate(ROWS))
    print('errors   :', errs); b.close()
