// Rutas (origen → destino) por callsign, usando la base de rutas de adsb.lol.
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

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(URL_RUTAS, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'radar-vuelos/1.0 (uso personal)' },
      body: JSON.stringify({ planes: callsigns.map((c) => ({ callsign: c, lat, lng: lon })) }),
    });
    if (!r.ok) throw new Error('adsb.lol rutas: HTTP ' + r.status);
    const lista = await r.json();

    const rutas = {};
    callsigns.forEach((c) => { rutas[c] = null; });
    (Array.isArray(lista) ? lista : []).forEach((x) => {
      const cs = String(x.callsign || '').toUpperCase();
      if (!(cs in rutas)) return;
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

    // Las rutas cambian poco: se cachean una hora en el CDN
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ rutas });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String((e && e.message) || e) });
  } finally {
    clearTimeout(t);
  }
};
