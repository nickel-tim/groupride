#!/usr/bin/env python3
"""Folds index.html, CSS and all JS modules into a single file.

Handy for web hosting: upload one file, done. The
fonts stay external (Google Fonts), everything else is embedded.
"""
import re, pathlib, sys

base = pathlib.Path(__file__).parent
html = (base / 'index.html').read_text(encoding='utf-8')

css = (base / 'css/app.css').read_text(encoding='utf-8')
html = html.replace('<link rel="stylesheet" href="css/app.css">',
                    '<style>\n' + css + '\n</style>')

def inline(m):
    src = m.group(1)
    code = (base / src).read_text(encoding='utf-8')
    return '<script>\n/* ==== ' + src + ' ==== */\n' + code + '\n</script>'

html, n = re.subn(r'<script src="(js/[^"]+)"></script>', inline, html)

out = base / 'ausfahrt.html'
out.write_text(html, encoding='utf-8')
print(f'{out.name}: {n} Module eingebettet, {len(html)/1024:.0f} KB')
