"""Prueft liga/migrations/0001_init.sql gegen SQLite (D1 ist SQLite).
Lauf:  python3 liga/test/schema_check.py
Geprueft: Schema laedt, Fremdschluessel/CHECKs greifen, Ranglisten-Abfragen nutzen den
Index (kein Scan der ganzen Tabelle), Loeschen kaskadiert."""
import sqlite3, pathlib, sys
sql = (pathlib.Path(__file__).resolve().parents[1] / 'migrations' / '0001_init.sql').read_text()
db = sqlite3.connect(':memory:'); db.executescript(sql)
db.execute('PRAGMA foreign_keys=ON')
ok = True
def check(name, cond, extra=''):
    global ok; ok &= bool(cond); print(('OK   ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra else ''))

D = 86400000
for a in ('anna', 'ben', 'cy'):
    db.execute("insert into accounts(id,name,email_hash,created_at) values(?,?,?,0)", (a, a, 'h' + a))
db.execute("insert into leagues(id,name,admin_id,invite_hash,start_ts,cats,created_at) values('L','Test','anna','h',0,'[\"dist\"]',0)")
for a in ('anna', 'ben', 'cy'):
    db.execute("insert into memberships values('L',?,0,'[]')", (a,))
n = 0
for a, km in (('anna', 50), ('ben', 80), ('cy', 30)):
    for k in range(20):
        n += 1; rid = 'r%d' % n; st = (k + 1) * D
        db.execute("insert into rides values(?,?,?,?,?,?,?,?,?,?,?,0)", (rid, a, 'x', 'ride', st, st + 3600000, '2026-01-%02d' % (k + 1), km * 1000, 3600000, 3600, 1))
        db.execute("insert into ride_values values(?,?,?,?,?,?)", (rid, 'dist', km * 1000, a, st, '2026-01-%02d' % (k + 1)))
        db.execute("insert into ride_values values(?,?,?,?,?,?)", (rid, 'top', 10 + k * 0.1, a, st, '2026-01-%02d' % (k + 1)))

# Rangliste Summe (Kilometer) im Zeitraum, nur Mitglieder
q = """select account_id, sum(v) s from ride_values
       where cat='dist' and start_ts>=? and start_ts<? and account_id in (select account_id from memberships where league_id='L')
       group by account_id order by s desc"""
rows = db.execute(q, (5 * D, 15 * D)).fetchall()
check('Rangliste Summe', [r[0] for r in rows] == ['ben', 'anna', 'cy'] and rows[0][1] == 10 * 80000, rows)
plan = ' '.join(r[3] for r in db.execute('explain query plan ' + q, (5 * D, 15 * D)))
check('Rangliste nutzt Index', 'ride_values_board' in plan and 'SCAN ride_values' not in plan.replace('USING', ''), plan)

# Bestwert (Topspeed): Maximum je Konto
rows = db.execute("select account_id, max(v) from ride_values where cat='top' and start_ts>=? and start_ts<? group by account_id", (0, 30 * D)).fetchall()
check('Rangliste Maximum', len(rows) == 3)

# Fahrtage: verschiedene Tage
rows = db.execute("select account_id, count(distinct day) from ride_values where cat='dist' and start_ts>=? and start_ts<? group by account_id", (0, 8 * D)).fetchall()
check('Fahrtage', all(r[1] == 7 for r in rows), rows)

# Entdecken: nur neue Kacheln im Zeitraum, ueber Index
for i in range(400): db.execute("insert into account_tiles values('anna',?,?)", (i, (i % 40) * D))
q2 = "select count(*) from account_tiles where account_id='anna' and first_ts>=? and first_ts<?"
check('Entdecken zaehlt', db.execute(q2, (0, 4 * D)).fetchone()[0] == 40)
plan = ' '.join(r[3] for r in db.execute('explain query plan ' + q2, (0, 4 * D)))
check('Entdecken nutzt Index', 'account_tiles_first' in plan, plan)

# CHECK-Regeln
def fails(stmt, args=()):
    try: db.execute(stmt, args); return False
    except sqlite3.IntegrityError: return True
check('src sim abgelehnt', fails("insert into rides values('x','anna','n','sim',0,1,'d',1,1,1,1,0)"))
check('Liga once ohne Ende abgelehnt', fails("insert into leagues(id,name,admin_id,invite_hash,unit,start_ts,created_at) values('M','n','anna','h','once',0,0)"))
check('Fremdschluessel Fahrt->Konto', fails("insert into rides values('y','nobody','n','ride',0,1,'d',1,1,1,1,0)"))

# Kaskade: Fahrt loeschen nimmt Werte, Track, Teilen mit
db.execute("insert into tracks(ride_id,data) values('r1','AA')")
db.execute("insert into ride_shares values('r1','L',0)")
db.execute("insert into shared_tracks values('r1',1,300,'AA')")
db.execute("delete from rides where id='r1'")
left = sum(db.execute("select count(*) from %s where ride_id='r1'" % t).fetchone()[0] for t in ('ride_values', 'tracks', 'ride_shares', 'shared_tracks'))
check('Fahrt loeschen kaskadiert', left == 0)
# Konto loeschen nimmt alles mit
db.execute("delete from accounts where id='ben'")
check('Konto loeschen kaskadiert',
      db.execute("select count(*) from rides where account_id='ben'").fetchone()[0] == 0 and
      db.execute("select count(*) from ride_values where account_id='ben'").fetchone()[0] == 0 and
      db.execute("select count(*) from memberships where account_id='ben'").fetchone()[0] == 0)
print('\nERGEBNIS:', 'alles bestanden' if ok else 'FEHLER'); sys.exit(0 if ok else 1)
