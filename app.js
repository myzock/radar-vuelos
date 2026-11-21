/* Radar de vuelos — webapp para tablet (Chrome 106 / Android 6)
   Parámetros de URL opcionales: ?lat=-34.60&lon=-58.38&km=50  ·  ?demo  (datos simulados) */
(function () {
  'use strict';

  // ---------------- Configuración ----------------
  var DEFECTO = { lat: -34.6037, lon: -58.3816, km: 50 }; // Obelisco
  var RANGOS = [10, 25, 50, 100, 200];
  var INTERVALO_MS = 6000;       // cada cuánto se piden datos
  var EXTRAPOLAR_MAX_S = 45;     // cuánto se "adivina" la posición sin datos nuevos
  var VUELTA_BARRIDO_MS = 4000;
  // Mapa de fondo: se arma con mosaicos de 2°x2° (carpeta /mapa) según la ubicación.
  // Capas: c costa, f límites de países, p provincias/estados, r ríos,
  //        ci ciudades [nombre, lat, lon, población], a aeropuertos [código, lat, lon, nivel], pi pistas
  var MOSAICO = 2;
  var GEO = { c: [], f: [], p: [], r: [], ci: [], a: [], pi: [] };
  var mosaicos = {}; // cache: clave -> datos (o {} si no hay nada en ese mosaico)

  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo');
  var DEMO_N = parseInt(params.get('demo'), 10) || 14; // ?demo=80 para prueba de carga
  // Pantalla redonda: ?redondo fuerza el modo, ?redondo=0 lo apaga; si no, se activa solo en pantallas cuadradas
  var REDONDO = params.has('redondo') ? params.get('redondo') !== '0'
    : Math.abs(window.innerWidth / window.innerHeight - 1) < 0.12;
  if (REDONDO) document.body.className += ' redondo';

  function primeroNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = parseFloat(arguments[i]);
      if (isFinite(v)) return v;
    }
  }
  function leerGuardado() {
    try { return JSON.parse(localStorage.getItem('radar-cfg') || '{}') || {}; } catch (e) { return {}; }
  }
  function guardar() {
    try { localStorage.setItem('radar-cfg', JSON.stringify(cfg)); } catch (e) {}
  }
  // Ajustes del usuario (panel ⚙), guardados en la tablet
  var AJUSTES_DEFECTO = {
    ocultarTierra: true, altMax: 0, noche: 'auto', nocheDesde: 23, nocheHasta: 7, sonido: true,
    vigilar: 'A388, A124, AN22, B748, B744, C17, C5M, A400, IL76, A3ST, BLCF, B52'
  };
  var ajustes = (function () {
    var a = {}, k, guardado = {};
    try { guardado = JSON.parse(localStorage.getItem('radar-ajustes') || '{}') || {}; } catch (e) {}
    for (k in AJUSTES_DEFECTO) a[k] = k in guardado ? guardado[k] : AJUSTES_DEFECTO[k];
    return a;
  })();
  function guardarAjustes() {
    try { localStorage.setItem('radar-ajustes', JSON.stringify(ajustes)); } catch (e) {}
  }

  var g = leerGuardado();
  var cfg = {
    lat: primeroNum(params.get('lat'), g.lat, DEFECTO.lat),
    lon: primeroNum(params.get('lon'), g.lon, DEFECTO.lon),
    km: primeroNum(params.get('km'), g.km, DEFECTO.km)
  };

  // ---------------- Geometría ----------------
  var KM_LAT = 110.574;
  function kmLon(lat) { return 111.320 * Math.cos(lat * Math.PI / 180); }
  function aXY(lat, lon) { return { x: (lon - cfg.lon) * kmLon(cfg.lat), y: (lat - cfg.lat) * KM_LAT }; }
  function avanzar(lat, lon, rumbo, km) {
    var r = rumbo * Math.PI / 180;
    return { lat: lat + km * Math.cos(r) / KM_LAT, lon: lon + km * Math.sin(r) / kmLon(lat) };
  }
  function cardinal(g) {
    var c = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return c[Math.round(((g % 360) + 360) % 360 / 45) % 8];
  }

  // ---------------- Formato ----------------
  function miles(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function nombre(d) { return d.cs || d.reg || d.hex.toUpperCase(); }
  function altTexto(d) {
    if (d.gnd) return 'En tierra';
    if (d.alt == null) return '—';
    return miles(d.alt * 0.3048) + ' m';
  }
  function esEmerg(d) { return d.sq === '7500' || d.sq === '7600' || d.sq === '7700'; }
  function colorAlt(d) {
    if (esEmerg(d)) return '#ff4d4d';
    if (d.gnd) return '#8a9a9a';
    var a = d.alt || 0;
    if (a < 3000) return '#ffb347';
    if (a < 10000) return '#ffe066';
    if (a < 25000) return '#7dff9a';
    return '#5fe3ff';
  }

  // ---------------- Estado ----------------
  var aviones = {};   // hex -> { d, t0, visto, estela[], px, py, dist, dentro }
  var seleccion = null;  // hex del avión que se está siguiendo
  var perdido = null;    // último dato del seguido si dejó de aparecer: { d, lat, lon, hora }
  var SIN_SENAL_S = 20;  // a partir de cuántos segundos sin posición se avisa
  var estado = DEMO ? 'demo' : 'cargando';
  var fuente = '';
  var ultimaOK = 0;
  var pidiendo = false;

  function posActual(a, ahora) {
    var d = a.d;
    if (d.gnd || d.gs == null || d.trk == null) return { lat: d.lat, lon: d.lon };
    var dt = Math.min((ahora - a.t0) / 1000, EXTRAPOLAR_MAX_S);
    if (dt <= 0) return { lat: d.lat, lon: d.lon };
    return avanzar(d.lat, d.lon, d.trk, d.gs * 1.852 * dt / 3600);
  }

  function integrar(lista, ahora) {
    var vistos = {};
    lista.forEach(function (d) {
      if (!d.hex) return;
      vistos[d.hex] = true;
      var a = aviones[d.hex];
      if (!a) {
        a = aviones[d.hex] = { estela: [], hist: [] };
      } else if (a.d && (a.d.lat !== d.lat || a.d.lon !== d.lon)) {
        a.estela.push({ lat: a.d.lat, lon: a.d.lon });
        if (a.estela.length > 12) a.estela.shift();
      }
      // Recorrido completo desde que entró al radar (para dibujar el vuelo del seleccionado)
      var ult = a.hist[a.hist.length - 1];
      if (!ult || ult.lat !== d.lat || ult.lon !== d.lon) {
        a.hist.push({ lat: d.lat, lon: d.lon, alt: d.alt, gnd: d.gnd });
        if (a.hist.length > 600) a.hist.shift(); // ~1 hora a 6 s
      }
      // Aterrizajes y despegues (se avisa solo del avión que estás siguiendo)
      if (a.d && !a.d.gnd && d.gnd) {
        a.aterrizo = { hora: ahora, ap: aeropuertoCercano(d.lat, d.lon) };
        if (d.hex === seleccion) mostrarAlerta('🛬 ' + nombre(d) + ' aterrizó' + (a.aterrizo.ap ? ' en ' + a.aterrizo.ap : ''), false);
      } else if (a.d && a.d.gnd && !d.gnd) {
        a.despego = { hora: ahora, ap: aeropuertoCercano(a.d.lat, a.d.lon) };
        if (d.hex === seleccion) mostrarAlerta('🛫 ' + nombre(d) + ' despegó' + (a.despego.ap ? ' de ' + a.despego.ap : ''), false);
      }
      a.d = d;
      a.t0 = ahora - (d.seen || 0) * 1000;
      a.visto = ahora;
    });
    Object.keys(aviones).forEach(function (h) {
      if (!vistos[h] && ahora - aviones[h].visto > 60000) {
        if (h === seleccion) {
          // El que seguías desapareció: se guarda dónde se lo vio por última vez
          var p = posActual(aviones[h], ahora);
          perdido = { d: aviones[h].d, lat: p.lat, lon: p.lon, hora: aviones[h].t0 + EXTRAPOLAR_MAX_S * 1000 };
          mostrarAlerta('Se perdió la señal de ' + nombre(aviones[h].d), false);
        }
        delete aviones[h];
      }
    });
    if (seleccion && aviones[seleccion] && perdido) { // volvió a aparecer
      perdido = null;
      mostrarAlerta('📡 Volvió la señal de ' + nombre(aviones[seleccion].d), false);
    }
    rehacerLista();
    calcularPosiciones(ahora);
    calcularEstelas();
    revisarAlertas();
    pedirRutas();
    renderPanel();
  }

  // ---------------- Datos ----------------
  // Para no gastar el plan gratuito de Vercel, la tablet consulta las APIs DIRECTAMENTE
  // cuando el navegador lo permite (CORS). El proxy /api/aviones queda de respaldo.
  var DIRECTAS = [
    { nombre: 'adsb.fi', zona: function (la, lo, nm) { return 'https://opendata.adsb.fi/api/v2/lat/' + la + '/lon/' + lo + '/dist/' + nm; },
      hex: function (h) { return 'https://opendata.adsb.fi/api/v2/hex/' + h; } },
    { nombre: 'adsb.lol', zona: function (la, lo, nm) { return 'https://api.adsb.lol/v2/lat/' + la + '/lon/' + lo + '/dist/' + nm; },
      hex: function (h) { return 'https://api.adsb.lol/v2/hex/' + h; } }
  ];
  var directaFalla = {};        // nombre -> momento en que falló (se reintenta a los 30 min)
  var usandoProxy = false;
  var REINTENTO_DIRECTO_MS = 30 * 60000;

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function primero() { for (var i = 0; i < arguments.length; i++) if (arguments[i] != null) return arguments[i]; return null; }
  // Mismo formato que devuelve el proxy (ver api/aviones.js)
  function normalizar(x) {
    if (!x || num(x.lat) === null || num(x.lon) === null || !x.hex) return null;
    var tierra = x.alt_baro === 'ground';
    return {
      hex: String(x.hex).replace('~', ''), cs: String(x.flight || '').trim(), reg: x.r || '', tipo: x.t || '', desc: x.desc || '',
      lat: x.lat, lon: x.lon, alt: tierra ? 0 : primero(num(x.alt_baro), num(x.alt_geom)), gnd: tierra,
      gs: num(x.gs), trk: primero(num(x.track), num(x.true_heading)), vr: primero(num(x.baro_rate), num(x.geom_rate)),
      sq: x.squawk || '', seen: primero(num(x.seen_pos), num(x.seen), 0)
    };
  }
  function traerJson(url, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
            function (e) { clearTimeout(to); throw e; });
  }
  function pedirDirecto() {
    var ahora = Date.now();
    var disponibles = DIRECTAS.filter(function (f) { return !(directaFalla[f.nombre] && ahora - directaFalla[f.nombre] < REINTENTO_DIRECTO_MS); });
    var nm = Math.min(250, Math.ceil(cfg.km * 1.15 / 1.852));
    var la = cfg.lat.toFixed(3), lo = cfg.lon.toFixed(3);
    function intentar(i) {
      if (i >= disponibles.length) return Promise.reject(new Error('sin fuentes directas'));
      var f = disponibles[i];
      return traerJson(f.zona(la, lo, nm), 8000).then(function (j) {
        var l = j.ac || j.aircraft;
        if (!Array.isArray(l)) throw new Error('respuesta sin aviones');
        var res = { fuente: f.nombre, aviones: l.map(normalizar).filter(Boolean) };
        // el avión seguido, si se fue del área, se busca por su código en la otra fuente
        if (!seleccion || res.aviones.some(function (a) { return a.hex === seleccion; })) return res;
        var otra = DIRECTAS[(DIRECTAS.indexOf(f) + 1) % DIRECTAS.length];
        return traerJson(otra.hex(seleccion), 6000).then(function (jh) {
          (jh.ac || jh.aircraft || []).map(normalizar).filter(Boolean).forEach(function (a) { if (a.hex === seleccion) res.aviones.push(a); });
          return res;
        }, function () { return res; });
      }, function (e) {
        directaFalla[f.nombre] = Date.now(); // CORS bloqueado o caída: probar la siguiente
        return intentar(i + 1);
      });
    }
    return intentar(0);
  }
  function pedirProxy() {
    var url = '/api/aviones?lat=' + cfg.lat.toFixed(3) + '&lon=' + cfg.lon.toFixed(3) + '&km=' + Math.ceil(cfg.km * 1.15) +
      (seleccion ? '&hex=' + seleccion : ''); // el seguido se pide aparte por si se va del área
    return traerJson(url, 9000);
  }

  function pedir() {
    if (DEMO || pidiendo || document.hidden) return;
    pidiendo = true;
    pedirDirecto()
      .then(function (r) { usandoProxy = false; return r; },
            function () { usandoProxy = true; return pedirProxy(); })
      .then(function (j) {
        fuente = (j.fuente || '') + (usandoProxy ? ' (proxy)' : '');
        estado = 'live';
        ultimaOK = Date.now();
        integrar(j.aviones || [], Date.now());
      })
      .catch(function (e) {
        estado = 'error';
        console.warn('Radar: error al pedir datos', e);
      })
      .then(function () {
        pidiendo = false;
        actualizarEstado();
      });
  }
  // Intervalo: directo cada 6 s; por el proxy (cuenta en Vercel) cada 10 s, o 30 s en modo noche
  function intervaloActual() {
    if (!usandoProxy) return INTERVALO_MS;
    return nocheActiva ? 30000 : 10000;
  }
  function cicloPedidos() {
    pedir();
    setTimeout(cicloPedidos, intervaloActual());
  }

  // ---------------- Modo demo ----------------
  var DEMO_CS = ['ARG1302', 'LAN440', 'AZU7720', 'JES5012', 'GLO7650', 'FBZ5301', 'TAM8040', 'UAL818',
    'AAL909', 'AFR418', 'IBE6845', 'DAL101', 'CMP320', 'ARG1880', 'LPE2470', 'KLM701'];
  var DEMO_TIPOS = [['B738', 'BOEING 737-800'], ['A320', 'AIRBUS A-320'], ['E190', 'EMBRAER ERJ-190'],
    ['B789', 'BOEING 787-9'], ['A332', 'AIRBUS A-330-200'], ['B77W', 'BOEING 777-300ER']];
  function avionDemo(i) {
    var p = avanzar(cfg.lat, cfg.lon, Math.random() * 360, Math.random() * cfg.km * 0.9);
    var t = DEMO_TIPOS[i % DEMO_TIPOS.length];
    var alt = Math.round(Math.random() * 38000 / 100) * 100;
    return {
      hex: (0xe00000 + i * 4111).toString(16), cs: DEMO_CS[i % DEMO_CS.length], reg: 'LV-' + String.fromCharCode(65 + i) + 'XY',
      tipo: t[0], desc: t[1], lat: p.lat, lon: p.lon, alt: alt, gnd: false,
      gs: 140 + Math.random() * 340, trk: Math.random() * 360,
      vr: Math.round((Math.random() - 0.5) * 3000 / 64) * 64, sq: i === 5 ? '7700' : String(1000 + i * 13), seen: 0,
      // para probar alertas y filtros: un A380 (lista de vigilancia) y uno en tierra
      gndDemo: i === 3
    };
  }
  function ajustarDemo(d) {
    if (d.gndDemo) { d.gnd = true; d.alt = 0; d.gs = 0; }
    if (d.cs === 'AFR418') { d.tipo = 'A388'; d.desc = 'AIRBUS A-380-800'; }
    return d;
  }
  function demoTick() {
    var ahora = Date.now();
    var lista;
    if (!Object.keys(aviones).length) {
      lista = [];
      for (var i = 0; i < DEMO_N; i++) lista.push(avionDemo(i));
    } else {
      lista = Object.keys(aviones).map(function (h, i) {
        var a = aviones[h];
        var p = posActual(a, ahora);
        var xy = aXY(p.lat, p.lon);
        if (Math.sqrt(xy.x * xy.x + xy.y * xy.y) > cfg.km * 1.05) return avionDemo(i + 20 + Math.floor(Math.random() * 50));
        var d = {};
        for (var k in a.d) d[k] = a.d[k];
        d.lat = p.lat; d.lon = p.lon; d.trk = (d.trk + (Math.random() - 0.5) * 6 + 360) % 360;
        return d;
      });
    }
    integrar(lista.map(ajustarDemo), ahora);
  }

  // ---------------- Rutas (origen → destino) ----------------
  var rutas = {};      // callsign -> {o, d, on, dn, ok} | null (sin ruta conocida)
  var rutasPedidas = {};
  var DEMO_RUTAS = [['AEP', 'COR'], ['SCL', 'AEP'], ['EZE', 'GRU'], ['AEP', 'MDZ'], ['EZE', 'MAD'], ['GIG', 'EZE'], ['AEP', 'BRC'], ['EZE', 'MIA']];
  var DEMO_AP = { AEP: [-34.559, -58.416], EZE: [-34.822, -58.536], COR: [-31.32, -64.21], SCL: [-33.393, -70.786], GRU: [-23.435, -46.473],
    MDZ: [-32.832, -68.793], MAD: [40.472, -3.561], GIG: [-22.81, -43.25], BRC: [-41.151, -71.158], MIA: [25.795, -80.287] };
  function pedirRutas() {
    var faltan = [];
    for (var i = 0; i < lista.length && faltan.length < 40; i++) {
      var cs = lista[i].d.cs;
      if (cs && !(cs in rutas) && !rutasPedidas[cs]) faltan.push(cs);
    }
    if (!faltan.length) return;
    if (DEMO) {
      faltan.forEach(function (cs, i) {
        var r = DEMO_RUTAS[(cs.length + i) % DEMO_RUTAS.length], o = DEMO_AP[r[0]], d = DEMO_AP[r[1]];
        rutas[cs] = { o: r[0], d: r[1], on: '', dn: '', ok: true, olat: o[0], olon: o[1], dlat: d[0], dlon: d[1] };
      });
      return;
    }
    faltan.forEach(function (cs) { rutasPedidas[cs] = true; });
    fetch('/api/rutas?cs=' + faltan.join(',') + '&lat=' + cfg.lat.toFixed(2) + '&lon=' + cfg.lon.toFixed(2))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var rr = j.rutas || {};
        for (var cs in rr) rutas[cs] = rr[cs];
        if (seleccion) calcularEstelas(); // ahora se puede dibujar el tramo desde el origen
        // los que no vinieron (falló la consulta) se reintentan en un minuto
        var sinRespuesta = faltan.filter(function (c) { return !(c in rr); });
        if (sinRespuesta.length) setTimeout(function () { sinRespuesta.forEach(function (c) { delete rutasPedidas[c]; }); }, 60000);
        renderPanel();
      })
      .catch(function (e) {
        // si falla, se vuelve a intentar en un minuto
        setTimeout(function () { faltan.forEach(function (cs) { delete rutasPedidas[cs]; }); }, 60000);
        console.warn('Radar: rutas', e);
      });
  }
  function rutaCorta(d) {
    var r = d.cs && rutas[d.cs];
    return r ? r.o + '→' + r.d : '';
  }

  // ---------------- Filtros ----------------
  function pasaFiltros(d) {
    if (ajustes.ocultarTierra && d.gnd && !esEmerg(d)) return false;
    if (ajustes.altMax && !d.gnd && d.alt != null && d.alt > ajustes.altMax) return false;
    return true;
  }

  // ---------------- Alertas ----------------
  var alertados = {};
  var audio = null;
  function listaVigilar() {
    return String(ajustes.vigilar || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
  }
  function motivoVigilancia(d) {
    var l = listaVigilar(), cs = (d.cs || '').toUpperCase(), reg = (d.reg || '').toUpperCase(), tipo = (d.tipo || '').toUpperCase();
    for (var i = 0; i < l.length; i++) {
      var v = l[i];
      if (v === tipo) return d.desc || tipo;
      if (reg && v.replace('-', '') === reg.replace('-', '')) return 'matrícula ' + reg;
      if (v.length === 3 && /^[A-Z]{3}$/.test(v) && cs.indexOf(v) === 0 && /\d/.test(cs.charAt(3))) return 'aerolínea ' + v;
      if (v === d.hex.toUpperCase()) return 'hex ' + v;
    }
    return '';
  }
  function revisarAlertas() {
    for (var i = 0; i < lista.length; i++) {
      var a = lista[i], d = a.d;
      if (!a.dentro || alertados[d.hex]) continue;
      if (esEmerg(d)) {
        var tipoEm = { '7500': 'interferencia ilícita', '7600': 'falla de radio', '7700': 'emergencia' }[d.sq];
        alertados[d.hex] = 'emerg';
        mostrarAlerta('⚠ ' + d.sq + ' ' + tipoEm + ' · ' + nombre(d) + ' a ' + a.dist.toFixed(0) + ' km', true);
        continue;
      }
      var m = motivoVigilancia(d);
      if (m) {
        alertados[d.hex] = 'vigilado';
        mostrarAlerta('★ ' + nombre(d) + ' · ' + m + ' a ' + a.dist.toFixed(0) + ' km', false);
      }
    }
  }
  var tAlerta;
  function mostrarAlerta(texto, emergencia) {
    var el = $('alerta');
    el.textContent = texto;
    el.className = 'alerta' + (emergencia ? ' emerg' : '');
    clearTimeout(tAlerta);
    tAlerta = setTimeout(function () { el.className = 'alerta oculto' + (emergencia ? ' emerg' : ''); }, emergencia ? 30000 : 12000);
    if (ajustes.sonido) sonar(emergencia);
  }
  function desbloquearAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!audio && AC) { try { audio = new AC(); } catch (e) {} }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function sonar(emergencia) {
    if (!audio || audio.state !== 'running') return; // el navegador exige tocar la pantalla una vez antes
    var t = audio.currentTime;
    var tonos = emergencia ? [880, 660, 880, 660] : [660, 990];
    tonos.forEach(function (f, i) {
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(g); g.connect(audio.destination);
      o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.17);
    });
  }

  // ---------------- Modo noche ----------------
  var nocheActiva = false;
  function esNoche() {
    if (ajustes.noche === 'si') return true;
    if (ajustes.noche === 'no') return false;
    var h = new Date().getHours(), de = +ajustes.nocheDesde, a = +ajustes.nocheHasta;
    return de <= a ? (h >= de && h < a) : (h >= de || h < a);
  }
  function aplicarNoche() {
    var n = esNoche();
    if (n === nocheActiva) return;
    nocheActiva = n;
    var v = $('noche');
    if (n) {
      v.style.display = 'block';
      setTimeout(function () { v.style.opacity = '0.7'; }, 30);
    } else {
      v.style.opacity = '0';
      setTimeout(function () { if (!nocheActiva) v.style.display = 'none'; }, 2100);
    }
  }

  // ---------------- Canvas (optimizado para 60 fps) ----------------
  // El radar son 5 canvas apilados; la GPU los compone y solo uno se redibuja por cuadro:
  //  - capa-fondo: anillos, marcas, textos, aeropuertos (solo al cambiar tamaño/alcance/ubicación)
  //  - capa-estelas: recorridos pasados (solo cuando llegan datos)
  //  - capa-barrido: se dibuja una vez y la rota el compositor con una animación (no usa JS)
  //  - capa-borde: círculo exterior y puntos cardinales
  //  - radar: aviones. Un sprite por color y una etiqueta pre-renderizada por avión,
  //    así cada cuadro es solo drawImage + matemática: sin texto, gradientes ni arcos.
  var cv = document.getElementById('radar');
  var ctx = cv.getContext('2d');
  var W, H, R, CX, CY, DPR, ESCALA;
  var TAU = Math.PI * 2;
  var CALIDAD = params.get('dpr'); // ?dpr=1 si la tablet sufre
  // Capas estáticas: canvas reales apilados que el navegador compone en la GPU
  var fondo = document.getElementById('capa-fondo');
  var barrido = document.getElementById('capa-barrido');
  var animBarrido = null;
  var sprites = {};

  function lienzo(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.ceil(w * DPR); c.height = Math.ceil(h * DPR);
    var x = c.getContext('2d');
    x.scale(DPR, DPR);
    return { c: c, x: x };
  }

  function redimensionar() {
    DPR = Math.min(parseFloat(CALIDAD) || window.devicePixelRatio || 1, 1.5);
    var r = cv.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    R = Math.min(W, H) / 2 - (REDONDO ? 2 : 22);
    CX = W / 2; CY = H / 2;
    sprites = {};
    construirBarrido();
    construirFondo();
  }

  function rad(gradosNorte) { return (gradosNorte - 90) * Math.PI / 180; }

  function construirFondo() {
    if (!R || R < 20) return;
    ESCALA = R / cfg.km;
    fondo.width = cv.width; fondo.height = cv.height;
    var x = fondo.getContext('2d');
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    // OLED: negro puro (#000 = píxel apagado). Solo un halo muy tenue en el centro.
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    var gr = x.createRadialGradient(CX, CY, 0, CX, CY, R * 0.6);
    gr.addColorStop(0, 'rgba(20,90,90,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(CX, CY, R * 0.6, 0, TAU); x.fill();

    x.lineWidth = 1; x.strokeStyle = 'rgba(120,230,215,.32)';
    for (var k = 1; k <= 3; k++) { x.beginPath(); x.arc(CX, CY, R * k / 4, 0, TAU); x.stroke(); }
    x.beginPath(); x.moveTo(CX - R, CY); x.lineTo(CX + R, CY); x.moveTo(CX, CY - R); x.lineTo(CX, CY + R); x.stroke();
    x.strokeStyle = 'rgba(120,230,215,.6)';
    for (var t = 0; t < 360; t += 10) {
      var l = t % 30 === 0 ? 9 : 5;
      x.beginPath();
      x.moveTo(CX + (R - l) * Math.cos(rad(t)), CY + (R - l) * Math.sin(rad(t)));
      x.lineTo(CX + R * Math.cos(rad(t)), CY + R * Math.sin(rad(t)));
      x.stroke();
    }

    x.font = '12px Roboto, sans-serif'; x.fillStyle = 'rgba(170,235,225,.75)';
    x.textAlign = 'left'; x.textBaseline = 'middle';
    for (k = 1; k <= 4; k++) {
      var v = cfg.km * k / 4;
      x.fillText((v % 1 ? v.toFixed(1) : v) + ' km', CX + R * k / 4 * Math.cos(rad(160)) + 4, CY + R * k / 4 * Math.sin(rad(160)));
    }

    dibujarMapa(x);
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(CX, CY, 3, 0, TAU); x.fill();
  }

  // Contornos del mapa: todo recortado al círculo y dibujado una sola vez en la capa de fondo
  function dibujarMapa(x) {
    function px(lat, lon) { var p = aXY(lat, lon); return [CX + p.x * ESCALA, CY - p.y * ESCALA]; }
    function lineas(capa, color, ancho, guiones) {
      x.strokeStyle = color; x.lineWidth = ancho; x.setLineDash(guiones || []);
      GEO[capa].forEach(function (l) {
        x.beginPath();
        for (var i = 0; i < l.length; i += 2) {
          var p = px(l[i], l[i + 1]);
          if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]);
        }
        x.stroke();
      });
    }
    function dentro(lat, lon, margen) {
      var p = aXY(lat, lon);
      return p.x * p.x + p.y * p.y <= Math.pow(cfg.km * (margen || 0.97), 2);
    }
    x.save();
    x.beginPath(); x.arc(CX, CY, R, 0, TAU); x.clip();
    x.lineJoin = 'round';
    lineas('p', 'rgba(140,175,180,.28)', 1, [3, 4]);          // provincias / partidos / estados
    lineas('r', 'rgba(70,130,200,.45)', 1);                    // ríos
    lineas('f', 'rgba(215,180,120,.55)', 1.3, [7, 4]);         // límites de países
    lineas('c', 'rgba(80,155,215,.65)', 1.3);                  // costa
    x.setLineDash([]);

    // Pistas con su ancho real (mínimo 2 px para que se vean)
    x.strokeStyle = 'rgba(255,150,210,.75)'; x.lineCap = 'round';
    GEO.pi.forEach(function (p) {
      if (!dentro(p[0], p[1], 1.02)) return;
      var a = px(p[0], p[1]), b = px(p[2], p[3]);
      x.lineWidth = Math.max(2, (p[4] || 45) / 1000 * ESCALA);
      x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke();
    });
    x.restore();

    // Ciudades: más o menos según el alcance
    var minPob = cfg.km <= 25 ? 0 : cfg.km <= 50 ? 100000 : cfg.km <= 100 ? 300000 : 1000000;
    x.font = 'italic 11px Roboto, sans-serif'; x.textBaseline = 'middle'; x.textAlign = 'left';
    GEO.ci.forEach(function (c) {
      if (c[3] < minPob || !dentro(c[1], c[2], 0.9)) return;
      var p = px(c[1], c[2]);
      if (Math.abs(p[0] - CX) < 18 && Math.abs(p[1] - CY) < 18) return; // no tapar el centro
      x.fillStyle = 'rgba(160,175,180,.6)';
      x.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
      x.fillText(c[0], p[0] + 5, p[1]);
    });

    // Aeropuertos: grandes siempre; medianos y chicos al acercarse
    var maxNivel = cfg.km <= 50 ? 2 : cfg.km <= 100 ? 1 : 0;
    x.font = '11px Roboto, sans-serif';
    GEO.a.forEach(function (a) {
      if (a[3] > maxNivel || !dentro(a[1], a[2])) return;
      var p = px(a[1], a[2]);
      x.fillStyle = 'rgba(255,160,215,.9)';
      x.fillText(a[0], p[0] + 9, p[1] - 8);
    });
  }

  // Baja los mosaicos que cubren 220 km alrededor del centro y rearma el fondo
  function cargarMapa() {
    var dLat = 220 / KM_LAT, dLon = 220 / Math.max(10, kmLon(cfg.lat));
    var i0 = Math.floor((Math.max(-89.9, cfg.lat - dLat) + 90) / MOSAICO), i1 = Math.floor((Math.min(89.9, cfg.lat + dLat) + 90) / MOSAICO);
    var j0 = Math.floor((cfg.lon - dLon + 180) / MOSAICO), j1 = Math.floor((cfg.lon + dLon + 180) / MOSAICO);
    var claves = [], n = 360 / MOSAICO;
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) claves.push(i + '_' + (((j % n) + n) % n));
    var origen = cfg.lat + ',' + cfg.lon;
    Promise.all(claves.map(function (k) {
      if (mosaicos[k]) return mosaicos[k];
      return fetch('/mapa/' + k + '.json')
        .then(function (r) { return r.ok ? r.json() : {}; }) // 404 = mar abierto, sin datos
        .catch(function () { return null; })                  // error de red: se reintenta después
        .then(function (d) { if (d) mosaicos[k] = d; return d || {}; });
    })).then(function (lista) {
      if (origen !== cfg.lat + ',' + cfg.lon) return; // la ubicación cambió mientras bajaba
      var g = { c: [], f: [], p: [], r: [], ci: [], a: [], pi: [] };
      lista.forEach(function (d) { for (var k in g) if (d[k]) g[k] = g[k].concat(d[k]); });
      GEO = g;
      construirFondo();
    });
  }

  // El borde y los puntos cardinales van ENCIMA del barrido, en otra capa
  var borde = document.getElementById('capa-borde');
  function construirBorde() {
    borde.width = cv.width; borde.height = cv.height;
    var x = borde.getContext('2d');
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    x.strokeStyle = 'rgba(120,235,220,.95)'; x.lineWidth = 2;
    x.beginPath(); x.arc(CX, CY, R, 0, TAU); x.stroke();
    x.font = 'bold 16px Roboto, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['O', 270]].forEach(function (c) {
      var dc = REDONDO ? R - 16 : R + 12; // en pantalla redonda van del lado de adentro
      var px = CX + dc * Math.cos(rad(c[1])), py = CY + dc * Math.sin(rad(c[1]));
      x.fillStyle = '#000'; x.beginPath(); x.arc(px, py, 11, 0, TAU); x.fill();
      x.fillStyle = '#d8fff8'; x.fillText(c[0], px, py + 1);
    });
  }

  function construirBarrido() {
    if (!R || R < 20) return;
    var tam = Math.ceil(R * 2 + 4);
    barrido.width = Math.ceil(tam * DPR); barrido.height = barrido.width;
    var x = barrido.getContext('2d');
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    var c = tam / 2, N = 18, paso = 2.5;
    for (var i = 0; i < N; i++) {
      x.beginPath(); x.moveTo(c, c);
      x.arc(c, c, R, rad(-(i + 1) * paso), rad(-i * paso));
      x.closePath();
      x.fillStyle = 'rgba(60,255,205,' + (0.30 * (1 - i / N)).toFixed(3) + ')';
      x.fill();
    }
    x.strokeStyle = 'rgba(140,255,225,.8)'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(c, c); x.lineTo(c, c - R); x.stroke();
    barrido.style.width = tam + 'px'; barrido.style.height = tam + 'px';
    barrido.style.left = (CX - tam / 2) + 'px'; barrido.style.top = (CY - tam / 2) + 'px';
    if (!animBarrido && barrido.animate) {
      animBarrido = barrido.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: VUELTA_BARRIDO_MS, iterations: Infinity, easing: 'linear' });
    }
    construirBorde();
  }

  function spriteAvion(col, esc) {
    var k = col + esc;
    if (sprites[k]) return sprites[k];
    var l = lienzo(32, 32), x = l.x;
    x.translate(16, 16); x.scale(esc, esc);
    x.beginPath();
    x.moveTo(0, -10); x.lineTo(1.6, -6); x.lineTo(1.6, -2); x.lineTo(9, 3); x.lineTo(9, 5);
    x.lineTo(1.6, 2.5); x.lineTo(1.2, 7); x.lineTo(4, 9); x.lineTo(4, 10.5); x.lineTo(0, 9.5);
    x.lineTo(-4, 10.5); x.lineTo(-4, 9); x.lineTo(-1.2, 7); x.lineTo(-1.6, 2.5); x.lineTo(-9, 5);
    x.lineTo(-9, 3); x.lineTo(-1.6, -2); x.lineTo(-1.6, -6);
    x.closePath(); x.fillStyle = col; x.fill();
    return (sprites[k] = l.c);
  }

  function etiqueta(a, sel) {
    var d = a.d, col = colorAlt(d);
    var t1 = nombre(d), t2 = altTexto(d);
    var clave = t1 + '|' + t2 + '|' + col + '|' + sel + '|' + DPR;
    if (a.etqClave === clave) return a.etq;
    var l = lienzo(120, 32), x = l.x;
    x.textBaseline = 'middle';
    x.font = (sel ? 'bold 14px' : 'bold 12px') + ' Roboto, sans-serif';
    x.fillStyle = sel ? '#ffd54a' : '#e8fffb'; x.fillText(t1, 0, 9);
    x.font = '11px Roboto, sans-serif'; x.fillStyle = col; x.fillText(t2, 0, 23);
    a.etqClave = clave;
    return (a.etq = l.c);
  }

  // Lista plana de aviones (evita crear arrays en cada cuadro)
  var lista = [];
  function rehacerLista() {
    lista = Object.keys(aviones).map(function (h) { return aviones[h]; });
  }

  // Estelas: son posiciones pasadas, no se mueven. Se dibujan en su propia capa
  // solo cuando llegan datos o cambia el alcance, nunca en cada cuadro.
  var capaEstelas = document.getElementById('capa-estelas');
  function calcularEstelas() {
    if (!ESCALA) return;
    capaEstelas.width = cv.width; capaEstelas.height = cv.height;
    var x = capaEstelas.getContext('2d');
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    x.fillStyle = '#a0f0e6';
    for (var i = 0; i < lista.length; i++) {
      var a = lista[i], n = a.estela.length;
      if (!pasaFiltros(a.d) && a.d.hex !== seleccion) continue;
      for (var j = 0; j < n; j++) {
        var xy = aXY(a.estela[j].lat, a.estela[j].lon);
        if (xy.x * xy.x + xy.y * xy.y > cfg.km * cfg.km) continue;
        x.globalAlpha = 0.08 + 0.35 * (j + 1) / n;
        x.fillRect(CX + xy.x * ESCALA - 1, CY - xy.y * ESCALA - 1, 2, 2);
      }
    }
    dibujarRecorrido(x);
  }

  // ---------------- Vuelo del avión seleccionado ----------------
  // Rumbo y distancia por círculo máximo (sirven para destinos a miles de km)
  function rumboGC(la1, lo1, la2, lo2) {
    var r = Math.PI / 180, f1 = la1 * r, f2 = la2 * r, dl = (lo2 - lo1) * r;
    var y = Math.sin(dl) * Math.cos(f2), xx = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, xx) / r + 360) % 360;
  }
  function distGC(la1, lo1, la2, lo2) {
    var r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2), b = Math.sin((lo2 - lo1) * r / 2);
    var h = a * a + Math.cos(la1 * r) * Math.cos(la2 * r) * b * b;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Punto final de una línea que sale de (px,py) hacia un aeropuerto: el aeropuerto si entra
  // en el radar; si no, el borde del círculo en la dirección correcta.
  function haciaAeropuerto(px, py, lat, lon, latAp, lonAp) {
    var dist = distGC(lat, lon, latAp, lonAp);
    var ap = aXY(latAp, lonAp);
    if (ap.x * ap.x + ap.y * ap.y <= cfg.km * cfg.km) return { x: CX + ap.x * ESCALA, y: CY - ap.y * ESCALA, dist: dist, dentro: true };
    var b = rumboGC(lat, lon, latAp, lonAp) * Math.PI / 180, dx = Math.sin(b), dy = -Math.cos(b);
    var ox = px - CX, oy = py - CY;
    var B = 2 * (ox * dx + oy * dy), C = ox * ox + oy * oy - R * R;
    var t = (-B + Math.sqrt(Math.max(0, B * B - 4 * C))) / 2;
    return { x: px + dx * t, y: py + dy * t, dist: dist, dentro: false };
  }
  // Se dibuja en la capa de estelas: solo se rehace al llegar datos o cambiar la selección
  function dibujarRecorrido(x) {
    var a = seleccion && aviones[seleccion];
    if (!a || !a.hist || !a.hist.length) return;
    x.save();
    x.beginPath(); x.arc(CX, CY, R, 0, TAU); x.clip();
    x.lineCap = 'round'; x.lineJoin = 'round';
    var r = a.d.cs && rutas[a.d.cs], h = a.hist;
    // Desde el origen hasta el primer punto visto (punteada y tenue)
    if (r && r.olat != null) {
      var p0 = aXY(h[0].lat, h[0].lon), x0 = CX + p0.x * ESCALA, y0 = CY - p0.y * ESCALA;
      var o = haciaAeropuerto(x0, y0, h[0].lat, h[0].lon, r.olat, r.olon);
      x.globalAlpha = 0.45; x.strokeStyle = '#c9a227'; x.lineWidth = 1.5; x.setLineDash([2, 6]);
      x.beginPath(); x.moveTo(o.x, o.y); x.lineTo(x0, y0); x.stroke();
      x.setLineDash([]);
    }
    // Recorrido real, coloreado por altitud
    x.globalAlpha = 0.9; x.lineWidth = 2.5;
    for (var i = 1; i < h.length; i++) {
      var p1 = aXY(h[i - 1].lat, h[i - 1].lon), p2 = aXY(h[i].lat, h[i].lon);
      x.strokeStyle = colorAlt({ alt: h[i].alt, gnd: h[i].gnd, sq: '' });
      x.beginPath(); x.moveTo(CX + p1.x * ESCALA, CY - p1.y * ESCALA); x.lineTo(CX + p2.x * ESCALA, CY - p2.y * ESCALA); x.stroke();
    }
    x.restore();
  }
  // Etiqueta del destino ("AEP · 312 km"), pre-renderizada y reusada mientras no cambie
  var etqDestino = { clave: '', c: null };
  function etiquetaDestino(texto) {
    if (etqDestino.clave === texto + DPR) return etqDestino.c;
    var l = lienzo(140, 22), x = l.x;
    x.font = 'bold 12px Roboto, sans-serif'; x.textBaseline = 'middle';
    var w = x.measureText(texto).width + 12;
    x.fillStyle = 'rgba(0,0,0,.85)'; x.strokeStyle = '#ffd54a'; x.lineWidth = 1;
    x.fillRect(0.5, 0.5, w, 20); x.strokeRect(0.5, 0.5, w, 20);
    x.fillStyle = '#ffd54a'; x.fillText(texto, 6, 11);
    etqDestino = { clave: texto + DPR, c: l.c, w: w };
    return l.c;
  }

  function calcularPosiciones(ahora) {
    if (!ESCALA) return;
    for (var i = 0; i < lista.length; i++) {
      var a = lista[i];
      var p = posActual(a, ahora);
      var xy = aXY(p.lat, p.lon);
      a.dist = Math.sqrt(xy.x * xy.x + xy.y * xy.y);
      a.rumboDesde = (Math.atan2(xy.x, xy.y) * 180 / Math.PI + 360) % 360;
      a.px = CX + xy.x * ESCALA;
      a.py = CY - xy.y * ESCALA;
      a.dentro = a.dist <= cfg.km;
      a.mostrar = a.dentro && (pasaFiltros(a.d) || a.d.hex === seleccion); // el seguido ignora los filtros
    }
  }

  function anguloBarrido(ahora) {
    var t = animBarrido && animBarrido.currentTime != null ? animBarrido.currentTime : ahora;
    return (t % VUELTA_BARRIDO_MS) / VUELTA_BARRIDO_MS * 360;
  }

  function dibujar(ahora) {
    if (!ESCALA) return;
    var D = DPR;
    // Esta capa solo tiene aviones y estelas: limpiar y redibujar es barato
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    var ang = anguloBarrido(ahora);

    calcularPosiciones(ahora);
    var viejo = estado === 'error' && ahora - ultimaOK > 60000;
    var visibles = 0, i, a;
    for (i = 0; i < lista.length; i++) if (lista[i].mostrar) visibles++;
    var conEtiqueta = visibles <= 30 && !nocheActiva;

    ctx.setTransform(D, 0, 0, D, 0, 0);

    // Aviones y etiquetas
    var sel = null;
    for (i = 0; i < lista.length; i++) {
      a = lista[i];
      if (!a.mostrar) continue;
      if (a.d.hex === seleccion) { sel = a; continue; } // el seleccionado va al final, arriba de todo
      pintarAvion(a, false, ang, viejo, conEtiqueta, D);
    }
    // Anillo pulsante en aviones con alerta (son pocos: un arco por avión)
    var pulso = (ahora % 1500) / 1500;
    for (i = 0; i < lista.length; i++) {
      a = lista[i];
      if (!a.mostrar || !alertados[a.d.hex]) continue;
      ctx.setTransform(D, 0, 0, D, 0, 0);
      ctx.globalAlpha = 1 - pulso;
      ctx.strokeStyle = alertados[a.d.hex] === 'emerg' ? '#ff4d4d' : '#ffd54a';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(a.px, a.py, 12 + pulso * 16, 0, TAU); ctx.stroke();
    }
    if (sel) {
      var d = sel.d;
      ctx.setTransform(D, 0, 0, D, 0, 0);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 2;
      ctx.beginPath();
      if (d.gs && d.trk != null && !d.gnd) {
        var km2 = d.gs * 1.852 * 2 / 60, tr = d.trk * Math.PI / 180;
        ctx.moveTo(sel.px, sel.py);
        ctx.lineTo(sel.px + Math.sin(tr) * km2 * ESCALA, sel.py - Math.cos(tr) * km2 * ESCALA);
      }
      ctx.moveTo(sel.px + 17, sel.py);
      ctx.arc(sel.px, sel.py, 17, 0, TAU);
      ctx.stroke();
      // Línea punteada hacia el destino, con la distancia que le falta
      var rt = d.cs && rutas[d.cs];
      if (rt && rt.dlat != null && !d.gnd) {
        var pa = posActual(sel, ahora);
        var dst = haciaAeropuerto(sel.px, sel.py, pa.lat, pa.lon, rt.dlat, rt.dlon);
        if (dst.dist > 2) {
          ctx.globalAlpha = 0.75; ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]);
          ctx.beginPath(); ctx.moveTo(sel.px, sel.py); ctx.lineTo(dst.x, dst.y); ctx.stroke();
          ctx.setLineDash([]);
          var et = etiquetaDestino(rt.d + ' · ' + miles(dst.dist) + ' km');
          // la etiqueta queda adentro del círculo, cerca del extremo de la línea
          var ex = Math.min(Math.max(dst.x - (etqDestino.w || 80) / 2, CX - R + 6), CX + R - (etqDestino.w || 80) - 6);
          var ey = Math.min(Math.max(dst.y - (dst.dentro ? 28 : 11), 8), H - 30);
          ctx.globalAlpha = 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(et, Math.round(ex * D), Math.round(ey * D));
          ctx.setTransform(D, 0, 0, D, 0, 0);
        }
      }
      pintarAvion(sel, true, ang, viejo, true, D);
    } else if (perdido && perdido.d.hex === seleccion) {
      // Última posición conocida del avión que se perdió: círculo punteado gris
      var pp = aXY(perdido.lat, perdido.lon);
      if (pp.x * pp.x + pp.y * pp.y <= cfg.km * cfg.km) {
        ctx.setTransform(D, 0, 0, D, 0, 0);
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#9aa7a7'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(CX + pp.x * ESCALA, CY - pp.y * ESCALA, 14, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
  }

  function pintarAvion(a, sel, ang, viejo, conEtiqueta, D) {
    var d = a.d;
    var delta = ((ang - a.rumboDesde) % 360 + 360) % 360;
    var sinSenal = (Date.now() - a.t0) / 1000 > SIN_SENAL_S;
    ctx.globalAlpha = sel ? (sinSenal ? 0.45 : 1) : (viejo ? 0.35 : 0.6 + 0.4 * (1 - delta / 360));
    var spr = spriteAvion(sel ? '#ffd54a' : colorAlt(d), sel ? 1.25 : 1);
    var r = (d.trk || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    ctx.setTransform(D * co, D * si, -D * si, D * co, a.px * D, a.py * D);
    ctx.drawImage(spr, -16, -16, 32, 32);
    if (conEtiqueta || sel) {
      var et = etiqueta(a, sel);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(et, Math.round((a.px + 13) * D), Math.round((a.py - 15) * D));
    }
  }

  // ?fps muestra cuadros por segundo y cuánto tarda cada cuadro en dibujarse
  var fpsCuadros = 0, fpsDesde = 0, fpsMs = 0, fpsVer = params.has('fps');
  function cuadro(t) {
    requestAnimationFrame(cuadro);
    var t0 = fpsVer ? performance.now() : 0;
    dibujar(Date.now());
    if (fpsVer) {
      fpsMs += performance.now() - t0;
      fpsCuadros++;
      if (t - fpsDesde >= 1000) {
        $('fuente').textContent = fpsCuadros + ' fps · ' + (fpsMs / fpsCuadros).toFixed(1) + ' ms/cuadro';
        fpsCuadros = 0; fpsMs = 0; fpsDesde = t;
      }
    }
  }

  // ---------------- Panel ----------------
  var $ = function (id) { return document.getElementById(id); };

  function actualizarEstado() {
    var p = $('pill');
    var textos = { live: 'Live', demo: 'Demo', error: 'Sin datos', cargando: 'Conectando' };
    p.className = 'pill ' + estado;
    p.textContent = textos[estado] || estado;
    $('fuente').textContent = DEMO ? 'datos simulados' : (fuente ? 'vía ' + fuente : '');
    var re = $('r-estado');
    re.className = p.className;
    re.textContent = p.textContent;
  }

  function renderRangos() {
    $('r-rango').textContent = cfg.km + ' KM';
    $('rangos').innerHTML = RANGOS.map(function (r) {
      return '<button data-km="' + r + '"' + (r === cfg.km ? ' class="activo"' : '') + '>' + r + ' km</button>';
    }).join('');
  }

  // ---------------- Seguimiento ----------------
  function distKm(lat1, lon1, lat2, lon2) {
    var dx = (lon2 - lon1) * kmLon((lat1 + lat2) / 2), dy = (lat2 - lat1) * KM_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function aeropuertoCercano(lat, lon) {
    var mejor = '', mejorD = 6; // a menos de 6 km
    GEO.a.forEach(function (a) { var d = distKm(lat, lon, a[1], a[2]); if (d < mejorD) { mejorD = d; mejor = a[0]; } });
    return mejor;
  }
  function lugarCercano(lat, lon) {
    var mejor = null, mejorD = 40;
    GEO.ci.forEach(function (c) { var d = distKm(lat, lon, c[1], c[2]); if (d < mejorD) { mejorD = d; mejor = c[0]; } });
    var ap = aeropuertoCercano(lat, lon);
    return ap ? 'cerca de ' + ap : mejor ? 'cerca de ' + mejor : 'a ' + distKm(cfg.lat, cfg.lon, lat, lon).toFixed(0) + ' km de vos';
  }
  function horaCorta(ms) {
    var f = new Date(ms);
    return ('0' + f.getHours()).slice(-2) + ':' + ('0' + f.getMinutes()).slice(-2);
  }
  // Una línea de estado para el avión seguido: { texto, clase, ampliar (km) }
  function estadoSeguimiento(a, ahora) {
    var d = a.d, edad = (ahora - a.t0) / 1000;
    if (edad > SIN_SENAL_S) return { texto: 'Sin señal hace ' + Math.round(edad) + ' s · posición estimada', clase: 'aviso' };
    if (!a.dentro) {
      var siguiente = RANGOS.filter(function (r) { return r >= a.dist * 1.05; })[0];
      return { texto: 'Fuera del radar · a ' + a.dist.toFixed(0) + ' km', clase: 'aviso', ampliar: siguiente };
    }
    if (d.gnd) {
      if (a.aterrizo && ahora - a.aterrizo.hora < 15 * 60000)
        return { texto: '🛬 Aterrizó' + (a.aterrizo.ap ? ' en ' + a.aterrizo.ap : '') + ' a las ' + horaCorta(a.aterrizo.hora), clase: 'ok' };
      var ap = aeropuertoCercano(d.lat, d.lon);
      return { texto: 'En tierra' + (ap ? ' en ' + ap : ''), clase: 'ok' };
    }
    if (a.despego && ahora - a.despego.hora < 10 * 60000)
      return { texto: '🛫 Despegó' + (a.despego.ap ? ' de ' + a.despego.ap : '') + ' a las ' + horaCorta(a.despego.hora), clase: 'ok' };
    return null;
  }
  function htmlEstado(e) {
    if (!e) return '';
    return '<div class="estado-seg ' + e.clase + '">' + esc(e.texto) +
      (e.ampliar ? ' <button class="ampliar" data-km="' + e.ampliar + '">Ampliar a ' + e.ampliar + ' km</button>' : '') + '</div>';
  }
  function cambiarAlcance(km) {
    cfg.km = km;
    guardar();
    renderRangos();
    construirFondo();
    calcularPosiciones(Date.now());
    calcularEstelas();
    renderPanel();
    pedir();
  }

  function renderPanel() {
    var enRadio = lista.filter(function (a) { return a.mostrar; })
      .sort(function (a, b) { return a.dist - b.dist; });

    poner('contador', 'textContent', String(enRadio.length));
    poner('lista', 'innerHTML', enRadio.length ? enRadio.slice(0, 30).map(function (a) {
      var d = a.d;
      return '<li data-hex="' + esc(d.hex) + '"' + (d.hex === seleccion ? ' class="sel"' : '') + '>' +
        '<span class="izq"><span class="cs' + (esEmerg(d) ? ' emerg' : '') + '">' + esc(nombre(d)) + '</span>' +
        (rutaCorta(d) ? '<span class="ruta">' + esc(rutaCorta(d)) + '</span>' : '<span class="t">' + esc(d.tipo || '') + '</span>') + '</span>' +
        '<span class="num a">' + altTexto(d) + '</span>' +
        '<span class="num d">' + a.dist.toFixed(1) + ' km</span></li>';
    }).join('') : '<li class="vacio">' + (estado === 'cargando' ? 'Buscando aviones…' : 'No hay aviones en este radio') + '</li>');

    var a = seleccion && aviones[seleccion];
    var ahora = Date.now();
    renderDetalleRedondo(a, ahora);
    if (!a && perdido && perdido.d.hex === seleccion) {
      var pd = perdido.d;
      poner('detalle', 'className', 'detalle perdido');
      poner('detalle', 'innerHTML',
        '<button class="cerrar" title="Cerrar">✕</button>' +
        '<div class="cs">' + esc(nombre(pd)) + '</div>' +
        (rutaCorta(pd) ? '<div class="ruta">' + esc(rutaCorta(pd).replace('→', ' → ')) + '</div>' : '') +
        '<div class="estado-seg aviso">Señal perdida a las ' + horaCorta(perdido.hora) + ' ' + esc(lugarCercano(perdido.lat, perdido.lon)) + '</div>' +
        '<div class="tipo">Último dato: ' + altTexto(pd) + (pd.gs != null ? ' · ' + miles(pd.gs * 1.852) + ' km/h' : '') +
        '. Si vuelve a aparecer, se sigue solo.</div>');
      return;
    }
    if (!a) {
      poner('detalle', 'className', 'detalle vacio');
      poner('detalle', 'innerHTML', 'Tocá un avión para ver el detalle');
      return;
    }
    var est = estadoSeguimiento(a, ahora);
    var d = a.d;
    var tipo = d.desc ? d.desc + (d.tipo ? ' (' + d.tipo + ')' : '') : (d.tipo || 'Tipo desconocido');
    var r = d.cs && rutas[d.cs];
    var rutaHtml = r ? '<div class="ruta">' + esc(r.o) + (r.on ? ' <small>' + esc(r.on) + '</small>' : '') + ' → ' + esc(r.d) +
      (r.dn ? ' <small>' + esc(r.dn) + '</small>' : '') + (r.ok ? '' : ' <small>(sin confirmar)</small>') + '</div>' : '';
    var vr = d.vr == null || Math.abs(d.vr) < 100 ? 'Nivelado' : (d.vr > 0 ? '↑ ' : '↓ ') + miles(Math.abs(d.vr)) + ' ft/min';
    poner('detalle', 'className', 'detalle');
    poner('detalle', 'innerHTML',
      '<button class="cerrar" title="Dejar de seguir">✕</button>' +
      '<div class="cs' + (esEmerg(d) ? ' emerg' : '') + '">' + esc(nombre(d)) + '</div>' +
      rutaHtml + htmlEstado(est) +
      '<div class="tipo">' + esc(tipo) + '</div>' +
      '<div class="grid">' +
      '<span>Altitud <b>' + altTexto(d) + '</b></span>' +
      '<span>' + (d.alt != null && !d.gnd ? '<b>' + miles(d.alt) + ' ft</b>' : '') + '</span>' +
      '<span>Vel. <b>' + (d.gs != null ? miles(d.gs * 1.852) + ' km/h' : '—') + '</b></span>' +
      '<span>Rumbo <b>' + (d.trk != null ? Math.round(d.trk) + '° ' + cardinal(d.trk) : '—') + '</b></span>' +
      '<span>Dist. <b>' + a.dist.toFixed(1) + ' km ' + cardinal(a.rumboDesde) + '</b></span>' +
      '<span><b>' + vr + '</b></span>' +
      '<span>Matr. <b>' + esc(d.reg || '—') + '</b></span>' +
      '<span>Squawk <b' + (esEmerg(d) ? ' class="emerg"' : '') + '>' + esc(d.sq || '—') + '</b></span>' +
      '</div>');
  }

  // Tarjeta compacta para pantalla redonda (como los radares de escritorio)
  function renderDetalleRedondo(a, ahora) {
    if (!REDONDO) return;
    if (!a && perdido && perdido.d.hex === seleccion) {
      poner('r-detalle', 'className', 'r-detalle perdido');
      poner('r-detalle', 'innerHTML', '<b>' + esc(nombre(perdido.d)) + '</b><br>Señal perdida ' + horaCorta(perdido.hora) + '<br>' +
        esc(lugarCercano(perdido.lat, perdido.lon)));
      return;
    }
    if (!a) { poner('r-detalle', 'className', 'r-detalle oculto'); return; }
    var d = a.d;
    var ruta = rutaCorta(d);
    var est = estadoSeguimiento(a, ahora);
    poner('r-detalle', 'className', 'r-detalle');
    poner('r-detalle', 'innerHTML',
      '<b>' + esc(nombre(d)) + '</b>' + (ruta ? ' <span class="ruta">' + esc(ruta) + '</span>' : '') + '<br>' +
      (est ? '<span class="estado-seg ' + est.clase + '">' + esc(est.texto) + '</span><br>' : '') +
      esc(d.desc || d.tipo || '') + '<br>' +
      altTexto(d) + (d.trk != null ? ' · RUMBO ' + Math.round(d.trk) + '°' : '') + '<br>' +
      (d.gs != null ? miles(d.gs * 1.852) + ' km/h · ' : '') + a.dist.toFixed(1) + ' km');
  }

  // Solo escribe en el DOM si el valor cambió (evita relayouts que cortan la animación)
  var cacheDom = {};
  function poner(id, prop, valor) {
    var k = id + '.' + prop;
    if (cacheDom[k] === valor) return;
    cacheDom[k] = valor;
    $(id)[prop] = valor;
  }

  function reloj() {
    var f = new Date();
    var hm = ('0' + f.getHours()).slice(-2) + ':' + ('0' + f.getMinutes()).slice(-2);
    poner('reloj', 'textContent', hm);
    poner('r-reloj', 'textContent', hm);
  }

  // ---------------- Interacción ----------------
  cv.addEventListener('click', function (e) {
    var r = cv.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    var mejor = null, mejorD = 40;
    lista.forEach(function (a) {
      if (!a.mostrar) return;
      var dd = Math.sqrt((a.px - x) * (a.px - x) + (a.py - y) * (a.py - y));
      if (dd < mejorD) { mejorD = dd; mejor = a.d.hex; }
    });
    seleccionar(mejor);
  });

  function seleccionar(hex) {
    seleccion = hex;
    perdido = null;
    calcularEstelas(); // dibuja (o borra) el recorrido del seleccionado
    renderPanel();
  }

  $('detalle').addEventListener('click', function (e) {
    if (e.target.closest('.cerrar')) { seleccionar(null); return; }
    var b = e.target.closest('button.ampliar');
    if (b) cambiarAlcance(Number(b.getAttribute('data-km')));
  });

  $('lista').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-hex]');
    if (!li) return;
    var h = li.getAttribute('data-hex');
    seleccionar(seleccion === h ? null : h);
  });

  $('rangos').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-km]');
    if (!b) return;
    cambiarAlcance(Number(b.getAttribute('data-km')));
  });

  function ubicar() {
    if (!navigator.geolocation) return;
    $('pill').textContent = 'Ubicando…';
    navigator.geolocation.getCurrentPosition(function (p) {
      cfg.lat = p.coords.latitude;
      cfg.lon = p.coords.longitude;
      guardar();
      aviones = {};
      lista = [];
      seleccion = null;
      construirFondo();
      cargarMapa();
      if (DEMO) demoTick(); else pedir();
      actualizarEstado();
    }, function () {
      $('pill').textContent = 'Sin ubicación';
      setTimeout(actualizarEstado, 2500);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  $('btn-ubic').addEventListener('click', ubicar);

  $('btn-full').addEventListener('click', function () {
    var el = document.documentElement;
    if (!document.fullscreenElement) {
      var f = el.requestFullscreen || el.webkitRequestFullscreen;
      if (f) f.call(el);
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
    mantenerDespierta();
  });

  // Mantener la pantalla prendida (necesita HTTPS: funciona en Vercel)
  var wakeLock = null;
  function mantenerDespierta() {
    if (wakeLock || !('wakeLock' in navigator) || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (w) {
      wakeLock = w;
      w.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener('click', function () { mantenerDespierta(); desbloquearAudio(); });

  // ---------------- Panel de ajustes ----------------
  function abrirAjustes() {
    $('aj-tierra').checked = !!ajustes.ocultarTierra;
    $('aj-alt').value = String(ajustes.altMax);
    $('aj-noche').value = ajustes.noche;
    $('aj-desde').value = ajustes.nocheDesde;
    $('aj-hasta').value = ajustes.nocheHasta;
    $('aj-sonido').checked = !!ajustes.sonido;
    $('aj-vigilar').value = ajustes.vigilar;
    $('ajustes').className = 'ajustes';
  }
  function leerAjustes() {
    ajustes.ocultarTierra = $('aj-tierra').checked;
    ajustes.altMax = Number($('aj-alt').value) || 0;
    ajustes.noche = $('aj-noche').value;
    ajustes.nocheDesde = Math.min(23, Math.max(0, parseInt($('aj-desde').value, 10) || 0));
    ajustes.nocheHasta = Math.min(23, Math.max(0, parseInt($('aj-hasta').value, 10) || 0));
    ajustes.sonido = $('aj-sonido').checked;
    ajustes.vigilar = $('aj-vigilar').value;
    guardarAjustes();
    calcularPosiciones(Date.now());
    calcularEstelas();
    aplicarNoche();
    renderPanel();
  }
  $('btn-aj').addEventListener('click', abrirAjustes);
  $('r-aj').addEventListener('click', abrirAjustes);
  // En pantalla redonda, tocar el alcance pasa al siguiente
  $('r-rango').addEventListener('click', function () {
    cambiarAlcance(RANGOS[(RANGOS.indexOf(cfg.km) + 1) % RANGOS.length]);
  });
  $('ajustes').addEventListener('change', leerAjustes);
  $('aj-cerrar').addEventListener('click', function () {
    leerAjustes();
    $('ajustes').className = 'ajustes oculto';
    revisarAlertas();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { mantenerDespierta(); pedir(); }
  });

  var tResize;
  window.addEventListener('resize', function () {
    clearTimeout(tResize);
    tResize = setTimeout(function () { redimensionar(); calcularPosiciones(Date.now()); calcularEstelas(); }, 150);
  });

  // ---------------- Actualización automática ----------------
  // La tablet queda abierta días: cada 5 minutos se fija si hay una versión nueva publicada
  // y, si la hay, recarga la página (los ajustes quedan guardados en la tablet).
  var versionInicial = null;
  function revisarVersion() {
    if (document.hidden) return;
    fetch('/api/version', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.v || j.v === 'local') return;
        if (versionInicial === null) { versionInicial = j.v; return; }
        if (j.v !== versionInicial && $('ajustes').className.indexOf('oculto') >= 0) location.reload();
      })
      .catch(function () {});
  }

  // ---------------- Arranque ----------------
  redimensionar();
  cargarMapa();
  revisarVersion();
  setInterval(revisarVersion, 5 * 60000);
  // Primera vez sin ubicación guardada ni en la URL: la pide al dispositivo (si no, queda el Obelisco)
  if (!params.has('lat') && g.lat == null) {
    var yaPedida = false;
    try { yaPedida = localStorage.getItem('radar-ubic-pedida') === '1'; localStorage.setItem('radar-ubic-pedida', '1'); } catch (e) {}
    if (!yaPedida) setTimeout(ubicar, 800);
  }
  renderRangos();
  actualizarEstado();
  reloj();
  setInterval(reloj, 1000);
  aplicarNoche();
  setInterval(aplicarNoche, 60000);
  setInterval(function () { calcularPosiciones(Date.now()); renderPanel(); }, 3000);
  if (DEMO) {
    demoTick();
    setInterval(demoTick, INTERVALO_MS);
  } else {
    cicloPedidos();
  }
  // Anti quemado OLED: corre toda la interfaz unos píxeles cada 2 minutos,
  // así los elementos fijos (anillos, reloj, bordes) no marcan la pantalla.
  var DESPLAZAMIENTOS = [[0, 0], [2, 1], [1, -2], [-2, -1], [-1, 2], [2, -2], [-2, 2]];
  var paso = 0;
  setInterval(function () {
    paso = (paso + 1) % DESPLAZAMIENTOS.length;
    var dx = DESPLAZAMIENTOS[paso][0], dy = DESPLAZAMIENTOS[paso][1];
    document.getElementById('app').style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }, 120000);

  mantenerDespierta();
  requestAnimationFrame(cuadro);
})();
