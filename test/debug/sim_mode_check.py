import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools, os
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8125),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
ST="""() => ({rank: document.getElementById('myRank').textContent, lbl: document.getElementById('myRankLbl').textContent,
  speed: document.getElementById('mySpeed').textContent, rows: document.querySelectorAll('.rrow').length,
  ev: document.querySelectorAll('#eventList .ev').length, climbs: document.querySelectorAll('#climbList .climb').length,
  msg: document.getElementById('simMsg').textContent, net: document.getElementById('netTxt').textContent.trim(),
  head: document.getElementById('hdSrc').textContent.trim(), dots: document.querySelectorAll('#mapSvg .mdot').length})"""
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2).new_page(); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'net::' not in m.text else None)
    pg.goto('http://127.0.0.1:8125/index.html'); pg.wait_for_timeout(400)
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(2500)
    print('t~2s x1  :', pg.evaluate(ST)); pg.screenshot(path=S+'/simmode-tacho.png')
    pg.click('[data-warp="20"]'); pg.wait_for_timeout(9000)
    print('x20 9s   :', pg.evaluate(ST))
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(500); pg.click('#mapMe'); pg.wait_for_timeout(400); pg.screenshot(path=S+'/simmode-map.png')
    pg.click('#btnSimAttack'); pg.click('#simMore'); pg.click('#simMore'); pg.wait_for_timeout(3000)
    print('effort   :', pg.evaluate("document.getElementById('simEffort').textContent"), 'attack on:', pg.evaluate("document.getElementById('btnSimAttack').classList.contains('on')"))
    pg.click('nav button[data-v="log"]'); pg.wait_for_timeout(300); pg.screenshot(path=S+'/simmode-log.png')
    pg.click('nav button[data-v="climbs"]'); pg.wait_for_timeout(300); pg.screenshot(path=S+'/simmode-climbs.png')
    pg.click('nav button[data-v="tacho"]'); pg.wait_for_timeout(300)
    # bis ins Ziel
    for i in range(40):
        pg.wait_for_timeout(1500)
        if 'Ziel erreicht' in pg.evaluate("document.getElementById('simMsg').textContent"): break
    print('ende     :', pg.evaluate(ST)); pg.screenshot(path=S+'/simmode-end.png')
    print('hscroll  :', pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth+1"))
    # beenden: Zustand muss leer sein
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(500)
    print('gestoppt :', pg.evaluate(ST), 'simbar hidden:', pg.evaluate("document.getElementById('simbar').hidden"))
    # Start waehrend echter Ausfahrt -> abgelehnt
    print('errors   :', errs)
    b.close()
