import http.server, threading, functools, json, sys, os
from playwright.sync_api import sync_playwright
ROOT='/home/tim/Projects/groupride'; S=os.path.dirname(os.path.abspath(__file__))
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
h.log_message=lambda *a,**k: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8123),h); threading.Thread(target=srv.serve_forever,daemon=True).start()

SIM = r"""
() => {
  // simulierte Gruppe auf einer geschwungenen Strecke (Serpentine + Anstieg)
  var route = new Route(), an = new Analytics(route);
  var lat0=47.80, lon0=11.09, t0=Date.now()-600000;
  function pos(s, off){ // Strecke: S-Kurve nach Nordost
    var x = s*0.8 + 60*Math.sin(s/90), y = s*0.6 + 45*Math.cos(s/70) ;
    return { lat: lat0 + (y+off)/111320, lon: lon0 + (x)/(111320*Math.cos(lat0*Math.PI/180)) };
  }
  var riders=[['a','Anna',0,1400],['b','Ben',1,1330],['c','Chris',2,1310],['d','Dora',3,1180],['e','Emil',4,900]];
  for (var t=0;t<=1400;t+=8) {
    riders.forEach(function(r){
      var s = Math.min(t, r[3]) - (r[2]*2);
      if (s<0) return;
      var p = pos(s, r[2]*1.5);
      an.ingest(r[0], {lat:p.lat, lon:p.lon, ele: 600 + s*0.05 + (s>500&&s<900? (s-500)*0.09:0), speed:8, heading: 50, acc:5, t: t0+t*1000, name:r[1], color: UI.COLORS[r[2]]});
    });
  }
  an.tick(); an.riders['e'].dropped = true; an.riders['d'].lastSeen = Date.now()-30000;
  window.__an = an; window.__route = route;
  var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='simSvg'; svg.setAttribute('style','position:fixed;left:0;top:60px;width:390px;height:620px;background:var(--bg2);z-index:99');
  document.body.appendChild(svg);
  return { pts: route.pts.length, len: Math.round(route.length()), climbs: an.climbs.length };
}
"""
DRAW = r"""
(o) => { var an=window.__an; var ord=an.order(); var svg=document.getElementById('simSvg');
  var r = MapView.render(svg, {route: window.__route, riders: ord, meId:'c', climbs: an.climbs, follow:o.follow, zoom:o.zoom, trackUp:o.trackUp, heading:o.trackUp?50:null});
  return {r:r, paths: svg.querySelectorAll('path').length, dots: svg.querySelectorAll('.mdot').length, len: svg.innerHTML.length}; }
"""
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, permissions=['geolocation'], geolocation={'latitude':47.8021,'longitude':11.0912,'accuracy':5}, locale='de-DE')
    pg=ctx.new_page(); errs=[]
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('pageerror: '+str(e)))
    pg.goto('http://127.0.0.1:8123/index.html'); pg.wait_for_timeout(600)

    # --- QR ---
    pg.click('#btnQr'); pg.wait_for_timeout(300)
    link = pg.evaluate("document.getElementById('linkNote').querySelector('code').textContent")
    pg.locator('#qrBox').screenshot(path=S+'/qr.png')
    pg.screenshot(path=S+'/shot-qr.png')
    print('link:', link, len(link))
    pg.click('#btnQrClose'); print('overlay closed:', pg.evaluate("document.getElementById('qrOverlay').hidden"))
    # QR mit Relay-Parameter (laengerer Link)
    pg.goto('http://127.0.0.1:8123/index.html?relay=wss://gruppenausfahrt-relay.tim-nickel.workers.dev'); pg.wait_for_timeout(500)
    pg.click('#btnQr'); pg.wait_for_timeout(200)
    link2 = pg.evaluate("document.getElementById('linkNote').querySelector('code').textContent")
    pg.locator('#qrBox').screenshot(path=S+'/qr2.png'); print('link2:', link2, len(link2))
    pg.click('#btnQrClose')

    # --- echte App: Start, Fahrt, Karte ---
    pg.goto('http://127.0.0.1:8123/index.html'); pg.wait_for_timeout(500)
    pg.click('#btnStart'); pg.wait_for_timeout(300)
    lat,lon=47.8021,11.0912
    for i in range(14):
        lat+=0.00013; lon+=0.00010
        ctx.set_geolocation({'latitude':lat,'longitude':lon,'accuracy':5}); pg.wait_for_timeout(150)
    pg.click('nav button[data-v="map"]'); pg.wait_for_timeout(500)
    print('real map:', pg.evaluate("({dots: document.querySelectorAll('#mapSvg .mdot').length, info: document.getElementById('mapInfo').textContent, w: document.getElementById('mapSvg').clientWidth, h: document.getElementById('mapSvg').clientHeight})"))
    for bid in ['mapMe','mapCourse','mapIn','mapOut','mapAll','mapNorth']:
        pg.click('#'+bid); pg.wait_for_timeout(120)
    pg.screenshot(path=S+'/shot-map-real.png')
    print('hscroll:', pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth+1"))

    # --- Simulation mit 5 Fahrern ---
    print('sim:', pg.evaluate(SIM))
    for name,o in [('all-north',{'follow':False,'zoom':1,'trackUp':False}),('me-north',{'follow':True,'zoom':1,'trackUp':False}),('me-course',{'follow':True,'zoom':2,'trackUp':True}),('all-course',{'follow':False,'zoom':1,'trackUp':True}),('me-close',{'follow':True,'zoom':0,'trackUp':False})]:
        print(name, pg.evaluate(DRAW, o)); pg.screenshot(path=S+f'/sim-{name}.png', clip={'x':0,'y':60,'width':390,'height':620})
    # sonnenmodus
    pg.evaluate("document.documentElement.setAttribute('data-theme','sun')"); pg.evaluate(DRAW, {'follow':False,'zoom':1,'trackUp':False}); pg.screenshot(path=S+'/sim-sun.png', clip={'x':0,'y':60,'width':390,'height':620})
    print('errors:', errs)
    b.close()
