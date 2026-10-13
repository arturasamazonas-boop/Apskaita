// Test environments under one service: the main app at "/" and one app per tenant at "/<name>/" (e.g. /ieva,
// /sonata). Every environment runs the same code (so each deploy updates all of them) but has its own database,
// file storage, users, sessions and background jobs. The prefix is removed before the request reaches the app.
import pg from 'pg';
import path from 'node:path';
import {createApp} from './app.mjs';
import {send} from './http.mjs';

const label = (name) => name.charAt(0).toUpperCase() + name.slice(1);

/** The tenant's database URL: DATABASE_URL_<NAME>, or the main URL with "_<name>" added to the database name. */
export function tenantDatabaseUrl(mainUrl, name, env = process.env) {
  const own = env[`DATABASE_URL_${name.toUpperCase().replace(/-/g, '_')}`];
  if (own) return own;
  const u = new URL(mainUrl);
  const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  u.pathname = `/${db}_${name.replace(/-/g, '_')}`;
  return u.toString();
}

/** Creates the tenant database when it does not exist (needs the CREATEDB right on the main connection). */
export async function ensureDatabase(mainUrl, tenantUrl) {
  const name = decodeURIComponent(new URL(tenantUrl).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Netinkamas duomenų bazės pavadinimas: ${name}`);
  const c = new pg.Client({connectionString: mainUrl});
  await c.connect();
  try {
    if (!(await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await c.query(`CREATE DATABASE "${name}"`);
  } finally { await c.end(); }
}

export function tenantConfig(config, name, env = process.env) {
  return {...config, databaseUrl: tenantDatabaseUrl(config.databaseUrl, name, env), basePath: `/${name}`, envLabel: label(name), cookieName: `sid_${name.replace(/-/g, '_')}`,
    storageDir: path.join(config.storageDir, 'tenants', name), dbPoolMax: Math.min(config.dbPoolMax || 10, 4), tenants: []};
}

export async function createEnvironments(config, {log = console, env = process.env, onApp = async () => {}} = {}) {
  const main = await createApp(config, {log});
  await onApp(main, 'main');
  const tenants = [];
  for (const name of config.tenants || []) {
    const cfg = tenantConfig(config, name, env);
    try {
      if (!env[`DATABASE_URL_${name.toUpperCase().replace(/-/g, '_')}`]) await ensureDatabase(config.databaseUrl, cfg.databaseUrl);
      const app = await createApp(cfg, {log});
      await onApp(app, name);
      tenants.push({name, app});
      log.info?.(`[aplinkos] /${name}/ – duomenų bazė ${new URL(cfg.databaseUrl).pathname.slice(1)}`);
    } catch (e) {
      log.error?.(`[aplinkos] /${name}/ nepaleista: ${e.message}`);
      tenants.push({name, error: e.message});
    }
  }
  async function handle(req, res) {
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
    for (const t of tenants) {
      const prefix = `/${t.name}`;
      if (pathname === prefix) { res.writeHead(301, {Location: `${prefix}/${q < 0 ? '' : req.url.slice(q)}`}); return res.end(); }
      if (!pathname.startsWith(`${prefix}/`)) continue;
      if (!t.app) return send(res, 503, `Testinė aplinka „${label(t.name)}“ neveikia: ${t.error}. Žr. docs/DEPLOY_RENDER.md („Testinės aplinkos“).`, {'Content-Type': 'text/plain; charset=utf-8'});
      req.url = req.url.slice(prefix.length);
      return t.app.handle(req, res);
    }
    return main.handle(req, res);
  }
  const all = () => [main, ...tenants.filter((t) => t.app).map((t) => t.app)];
  return {handle, main, tenants, all, async close() { for (const a of all()) await a.close(); }};
}
