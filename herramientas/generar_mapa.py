"""Genera mosaicos estáticos de mapa (2°x2°) para radar-vuelos.
Uso: python3 generar_mapa.py <carpeta_datos> <carpeta_salida>"""
import json, csv, sys, os, math
from collections import defaultdict
DATOS, SALIDA = sys.argv[1], sys.argv[2]
T = 2.0
def tile(lat, lon):
    return (int(math.floor((min(lat, 89.999) + 90) / T)), int(math.floor((min(lon, 179.999) + 180) / T)))

def dp(pts, eps):
    if len(pts) < 3: return pts
    # Douglas-Peucker iterativo
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    pila = [(0, len(pts)-1)]
    while pila:
        i0, i1 = pila.pop()
        (x1, y1), (x2, y2) = pts[i0], pts[i1]
        dx, dy = x2-x1, y2-y1; den = math.hypot(dx, dy) or 1e-12
        dmax, idx = 0, -1
        for i in range(i0+1, i1):
            d = abs(dy*pts[i][0] - dx*pts[i][1] + x2*y1 - y2*x1) / den
            if d > dmax: dmax, idx = d, i
        if dmax > eps and idx > 0:
            keep[idx] = True; pila += [(i0, idx), (idx, i1)]
    return [p for p, k in zip(pts, keep) if k]

capas = defaultdict(lambda: defaultdict(list))  # tile -> capa -> [polilíneas]

def agregar_lineas(capa, lineas, eps):
    for l in lineas:
        l = dp(l, eps)
        if len(l) < 2: continue
        runs = {}
        for i in range(len(l)-1):
            a, b = l[i], l[i+1]
            for t in {tile(a[1], a[0]), tile(b[1], b[0])}:
                r = runs.get(t)
                if r and r[1] == i: r[0].append(b); r[1] = i+1
                else:
                    if r: capas[t][capa].append(r[0])
                    runs[t] = [[a, b], i+1]
        for t, r in runs.items(): capas[t][capa].append(r[0])

def lineas_geojson(nombre, filtro=None):
    g = json.load(open(os.path.join(DATOS, nombre)))
    for f in g['features']:
        if filtro and not filtro(f['properties']): continue
        geo = f['geometry']
        if not geo: continue
        if geo['type'] == 'LineString': yield geo['coordinates']
        elif geo['type'] == 'MultiLineString':
            for c in geo['coordinates']: yield c

agregar_lineas('c', lineas_geojson('ne_10m_coastline.geojson'), 0.002)
agregar_lineas('f', lineas_geojson('ne_10m_admin_0_boundary_lines_land.geojson'), 0.003)
agregar_lineas('p', lineas_geojson('ne_10m_admin_1_states_provinces_lines.geojson'), 0.003)
agregar_lineas('r', lineas_geojson('ne_10m_rivers_lake_centerlines.geojson'), 0.003)

# Ciudades
g = json.load(open(os.path.join(DATOS, 'ne_10m_populated_places_simple.geojson')))
for f in g['features']:
    p = f['properties']; pop = p.get('pop_max') or 0
    if pop < 50000 and (p.get('scalerank') or 10) > 6: continue
    lat, lon = p['latitude'], p['longitude']
    capas[tile(lat, lon)]['ci'].append([p['name'], round(lat, 4), round(lon, 4), int(pop)])

# Aeropuertos y pistas
aps = {}
for r in csv.DictReader(open(os.path.join(DATOS, 'airports.csv'), encoding='utf-8')):
    t = r['type']
    if t not in ('large_airport', 'medium_airport') and not (t == 'small_airport' and r['iata_code']): continue
    try: lat, lon = float(r['latitude_deg']), float(r['longitude_deg'])
    except ValueError: continue
    cod = r['iata_code'] or r['ident']
    nivel = {'large_airport': 0, 'medium_airport': 1}.get(t, 2)
    aps[r['ident']] = 1
    capas[tile(lat, lon)]['a'].append([cod, round(lat, 4), round(lon, 4), nivel])
for r in csv.DictReader(open(os.path.join(DATOS, 'runways.csv'), encoding='utf-8')):
    if r['airport_ident'] not in aps or r['closed'] == '1': continue
    try: c = [float(r[k]) for k in ('le_latitude_deg', 'le_longitude_deg', 'he_latitude_deg', 'he_longitude_deg')]
    except ValueError: continue
    try: ancho = round(float(r['width_ft']) * 0.3048)
    except ValueError: ancho = 45
    capas[tile(c[0], c[1])]['pi'].append([round(c[0], 5), round(c[1], 5), round(c[2], 5), round(c[3], 5), ancho])

os.makedirs(SALIDA, exist_ok=True)
total = 0
for (ti, tj), cs in capas.items():
    out = {}
    for k, v in cs.items():
        if k in ('c', 'f', 'p', 'r'):
            out[k] = [[round(x, 4) for pt in l for x in (pt[1], pt[0])] for l in v]  # lat, lon
        else:
            out[k] = v
    txt = json.dumps(out, separators=(',', ':'), ensure_ascii=False)
    open(os.path.join(SALIDA, f'{ti}_{tj}.json'), 'w', encoding='utf-8').write(txt)
    total += len(txt.encode())
print('mosaicos:', len(capas), 'tamaño total: %.1f MB' % (total/1e6))
