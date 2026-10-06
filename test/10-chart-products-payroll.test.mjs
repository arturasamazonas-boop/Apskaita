// Chart of accounts from the accountant's workbook, product cards and stock, payroll (LT 2026 rates).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {startTestApp, ledgerTotals, TEST_DB} from './helpers.mjs';
import {calcLine, npdFor, workingDays} from '../src/payroll/calc.mjs';
import {migrate} from '../src/db.mjs';
import {ROOT} from '../src/config.mjs';

let t, acc, admin, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  admin = await t.client('admin').login();
  ro = await t.client('readonly').login();
});
after(async () => t.close());

test('chart: UAB tree from the workbook, posting roles, only leaf accounts can be posted to', async () => {
  const all = (await acc.get('/api/accounts?all=1')).body;
  const by = Object.fromEntries(all.map((a) => [a.code, a]));
  assert.equal(by['1'].name, 'Ilgalaikis turtas'); assert.equal(by['1'].postable, false);
  assert.equal(by['443'].name, 'Skolos tiekėjams'); assert.equal(by['443'].postable, true); assert.equal(by['443'].system_role, 'payable');
  assert.equal(by['6304'].name, 'Darbuotojų darbo užmokestis ir su juo susijusios sąnaudos');
  assert.equal(by['4481'].system_role, 'payroll_gpm');
  assert.equal(by['271'].postable, false, 'bank group has sub-accounts per bank account');
  assert.ok(all.length > 280);
  const pickers = (await acc.get('/api/accounts')).body;
  assert.ok(pickers.every((a) => a.postable), 'pickers list leaf accounts only');
  const r = await acc.post('/api/journal', {date: '2026-09-30', description: 'Į grupę', lines: [{account: '63', debit: '1'}, {account: '2710', credit: '1'}]});
  assert.equal(r.status, 422);
  await assert.rejects(t.app.pool.query(`WITH e AS (INSERT INTO journal_entries(entry_date, description, source_type, idempotency_key) VALUES ('2026-09-30','x','manual','raw-group') RETURNING id)
    INSERT INTO journal_lines(entry_id, account_code, debit) SELECT id, '63', 1 FROM e`), /grupė/);
  // A sub-account turns an unused leaf into a group; a used one cannot be split.
  const sub = await admin.post('/api/accounts', {code: '63121', name: 'Biuro išlaidos', type: 'expense', parent_code: '6312'});
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((await acc.get('/api/accounts?all=1')).body.find((a) => a.code === '6312').postable, false);
  assert.equal((await acc.post('/api/journal', {date: '2026-09-30', description: 'x', lines: [{account: '6206', debit: '1'}, {account: '2710', credit: '1'}]})).status, 200);
  assert.equal((await admin.post('/api/accounts', {code: '62061', name: 'x', type: 'expense', parent_code: '6206'})).status, 409);
  assert.equal((await admin.post('/api/accounts', {code: '7001', name: 'x', type: 'expense', parent_code: '6206'})).status, 400, 'code must start with the parent code');
});

test('chart upgrade keeps old postings: used starter accounts are deactivated, unused ones removed', async () => {
  const db = TEST_DB.replace(/\/([^/]+)$/, '/$1_upgrade');
  const adminPool = new pg.Pool({connectionString: TEST_DB});
  await adminPool.query(`DROP DATABASE IF EXISTS ${db.split('/').pop()}`);
  await adminPool.query(`CREATE DATABASE ${db.split('/').pop()}`);
  await adminPool.end();
  const pool = new pg.Pool({connectionString: db});
  try {
    await pool.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const f of (await fs.readdir(path.join(ROOT, 'migrations'))).filter((x) => x < '009').sort()) {
      await pool.query(await fs.readFile(path.join(ROOT, 'migrations', f), 'utf8'));
      await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    }
    await pool.query(`INSERT INTO bank_accounts(iban, name, ledger_account) VALUES ('LT977044060000000001','Pagr.','2720')`);
    await pool.query(`BEGIN; WITH e AS (INSERT INTO journal_entries(entry_date, description, source_type, idempotency_key) VALUES ('2025-12-31','Senas','manual','old-1') RETURNING id)
      INSERT INTO journal_lines(entry_id, account_code, debit, credit) SELECT id, '2040', 50, 0 FROM e UNION ALL SELECT id, '4430', 0, 50 FROM e; COMMIT;`);
    await migrate(pool);
    const acc2 = Object.fromEntries((await pool.query('SELECT * FROM accounts')).rows.map((a) => [a.code, a]));
    assert.equal(acc2['2040'].active, false); assert.match(acc2['2040'].name, /ankstesnis planas/);
    assert.equal(acc2['4430'].active, false);
    assert.equal(acc2['2720'], undefined, 'unused old account removed');
    assert.equal(acc2['272'].name, 'Kasa');
    assert.equal((await pool.query('SELECT ledger_account FROM bank_accounts')).rows[0].ledger_account, '2710', 'bank account moved off the retired account');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM journal_lines WHERE account_code IN ('2040','4430')`)).rows[0].n, 2);
  } finally {
    await pool.end();
    const p2 = new pg.Pool({connectionString: TEST_DB}); await p2.query(`DROP DATABASE IF EXISTS ${db.split('/').pop()}`); await p2.end();
  }
});

test('product card: all fields saved, SKU unique, stock from invoices and manual movements, low-stock filter', async () => {
  const p = await acc.post('/api/products', {sku: 'KAB-01', name: 'Kabelis 3x2,5', kind: 'goods', unit: 'm', group_name: 'Elektra', barcode: '4770000000017', unit_price: '2.50', purchase_price: '1,20',
    manufacturer: 'Lietkabelis', origin_country: 'lt', cn_code: '8544 49', weight_kg: '0.12', location: 'A-3', min_stock: '50', description: 'Varinis', notes: 'Tik ritėmis', expense_account: '204', revenue_account: '5000'});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.origin_country, 'LT'); assert.equal(p.body.purchase_price, '1.2000'); assert.equal(p.body.cn_code, '854449'); assert.equal(p.body.track_stock, true);
  assert.equal((await acc.post('/api/products', {sku: 'KAB-01', name: 'Dublis'})).status, 409);
  assert.equal((await acc.post('/api/products', {name: 'Bloga sąskaita', expense_account: '20'})).status, 400, 'group account rejected');
  const id = p.body.id;
  assert.equal((await acc.post('/api/stock/movements', {productId: id, kind: 'opening', date: '2026-09-01', quantity: '100', unitCost: '1.10'})).status, 200);
  assert.equal((await acc.post('/api/stock/movements', {productId: id, kind: 'writeoff', date: '2026-09-02', quantity: '5'})).status, 400, 'write-off needs a reason');
  assert.equal((await acc.post('/api/stock/movements', {productId: id, kind: 'writeoff', date: '2026-09-02', quantity: '5', note: 'Pažeista'})).status, 200);
  assert.equal((await ro.post('/api/stock/movements', {productId: id, kind: 'opening', date: '2026-09-01', quantity: '1'})).status, 403);
  // Purchase 20 m and sell 80 m through invoices linked to the product.
  const buy = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'T', number: '77', issueDate: '2026-09-05', counterparty: {name: 'Kabelių tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Kabelis', productId: id, quantity: '20', unitPrice: '1.30', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
  assert.equal((await acc.post(`/api/proposals/${buy.body.proposal.id}/approve`, {contentHash: buy.body.proposal.content_hash})).status, 200);
  const sell = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-09-10', counterparty: {name: 'Montuotojas'}, lines: [{description: 'Kabelis', productId: id, quantity: '80', unitPrice: '2.50', taxCode: 'PVM1'}]});
  assert.equal((await acc.post(`/api/proposals/${sell.body.proposal.id}/approve`, {contentHash: sell.body.proposal.content_hash})).status, 200);
  const card = (await acc.get(`/api/products/${id}`)).body;
  assert.equal(Number(card.stock), 35, '100 − 5 + 20 − 80');
  assert.equal(Number(card.totals.purchased), 20); assert.equal(Number(card.totals.sold), 80);
  assert.equal(Number(card.avg_cost), 1.1333, '(100×1.10 + 20×1.30) / 120');
  const low = (await acc.get('/api/products?low=true')).body.items;
  assert.deepEqual(low.map((x) => x.sku), ['KAB-01']);
  const st = (await acc.get('/api/stock?asOf=2026-09-03')).body;
  assert.equal(Number(st.items.find((x) => x.id === id).stock), 95, 'balance as of a date');
  const mv = (await acc.get(`/api/stock/moves?product=${id}`)).body.items;
  assert.deepEqual(mv.map((m) => [m.kind, Number(m.quantity), Number(m.balance)]), [['opening', 100, 100], ['writeoff', -5, 95], ['purchase', 20, 115], ['sale', -80, 35]]);
  await assert.rejects(t.app.pool.query('UPDATE stock_movements SET quantity=1'), /immutable|keisti|negalima/i);
  const upd = await acc.put(`/api/products/${id}`, {min_stock: ''});
  assert.equal(upd.body.min_stock, null); assert.equal(upd.body.name, 'Kabelis 3x2,5', 'partial update keeps other fields');
  const svc = await acc.post('/api/products', {name: 'Montavimas', kind: 'service'});
  assert.equal(svc.body.track_stock, false);
});

test('payroll calculation: 2026 NPD formula, GPM 20 %, Sodra 19.5 % + employer 1.77 %, working-day norm', () => {
  const p = {mma: '1153.00', npd_max: '747.00', npd_coef: '0.4900', gpm_rate: '20.00', vsd_rate: '12.52', psd_rate: '6.98', pension_extra_rate: '3.00', employer_rate: '1.77', employer_rate_fixed: '2.49'};
  const e = {pay_type: 'monthly', base_salary: '2000.00', apply_npd: true, contract_type: 'indefinite', pension_extra: false};
  const c = calcLine(e, p, {workedDays: '20', normDays: '20'});
  assert.deepEqual([c.gross, c.npd, c.gpm, c.vsd, c.psd, c.net, c.employer_sodra], ['2000.00', '331.97', '333.61', '250.40', '139.60', '1276.39', '35.40']);
  assert.equal(calcLine({...e, base_salary: '1153.00'}, p, {workedDays: '20', normDays: '20'}).net, '846.96', 'MMA net');
  assert.equal(npdFor('3000.00', p), '0.00', 'NPD phases out');
  assert.equal(npdFor('500.00', p), '500.00', 'NPD never exceeds income');
  assert.equal(npdFor('2000.00', p, {fixed: '1127'}), '1127.00', 'disability NPD');
  const half = calcLine({...e, pension_extra: true, contract_type: 'fixed_term'}, p, {workedDays: '10', normDays: '20', bonus: '100'});
  assert.deepEqual([half.base, half.gross, half.pension, half.employer_sodra], ['1000.00', '1100.00', '33.00', '27.39']);
  assert.equal(calcLine({pay_type: 'hourly', hourly_rate: '8.5000', apply_npd: false, contract_type: 'indefinite'}, p, {workedHours: '100'}).gross, '850.00');
  assert.deepEqual(['2026-01', '2026-04', '2026-05', '2026-12'].map(workingDays), [21, 21, 20, 21]);
});

test('payroll sheet: create, edit, approve posts one balanced entry, cancel reverses, privacy', async () => {
  const e1 = await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', personal_code: '38001010000', position: 'Vadybininkas', employment_start: '2025-01-01', base_salary: '2000'});
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  const e2 = await acc.post('/api/employees', {first_name: 'Ona', last_name: 'Onaitė', employment_start: '2026-05-18', pay_type: 'hourly', hourly_rate: '10', hours_per_week: '20', pension_extra: true, expense_account: '6203'});
  assert.equal(e2.status, 200, JSON.stringify(e2.body));
  assert.equal((await acc.post('/api/employees', {first_name: 'X', last_name: 'Y', employment_start: '2026-01-01', personal_code: '123'})).status, 400);
  assert.equal((await ro.get(`/api/employees/${e1.body.id}`)).body.personal_code, '3**********', 'read-only users see a masked personal code');
  const run = await acc.post('/api/payroll/runs', {period: '2026-05'});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.norm_days, 20);
  const l1 = run.body.lines.find((l) => l.employee_id === e1.body.id), l2 = run.body.lines.find((l) => l.employee_id === e2.body.id);
  assert.equal(l1.gross, '2000.00'); assert.equal(l1.net, '1276.39');
  assert.equal(Number(l2.worked_days), 10, 'started on 18 May: 10 working days left'); assert.equal(Number(l2.worked_hours), 40); assert.equal(l2.gross, '400.00');
  assert.equal((await acc.post('/api/payroll/runs', {period: '2026-05'})).status, 409);
  const upd = await acc.put(`/api/payroll/runs/${run.body.id}`, {lines: [{employee_id: e1.body.id, bonus: '300', advance: '500'}]});
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const u1 = upd.body.lines.find((l) => l.employee_id === e1.body.id);
  assert.deepEqual([u1.gross, u1.npd, u1.gpm, u1.net, u1.to_pay], ['2300.00', '184.97', '423.01', '1428.49', '928.49']);
  assert.equal((await ro.post(`/api/payroll/runs/${run.body.id}/approve`)).status, 403);
  const before = await ledgerTotals(t.app.pool);
  const ap = await acc.post(`/api/payroll/runs/${run.body.id}/approve`);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal((await acc.post(`/api/payroll/runs/${run.body.id}/approve`)).body.journal_entry_id, ap.body.journal_entry_id, 'approving twice posts once');
  const after = await ledgerTotals(t.app.pool);
  const d = (k) => (Number(after[k] || 0) - Number(before[k] || 0)).toFixed(2);
  const tt = ap.body.totals;
  assert.equal(d('6304'), (2300 + Number(u1.employer_sodra)).toFixed(2));
  assert.equal(d('6203'), (Number(tt.cost) - Number(d('6304'))).toFixed(2), 'hourly employee booked to sales expenses');
  assert.equal(d('4480'), (-Number(tt.net)).toFixed(2)); assert.equal(d('4481'), (-Number(tt.gpm)).toFixed(2)); assert.equal(d('4482'), (-Number(tt.sodra_total)).toFixed(2));
  assert.equal((await acc.put(`/api/payroll/runs/${run.body.id}`, {norm_days: 19})).status, 409, 'approved sheet is read-only');
  const entry = (await acc.get(`/api/journal/${ap.body.journal_entry_id}`)).body;
  assert.equal(entry.source.type, 'payroll');
  const cancel = await acc.post(`/api/payroll/runs/${run.body.id}/cancel`, {reason: 'Pamiršta premija'});
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const back = await ledgerTotals(t.app.pool);
  assert.equal((Number(back['4480'] || 0) - Number(before['4480'] || 0)).toFixed(2), '0.00', 'reversal cancels the posting');
  const again = await acc.post(`/api/payroll/runs/${run.body.id}/approve`);
  assert.notEqual(again.body.journal_entry_id, ap.body.journal_entry_id, 're-approval posts a new entry');
  assert.equal((await acc.del(`/api/payroll/runs/${run.body.id}`)).status, 409);
});
