// Busca un vuelo en todo el mundo por callsign (ARG1302) o matrícula (LV-FNI / LVFNI).
// GET /api/buscar?q=ARG1302  →  { aviones: [...] } con el mismo formato que /api/aviones
const { normalizar } = require('./aviones.js');

const CONSULTAS = [
  (q) => `https://opendata.adsb.fi/api/v2/callsign/${q}`,
  (q) => `https://api.adsb.lol/v2/callsign/${q}`,
  (q) => `https://opendata.adsb.fi/api/v2/registration/${q}`,
  (q) => `https://api.adsb.lol/v2/reg/${q}`,
];

async function traer(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'radar-vuelos/1.0 (uso personal)' } });
    if (!r.ok) return [];
    const j = await r.json();
    return j.ac || j.aircraft || [];
  } catch (e) {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// Las matrículas se guardan con guion (LV-FNI); si el usuario no lo puso, se prueban variantes
function variantesMatricula(q) {
  const v = [q];
  if (!q.includes('-')) for (const n of [1, 2]) if (q.length > n + 1) v.push(q.slice(0, n) + '-' + q.slice(n));
  return v;
}

module.exports = async (req, res) => {
  const q = String((req.query || {}).q || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  if (q.length < 3) {
    res.status(400).json({ error: 'Consulta muy corta' });
    return;
  }
  let lista = [];
  // 1) callsign
  for (const c of CONSULTAS.slice(0, 2)) {
    lista = await traer(c(q.replace(/-/g, '')));
    if (lista.length) break;
  }
  // 2) matrícula
  if (!lista.length) {
    outer: for (const v of variantesMatricula(q)) {
      for (const c of CONSULTAS.slice(2)) {
        lista = await traer(c(v));
        if (lista.length) break outer;
      }
    }
  }
  res.setHeader('Cache-Control', 's-maxage=5');
  res.status(200).json({ aviones: lista.map(normalizar).filter((a) => a && a.hex) });
};
