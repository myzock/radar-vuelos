// Rutas (origen → destino) por callsign: base de rutas de adsb.lol, con adsbdb.com de respaldo.
// GET /api/rutas?cs=ARG1302,LAN440&lat=-34.6&lon=-58.4
// Responde { rutas: { ARG1302: { o: 'AEP', d: 'COR', on: 'Buenos Aires', dn: 'Córdoba', ok: true }, LAN440: null } }

const URL_RUTAS = 'https://api.adsb.lol/api/0/routeset';

function aeropuerto(a) {
  if (!a) return null;
  return {
    cod: a.iata || a.icao || '',
    ciudad: a.location || a.name || '',
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const lat = Number(q.lat) || 0;
  const lon = Number(q.lon) || 0;
  const callsigns = String(q.cs || '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z0-9]{3,8}$/.test(c))
    .slice(0, 40);

  if (!callsigns.length) {
    res.status(400).json({ error: 'Falta cs' });
    return;
  }

  const errores = [];
  let rutas = null;
  try {
    rutas = await desdeAdsbLol(callsigns, lat, lon);
  } catch (e) {
    errores.push(String((e && e.message) || e));
  }
  // Respaldo: adsbdb, una consulta por callsign (solo para los que faltan)
  const faltan = callsigns.filter((c) => !rutas || !rutas[c]);
  if (faltan.length) {
    try {
      const extra = await desdeAdsbdb(faltan);
      rutas = Object.assign({}, rutas || {}, extra);
    } catch (e) {
      errores.push(String((e && e.message) || e));
    }
  }
  if (!rutas) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'Sin fuente de rutas', detalle: errores });
    return;
  }
  // Las rutas cambian poco: se cachean una hora en el CDN. Si alguna consulta falló
  // (el callsign no aparece en la respuesta), solo un minuto, para reintentar.
  const completas = callsigns.every((c) => c in rutas);
  res.setHeader('Cache-Control', completas ? 's-maxage=3600, stale-while-revalidate=86400' : 's-maxage=60');
  res.status(200).json(q.debug ? { rutas, errores } : { rutas });
};

async function conTiempo(url, opciones, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, opciones));
  } finally {
    clearTimeout(t);
  }
}

async function desdeAdsbLol(callsigns, lat, lon) {
  const r = await conTiempo(URL_RUTAS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'radar-vuelos/1.0 (uso personal)' },
    body: JSON.stringify({ planes: callsigns.map((c) => ({ callsign: c, lat, lng: lon })) }),
  }, 5000);
  if (!r.ok) throw new Error('adsb.lol: HTTP ' + r.status);
  const texto = await r.text();
  if (!texto.trim()) throw new Error('adsb.lol: respuesta vacía');
  const lista = JSON.parse(texto);
  const rutas = {};
  (Array.isArray(lista) ? lista : []).forEach((x) => {
    const cs = String(x.callsign || '').toUpperCase();
    if (callsigns.indexOf(cs) < 0) return;
    const aps = Array.isArray(x._airports) ? x._airports : [];
    const codigos = String(x._airport_codes_iata || x.airport_codes || '').split('-').filter(Boolean);
    if (aps.length < 2 && codigos.length < 2) return;
    const o = aeropuerto(aps[0]) || { cod: codigos[0], ciudad: '' };
    const d = aeropuerto(aps[aps.length - 1]) || { cod: codigos[codigos.length - 1], ciudad: '' };
    rutas[cs] = {
      o: o.cod || codigos[0] || '?',
      d: d.cod || codigos[codigos.length - 1] || '?',
      on: o.ciudad,
      dn: d.ciudad,
      ok: x.plausible === undefined ? true : !!x.plausible, // false: la ruta no coincide con la posición
    };
  });
  return rutas;
}

async function desdeAdsbdb(callsigns) {
  const rutas = {};
  await Promise.all(callsigns.slice(0, 25).map(async (cs) => {
    try {
      const r = await conTiempo('https://api.adsbdb.com/v0/callsign/' + cs, {
        headers: { Accept: 'application/json', 'User-Agent': 'radar-vuelos/1.0 (uso personal)' },
      }, 5000);
      if (r.status === 404) { rutas[cs] = null; return; } // callsign desconocido
      if (!r.ok) return;
      const j = await r.json();
      const fr = j && j.response && j.response.flightroute;
      if (!fr || !fr.origin || !fr.destination) { rutas[cs] = null; return; }
      rutas[cs] = {
        o: fr.origin.iata_code || fr.origin.iata || fr.origin.icao_code || fr.origin.icao || '?',
        d: fr.destination.iata_code || fr.destination.iata || fr.destination.icao_code || fr.destination.icao || '?',
        on: fr.origin.municipality || fr.origin.name || '',
        dn: fr.destination.municipality || fr.destination.name || '',
        ok: true,
      };
    } catch (e) { /* se reintenta en otra consulta */ }
  }));
  return rutas;
}
