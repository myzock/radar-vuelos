// Proxy de datos ADS-B para Radar de vuelos.
// Prueba varias fuentes públicas (todas usan el formato "readsb")
// y devuelve una lista normalizada y liviana para la tablet.

const FUENTES = [
  { nombre: 'adsb.fi', url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    hex: (h) => `https://opendata.adsb.fi/api/v2/hex/${h}` },
  { nombre: 'airplanes.live', url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
    hex: (h) => `https://api.airplanes.live/v2/hex/${h}` },
  { nombre: 'adsb.lol', url: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    hex: (h) => `https://api.adsb.lol/v2/hex/${h}` },
];

// Recuerda la última fuente que funcionó (mientras la función siga "caliente")
let preferida = 0;

async function traer(fuente, lat, lon, nm, urlDirecta) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(urlDirecta || fuente.url(lat, lon, nm), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'radar-vuelos/1.0 (uso personal)', Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`${fuente.nombre}: HTTP ${r.status}`);
    const j = await r.json();
    const lista = j.ac || j.aircraft;
    if (!Array.isArray(lista)) throw new Error(`${fuente.nombre}: respuesta sin aviones`);
    return lista;
  } finally {
    clearTimeout(t);
  }
}

function n(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function normalizar(x) {
  if (!x || n(x.lat) === null || n(x.lon) === null) return null;
  const enTierra = x.alt_baro === 'ground';
  return {
    hex: String(x.hex || '').replace('~', ''),
    cs: String(x.flight || '').trim(),
    reg: x.r || '',
    tipo: x.t || '',
    desc: x.desc || '',
    lat: x.lat,
    lon: x.lon,
    alt: enTierra ? 0 : n(x.alt_baro) ?? n(x.alt_geom), // pies
    gnd: enTierra,
    gs: n(x.gs), // nudos
    trk: n(x.track) ?? n(x.true_heading), // grados
    vr: n(x.baro_rate) ?? n(x.geom_rate), // pies/min
    sq: x.squawk || '',
    seen: n(x.seen_pos) ?? n(x.seen) ?? 0, // segundos desde la última posición
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const lat = Number(q.lat);
  const lon = Number(q.lon);
  let km = Number(q.km) || 50;

  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'lat/lon inválidos' });
    return;
  }
  km = Math.min(Math.max(km, 5), 400);
  const nm = Math.min(Math.ceil(km / 1.852), 250);
  const latS = lat.toFixed(3);
  const lonS = lon.toFixed(3);

  const errores = [];
  for (let i = 0; i < FUENTES.length; i++) {
    const idx = (preferida + i) % FUENTES.length;
    const f = FUENTES[idx];
    try {
      const lista = await traer(f, latS, lonS, nm);
      preferida = idx;
      // Avión seguido fuera del área: se lo busca por su código en OTRA fuente
      // (así no se suman dos consultas seguidas a la misma API y su límite de uso)
      const hex = String(q.hex || '').toLowerCase();
      if (/^[0-9a-f]{6}$/.test(hex) && !lista.some((x) => String(x.hex || '').toLowerCase() === hex)) {
        const otra = FUENTES[(idx + 1) % FUENTES.length];
        try {
          const extra = await traer(otra, 0, 0, 0, otra.hex(hex));
          extra.forEach((x) => lista.push(x));
        } catch (e) { /* si falla, la app lo marca como sin señal */ }
      }
      // Cache en el CDN de Vercel: varias consultas seguidas no le pegan a la API
      res.setHeader('Cache-Control', 's-maxage=4, stale-while-revalidate=20');
      res.status(200).json({
        fuente: f.nombre,
        ts: Date.now(),
        aviones: lista.map(normalizar).filter((a) => a && a.hex),
      });
      return;
    } catch (e) {
      errores.push(String((e && e.message) || e));
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(502).json({ error: 'Ninguna fuente respondió', detalle: errores });
};
