"""Checks the league metrics (js/liga-metrics.js) with rides whose result is known.
No server needed:  python3 liga/test/metrics_check.py
"""
import http.server, threading, functools, os, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8213), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
ok = []
def check(name, cond, info=''): ok.append(bool(cond)); print(('OK    ' if cond else 'FEHLER '), name, info if not cond or os.environ.get('VERBOSE') else '')

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    pg = b.new_context().new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8213/index.html'); pg.wait_for_timeout(600)

    print('--- Steigrate (VAM)')
    r = pg.evaluate("""() => {
      const M = 111320, mk = (v, grade, secs, ele) => { const pts = []; let la = 48, d = 0;
        for (let t = 0; t < secs; t++) { pts.push({ t: 1.7e12 + t * 1000, lat: la, lon: 11, ele: ele === null ? null : 400 + grade * d }); la += v / M; d += v; } return pts; };
      const climb = LigaMetrics.values(mk(3, 0.06, 900));                  // 15 min mit 6 %
      const flat = LigaMetrics.values(mk(8, 0, 900));
      const noEle = LigaMetrics.values(mk(3, 0.06, 900, null));
      return { climb: climb.values, flat: flat.values, noEle: noEle.values }; }""")
    # 6 % at 3 m/s = 0.18 m/s = 648 m/h
    check('6 % Steigung, 3 m/s: Steigrate ~648 m/h', abs(r['climb'].get('vam', 0) - 648) < 40, r['climb'])
    check('Hoehenmeter ~ 6 % von 2700 m = 162', abs(r['climb'].get('gain', 0) - 162) < 20, r['climb'])
    check('Flachstueck: keine Steigrate', 'vam' not in r['flat'], r['flat'])
    check('Ohne Hoehendaten: keine Steigrate und keine Hoehenmeter', 'vam' not in r['noEle'] and 'gain' not in r['noEle'], r['noEle'])
    check('Flach: Topspeed ~8 m/s (5-s-Fenster)', abs(r['flat'].get('top', 0) - 8) < 0.3, r['flat'])
    check('unter 20 km: kein Schnitt-Wert, keine Bestzeit 10 km (nur 7 km)', 'avg20' not in r['flat'] and 't10k' not in r['flat'])

    print('--- Bestzeiten und beste Stunde')
    r = pg.evaluate("""() => {
      const M = 111320, pts = []; let la = 48;
      for (let t = 0; t < 4500; t++) { pts.push({ t: 1.7e12 + t * 1000, lat: la, lon: 11, ele: 500 }); la += 10 / M; }        // 75 min mit 10 m/s = 45 km
      return LigaMetrics.values(pts).values; }""")
    check('10 km in ~1000 s', abs(r.get('t10k', 0) - 1000000) < 8000, r)
    check('20 km in ~2000 s, 40 km in ~4000 s', abs(r.get('t20k', 0) - 2000000) < 12000 and abs(r.get('t40k', 0) - 4000000) < 20000, r)
    check('beste Stunde: 10 m/s', abs(r.get('avg1h', 0) - 10) < 0.2, r)
    check('Schnitt ab 20 km: 10 m/s', abs(r.get('avg20', 0) - 10) < 0.2, r)

    print('--- Gruppenwerte (drei Fahrer)')
    r = pg.evaluate("""async () => {
      const M = 111320, T0 = Date.now() - 4 * 3600000, out = {};
      Recorder.reset('anna');
      // Anna faehrt 150 m vor Ben und Cy, die dicht zusammen sind: 10 Minuten lang mit 8 m/s
      for (let t = 0; t <= 600; t += 2) {
        const base = 48 + t * 8 / M, ts = T0 + t * 1000;
        Recorder.add('anna', 'Anna', '#ff0000', ts, base + 150 / M, 11, 500, 1);
        Recorder.add('ben', 'Ben', '#00ff00', ts, base + 6 / M, 11, 500, 2);
        Recorder.add('cy', 'Cy', '#0000ff', ts, base, 11.00001, 500, null);
      }
      const rec = Rides.save({ src: 'ride', pts: Recorder.pack ? (function () { const a = []; for (let t = 0; t <= 600; t++) a.push({ t: T0 + t * 1000, lat: 48 + t * 8 / M + 150 / M, lon: 11, ele: 500 }); return a; })() : [], name: 'Gruppe',
                            group: Recorder.pack(), x: { coffee: 2 } });
      const body = await LigaMetrics.build(Rides.get(rec.rec.id), 'anna-konto');
      return { values: body.values, id: body.id, day: body.day, n: body.track.length, tiles: body.tiles.length }; }""")
    v = r['values']
    check('Wasserträger: Anna fuehrt die ganze Zeit (~600 s)', 500000 < v.get('front', 0) <= 610000, v)
    check('Ausreisser: 150 m Vorsprung fast die ganze Zeit', v.get('escape', 0) > 400000, v)
    check('Gemeinsam gefahren: Anna ist 150 m weg -> praktisch nichts', v.get('together', 0) < 5, v)
    check('Kaffee aus der Aufzeichnung', v.get('coffee') == 2, v)
    check('Angriffe: keine (gleichmaessiges Tempo)', v.get('attacks', 0) == 0, v)
    check('Fahrt-ID stabil und ohne Sonderzeichen', r['id'].startswith('r') and len(r['id']) == 24, r['id'])

    r = pg.evaluate("""async () => {
      const M = 111320, T0 = Date.now() - 5 * 3600000;
      Recorder.reset('ben');
      for (let t = 0; t <= 600; t += 2) {
        const base = 48.5 + t * 8 / M, ts = T0 + t * 1000;
        Recorder.add('anna', 'Anna', '#ff0000', ts, base + 40 / M, 11, 500, 1);
        Recorder.add('ben', 'Ben', '#00ff00', ts, base, 11, 500, 2);
      }
      const pts = []; for (let t = 0; t <= 600; t++) pts.push({ t: T0 + t * 1000, lat: 48.5 + t * 8 / M, lon: 11, ele: 500 });
      const rec = Rides.save({ src: 'ride', pts: pts, name: 'Zu zweit', group: Recorder.pack() });
      const body = await LigaMetrics.build(Rides.get(rec.rec.id), 'ben-konto');
      return body.values; }""")
    check('Gemeinsam gefahren: zwei Fahrer 40 m auseinander -> ~4,8 km', 4000 < r.get('together', 0) < 5100, r)
    check('Ben fuehrt nie: keine Wasserträger-Zeit, kein Ausreisser', r.get('front', 0) < 30000 and 'escape' not in r, r)

    print('--- Kaffee-Regel und Upload-Vorbereitung')
    check('Kaffee: hoechstens eine je 15 Minuten', pg.evaluate("LigaMetrics.countCoffee([0, 600000, 960000, 2400000, 2401000])") == 3)
    check('Kaffee: nichts -> 0', pg.evaluate("LigaMetrics.countCoffee([])") == 0)
    r = pg.evaluate("""() => { const p = []; for (let i = 0; i < 50000; i++) p.push({ t: 1.7e12 + i * 1000, lat: 48 + i * 1e-5, lon: 11, ele: null });
      p.splice(100, 0, { t: 1.7e12 + 99000, lat: 1, lon: 1, ele: 0 });        // doppelte Zeit
      const c = LigaMetrics.clean(p); let inc = true; for (let i = 1; i < c.length; i++) if (!(c[i].t > c[i - 1].t)) inc = false;
      return { n: c.length, inc: inc }; }""")
    check('Bereinigen: Zeit strikt steigend, sehr lange Fahrt auf <= 39000 Punkte ausgeduennt', r['inc'] and r['n'] <= 39000, r)
    r = pg.evaluate("""() => { const p = []; for (let i = 0; i <= 900; i++) p.push({ t: 1.7e12 + i * 1000, lat: 48 + i * 8 / 111320, lon: 11, ele: 500 });
      const t = LigaMetrics.trimmed({ p: [], start: 0 }, 0) ; return 0; }""") if False else None
    r = pg.evaluate("""() => { const p = []; for (let i = 0; i <= 900; i++) p.push({ t: 1.7e12 + i * 1000, lat: 48 + i * 8 / 111320, lon: 11, ele: 500 });
      const rec = Rides.save({ src: 'ride', pts: p, name: 'trim' }).rec; const t = LigaMetrics.trimmed(Rides.get(rec.id), 300);
      return { n: t.length, d: Rides.distanceOf(t) }; }""")
    check('Teilen: 300 m am Anfang und Ende fehlen (7200 m -> ~6600 m)', 6400 < r['d'] < 6700, r)
    check('keine JavaScript-Fehler', not errs, errs[:3])
    b.close()
print('\nERGEBNIS:', 'alle bestanden' if all(ok) else f'{ok.count(False)} von {len(ok)} FEHLGESCHLAGEN'); sys.exit(0 if all(ok) else 1)
