// Test environments: /ieva and /sonata run the same code with their own database, cookie and URLs.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {loadConfig} from '../src/config.mjs';
import {createPool} from '../src/db.mjs';
import {createEnvironments, tenantDatabaseUrl} from '../src/tenants.mjs';
import {TEST_DB} from './helpers.mjs';

let envs, server, base, storageDir;
const tenantDb = tenantDatabaseUrl(TEST_DB, 'ieva', {});
const quiet = {info() {}, warn() {}, error() {}};

async function dropDb(url) {
  const name = new URL(url).pathname.slice(1);
  const c = new pg.Client({connectionString: TEST_DB}); await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await c.end(); }
}

before(async () => {
  const admin = createPool(TEST_DB);
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await dropDb(tenantDb);
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-env-'));
  const config = {...loadConfig({NODE_ENV: 'test', DATABASE_URL: TEST_DB, STORAGE_DIR: storageDir, OPEN_ACCESS: 'true'}), fxUrl: '', tenants: ['ieva', 'broken']};
  envs = await createEnvironments(config, {log: quiet, env: {DATABASE_URL_BROKEN: 'postgres://x:y@127.0.0.1:1/none'}});
  server = http.createServer(envs.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await envs?.close(); await dropDb(tenantDb); await fs.rm(storageDir, {recursive: true, force: true}); });

async function session(prefix) {
  const r = await fetch(`${base}${prefix}/api/open-login`, {method: 'POST', headers: {origin: base}});
  assert.equal(r.status, 200, await r.clone().text());
  const cookie = r.headers.get('set-cookie');
  const {csrf} = await r.json();
  const call = (method, url, body) => fetch(`${base}${prefix}${url}`, {method, headers: {cookie: cookie.split(';')[0], origin: base, 'x-csrf-token': csrf, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined}).then(async (x) => ({status: x.status, body: await x.json()}));
  return {cookie, call};
}

test('tenant database URL: own variable or the main database name + suffix', () => {
  assert.equal(tenantDatabaseUrl('postgres://u:p@ep-x.neon.tech/neondb?sslmode=require', 'sonata', {}), 'postgres://u:p@ep-x.neon.tech/neondb_sonata?sslmode=require');
  assert.equal(tenantDatabaseUrl('postgres://u:p@h/db', 'ieva', {DATABASE_URL_IEVA: 'postgres://o@h/kita'}), 'postgres://o@h/kita');
});

test('/ieva: own pages, own session cookie, own data; a broken environment does not stop the others', async () => {
  const r = await fetch(`${base}/ieva?x=1`, {redirect: 'manual'});
  assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/ieva/?x=1');
  const html = await (await fetch(`${base}/ieva/`)).text();
  assert.match(html, /<meta name="app-base" content="\/ieva">/); assert.match(html, /<meta name="app-env" content="Ieva">/); assert.match(html, /src="js\/app\.mjs"/);
  assert.match(await (await fetch(`${base}/`)).text(), /<meta name="app-base" content="">/);
  assert.equal((await fetch(`${base}/ieva/js/app.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/ieva/api/health`)).status, 200);

  const ieva = await session('/ieva'), main = await session('');
  assert.match(ieva.cookie, /^sid_ieva=[^;]+;.*Path=\/ieva\//);
  assert.match(main.cookie, /^sid=[^;]+;.*Path=\/;/);
  assert.equal((await ieva.call('POST', '/api/products', {name: 'Ievos prekė'})).status, 200);
  assert.deepEqual((await ieva.call('GET', '/api/products')).body.items.map((p) => p.name), ['Ievos prekė']);
  assert.deepEqual((await main.call('GET', '/api/products')).body.items, [], 'the main environment does not see it');
  // The main cookie does not open /ieva.
  assert.equal((await fetch(`${base}/ieva/api/products`, {headers: {cookie: main.cookie.split(';')[0]}})).status, 401);

  const broken = await fetch(`${base}/broken/`);
  assert.equal(broken.status, 503); assert.match(await broken.text(), /Testinė aplinka „Broken“ neveikia/);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
