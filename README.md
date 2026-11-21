# Radar de vuelos (tablet)

Radar de aviones en vivo (datos ADS-B de adsb.fi / airplanes.live / adsb.lol) pensado para Chrome 106 en Android 6.

## Estructura
- `index.html`, `estilo.css`, `app.js`: la webapp (JS simple, sin build)
- `api/aviones.js`: función serverless de Vercel que consulta las APIs y normaliza los datos
- `servidor-local.js`: para probar en la PC sin Vercel

## Probar en la PC
    node servidor-local.js
Abrí http://localhost:3000 (datos reales) o http://localhost:3000/?demo (simulado).

## Parámetros de URL
- `?lat=-34.60&lon=-58.38` centro del radar (por defecto: Obelisco)
- `?km=50` radio inicial
- `?demo` datos simulados (`?demo=80` para prueba de carga)
- `?fps` muestra fps y ms por cuadro
- `?dpr=1` baja la resolución interna si la tablet no llega a 60 fps
El botón 📍 usa el GPS/Wi-Fi de la tablet y queda guardado.
