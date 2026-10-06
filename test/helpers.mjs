// Test harness: dedicated test database (schema reset), temp storage, real HTTP server, session client.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, ROOT} from '../src/config.mjs';
import {createPool} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {createUser} from '../src/auth/auth.mjs';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://apskaita:apskaita@127.0.0.1:5432/apskaita_test';
export const FIX = path.join(ROOT, 'fixtures');
export const PASSWORD = 'test-slaptazodis-123';

export const COMPANY = {name: 'UAB Pavyzdinė prekyba', company_code: '305555555', vat_code: 'LT100015555519', vat_registered: true, vat_registered_from: '2020-01-01', address: 'Gedimino pr. 1, LT-01103 Vilnius', onboarding_done: true};

export async function startTestApp({config: overrides = {}} = {}) {
  if (!/_test\b|_test$|test/.test(TEST_DB)) throw new Error('Refusing to run tests on a non-test database');
  const admin = createPool(TEST_DB);
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-test-'));
  const config = {...loadConfig({NODE_ENV: 'test', DATABASE_URL: TEST_DB, STORAGE_DIR: storageDir}), ...overrides};
  const quiet = {info() {}, warn() {}, error: (...a) => console.error(...a)};
  const app = await createApp(config, {log: quiet});
  const users = {
    admin: await createUser(app.pool, {email: 'admin@test.lt', name: 'Admin', role: 'admin', password: PASSWORD}),
    accountant: await createUser(app.pool, {email: 'buhaltere@test.lt', name: 'Buhalterė', role: 'accountant', password: PASSWORD}),
    readonly: await createUser(app.pool, {email: 'skaitytojas@test.lt', name: 'Skaitytojas', role: 'readonly', password: PASSWORD}),
  };
  const keys = Object.keys(COMPANY);
  await app.pool.query(`UPDATE company_settings SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=1`, keys.map((k) => COMPANY[k]));
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, config, users, base, storageDir,
    client: (who) => makeClient(base, who),
    drain: () => app.worker.drain(),
    async close() { server.close(); await app.close(); await fs.rm(storageDir, {recursive: true, force: true}); },
  };
}

export function makeClient(base, who) {
  let cookie = '', csrf = '';
  const email = {admin: 'admin@test.lt', accountant: 'buhaltere@test.lt', readonly: 'skaitytojas@test.lt'}[who] || who;
  async function call(method, url, body, {raw = false, headers = {}} = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {method, headers: {...(cookie ? {cookie} : {}), ...(csrf ? {'x-csrf-token': csrf} : {}), ...(body && !isForm ? {'content-type': 'application/json'} : {}), ...headers},
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined});
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return {status: res.status, body: json};
  }
  return {
    async login() {
      const r = await call('POST', '/api/login', {email, password: PASSWORD});
      if (r.status !== 200) throw new Error(`login failed ${JSON.stringify(r.body)}`);
      csrf = r.body.csrf;
      return this;
    },
    get: (u, o) => call('GET', u, null, o), post: (u, b, o) => call('POST', u, b || {}, o), put: (u, b, o) => call('PUT', u, b, o), del: (u) => call('DELETE', u),
    async upload(files, {workflow = 'invoice', meta} = {}) {
      const fd = new FormData();
      fd.append('workflow', workflow);
      if (meta) fd.append('meta', JSON.stringify(meta));
      for (const f of files) {
        const buf = typeof f === 'string' ? await fs.readFile(f) : f.buffer;
        fd.append('files', new Blob([buf]), typeof f === 'string' ? path.basename(f) : f.name);
      }
      return call('POST', '/api/uploads', fd);
    },
    raw: call,
    setCsrf(v) { csrf = v; },
  };
}

/** Upload, process and return the open proposal for a fixture. */
export async function uploadAndProcess(t, client, file) {
  const up = await client.upload([file]);
  if (up.status !== 200) throw new Error(JSON.stringify(up.body));
  const res = up.body.results[0];
  await t.drain();
  if (res.status !== 'uploaded') return {upload: res};
  const doc = await client.get(`/api/documents/${res.documentId}`);
  const open = doc.body.proposals.find((p) => p.status === 'open');
  const proposal = open ? (await client.get(`/api/proposals/${open.id}`)).body : null;
  return {upload: res, doc: doc.body, proposal};
}

export function errors(p) { return (p.validation.issues || []).filter((i) => i.level === 'error'); }

export async function ledgerTotals(pool) {
  const r = await pool.query(`SELECT account_code, sum(debit) AS d, sum(credit) AS c FROM journal_lines GROUP BY 1 ORDER BY 1`);
  return Object.fromEntries(r.rows.map((x) => [x.account_code, (Number(x.d) - Number(x.c)).toFixed(2)]));
}
