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
    storageDir: path.join(config.storageDir, 'tenants', name), dbPoolMax: Math.min(config.dbPoolMax || 10, 4), tenants: [], copyMainTo: [], seedDemo: [], swapMainWith: ''};
}

/** A requested one-time copy of the real (DATABASE_URL) environment into this one (COPY_MAIN_TO="ieva:<tag>"). */
async function copyMainIfRequested(source, app, name, config, log) {
  for (const {tenant, tag} of config.copyMainTo || []) {
    if (tenant !== name || source === app) continue;
    if ((await app.pool.query('SELECT 1 FROM environment_copies WHERE tag=$1', [tag])).rowCount) continue;
    log.info?.(`[aplinkos] /${name}/: kopijuojami pagrindinės duomenų bazės duomenys (${tag})…`);
    try {
      const r = await copyDatabase(source.pool, app.pool, {log, tag});
      if (config.storageBackend !== 'postgres') {
        // Files on disk: everything except the test environments' own folders (they live inside the main one).
        for (const entry of await fs.readdir(source.config.storageDir).catch(() => [])) {
          if (entry !== 'tenants') await fs.cp(path.join(source.config.storageDir, entry), path.join(app.config.storageDir, entry), {recursive: true, force: true});
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

/** Fictional demo data (SEED_DEMO="test:<tag>" – the database of /test): generated once into an empty database. */
async function seedSlot(slot, tag, log) {
  const pool = slot.app.pool;
  if ((await pool.query('SELECT 1 FROM environment_copies WHERE tag=$1', [`demo:${tag}`])).rowCount) return;
  if ((await pool.query('SELECT 1 FROM counterparties LIMIT 1')).rowCount) { log.warn?.(`[aplinkos] ${slot.where}: duomenų bazė ne tuščia – demonstraciniai duomenys nekuriami.`); return; }
  await pool.query(`INSERT INTO environment_copies(tag, source) VALUES ($1, 'demo')`, [`demo:${tag}`]);
  const started = Date.now();
  try {
    const c = await seedManufacturing(slot.app, {end: demoEndDate(), log});
    await pool.query('UPDATE environment_copies SET rows=$2, tables=0 WHERE tag=$1', [`demo:${tag}`, c.invoices + c.bankRows]);
    log.info?.(`[aplinkos] ${slot.where}: demonstraciniai duomenys sukurti per ${Math.round((Date.now() - started) / 1000)} s (${JSON.stringify(c)}).`);
  } catch (e) {
    log.error?.(`[aplinkos] ${slot.where}: demonstracinių duomenų sukurti nepavyko: ${e.message}`);
  }
}

/**
 * The main app at "/" and one app per tenant at "/<name>/". SWAP_MAIN_WITH=<name> exchanges the databases (and file
 * folders) of "/" and "/<name>/": "/" then shows that environment's data and "/<name>/" the main database.
 */
export async function createEnvironments(config, {log = console, env = process.env, onApp = async () => {}} = {}) {
  const own = (name) => !!env[`DATABASE_URL_${name.toUpperCase().replace(/-/g, '_')}`];
  const swap = (config.tenants || []).includes(config.swapMainWith) ? config.swapMainWith : null;
  const tenantCfg = Object.fromEntries((config.tenants || []).map((n) => [n, tenantConfig(config, n, env)]));
  // Databases: name → URL (the main one under "main").
  const dbOf = (name) => (name === 'main' ? config.databaseUrl : tenantCfg[name].databaseUrl);
  const storageOf = (name) => (name === 'main' ? config.storageDir : tenantCfg[name].storageDir);
  const slotDb = (name) => (swap && name === 'main' ? swap : swap && name === swap ? 'main' : name); // which database a slot uses

  const mainUses = slotDb('main');
  if (mainUses !== 'main' && !own(mainUses)) await ensureDatabase(config.databaseUrl, dbOf(mainUses));
  const main = await createApp({...config, databaseUrl: dbOf(mainUses), storageDir: storageOf(mainUses)}, {log});
  await onApp(main, 'main');
  const mainSlot = {name: 'main', where: '/', db: mainUses, app: main};
  if (swap) log.info?.(`[aplinkos] / rodo /${swap}/ duomenų bazę (${new URL(dbOf(mainUses)).pathname.slice(1)}), o /${swap}/ – pagrindinę.`);
  const tenants = [];
  for (const name of config.tenants || []) {
    const uses = slotDb(name);
    const cfg = {...tenantCfg[name], databaseUrl: dbOf(uses), storageDir: storageOf(uses)};
    try {
      if (uses !== 'main' && !own(uses)) await ensureDatabase(config.databaseUrl, cfg.databaseUrl);
      const app = await createApp(cfg, {log});
      await onApp(app, name);
      tenants.push({name, where: `/${name}/`, db: uses, app});
      log.info?.(`[aplinkos] /${name}/ – duomenų bazė ${new URL(cfg.databaseUrl).pathname.slice(1)}`);
    } catch (e) {
      log.error?.(`[aplinkos] /${name}/ nepaleista: ${e.message}`);
      tenants.push({name, where: `/${name}/`, db: uses, error: e.message});
    }
  }
  // One-time copies from the real (main) database, wherever it is served.
  const slots = [mainSlot, ...tenants];
  const real = slots.find((x) => x.db === 'main' && x.app);
  if (real) for (const t of tenants) if (t.app) await copyMainIfRequested(real.app, t.app, t.name, config, log);

  async function handle(req, res) {
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
    const busy = (slot) => send(res, 503, `${slot === mainSlot ? 'Programa' : `Testinė aplinka „${label(slot.name)}“`} ruošiama: kuriami demonstraciniai duomenys. Atnaujinkite puslapį po minutės.`, {'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30'});
    for (const t of tenants) {
      const prefix = `/${t.name}`;
      if (pathname === prefix) { res.writeHead(301, {Location: `${prefix}/${q < 0 ? '' : req.url.slice(q)}`}); return res.end(); }
      if (!pathname.startsWith(`${prefix}/`)) continue;
      if (t.preparing && !pathname.startsWith(`${prefix}/api/health`)) return busy(t);
      if (!t.app) return send(res, 503, `Testinė aplinka „${label(t.name)}“ neveikia: ${t.error}. Žr. docs/DEPLOY_RENDER.md („Testinės aplinkos“).`, {'Content-Type': 'text/plain; charset=utf-8'});
      req.url = req.url.slice(prefix.length);
      return t.app.handle(req, res);
    }
    if (mainSlot.preparing && !pathname.startsWith('/api/health')) return busy(mainSlot);
    return main.handle(req, res);
  }
  const all = () => [main, ...tenants.filter((t) => t.app).map((t) => t.app)];
  // Demo data goes into the database named by SEED_DEMO (e.g. that of /test), whichever address serves it now. It is
  // generated after start-up (the server is already listening); that address answers "ruošiama" meanwhile.
  const jobs = [];
  for (const {tenant, tag} of config.seedDemo || []) {
    const slot = slots.find((x) => x.db === tenant && x.app);
    if (!slot) continue;
    slot.preparing = true;
    jobs.push(seedSlot(slot, tag, log).finally(() => { slot.preparing = false; }));
  }
  const seeding = Promise.all(jobs);
  return {handle, main, tenants, all, seeding, async close() { await seeding.catch(() => {}); for (const a of all()) await a.close(); }};
}
