/* Smoke test in a real browser: loads the page, feeds in positions
   and checks that the interface holds up and no JS errors occur.
   The network is blocked in this environment -- exactly right, because that
   also checks whether the app carries on cleanly without a network. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..';
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },      // iPhone-like, portrait
    deviceScaleFactor: 2,
    permissions: ['geolocation'],
    geolocation: { latitude: 47.8021, longitude: 11.0912, accuracy: 5 },
    locale: 'de-DE'
  });
  const page = await ctx.newPage();

  const errors = [], warnings = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:8099/index.html');
  await page.waitForTimeout(600);

  // The room key must have been created in the fragment
  const hash = await page.evaluate(() => location.hash);
  console.log('Fragment angelegt :', /^#k=[\w-]{20,}/.test(hash) ? 'ja' : 'NEIN  ' + hash);

  // The topic must have been derived from the key (crypto works)
  const linkOk = await page.evaluate(() =>
      document.getElementById('linkNote').textContent.includes('#k='));
  console.log('Teilen-Link       :', linkOk ? 'ok' : 'FEHLT');

  // Start (user gesture)
  await page.click('#btnStart');
  await page.waitForTimeout(400);

  // Feed in a short ride: 12 positions towards the north-east
  let lat = 47.8021, lon = 11.0912;
  for (let i = 0; i < 12; i++) {
    lat += 0.00013; lon += 0.00010;
    await ctx.setGeolocation({ latitude: lat, longitude: lon, accuracy: 5 });
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => ({
    speed: document.getElementById('mySpeed').textContent,
    rank:  document.getElementById('myRank').textContent,
    rows:  document.querySelectorAll('.rrow').length,
    net:   document.getElementById('netTxt').textContent.trim(),
    head:  document.getElementById('hdSrc').textContent.trim(),
    startBtn: document.getElementById('btnStart').textContent.trim()
  }));
  console.log('Eigene Zeile      :', state.rows >= 1 ? 'vorhanden' : 'FEHLT');
  console.log('Position          :', state.rank);
  console.log('Netzstatus        :', state.net);
  console.log('Kursquelle        :', state.head);
  console.log('Start-Knopf       :', state.startBtn);

  // Click through the tabs -- reveals rendering errors in the other views
  for (const v of ['log', 'climbs', 'group', 'tacho']) {
    await page.click(`nav button[data-v="${v}"]`);
    await page.waitForTimeout(220);
  }

  // Sun mode
  await page.click('nav button[data-v="group"]');
  await page.click('#btnTheme');
  await page.waitForTimeout(250);
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('Sonnenmodus       :', theme);
  await page.click('#btnTheme');
  await page.waitForTimeout(200);

  // Screenshots
  await page.click('nav button[data-v="tacho"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test/shot-tacho.png' });
  await page.click('nav button[data-v="group"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test/shot-gruppe.png' });

  // Horizontal scrolling must not exist
  const hScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log('Querscrollen      :', hScroll ? 'JA (Fehler)' : 'nein');

  console.log('\nJS-Fehler         :', errors.length);
  errors.slice(0, 12).forEach(e => console.log('   ' + e.slice(0, 160)));

  await browser.close();
  server.close();

  const hard = errors.filter(e => !/net::|ERR_|WebSocket|mqtt|jsdelivr|fonts\.g/i.test(e));
  if (hard.length || hScroll || state.rows < 1) {
    console.log('\nERGEBNIS: FEHLER');
    process.exit(1);
  }
  console.log('\nERGEBNIS: ok (Netzfehler erwartet, Umgebung ohne Broker-Zugang)');
})();
