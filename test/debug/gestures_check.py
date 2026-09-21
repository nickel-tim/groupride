import os; S=os.path.dirname(os.path.abspath(__file__))
import http.server, threading, functools, math, re
from playwright.sync_api import sync_playwright
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(S,'..','..')); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8150),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
# k = Pixel je Meter aus der Massstabsleiste; ME = Mitte des eigenen Punkts
ST="""() => { const t=document.querySelector('#mapSvg .mscale text').textContent; const m=t.match(/([\\d.]+) (km|m)/); const L=parseFloat(m[1])*(m[2]==='km'?1000:1);
  const w=document.querySelector('#mapSvg .mscale path').getBBox().width; const me=document.querySelector('#mapSvg .mdot.me').getBoundingClientRect();
  return {k: w/L, me:[me.x+me.width/2, me.y+me.height/2], ctr: !document.getElementById('mapCenter').hidden} }"""
def close(a,b,tol): return math.hypot(a[0]-b[0],a[1]-b[1])<=tol
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, has_touch=True, locale='de-DE')
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    pg.goto('http://127.0.0.1:8150/index.html?sim'); pg.wait_for_timeout(600)
    # Simulation bis ins Ziel laufen lassen: danach steht alles still, Messungen sind exakt
    pg.click('[data-warp="20"]')
    for i in range(80):
        pg.wait_for_timeout(1000)
        if 'Ziel erreicht' in pg.evaluate("document.getElementById('simMsg').textContent"): break
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(700)
    pg.click('#mapMe'); pg.wait_for_timeout(300)      # 'Ich': ich bleibe sicher im Bild
    box=pg.locator('#mapSvg').bounding_box(); cx=box['x']+box['width']/2; cy=box['y']+box['height']/2
    cdp=ctx.new_cdp_session(pg)
    def touch(kind, pts): cdp.send('Input.dispatchTouchEvent', {'type':kind, 'touchPoints':[{'x':x,'y':y,'id':i} for i,(x,y) in enumerate(pts)]})
    ok=[]
    def check(name, cond, info=''): ok.append(cond); print(('OK   ' if cond else 'FEHLER'), name, info)
    def reset(): pg.click('#mapCenter') if pg.evaluate("!document.getElementById('mapCenter').hidden") else None; pg.wait_for_timeout(250)

    s0=pg.evaluate(ST)
    # 1) Ziehen (Maus), am Ende anhalten -> kein Auslaufen
    pg.mouse.move(cx,cy); pg.mouse.down()
    for i in range(1,11): pg.mouse.move(cx+10*i, cy+6*i); pg.wait_for_timeout(12)
    pg.wait_for_timeout(150); pg.mouse.up(); pg.wait_for_timeout(120); s1=pg.evaluate(ST)
    dx,dy=s1['me'][0]-s0['me'][0], s1['me'][1]-s0['me'][1]
    check('ziehen verschiebt', abs(dx-100)<25 and abs(dy-60)<25, f'dx={dx:.0f} dy={dy:.0f} (erwartet 100/60), Massstab gleich: {abs(s1["k"]/s0["k"]-1)<0.03}')
    check('Zentrieren-Knopf erscheint', s1['ctr'])
    pg.screenshot(path=S+'/gest-pan.png')
    # 2) Zentrieren
    pg.click('#mapCenter'); pg.wait_for_timeout(250); s2=pg.evaluate(ST)
    check('zentrieren stellt zurueck', close(s2['me'],s0['me'],30) and abs(s2['k']/s0['k']-1)<0.05 and not s2['ctr'], f'Abweichung {math.hypot(s2["me"][0]-s0["me"][0],s2["me"][1]-s0["me"][1]):.0f}px')

    # 3) Mausrad ueber dem eigenen Punkt: 6 Rastungen rein -> Faktor exp(0.0016*120*6)=3.16, Punkt bleibt unter dem Zeiger
    me=s2['me']; pg.mouse.move(me[0],me[1])
    pg.evaluate("window.__wsum=0; window.__wn=0; document.getElementById('mapSvg').addEventListener('wheel', e=>{window.__wsum+=e.deltaY; window.__wn++}, {capture:true})")
    for i in range(6): pg.mouse.wheel(0,-120); pg.wait_for_timeout(80)
    pg.wait_for_timeout(150); s3=pg.evaluate(ST); f=s3['k']/s2['k']
    wsum=pg.evaluate('window.__wsum'); want=math.exp(-wsum*0.0016)
    check('mausrad zoomt hinein (Faktor passt zu den empfangenen Ereignissen)', abs(f/want-1)<0.06 and f>1.5, f'{pg.evaluate("window.__wn")} Ereignisse, Faktor {f:.2f}, erwartet {want:.2f}')
    check('mausrad zoomt um den Zeiger', close(s3['me'],me,14), f'Punkt wanderte {math.hypot(s3["me"][0]-me[0],s3["me"][1]-me[1]):.0f}px')
    pg.screenshot(path=S+'/gest-wheel.png'); reset()

    # 4) Doppelklick auf den eigenen Punkt
    s4=pg.evaluate(ST); me=s4['me']; pg.mouse.dblclick(me[0],me[1]); pg.wait_for_timeout(200); s5=pg.evaluate(ST)
    check('doppelklick verdoppelt', 1.8<s5['k']/s4['k']<2.2 and close(s5['me'],me,14), f'Faktor {s5["k"]/s4["k"]:.2f}, Punkt wanderte {math.hypot(s5["me"][0]-me[0],s5["me"][1]-me[1]):.0f}px'); reset()

    # 5) Pinch (Touch), Mitte auf dem eigenen Punkt: Abstand 80 -> 280 = Faktor 3.5
    s6=pg.evaluate(ST); me=s6['me']
    touch('touchStart',[(me[0]-40,me[1]),(me[0]+40,me[1])])
    for i in range(1,11): touch('touchMove',[(me[0]-40-i*10,me[1]),(me[0]+40+i*10,me[1])]); pg.wait_for_timeout(20)
    touch('touchEnd',[]); pg.wait_for_timeout(200); s7=pg.evaluate(ST); f=s7['k']/s6['k']
    check('pinch spreizen zoomt hinein', 3.0<f<4.0, f'Faktor {f:.2f} (erwartet ~3.5)')
    check('pinch zoomt um die Fingermitte', close(s7['me'],me,18), f'Punkt wanderte {math.hypot(s7["me"][0]-me[0],s7["me"][1]-me[1]):.0f}px')
    pg.screenshot(path=S+'/gest-pinch.png')
    # zusammenfuehren -> heraus
    me=s7['me']; touch('touchStart',[(me[0]-140,me[1]),(me[0]+140,me[1])])
    for i in range(1,21): touch('touchMove',[(me[0]-140+i*6,me[1]),(me[0]+140-i*6,me[1])]); pg.wait_for_timeout(15)
    touch('touchEnd',[]); pg.wait_for_timeout(200); s8=pg.evaluate(ST); f=s8['k']/s7['k']
    check('pinch zusammen zoomt heraus', 0.11<f<0.18, f'Faktor {f:.2f} (erwartet ~0.14 = 40/280)'); reset()

    # 6) Schnelles Wischen (Touch): nach dem Loslassen laeuft es weiter
    s9=pg.evaluate(ST); touch('touchStart',[(cx,cy)])
    for i in range(1,9): touch('touchMove',[(cx,cy+i*15)]); pg.wait_for_timeout(16)
    touch('touchEnd',[]); a1=pg.evaluate(ST)['me'][1]-s9['me'][1]; pg.wait_for_timeout(600); c1=pg.evaluate(ST)['me'][1]-s9['me'][1]
    check('wischen laeuft aus', a1>60 and c1>a1+30, f'direkt {a1:.0f}px -> nach 0.6 s {c1:.0f}px'); reset()

    # 7) Antippen aendert nichts; Seite scrollt nicht
    a0=pg.evaluate(ST); pg.mouse.click(cx,cy); pg.wait_for_timeout(500); a1=pg.evaluate(ST)
    check('einzelnes Antippen laesst die Karte stehen', close(a1['me'],a0['me'],20) and abs(a1['k']/a0['k']-1)<0.03)
    check('Seite scrollt nicht mit', pg.evaluate('window.scrollY')==0)

    # 8) Grenzen: Doppelklick rein bis zum Anschlag, Pinch zusammen bis zum Anschlag
    reset()
    for i in range(12):
        me=pg.evaluate(ST)['me']; pg.mouse.dblclick(me[0],me[1]); pg.wait_for_timeout(180)
    kmax=pg.evaluate(ST)['k']; reset()
    for i in range(5):
        touch('touchStart',[(cx-140,cy),(cx+140,cy)])
        for j in range(1,21): touch('touchMove',[(cx-140+j*6,cy),(cx+140-j*6,cy)]); pg.wait_for_timeout(8)
        touch('touchEnd',[]); pg.wait_for_timeout(120)
    kmin=pg.evaluate(ST)['k']
    check('Zoom ist begrenzt', 0.0035<=kmin<=0.0045 and 25<=kmax<=31, f'k_min={kmin:.4f} k_max={kmax:.1f} (Grenzen 0.004 / 30)')
    reset()

    # 9) Mit Strassenkarte
    pg.click('#mapTilesBtn'); pg.wait_for_timeout(1500)
    for i in range(6): pg.mouse.wheel(0,-150); pg.wait_for_timeout(60)
    pg.mouse.move(cx,cy); pg.mouse.down()
    for i in range(1,15): pg.mouse.move(cx-8*i, cy+4*i); pg.wait_for_timeout(15)
    pg.mouse.up(); pg.wait_for_timeout(2000)
    n=pg.evaluate("document.querySelectorAll('#mapTiles image').length")
    check('Kachelzahl bleibt begrenzt', n<=70, f'{n} Kacheln im DOM'); pg.screenshot(path=S+'/gest-tiles.png')
    check('keine JS-Fehler', not errs, str(errs))
    print('\nERGEBNIS:', 'alle bestanden' if all(ok) else 'FEHLER'); b.close()
