// /test: a fictional manufacturing company generated once through the app's own API, with a consistent ledger.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {loadConfig} from '../src/config.mjs';
import {createPool} from '../src/db.mjs';
import {createEnvironments, tenantDatabaseUrl, demoEndDate} from '../src/tenants.mjs';
import {TEST_DB} from './helpers.mjs';

const quiet = {info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a)};
const dbName = new URL(tenantDatabaseUrl(TEST_DB, 'test', {})).pathname.slice(1);
const dropDb = async () => { const c = new pg.Client({connectionString: TEST_DB}); await c.connect(); try { await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } finally { await c.end(); } };
let storageDir, config;

before(async () => {
  const admin = createPool(TEST_DB); await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await admin.end();
  await dropDb();
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-demo-'));
  config = {...loadConfig({NODE_ENV: 'test', DATABASE_URL: TEST_DB, STORAGE_DIR: storageDir, STORAGE_BACKEND: 'postgres', OPEN_ACCESS: 'true'}), fxUrl: '', tenants: ['test'], seedDemo: [{tenant: 'test', tag: 'gamyba-v1'}]};
});
after(async () => { await dropDb(); await fs.rm(storageDir, {recursive: true, force: true}); });

test('demo end date: yesterday, or last year when the year has just started', () => {
  assert.equal(demoEndDate(new Date('2026-10-13T10:00:00Z')), '2026-10-12');
  assert.equal(demoEndDate(new Date('2027-02-01T10:00:00Z')), '2026-12-31');
});

test('/test: answers "ruošiama" while generating, then a full year of a furniture manufacturer, once', async () => {
  const envs = await createEnvironments(config, {log: quiet, env: {}});
  const server = http.createServer(envs.handle); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const busy = await fetch(`${base}/test/`);
    assert.equal(busy.status, 503); assert.match(await busy.text(), /ruošiama/);
    await envs.seeding;
    assert.equal((await fetch(`${base}/test/`)).status, 200);
    const q = async (sql) => (await envs.tenants[0].app.pool.query(sql)).rows;
    const [inv] = await q(`SELECT count(*) FILTER (WHERE register='sales')::int AS s, count(*) FILTER (WHERE register='purchase')::int AS p FROM invoices WHERE journal_entry_id IS NOT NULL`);
    assert.ok(inv.s + inv.p >= 150, `invoices posted: ${JSON.stringify(inv)}`);
    assert.ok((await q(`SELECT count(*)::int AS n FROM counterparties`))[0].n >= 20);
    assert.ok((await q(`SELECT count(*)::int AS n FROM products`))[0].n >= 20);
    assert.deepEqual(await q(`SELECT DISTINCT status FROM bank_transactions`), [{status: 'approved'}], 'every bank row matched and approved');
    assert.deepEqual(await q(`SELECT entry_id FROM journal_lines GROUP BY 1 HAVING sum(debit) <> sum(credit)`), [], 'every entry balanced');
    assert.deepEqual(await q(`SELECT p.name FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE p.track_stock GROUP BY 1 HAVING sum(m.quantity) < 0`), [], 'no negative stock');
    const [pl] = await q(`SELECT -sum(debit - credit) FILTER (WHERE account_code ~ '^5') AS rev, -sum(debit - credit) FILTER (WHERE account_code ~ '^[56]') AS profit, sum(debit - credit) FILTER (WHERE account_code='2710') AS bank FROM journal_lines`);
    assert.ok(Number(pl.rev) > 150000 && Number(pl.profit) > 0 && Number(pl.profit) < Number(pl.rev) * 0.2 && Number(pl.bank) > 0, `P&L ${JSON.stringify(pl)}`);
    assert.ok((await q(`SELECT count(*)::int AS n FROM payroll_runs WHERE status='approved'`))[0].n >= 3);
    assert.ok((await q(`SELECT count(*)::int AS n FROM loan_accruals WHERE status='posted'`))[0].n === 1);
    assert.match((await q(`SELECT name FROM company_settings`))[0].name, /DEMO/);
  } finally { server.close(); await envs.close(); }
  // A second start does not generate again.
  const again = await createEnvironments(config, {log: quiet, env: {}});
  await again.seeding;
  const n = (await again.tenants[0].app.pool.query(`SELECT count(*)::int AS n FROM invoices`)).rows[0].n;
  assert.ok(n >= 150 && n < 400, `not duplicated: ${n}`);
  await again.close();
});
