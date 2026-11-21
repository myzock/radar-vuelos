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
  var HITOS = [
    { id: 'AEP', icao: 'SABE', lat: -34.5592, lon: -58.4156 },
    { id: 'EZE', icao: 'SAEZ', lat: -34.8222, lon: -58.5358 },
    { id: 'FDO', icao: 'SADF', lat: -34.4532, lon: -58.5896 },
    { id: 'EPA', icao: 'SADP', lat: -34.6099, lon: -58.6126 },
    { id: 'MOR', icao: 'SADM', lat: -34.6763, lon: -58.6428 }
  ];
  var GEO = window.RADAR_GEO || { costa: [], pistas: [] };

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
  var seleccion = null;
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
        a = aviones[d.hex] = { estela: [] };
      } else if (a.d && (a.d.lat !== d.lat || a.d.lon !== d.lon)) {
        a.estela.push({ lat: a.d.lat, lon: a.d.lon });
        if (a.estela.length > 12) a.estela.shift();
      }
      a.d = d;
      a.t0 = ahora - (d.seen || 0) * 1000;
      a.visto = ahora;
    });
    Object.keys(aviones).forEach(function (h) {
      if (!vistos[h] && ahora - aviones[h].visto > 60000) delete aviones[h];
    });
    if (seleccion && !aviones[seleccion]) seleccion = null;
    rehacerLista();
    calcularPosiciones(ahora);
    calcularEstelas();
    revisarAlertas();
    pedirRutas();
    renderPanel();
  }

  // ---------------- Datos ----------------
  function pedir() {
    if (DEMO || pidiendo || document.hidden) return;
    pidiendo = true;
    var radio = Math.ceil(cfg.km * 1.15);
    var url = '/api/aviones?lat=' + cfg.lat.toFixed(3) + '&lon=' + cfg.lon.toFixed(3) + '&km=' + radio;
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 9000);
    fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        fuente = j.fuente || '';
        estado = 'live';
        ultimaOK = Date.now();
        integrar(j.aviones || [], Date.now());
      })
      .catch(function (e) {
        estado = 'error';
        console.warn('Radar: error al pedir datos', e);
      })
      .then(function () {
        clearTimeout(to);
        pidiendo = false;
        actualizarEstado();
      });
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
  function pedirRutas() {
    var faltan = [];
    for (var i = 0; i < lista.length && faltan.length < 40; i++) {
      var cs = lista[i].d.cs;
      if (cs && !(cs in rutas) && !rutasPedidas[cs]) faltan.push(cs);
    }
    if (!faltan.length) return;
    if (DEMO) {
      faltan.forEach(function (cs, i) { var r = DEMO_RUTAS[(cs.length + i) % DEMO_RUTAS.length]; rutas[cs] = { o: r[0], d: r[1], on: '', dn: '', ok: true }; });
      return;
    }
    faltan.forEach(function (cs) { rutasPedidas[cs] = true; });
    fetch('/api/rutas?cs=' + faltan.join(',') + '&lat=' + cfg.lat.toFixed(2) + '&lon=' + cfg.lon.toFixed(2))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var rr = j.rutas || {};
        for (var cs in rr) rutas[cs] = rr[cs];
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

    // Costa del Río de la Plata (recortada al círculo del radar)
    x.save();
    x.beginPath(); x.arc(CX, CY, R, 0, TAU); x.clip();
    x.strokeStyle = 'rgba(80,150,210,.55)'; x.lineWidth = 1.3; x.lineJoin = 'round';
    GEO.costa.forEach(function (l) {
      x.beginPath();
      for (var i = 0; i < l.length; i += 2) {
        var p = aXY(l[i], l[i + 1]);
        if (i) x.lineTo(CX + p.x * ESCALA, CY - p.y * ESCALA); else x.moveTo(CX + p.x * ESCALA, CY - p.y * ESCALA);
      }
      x.stroke();
    });
    // Pistas (ancho real de ~45 m, con un mínimo para que se vean)
    var conPistas = {};
    x.strokeStyle = 'rgba(255,150,210,.75)'; x.lineCap = 'round';
    x.lineWidth = Math.max(2, 0.045 * ESCALA);
    GEO.pistas.forEach(function (p) {
      var a = aXY(p[2], p[3]), b = aXY(p[4], p[5]);
      conPistas[p[0]] = true;
      x.beginPath(); x.moveTo(CX + a.x * ESCALA, CY - a.y * ESCALA); x.lineTo(CX + b.x * ESCALA, CY - b.y * ESCALA); x.stroke();
    });
    x.restore();

    x.font = '11px Roboto, sans-serif';
    HITOS.forEach(function (h) {
      var xy = aXY(h.lat, h.lon);
      if (Math.sqrt(xy.x * xy.x + xy.y * xy.y) > cfg.km) return;
      var hx = CX + xy.x * ESCALA, hy = CY - xy.y * ESCALA;
      if (!conPistas[h.icao]) { x.strokeStyle = 'rgba(255,120,200,.8)'; x.lineWidth = 1.5; x.strokeRect(hx - 4, hy - 4, 8, 8); }
      x.fillStyle = 'rgba(255,160,215,.85)'; x.fillText(h.id, hx + 9, hy - 8);
    });
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(CX, CY, 3, 0, TAU); x.fill();
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
      if (!pasaFiltros(a.d)) continue;
      for (var j = 0; j < n; j++) {
        var xy = aXY(a.estela[j].lat, a.estela[j].lon);
        if (xy.x * xy.x + xy.y * xy.y > cfg.km * cfg.km) continue;
        x.globalAlpha = 0.08 + 0.35 * (j + 1) / n;
        x.fillRect(CX + xy.x * ESCALA - 1, CY - xy.y * ESCALA - 1, 2, 2);
      }
    }
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
      a.mostrar = a.dentro && pasaFiltros(a.d);
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
      pintarAvion(sel, true, ang, viejo, true, D);
    }
    ctx.globalAlpha = 1;
  }

  function pintarAvion(a, sel, ang, viejo, conEtiqueta, D) {
    var d = a.d;
    var delta = ((ang - a.rumboDesde) % 360 + 360) % 360;
    ctx.globalAlpha = sel ? 1 : (viejo ? 0.35 : 0.6 + 0.4 * (1 - delta / 360));
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
    renderDetalleRedondo(a);
    if (!a) {
      poner('detalle', 'className', 'detalle vacio');
      poner('detalle', 'innerHTML', 'Tocá un avión para ver el detalle');
      return;
    }
    var d = a.d;
    var tipo = d.desc ? d.desc + (d.tipo ? ' (' + d.tipo + ')' : '') : (d.tipo || 'Tipo desconocido');
    var r = d.cs && rutas[d.cs];
    var rutaHtml = r ? '<div class="ruta">' + esc(r.o) + (r.on ? ' <small>' + esc(r.on) + '</small>' : '') + ' → ' + esc(r.d) +
      (r.dn ? ' <small>' + esc(r.dn) + '</small>' : '') + (r.ok ? '' : ' <small>(sin confirmar)</small>') + '</div>' : '';
    var vr = d.vr == null || Math.abs(d.vr) < 100 ? 'Nivelado' : (d.vr > 0 ? '↑ ' : '↓ ') + miles(Math.abs(d.vr)) + ' ft/min';
    poner('detalle', 'className', 'detalle');
    poner('detalle', 'innerHTML',
      '<div class="cs' + (esEmerg(d) ? ' emerg' : '') + '">' + esc(nombre(d)) + '</div>' +
      rutaHtml +
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
  function renderDetalleRedondo(a) {
    if (!REDONDO) return;
    if (!a) { poner('r-detalle', 'className', 'r-detalle oculto'); return; }
    var d = a.d;
    var ruta = rutaCorta(d);
    poner('r-detalle', 'className', 'r-detalle');
    poner('r-detalle', 'innerHTML',
      '<b>' + esc(nombre(d)) + '</b>' + (ruta ? ' <span class="ruta">' + esc(ruta) + '</span>' : '') + '<br>' +
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
    seleccion = mejor;
    renderPanel();
  });

  $('lista').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-hex]');
    if (!li) return;
    var h = li.getAttribute('data-hex');
    seleccion = seleccion === h ? null : h;
    renderPanel();
  });

  $('rangos').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-km]');
    if (!b) return;
    cfg.km = Number(b.getAttribute('data-km'));
    guardar();
    renderRangos();
    construirFondo();
    calcularPosiciones(Date.now());
    calcularEstelas();
    renderPanel();
    pedir();
  });

  $('btn-ubic').addEventListener('click', function () {
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
      if (DEMO) demoTick(); else pedir();
      actualizarEstado();
    }, function () {
      $('pill').textContent = 'Sin ubicación';
      setTimeout(actualizarEstado, 2500);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  });

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
    cfg.km = RANGOS[(RANGOS.indexOf(cfg.km) + 1) % RANGOS.length];
    guardar();
    renderRangos();
    construirFondo();
    calcularPosiciones(Date.now());
    calcularEstelas();
    renderPanel();
    pedir();
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

  // ---------------- Arranque ----------------
  redimensionar();
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
    pedir();
    setInterval(pedir, INTERVALO_MS);
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
