"""Erzeugt aus der kommentierten Fassung (liga/schema.annotated.sql) die kommentarfreie Migration.
D1 (remote) lehnt Migrationsdateien mit alleinstehenden Kommentaren ab ("SQL code did not contain a statement").
Lauf: python3 liga/tools/strip_sql.py
"""
import re, pathlib
base = pathlib.Path(__file__).resolve().parents[1]
text = (base / 'schema.annotated.sql').read_text()
text = re.sub(r'\A(--[^\n]*\n)+', '', text)                       # Kopfzeilen der annotierten Fassung
t = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
t = re.sub(r'--[^\n]*', '', t)
t = re.sub(r'(?im)^\s*PRAGMA[^;]*;\s*$', '', t)
out, blank = [], False
for l in (x.rstrip() for x in t.split('\n')):
    if not l.strip():
        if not blank and out: out.append('')
        blank = True
    else:
        out.append(l); blank = False
(base / 'migrations' / '0001_init.sql').write_text('\n'.join(out).strip() + '\n')
print('migrations/0001_init.sql geschrieben')
