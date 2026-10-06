// Minimal HTTP framework: routing, JSON/multipart parsing, cookies, sessions, CSRF, security headers.
import fs from 'node:fs/promises';
import path from 'node:path';
import Busboy from 'busboy';
import {AppError} from './db.mjs';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({method, re, keys, handler, opts});
  };
  return {
    get: (p, h, o) => add('GET', p, h, o), post: (p, h, o) => add('POST', p, h, o), put: (p, h, o) => add('PUT', p, h, o), delete: (p, h, o) => add('DELETE', p, h, o),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return {route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))};
      }
      return null;
    },
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new AppError(413, 'too_large', 'Užklausa per didelė.'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'bad_json', 'Netinkamas JSON.'); }
}

export function readMultipart(req, {maxFileBytes, maxFiles = 50}) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({headers: req.headers, limits: {fileSize: maxFileBytes + 1, files: maxFiles, fields: 50, fieldSize: 100000}}); } catch (e) { reject(new AppError(400, 'bad_multipart', 'Netinkama įkėlimo užklausa.')); return; }
    const files = [], fields = {};
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => files.push({field: name, name: Buffer.from(info.filename || 'failas', 'latin1').toString('utf8'), mime: info.mimeType, buffer: Buffer.concat(chunks), truncated}));
    });
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('filesLimit', () => reject(new AppError(413, 'too_many', `Per daug failų (riba ${maxFiles}).`)));
    bb.on('error', (e) => reject(new AppError(400, 'bad_multipart', e.message)));
    bb.on('close', () => resolve({files, fields}));
    req.pipe(bb);
  });
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers});
  res.end(payload);
}

const STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2'};

export async function serveStatic(res, publicDir, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(publicDir, '.' + rel);
  if (!file.startsWith(path.resolve(publicDir) + path.sep)) return send(res, 404, 'Nerasta');
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300'});
    res.end(buf);
  } catch {
    send(res, 404, 'Nerasta');
  }
}

/** CSRF protection for cookie sessions: same-origin check + per-session token header. */
export function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // non-browser clients; token still required
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
