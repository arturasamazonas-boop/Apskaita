// Performance measurement with 10,000 documents (synthetic, bulk-inserted). Uses a separate database
// (PERF_DATABASE_URL, default apskaita_perf) whose schema is reset. Prints median/max over repeated requests.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../src/config.mjs';
import {createPool} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {createUser} from '../src/auth/auth.mjs';

const DB = process.env.PERF_DATABASE_URL || 'postgres://apskaita:apskaita@127.0.0.1:5432/apskaita_perf';
const N = Number(process.env.PERF_DOCUMENTS || 10000);
const admin0 = createPool(DB.replace(/\/[^/]+$/, '/apskaita_test'));
await admin0.query('DROP DATABASE IF EXISTS apskaita_perf').catch(() => {});
await admin0.query('CREATE DATABASE apskaita_perf').catch(() => {});
await admin0.end();
const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apskaita-perf-'));
const app = await createApp(loadConfig({NODE_ENV: 'test', DATABASE_URL: DB, STORAGE_DIR: storageDir}), {log: {info() {}, warn() {}, error: console.error}});
const pool = app.pool;
const user = await createUser(pool, {email: 'perf@test.lt', name: 'Perf', role: 'accountant', password: 'perf-slaptazodis-1'});
await pool.query(`UPDATE company_settings SET name='Perf UAB', company_code='305555555', vat_code='LT100015555519', vat_registered=true, onboarding_done=true WHERE id=1`);

console.log(`Seeding ${N} documents…`);
const t0 = Date.now();
await pool.query(`INSERT INTO counterparties(name, company_code, vat_code, is_supplier, is_customer)
  SELECT 'Kontrahentas ' || g, (300000000 + g)::text, '', true, true FROM generate_series(1, 500) g`);
await pool.query(`INSERT INTO documents(kind, title, workflow, processing_status, reference_number, issue_date, created_by, created_at, tags, search_text)
  SELECT CASE WHEN g % 10 = 0 THEN 'contract' WHEN g % 2 = 0 THEN 'sales_invoice' ELSE 'purchase_invoice' END,
    'Dokumentas ' || g || ' Kontrahentas ' || (g % 500 + 1), CASE WHEN g % 10 = 0 THEN 'vault' ELSE 'invoice' END,
    CASE WHEN g % 10 = 0 THEN 'stored' WHEN g % 4 = 0 THEN 'needs_review' ELSE 'posted' END, 'NR-' || g, date '2026-01-01' + (g % 270), $1, now() - (g || ' minutes')::interval, ARRAY['tag' || (g % 20)],
    to_tsvector('simple', 'Dokumentas ' || g || ' Kontrahentas ' || (g % 500 + 1) || ' NR-' || g)
  FROM generate_series(1, $2::int) g`, [user.id, N]);
await pool.query(`INSERT INTO stored_files(document_id, version, role, sha256, size_bytes, mime, original_name, storage_key, uploaded_by)
  SELECT id, 1, 'original', md5(id::text) || md5((id + 1)::text), 1000, 'application/pdf', 'f' || id || '.pdf', '00/' || md5(id::text) || md5((id + 1)::text), $1 FROM documents`, [user.id]);
await pool.query(`INSERT INTO proposals(document_id, kind, version, status, data, validation, blocking, content_hash)
  SELECT d.id, 'invoice', 1, CASE WHEN d.processing_status = 'posted' THEN 'approved' ELSE 'open' END,
    jsonb_build_object('register', CASE WHEN d.kind='sales_invoice' THEN 'sales' ELSE 'purchase' END, 'number', 'NR-' || d.id, 'issueDate', d.issue_date::text, 'counterparty', jsonb_build_object('name', 'Kontrahentas ' || (d.id % 500 + 1))),
    jsonb_build_object('issues', '[]'::jsonb, 'computed', jsonb_build_object('gross', '121.00')), d.processing_status <> 'posted', md5(d.id::text) || md5(d.id::text)
  FROM documents d WHERE d.workflow = 'invoice'`);
// Posted invoices with balanced journal entries (bulk; triggers still validate balance and period).
const posted = (await pool.query(`SELECT d.id, d.kind, d.issue_date, p.id AS pid FROM documents d JOIN proposals p ON p.document_id=d.id WHERE d.processing_status='posted' ORDER BY d.id`)).rows;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [i, d] of posted.entries()) {
    const sales = d.kind === 'sales_invoice';
    const cp = (d.id % 500) + 1;
    const net = (50 + (d.id % 400)).toFixed(2), vat = (Number(net) * 0.21).toFixed(2), gross = (Number(net) + Number(vat)).toFixed(2);
    const e = (await client.query(`INSERT INTO journal_entries(entry_date, description, source_type, source_id, idempotency_key) VALUES ($1,'perf','invoice',$2,$3) RETURNING id`, [d.issue_date, String(i + 1), `perf:${d.id}`])).rows[0].id;
    const lines = sales ? [['2410', gross, 0, cp], ['5000', 0, net, null], ['4492', 0, vat, null]] : [['6317', net, 0, null], ['2441', vat, 0, null], ['443', 0, gross, cp]];
    for (const [a, dr, cr, c] of lines) await client.query(`INSERT INTO journal_lines(entry_id, account_code, debit, credit, counterparty_id) VALUES ($1,$2,$3,$4,$5)`, [e, a, dr, cr, c]);
    const inv = (await client.query(`INSERT INTO invoices(register, doc_type, series, number, number_key, issue_date, due_date, currency, counterparty_id, counterparty_key, counterparty_snapshot, company_snapshot,
        net_total, vat_total, gross_total, document_id, proposal_id, journal_entry_id, approved_by) VALUES ($1,'vat_invoice','NR',$2,$3,$4,$4::date + 14,'EUR',$5,$6,$7,'{}',$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [sales ? 'sales' : 'purchase', String(d.id), `NR${d.id}`, d.issue_date, cp, sales ? 'own' : `code:${300000000 + cp}`, {name: `Kontrahentas ${cp}`, vatCode: 'LT100000000011'}, net, vat, gross, d.id, d.pid, e, user.id])).rows[0].id;
    await client.query(`INSERT INTO invoice_lines(invoice_id, line_no, description, sku, quantity, unit_price, net, tax_code, vat_rate, vat, gross, account_code, line_type, vat_treatment) VALUES ($1,1,'Prekė','SKU-' || ($2::int % 300),'1',$3,$3,'PVM1',21,$4,$5,$6,$7,$8)`,
      [inv, d.id, net, vat, gross, sales ? '5000' : '6309', sales ? 'revenue_goods' : 'service', sales ? 'output' : 'deductible']);
    await client.query(`INSERT INTO invoice_vat_rows(invoice_id, tax_code, isaf_code, rate, taxable, vat, deductible_vat) VALUES ($1,'PVM1','PVM1',21,$2,$3,$4)`, [inv, net, vat, sales ? 0 : vat]);
  }
  await client.query('COMMIT');
} finally { client.release(); }
const acct = (await pool.query(`INSERT INTO bank_accounts(iban, name, ledger_account) VALUES ('LT977044060000000001','Perf','2710') RETURNING id`)).rows[0].id;
const doc = (await pool.query(`SELECT id FROM documents LIMIT 1`)).rows[0].id;
const fileId = (await pool.query(`SELECT id FROM stored_files WHERE document_id=$1`, [doc])).rows[0].id;
const stmt = (await pool.query(`INSERT INTO bank_statements(bank_account_id, document_id, file_id, format, balance_status) VALUES ($1,$2,$3,'csv','ok') RETURNING id`, [acct, doc, fileId])).rows[0].id;
await pool.query(`INSERT INTO bank_transactions(bank_account_id, first_statement_id, dedupe_key, fingerprint, booking_date, amount, currency, counterparty_name, reference, status)
  SELECT $1, $2, 'perf:' || g, md5(g::text) || md5(g::text), date '2026-01-01' + (g % 270), CASE WHEN g % 2 = 0 THEN 121 ELSE -50 END, 'EUR', 'Kontrahentas ' || (g % 500 + 1), 'NR' || g, CASE WHEN g % 3 = 0 THEN 'approved' ELSE 'unmatched' END
  FROM generate_series(1, $3::int) g`, [acct, stmt, N / 2]);
await pool.query('ANALYZE');
console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${N} documents, ${posted.length} posted invoices, ${N / 2} bank transactions.`);

const server = http.createServer(app.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(`${base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'perf@test.lt', password: 'perf-slaptazodis-1'})});
const cookie = login.headers.get('set-cookie').split(';')[0];
const targets = [
  ['Dokumentų dėžutė (sąrašas, 50)', '/api/inbox?limit=50', 1000], ['Dokumentų dėžutė (filtras + paieška)', '/api/inbox?status=needs_review&q=Kontrahentas%2042', 1000],
  ['Dokumentai: viso teksto paieška', '/api/documents?q=kontrahentas%20123', 1000], ['Pirkimų sąrašas', '/api/invoices?register=purchase&limit=50', 1000], ['Pardavimų sąrašas su mokėjimų būsena', '/api/invoices?register=sales&limit=50', 1000],
  ['Banko operacijos (nesuderintos)', '/api/bank/transactions?status=open&limit=50', 1000], ['Apžvalga', '/api/dashboard', 3000],
  ['Bandomasis balansas', '/api/reports/trial-balance?from=2026-01-01&to=2026-12-31', 3000], ['Pelno (nuostolių) ataskaita', '/api/reports/profit-loss?from=2026-01-01&to=2026-12-31', 3000],
  ['Balansas', '/api/reports/balance-sheet?asOf=2026-12-31', 3000], ['PVM registras (metai)', '/api/reports/vat-sales?from=2026-01-01&to=2026-12-31', 3000],
  ['Pirkėjų skolos (senėjimas)', '/api/reports/receivables?asOf=2026-12-31', 3000], ['Pardavimai pagal prekę', '/api/reports/sales?from=2026-01-01&to=2026-12-31&groupBy=product', 3000],
  ['Didžioji knyga 5000 (500 eil.)', '/api/reports/ledger?account=5000&from=2026-01-01&to=2026-12-31', 3000],
];
const rows = [];
for (const [name, url, budget] of targets) {
  const times = [];
  for (let i = 0; i < 7; i++) {
    const s = performance.now();
    const r = await fetch(base + url, {headers: {cookie}});
    if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text()}`);
    await r.arrayBuffer();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  rows.push({name, median: times[3], max: times.at(-1), budget, ok: times[3] <= budget});
}
console.log(`\nEnvironment: ${os.cpus()[0].model} × ${os.cpus().length}, ${Math.round(os.totalmem() / 1e9)} GB RAM, Node ${process.version}, PostgreSQL ${(await pool.query('SHOW server_version')).rows[0].server_version}; server and DB on the same host; 7 sequential requests, first included.\n`);
console.log('| Užklausa | Mediana, ms | Maks., ms | Tikslas, ms | Rezultatas |\n|---|---:|---:|---:|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.median.toFixed(0)} | ${r.max.toFixed(0)} | ${r.budget} | ${r.ok ? 'atitinka' : 'NEATITINKA'} |`);
server.close();
await app.close();
await fs.rm(storageDir, {recursive: true, force: true});
