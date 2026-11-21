// Servidor para probar en la PC sin Vercel:  node servidor-local.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/aviones.js');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const PUERTO = process.env.PORT || 3000;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/aviones') {
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  const f = path.join(__dirname, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
  if (!f.startsWith(__dirname) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', TIPOS[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO, () => console.log(`Radar en http://localhost:${PUERTO}  (demo: /?demo)`));
