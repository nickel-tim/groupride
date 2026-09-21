"""Measures how large a 50 km ride (2 h, 1 Hz, GPS noise +-1.5 m) becomes on the server.
Run: python3 liga/test/track_size.py"""
import math, random, json, zlib, gzip
random.seed(3)
lat, lon, hd = 48.1, 11.5, 0.3
pts = []; ele = 520.0; v = 7.0
for t in range(7200):
    hd += random.gauss(0, 0.02) + (0.15*math.sin(t/300))*0.05
    v = max(3, min(11, v + random.gauss(0, 0.2)))
    lat += math.cos(hd)*v/111320 + random.gauss(0, 1.5)/111320
    lon += math.sin(hd)*v/(111320*math.cos(math.radians(lat))) + random.gauss(0, 1.5)/(111320*math.cos(math.radians(lat)))
    ele += random.gauss(0, 0.15) + math.sin(t/900)*0.4 + random.gauss(0,0.5)*0.3
    pts.append((t, lat, lon, ele))
js = json.dumps([[t, round(a,6), round(o,6), round(e,1)] for t,a,o,e in pts], separators=(',',':'))
def zz(n):  return (n<<1) ^ (n>>63)
def varint(n):
    n = zz(n); out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b|0x80)
        else: out.append(b); break
    return bytes(out)
for prec, label in ((1e5,'1e-5 (1,1 m)'),(1e6,'1e-6 (0,11 m)')):
    b = bytearray(); pl = plo = pe = 0
    for t,a,o,e in pts:
        la = round(a*prec); lo = round(o*prec); el = round(e*10)
        b += varint(la-pl) + varint(lo-plo) + varint(el-pe); pl, plo, pe = la, lo, el
    print(label, 'binaer', len(b), 'gzip', len(gzip.compress(bytes(b), 9)))
print('json', len(js), 'gzip', len(gzip.compress(js.encode(), 9)))
