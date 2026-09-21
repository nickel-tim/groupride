import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8140),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
INFO="""() => ({tiles: document.querySelectorAll('#mapTiles image').length, hrefs:[...document.querySelectorAll('#mapTiles image')].slice(0,3).map(i=>i.getAttribute('href').replace('https://tile.openstreetmap.org/','')),
  loaded: [...document.querySelectorAll('#mapTiles image')].filter(i=>i.style.display!=='none').length, attr: !document.getElementById('mapAttr').hidden})"""
reqs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, locale='de-DE')
    pg=ctx.new_page(); errs=[]; dialogs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('request', lambda r: reqs.append(r.url) if 'openstreetmap' in r.url else None)
    pg.on('dialog', lambda d: (dialogs.append(d.message[:60]), d.accept()))
    pg.goto('http://127.0.0.1:8140/index.html?sim'); pg.wait_for_timeout(600)
    pg.click('[data-warp="20"]'); pg.wait_for_timeout(5000)
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(500)
    print('aus      :', pg.evaluate(INFO), '| OSM-Anfragen:', len(reqs))
    pg.click('#mapTilesBtn'); pg.wait_for_timeout(2500)
    print('an       :', pg.evaluate(INFO), '| Anfragen:', len(reqs), '| Dialog:', dialogs)
    pg.screenshot(path=S+'/tiles-dark-all.png')
    pg.click('#mapMe'); pg.wait_for_timeout(1500); pg.screenshot(path=S+'/tiles-dark-me.png')
    pg.click('#mapCourse'); pg.wait_for_timeout(2000); pg.screenshot(path=S+'/tiles-dark-course.png')
    pg.click('nav button[data-v="group"]'); pg.click('#btnTheme'); pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(2000)
    pg.screenshot(path=S+'/tiles-sun-course.png')
    print('zoom     :', pg.evaluate(INFO))
    pg.click('#mapTilesBtn'); pg.wait_for_timeout(300)
    print('wieder aus:', pg.evaluate(INFO))
    # Einwilligung gemerkt: neu laden -> ohne Dialog wieder an?
    pg.click('#mapTilesBtn'); pg.wait_for_timeout(300); n=len(dialogs)
    pg.reload(); pg.wait_for_timeout(800)
    print('nach reload: tilesOn =', pg.evaluate("localStorage.getItem('tilesOn')"), '| erneuter Dialog beim Einschalten?', len(dialogs)>n)
    print('errors   :', errs); b.close()
