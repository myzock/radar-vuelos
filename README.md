# 🛫 Radar de vuelos

Radar de aviones en vivo pensado para dejar prendido en una tablet: muestra los vuelos alrededor de tu ubicación con datos ADS-B reales, barrido animado a 60 fps y paleta en negro puro para pantallas OLED.

**App:** https://radar-vuelos-sigma.vercel.app · **Demo con datos simulados:** https://radar-vuelos-sigma.vercel.app/?demo

![Radar de vuelos](docs/captura.png)

## Qué muestra

- Aviones en un radar circular con alcance de 10 a 200 km, coloreados por altitud (rojo = squawk de emergencia)
- Estelas con el recorrido reciente y movimiento suave entre actualizaciones (se extrapola con velocidad y rumbo)
- Detalle al tocar un avión: tipo, matrícula, altitud, velocidad, rumbo, distancia, régimen vertical y squawk, más una línea con dónde va a estar en 2 minutos
- Referencias de AEP, EZE, San Fernando y El Palomar
- Lista de vuelos ordenada por distancia y reloj

## Cómo funciona

```
Tablet (index.html + app.js)  →  /api/aviones (Vercel)  →  adsb.fi / airplanes.live / adsb.lol
```

- **Frontend:** HTML + CSS + JavaScript sin frameworks ni build, compatible con navegadores viejos (probado para Chrome 106 / Android 6).
- **Proxy (`api/aviones.js`):** función serverless que consulta las APIs públicas en orden, con respaldo si una falla, normaliza la respuesta y la cachea unos segundos en el CDN para no pasarse de los límites de uso.
- La app pide datos cada 6 segundos.

## Rendimiento (60 fps)

El radar son 5 canvas apilados que compone la GPU; solo uno se redibuja por cuadro:

| Capa | Se redibuja |
|---|---|
| Fondo (anillos, textos, aeropuertos) | al cambiar tamaño, alcance o ubicación |
| Estelas | cuando llegan datos |
| Barrido | nunca: lo rota el compositor con una animación, sin JavaScript |
| Borde y puntos cardinales | al cambiar tamaño |
| Aviones | cada cuadro, con sprites y etiquetas pre-renderizadas |

Con el CPU frenado 6x, dibujar un cuadro con 80 aviones lleva unos 2 ms de JavaScript, sobre 16,6 ms de presupuesto.

## Modo OLED

- Fondo y panel en `#000` (píxeles apagados).
- Cada 2 minutos toda la interfaz se desplaza 1–2 px para evitar que los elementos fijos se quemen en la pantalla.
- Con HTTPS usa la Wake Lock API para que la pantalla no se apague.

## Parámetros de URL

| Parámetro | Uso |
|---|---|
| `?lat=-34.60&lon=-58.38` | Centro del radar (por defecto: Obelisco). El botón 📍 lo toma del dispositivo y lo guarda. |
| `?km=50` | Alcance inicial |
| `?demo` / `?demo=80` | Datos simulados (con 80 aviones para prueba de carga) |
| `?fps` | Muestra fps y milisegundos por cuadro |
| `?dpr=1` | Baja la resolución interna si el dispositivo no llega a 60 fps |

## Instalar en la tablet

1. Abrir la URL de la app en Chrome.
2. Menú ⋮ → **Agregar a pantalla principal**: queda en pantalla completa y horizontal.
3. Tocar **📍 Mi ubicación** una vez.

## Probar localmente

```bash
node servidor-local.js
```

Abrir http://localhost:3000 (datos reales) o http://localhost:3000/?demo.

## Deploy

Cada push a `main` se publica en Vercel. No hay build ni variables de entorno.

## Fuentes de datos

Los datos de vuelos son de redes comunitarias de receptores ADS-B: [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live) y [adsb.lol](https://adsb.lol). Gracias a todos los que alimentan esas redes. Sus APIs son gratuitas y están pensadas para uso personal y no comercial: revisá sus condiciones antes de usar esto para otra cosa. La cobertura depende de la cantidad de receptores en cada zona.

## Licencia

El código está bajo licencia [MIT](LICENSE). La licencia no cubre los datos de terceros.
