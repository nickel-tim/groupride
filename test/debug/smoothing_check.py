import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools, statistics
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8161),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
def sampler(sel):
    return """(secs) => new Promise(res => { const out=[]; const t0=performance.now();
      function f(t){ const el=document.querySelector('%s'); if(el){ const r=el.getBoundingClientRect(); out.push([t, r.x+r.width/2, r.y+r.height/2]); }
        if (t-t0 < secs*1000) requestAnimationFrame(f); else res(out); }
      requestAnimationFrame(f); })""" % sel
def analyse(samples):
    steps=[((b[1]-a[1])**2+(b[2]-a[2])**2)**0.5 for a,b in zip(samples,samples[1:])]
    mean=statistics.mean(steps); mx=max(steps)
    stall=sum(1 for s in steps if s<0.2*mean)/len(steps)
    # Zeit zwischen "Bildern, in denen sich etwas bewegt" -- ruckelig = grosse Luecken
    return {'Bilder':len(steps),'Stillstand %':round(100*stall),'mittlerer Schritt px':round(mean,2),'groesster Schritt px':round(mx,1),'groesst/mittel':round(mx/mean,1)}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2); pg=ctx.new_page(); errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8161/index.html?sim'); pg.wait_for_timeout(600)
    for i in range(6): pg.click('#simMore')                     # 160 %: die anderen fallen mit ~4 m/s zurueck
    pg.click('[data-warp="5"]'); pg.wait_for_timeout(7000); pg.click('[data-warp="1"]'); pg.wait_for_timeout(300)
    # --- Kompass (Tacho) ---
    for smooth in (False, True):
        pg.evaluate(f"Smooth.enabled = {'true' if smooth else 'false'}"); pg.wait_for_timeout(1500)
        print('KOMPASS glaettung', 'AN ' if smooth else 'AUS', analyse(pg.evaluate(sampler('#cPeers circle'), 6)))
    pg.screenshot(path=S+'/smooth-compass.png')
    # --- Karte ---
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(500); pg.click('#mapMe'); pg.wait_for_timeout(300)
    for i in range(2): pg.click('#mapOut'); pg.wait_for_timeout(100)   # etwas heraus, damit die anderen im Bild bleiben
    for smooth in (False, True):
        pg.evaluate(f"Smooth.enabled = {'true' if smooth else 'false'}"); pg.wait_for_timeout(1500)
        print('KARTE   glaettung', 'AN ' if smooth else 'AUS', analyse(pg.evaluate(sampler('#mapSvg .mdot:not(.me)'), 6)))
    pg.screenshot(path=S+'/smooth-map.png')
    print('errors:', errs); b.close()
