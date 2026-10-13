// Test environments under one service: the main app at "/" and one app per tenant at "/<name>/" (e.g. /ieva,
// /sonata). Every environment runs the same code (so each deploy updates all of them) but has its own database,
// file storage, users, sessions and background jobs. The prefix is removed before the request reaches the app.
import pg from 'pg';
import path from 'node:path';
import {createApp} from './app.mjs';
import fs from 'node:fs/promises';
import {send} from './http.mjs';
import {copyDatabase} from './env-copy.mjs';
import {seedManufacturing} from './seed/manufacturing.mjs';

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
    storageDir: path.join(config.storageDir, 'tenants', name), dbPoolMax: Math.min(config.dbPoolMax || 10, 4), tenants: [], copyMainTo: [], seedDemo: []};
}

/** A requested one-time copy of the main environment into this one (COPY_MAIN_TO="ieva:<tag>"). */
async function copyMainIfRequested(main, app, name, config, log) {
  for (const {tenant, tag} of config.copyMainTo || []) {
    if (tenant !== name) continue;
    if ((await app.pool.query('SELECT 1 FROM environment_copies WHERE tag=$1', [tag])).rowCount) continue;
    log.info?.(`[aplinkos] /${name}/: kopijuojami pagrindinės aplinkos duomenys (${tag})…`);
    try {
      const r = await copyDatabase(main.pool, app.pool, {log, tag});
      if (config.storageBackend !== 'postgres') {
        // Files on disk: everything except the test environments' own folders (they live inside the main one).
        for (const entry of await fs.readdir(config.storageDir).catch(() => [])) {
          if (entry !== 'tenants') await fs.cp(path.join(config.storageDir, entry), path.join(app.config.storageDir, entry), {recursive: true, force: true});
        }
      }
      log.info?.(`[aplinkos] /${name}/: nukopijuota ${r.rows} eilučių iš ${r.tables} lentelių.`);
    } catch (e) {
      log.error?.(`[aplinkos] /${name}/: kopijuoti nepavyko: ${e.message}`);
    }
  }
}

/** Last day of demo activity: yesterday (Vilnius), or the end of last year early in a year (too little to show). */
export function demoEndDate(now = new Date()) {
  const y = new Date(now.getTime() - 86400000);
  const s = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius'}).format(y);
  return Number(s.slice(5, 7)) < 4 ? `${Number(s.slice(0, 4)) - 1}-12-31` : s;
}

/** Fictional demo data (SEED_DEMO="test:<tag>"): generated once into an empty environment, in the background. */
function seedIfRequested(t, config, log) {
  const spec = (config.seedDemo || []).find((x) => x.tenant === t.name);
  if (!spec || !t.app) return null;
  const run = async () => {
    const pool = t.app.pool;
    if ((await pool.query('SELECT 1 FROM environment_copies WHERE tag=$1', [`demo:${spec.tag}`])).rowCount) return;
    if ((await pool.query('SELECT 1 FROM counterparties LIMIT 1')).rowCount) { log.warn?.(`[aplinkos] /${t.name}/: duomenų bazė ne tuščia – demonstraciniai duomenys nekuriami.`); return; }
    await pool.query(`INSERT INTO environment_copies(tag, source) VALUES ($1, 'demo')`, [`demo:${spec.tag}`]);
    t.preparing = true;
    const started = Date.now();
    try {
      const c = await seedManufacturing(t.app, {end: demoEndDate(), log});
      await pool.query('UPDATE environment_copies SET rows=$2, tables=0 WHERE tag=$1', [`demo:${spec.tag}`, c.invoices + c.bankRows]);
      log.info?.(`[aplinkos] /${t.name}/: demonstraciniai duomenys sukurti per ${Math.round((Date.now() - started) / 1000)} s (${JSON.stringify(c)}).`);
    } catch (e) {
      log.error?.(`[aplinkos] /${t.name}/: demonstracinių duomenų sukurti nepavyko: ${e.message}`);
    } finally { t.preparing = false; }
  };
  return run();
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
      await copyMainIfRequested(main, app, name, config, log);
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
      if (t.preparing && !pathname.startsWith(`${prefix}/api/health`)) return send(res, 503, `Testinė aplinka „${label(t.name)}“ ruošiama: kuriami demonstraciniai duomenys. Atnaujinkite puslapį po minutės.`, {'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30'});
      if (!t.app) return send(res, 503, `Testinė aplinka „${label(t.name)}“ neveikia: ${t.error}. Žr. docs/DEPLOY_RENDER.md („Testinės aplinkos“).`, {'Content-Type': 'text/plain; charset=utf-8'});
      req.url = req.url.slice(prefix.length);
      return t.app.handle(req, res);
    }
    return main.handle(req, res);
  }
  const all = () => [main, ...tenants.filter((t) => t.app).map((t) => t.app)];
  // Demo data is generated after start-up (the server is already listening); /<name>/ answers "ruošiama" meanwhile.
  for (const t of tenants) if ((config.seedDemo || []).some((x) => x.tenant === t.name) && t.app) t.preparing = true;
  const seeding = Promise.all(tenants.map((t) => (seedIfRequested(t, config, log) || Promise.resolve()).finally(() => { t.preparing = false; })));
  return {handle, main, tenants, all, seeding, async close() { await seeding.catch(() => {}); for (const a of all()) await a.close(); }};
}
