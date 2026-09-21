"""Generates the comment-free migration from the commented version (liga/schema.annotated.sql).
D1 (remote) rejects migration files with stand-alone comments ("SQL code did not contain a statement").
Run: python3 liga/tools/strip_sql.py
"""
import re, pathlib
base = pathlib.Path(__file__).resolve().parents[1]
text = (base / 'schema.annotated.sql').read_text()
text = re.sub(r'\A(--[^\n]*\n)+', '', text)                       # header lines of the annotated version
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
