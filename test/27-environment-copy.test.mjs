// Copying the main environment's data into a test environment (/ieva): every table, files, sequences, and the
// ledger protections back in place afterwards; a requested copy runs once per tag.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import {startTestApp, TEST_DB, FIX} from './helpers.mjs';
import {createApp} from '../src/app.mjs';
import {copyDatabase} from '../src/env-copy.mjs';
import {createEnvironments, tenantConfig, ensureDatabase} from '../src/tenants.mjs';

let t, acc, ieva;
const quiet = {info() {}, warn() {}, error: (...a) => console.error(...a)};
const dropDb = async (name) => { const c = new pg.Client({connectionString: TEST_DB}); await c.connect(); try { await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await c.end(); } };

before(async () => {
  t = await startTestApp({config: {storageBackend: 'postgres'}});
  acc = await t.client('accountant').login();
  const cfg = tenantConfig({...t.config, tenants: ['ieva']}, 'ieva', {});
  await dropDb(new URL(cfg.databaseUrl).pathname.slice(1));
  await ensureDatabase(TEST_DB, cfg.databaseUrl);
  ieva = await createApp(cfg, {log: quiet});
  await ieva.pool.query(`INSERT INTO products(name) VALUES ('Ievos sena prekė')`); // replaced by the copy
});
after(async () => { await ieva?.close(); await t?.close(); await dropDb(new URL(tenantConfig(t.config, 'ieva', {}).databaseUrl).pathname.slice(1)); });

test('copy main → /ieva: same rows in every table, files, sequences continue, protections restored', async () => {
  // Some real data in the main environment: invoices posted to the ledger, an uploaded file, a loan with an accrual, a product.
  const p = (await acc.post('/api/products', {sku: 'P-1', name: 'Vamzdis'})).body;
  const inv = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'T', number: '1', issueDate: '2026-09-05', counterparty: {name: 'Tiekėjas', companyCode: '307777777'},
    lines: [{description: 'Vamzdis', productId: p.id, quantity: '10', unitPrice: '3', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
  assert.equal((await acc.post(`/api/proposals/${inv.body.proposal.id}/approve`, {contentHash: inv.body.proposal.content_hash})).status, 200);
  const up = await acc.upload([path.join(FIX, 'contract.pdf')], {workflow: 'vault'});
  assert.equal(up.body.results[0].status, 'uploaded');
  const loan = (await acc.post('/api/loans', {direction: 'received', principal: '1000', annual_rate: '5', events: [{kind: 'disbursement', date: '2026-01-01', amount: '1000'}]})).body;
  assert.equal((await acc.post(`/api/loans/${loan.id}/accruals`, {asOf: '2026-06-30'})).status, 200);

  const tables = (await t.app.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations','environment_copies','sessions','jobs') ORDER BY 1`)).rows.map((r) => r.tablename);
  const digest = async (pool) => Object.fromEntries(await Promise.all(tables.map(async (tb) => [tb, (await pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS h FROM "${tb}" x`)).rows[0]])));
  const deferrable = async (pool) => (await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND condeferrable`)).rows[0].n;
  const before = await deferrable(ieva.pool);

  const r = await copyDatabase(t.app.pool, ieva.pool, {log: quiet, tag: 'test-1'});
  assert.ok(r.rows > 100, `rows copied: ${r.rows}`);
  assert.deepEqual(await digest(ieva.pool), await digest(t.app.pool), 'every table identical');
  assert.ok((await ieva.pool.query('SELECT count(*)::int AS n FROM file_blobs')).rows[0].n >= 1, 'stored files travel with the database');
  assert.equal((await ieva.pool.query(`SELECT count(*)::int AS n FROM products WHERE name='Ievos sena prekė'`)).rows[0].n, 0, 'old /ieva data replaced');
  assert.equal(await deferrable(ieva.pool), before, 'foreign keys back to NOT DEFERRABLE');
  await assert.rejects(ieva.pool.query('UPDATE journal_entries SET description=description'), /immutable|keisti|negalima/i, 'ledger protection back on');
  const np = (await ieva.pool.query(`INSERT INTO products(name) VALUES ('Nauja') RETURNING id`)).rows[0].id;
  assert.ok(Number(np) > Number(p.id), 'sequences continue after the copied ids');
  assert.deepEqual((await ieva.pool.query('SELECT tag FROM environment_copies')).rows.map((x) => x.tag), ['test-1']);
});

test('a requested copy (COPY_MAIN_TO=ieva:<tag>) runs once at start-up', async () => {
  const config = {...t.config, tenants: ['ieva'], copyMainTo: [{tenant: 'ieva', tag: 'start-1'}]};
  await ieva.pool.query(`INSERT INTO products(name) VALUES ('Ievos darbas')`);
  let envs = await createEnvironments(config, {log: quiet, env: {}});
  const pool = envs.tenants[0].app.pool;
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM products WHERE name='Ievos darbas'`)).rows[0].n, 0, 'copied over at the first start');
  await pool.query(`INSERT INTO products(name) VALUES ('Ievos darbas po kopijos')`);
  await envs.close();
  envs = await createEnvironments(config, {log: quiet, env: {}});
  assert.equal((await envs.tenants[0].app.pool.query(`SELECT count(*)::int AS n FROM products WHERE name='Ievos darbas po kopijos'`)).rows[0].n, 1, 'not copied again with the same tag');
  await envs.close();
});
