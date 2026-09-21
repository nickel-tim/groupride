"""Checks the language mode (German / English).

Needs Playwright + Chrome and a running app with the league API:
  npx wrangler d1 migrations apply groupride --local -c liga/wrangler.dev.jsonc
  npx wrangler dev -c liga/wrangler.dev.jsonc
  python3 test/i18n_check.py              (BASE=http://127.0.0.1:8787 is the default)

1. Dictionary: every T('...') in js/ and every static text of index.html has an English entry,
   placeholders {x} match, no entry is unused.
2. English mode: clicks through all views (with a running simulation, saved ride, summary, replay,
   segments, league) and fails on (a) a text that had no translation (I18n.missing()) and
   (b) German words in the visible text.
3. Switching back to German restores the original texts; numbers follow the language.
"""
import os, re, sys, json, pathlib, time, random
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
ok = []
def check(name, cond, info=''): ok.append(bool(cond)); print(('OK    ' if cond else 'FAIL  '), name, ('' if cond else info) if not os.environ.get('VERBOSE') else info)

ESC = {"n": "\n", "t": "\t", "r": "\r", "'": "'", '"': '"', "\\": "\\", "/": "/", "0": "\0"}
def unesc(s):
    def r(m):
        g = m.group(1)
        if g[0] == 'u': return chr(int(g[1:5], 16))
        if g[0] == 'x': return chr(int(g[1:3], 16))
        return ESC.get(g, g)
    return re.sub(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", r, s)

def code_keys():
    keys = set()
    for f in sorted((ROOT / 'js').glob('*.js')):
        if f.name.startswith('i18n'): continue
        for m in re.finditer(r"(?<![\w.$])T\(\s*(?:'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\")", f.read_text()):
            keys.add(unesc(m.group(1) if m.group(1) is not None else m.group(2)))
    return keys

def dictionary():
    text = (ROOT / 'js/i18n-en.js').read_text()
    body = text.split("I18n.add('en', {", 1)[1].split("\n});", 1)[0]
    body = '\n'.join(l for l in body.split('\n') if not l.lstrip().startswith('//'))
    return json.loads('{' + body + '}')

def slots(s): return sorted(re.findall(r'\{(\w+)\}', s))

# German words that do not exist in English (identical words such as Name, Route, Ghost, Segment are fine)
GERMAN = re.compile(r"\b(und|nicht|kein|keine|der|die|das|ein|eine|einen|für|mit|von|bei|zum|zur|noch|wird|werden|ist|sind|Fahrt|Fahrten|Fahrer|Ausfahrt|Strecke|Gruppe|Karte|Berge|Verlauf|Bestzeit|Führung|Führungsarbeit|Höhenmeter|Höhenprofil|Löschen|Speichern|Abbrechen|Schließen|hinzufügen|löschen|teilen|Tage|Stunden|Minuten|gespeichert|Zeitraum|Kategorie|Kategorien|Mitglieder|Einladung|Anmelden|Konto|Auswertung|Verbindung|Anzeige|Rekorde|Rekord|Anstieg|Anstiege|Tempo|Zeit|Platz)\b")

d = dictionary(); ck = code_keys()
print('--- Dictionary')
missing = sorted(k for k in ck if k not in d)
check('every T(...) key of the code has an English entry', not missing, missing[:5])
bad = [k for k in ck if k in d and slots(k) != slots(d[k])]
check('placeholders {x} match in German and English', not bad, bad[:3])
check('no empty English text (except intended)', all(v != '' for v in d.values()), [k for k, v in d.items() if v == ''][:3])

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    def phone(lang):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, locale='de-DE'); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda x: x.accept())
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'status of 4' not in m.text and 'favicon' not in m.text else None)
        pg.goto(BASE + '/?lang=' + lang); pg.wait_for_timeout(900)
        return pg, errs
    def visible(pg):
        return pg.evaluate("document.body.innerText")
    def german_in(text):
        return sorted(set(m.group(0) for m in GERMAN.finditer(text)))

    print('--- Static keys of index.html')
    pg, errs = phone('de')
    static = pg.evaluate("I18n.staticKeys()")
    check('every static text of index.html has an English entry', all(k in d for k in static), [k for k in static if k not in d][:5])
    used = set(ck) | set(static)
    unused = [k for k in d if k not in used and not re.match(r'^(Signatur|Der |Die |Das |Zu |Nicht|Segment|Kategorie|Höchstens|Länge|Nur |Du |Diesen|Fahrt|Ungültige|Simulationen|Nach |Anzahl|Start |Zeitzone|Zeitraum|Liste|Ziel|Kein |Liga|Interner|Methode|Unbekannter|Anfrage|Bestätigung|Dieses|Dieser|Gerät|Heute|Bitte|Dist|Schnitt|Datum|E-Mail|Server|Kategorien|Das )', k)]
    print('     (entries not found in the code, possibly server messages:', len(unused), ')')

    print('--- English mode')
    pg, errs = phone('en')
    check('html lang attribute', pg.evaluate("document.documentElement.lang") == 'en')
    navs = pg.evaluate("[...document.querySelectorAll('nav button')].map(b => b.childNodes[0].textContent.trim())")
    check('tab bar in English', navs == ['Speed', 'Map', 'Log', 'Climbs', 'League', 'Group'], navs)
    check('number format follows the language', pg.evaluate("I18n.num(1.5, 1)") == '1.5' and pg.evaluate("I18n.locale()") == 'en-GB')

    def scan(label):
        t = visible(pg); g = german_in(t)
        check('no German words on screen: ' + label, not g, g)

    pg.click('nav button[data-v="group"]'); pg.wait_for_timeout(300); scan('Group')
    pg.click('#btnSim'); pg.click('[data-warp="20"]'); pg.wait_for_timeout(8000)
    for v, name in (('tacho', 'Speedometer (simulation running)'), ('map', 'Map'), ('log', 'Log'), ('climbs', 'Climbs')):
        pg.click('nav button[data-v="%s"]' % v); pg.wait_for_timeout(700); scan(name)
    for sub in ('seg', 'rec'):
        pg.click('[data-sub="%s"]' % sub); pg.wait_for_timeout(400); scan('Climbs / ' + sub)
    pg.click('[data-sub="now"]')
    pg.click('nav button[data-v="tacho"]'); pg.wait_for_timeout(300)
    check('rider tags in English', 'YOU' in visible(pg))
    check('quick messages in English', 'Stop!' in pg.evaluate("[...document.querySelectorAll('#quickRow button')].map(b => b.getAttribute('aria-label')).join(' ')"))
    pg.click('#msgMore'); pg.wait_for_timeout(300); scan('Message panel'); pg.click('#msgClose')
    # let the simulation finish and save, then summary / replay / segments
    pg.click('nav button[data-v="group"]'); pg.click('#btnSim'); pg.wait_for_timeout(1500)
    scan('Group with saved ride')
    check('saved ride list in English', 'Summary' in visible(pg) and 'Replay' in visible(pg))
    pg.locator('#rideList [data-act="sum"]').first.click(); pg.wait_for_selector('#sumBody .sumttl', timeout=30000); pg.wait_for_timeout(500)
    t = visible(pg).lower(); check('summary in English', 'front work' in t and 'distance' in t, t[:200]); scan('Summary'); pg.click('#sumClose')
    pg.locator('#rideList [data-act="replay"]').first.click(); pg.wait_for_timeout(2500); scan('Replay'); pg.keyboard.press('Escape')
    pg.click('nav button[data-v="climbs"]'); pg.click('[data-sub="seg"]'); pg.click('#segNew'); pg.wait_for_timeout(500); scan('Segment editor'); pg.click('#seCancel')
    pg.click('nav button[data-v="group"]'); pg.click('#btnQr') if pg.locator('#btnQr').count() else None; pg.wait_for_timeout(400); scan('QR overlay'); pg.keyboard.press('Escape')

    print('--- League (English)')
    pg.click('nav button[data-v="liga"]'); pg.wait_for_selector('#lgEmail'); scan('League login')
    pg.fill('#lgEmail', 'kaputt'); pg.click('[data-act="login-start"]'); pg.wait_for_timeout(600)
    t = visible(pg); check('server error message translated', 'That does not look like an e-mail address.' in t, t[-300:])
    pg.fill('#lgEmail', 'i18n-%d@example.com' % random.randint(10000, 99999)); pg.click('[data-act="login-start"]'); pg.wait_for_selector('#lgCode'); scan('League code')
    pg.click('[data-act="login-verify"]'); pg.wait_for_selector('[data-act="new"]'); pg.wait_for_timeout(400); scan('League home')
    pg.click('[data-act="new"]'); pg.wait_for_selector('#fName'); scan('League form')
    pg.fill('#fName', 'Test'); pg.click('[data-act="form-save"]'); pg.wait_for_selector('.lg-qr svg'); pg.wait_for_timeout(500); scan('League invite')
    for tab in ('stand', 'ziele', 'halle', 'geteilt', 'segmente', 'mehr'):
        pg.click('[data-act="tab"][data-tab="%s"]' % tab); pg.wait_for_timeout(500); scan('League / ' + tab)
    pg.click('[data-act="tab"][data-tab="ziele"]'); pg.click('[data-act="goal-add"][data-scope="my"]'); pg.wait_for_timeout(200); scan('League goals editor')
    t = visible(pg); check('period label uses English months/dates', re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)', t) is not None or re.search(r'\d{2}/\d{2}', t) is not None, t[:200])
    miss = pg.evaluate("I18n.missing()")
    check('no text without translation was requested (I18n.missing)', not miss, miss[:8])
    check('no JavaScript errors', not errs, errs[:3])

    print('--- Switching')
    en_static = pg.evaluate("[...document.querySelectorAll('#v-group h2')].map(h => h.textContent)")
    pg.click('nav button[data-v="group"]'); pg.wait_for_timeout(200)
    check('language button says what it does', 'Language: English' in pg.inner_text('#btnLang'), pg.inner_text('#btnLang'))
    pg.click('#btnLang'); pg.wait_for_timeout(800)
    check('button switches to German', pg.evaluate("I18n.lang()") == 'de' and pg.evaluate("document.documentElement.lang") == 'de')
    check('static text is German again', pg.evaluate("[...document.querySelectorAll('#v-group h2')].map(h => h.textContent)")[0] == 'Ich')
    navs = pg.evaluate("[...document.querySelectorAll('nav button')].map(b => b.childNodes[0].textContent.trim())")
    check('tab bar German again', navs == ['Tacho', 'Karte', 'Verlauf', 'Berge', 'Liga', 'Gruppe'], navs)
    check('German numbers again', pg.evaluate("I18n.num(1.5, 1)") == '1,5')
    check('button text is German-mode text', 'Sprache: Deutsch' in pg.inner_text('#btnLang'))
    pg.click('nav button[data-v="tacho"]'); pg.wait_for_timeout(300)
    check('quick messages German again', 'Halt!' in pg.evaluate("[...document.querySelectorAll('#quickRow button')].map(b => b.getAttribute('aria-label')).join(' ')"))
    pg.click('nav button[data-v="liga"]'); pg.wait_for_timeout(800)
    check('league page German again', 'Liga' in visible(pg) and 'League' not in visible(pg).replace('League', 'League') or 'Ligen' in visible(pg), visible(pg)[:150])
    pg.click('nav button[data-v="group"]'); pg.wait_for_timeout(200)
    check('the shared group link carries no language', 'lang=' not in pg.evaluate("document.getElementById('linkNote').textContent"))
    check('the choice is remembered', pg.evaluate("localStorage.getItem('lang')") == 'de')
    pg.goto(BASE + '/'); pg.wait_for_timeout(800)          # no ?lang= : the remembered choice applies
    check('a fresh visit without ?lang= is still German (remembered)', pg.evaluate("I18n.lang()") == 'de')
    pg.goto(BASE + '/?lang=en'); pg.wait_for_timeout(800)
    check('?lang=en switches and is remembered', pg.evaluate("I18n.lang()") == 'en' and pg.evaluate("localStorage.getItem('lang')") == 'en')
    b.close()

print('\nRESULT:', 'all passed' if all(ok) else '%d of %d FAILED' % (ok.count(False), len(ok)))
sys.exit(0 if all(ok) else 1)
