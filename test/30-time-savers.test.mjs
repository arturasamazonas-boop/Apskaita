// Time-savers for the accountant and the director: bank memory and bulk approval, supplier memory, director's view.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startTestApp} from './helpers.mjs';
import {classifyLine} from '../src/invoices/classify.mjs';

let t, acc, admin, account;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  admin = await t.client('admin').login();
  account = (await admin.post('/api/bank/accounts', {iban: 'LT977044060000000001', name: 'Pagrindinė', ledger_account: '2710'})).body;
});
after(async () => t.close());

test('bank: a recurring payment repeats the last booking; ready proposals are approved together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apskaita-'));
  const file = path.join(dir, 'nuoma.csv');
  fs.writeFileSync(file, ['Data;Gavėjas/Mokėtojas;Sąskaita;Paskirtis;Suma;Valiuta',
    '2026-08-05;UAB Biurų nuoma;LT897044060001234567;Rugpjūčio nuoma;-300,00;EUR',
    '2026-09-05;UAB Biurų nuoma;LT897044060001234567;Rugsėjo nuoma;-300,00;EUR'].join('\n'));
  const up = await acc.upload([file], {workflow: 'bank'});
  const imp = await acc.post('/api/bank/statements/import', {documentId: up.body.results[0].documentId, bankAccountId: account.id, opening: '1000', closing: '400'});
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const [aug, sep] = (await t.app.pool.query(`SELECT id FROM bank_transactions ORDER BY booking_date`)).rows.map((r) => String(r.id));
  const open = async (id) => (await acc.get(`/api/bank/transactions/${id}`)).body.proposals.find((p) => p.status === 'open');
  // August is booked by hand to rent.
  const p1 = await open(aug);
  const ed = await acc.put(`/api/bank/transactions/${aug}/proposal`, {contentHash: p1.content_hash, kind: 'other', allocations: [{kind: 'other', amount: '-300.00', accountCode: '6300', note: 'Biuro nuoma'}]});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  // Re-suggesting the open ones now proposes the same account for September.
  const rs = await acc.post('/api/bank/transactions/resuggest-open', {});
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  const augOpen = await open(aug);
  assert.equal(augOpen.data.source, 'user', 'a proposal edited by hand is left alone');
  const many0 = await acc.post('/api/bank/transactions/approve-many', {items: [{id: aug, contentHash: augOpen.content_hash}]});
  assert.equal(many0.body.approved, 1, JSON.stringify(many0.body));
  await acc.post('/api/bank/transactions/resuggest-open', {});
  const p2 = await open(sep);
  assert.equal(p2.data.allocations[0].accountCode, '6300', JSON.stringify(p2.data));
  assert.equal(p2.data.allocations[0].note, 'Biuro nuoma');
  assert.equal(p2.blocking, false, JSON.stringify(p2.validation));
  // Bulk approval: one stale item fails on its own, the valid one is posted.
  const many = await acc.post('/api/bank/transactions/approve-many', {items: [{id: sep, contentHash: p2.content_hash}, {id: aug, contentHash: 'pasenes'}]});
  assert.equal(many.status, 200, JSON.stringify(many.body));
  assert.deepEqual([many.body.approved, many.body.failed], [1, 1]);
  const st = (await t.app.pool.query(`SELECT status FROM bank_transactions WHERE id=$1`, [sep])).rows[0].status;
  assert.equal(st, 'approved');
});

test('purchases: the supplier\'s earlier booking is suggested for a new invoice', async () => {
  const buy = (n, description, accountCode) => acc.post('/api/manual-invoices', {register: 'purchase', series: 'KS', number: n, issueDate: '2026-09-10', counterparty: {name: 'UAB Konsultantai', companyCode: '304444444', vatCode: 'LT100001111111'},
    lines: [{description, quantity: '1', unitPrice: '200', taxCode: 'PVM1', ...(accountCode && {accountCode, lineType: 'service', vatTreatment: 'deductible'})}]});
  const first = await buy('1', 'Mokesčių konsultacija', '6318');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const ap = await acc.post(`/api/proposals/${first.body.proposal.id}/approve`, {contentHash: first.body.proposal.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const second = await buy('2', 'Rugsėjo paslaugos');
  const line = second.body.proposal.data.lines[0];
  assert.equal(line.accountCode, '6318');
  assert.equal(line.suggestion.source, 'history');
  assert.match(line.suggestion.explanation, /KS 1/);
});

test('classification memory: an exact description wins; an asset is never spread to other lines', () => {
  const base = {register: 'purchase', company: {vat_registered: true, asset_threshold: '500'}, rules: [], products: [], roles: {}, issueDate: '2026-10-01', counterpartyId: '7', counterparty: {vatCode: 'LT100001111111'}, docType: 'vat_invoice', accounts: new Map([['6300', {}], ['1240', {}], ['6317', {}]])};
  const history = new Map([['purchase:7', [{description: 'Serverio nuoma', account_code: '6317', line_type: 'service', vat_treatment: 'deductible', series: 'A', number: '1', issue_date: '2026-09-01'}, {description: 'Biuro nuoma', account_code: '6300', line_type: 'service', vat_treatment: 'deductible', series: 'A', number: '1', issue_date: '2026-09-01'}]]]);
  assert.equal(classifyLine({description: 'Serverio nuoma', vatRate: '21'}, {...base, history}).accountCode, '6317');
  assert.equal(classifyLine({description: 'Kita', vatRate: '21'}, {...base, history}).suggestion.source, 'none', 'two different accounts: no guess for a new description');
  const assets = new Map([['purchase:7', [{description: 'Nešiojamas kompiuteris', account_code: '1240', line_type: 'asset', vat_treatment: 'deductible', series: 'A', number: '2', issue_date: '2026-09-01'}]]]);
  assert.notEqual(classifyLine({description: 'Pelė', vatRate: '21'}, {...base, history: assets}).accountCode, '1240');
});

test('director: monthly management P&L, key figures and a cash forecast', async () => {
  await acc.post('/api/journal', {date: '2026-03-15', description: 'Pardavimai', lines: [{account: '2410', debit: '1210'}, {account: '5000', credit: '1000'}, {account: '4492', credit: '210'}]});
  await acc.post('/api/journal', {date: '2026-03-31', description: 'Savikaina', lines: [{account: '6000', debit: '600'}, {account: '204', credit: '600'}]});
  const pl = await acc.get('/api/reports/management-pl?year=2026');
  assert.equal(pl.status, 200, JSON.stringify(pl.body));
  const row = (k) => pl.body.rows.find((r) => r.key === k);
  assert.equal(row('revenue').m3, '1000.00');
  assert.equal(row('gross').m3, '400.00');
  assert.equal(row('margin').m3, 40);
  const x = await acc.get('/api/reports/management-pl?year=2026&format=xlsx', {raw: true});
  assert.equal(x.status, 200);
  const d = await acc.get('/api/director');
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.forecast.weeks.length, 8);
  assert.ok(d.body.kpis.some((k) => k.key === 'dso'));
  const w = d.body.forecast.weeks;
  assert.equal(w[7].closing, [w[0]].concat(w).reduce((c, x, i) => (i ? (Number(c) + Number(x.net)).toFixed(2) : Number(d.body.forecast.opening).toFixed(2)), 0));
});

test('month close: open bank items and a missing payroll are listed; locking works from the checklist', async () => {
  await t.app.pool.query(`INSERT INTO employees(first_name, last_name, personal_code, position, hired_on, base_salary) SELECT 'Ona','Onaitė','48001010000','Vadybininkė','2026-01-01',1500 WHERE NOT EXISTS (SELECT 1 FROM employees)`).catch(() => {});
  const d = (await acc.get('/api/month-close?period=2026-09')).body;
  assert.equal(d.to, '2026-09-30');
  const find = (re) => d.items.find((i) => re.test(i.title));
  assert.ok(find(/PVM už 2026-09/), JSON.stringify(d.items));
  assert.ok(d.items.every((i) => ['error', 'warn', 'info', 'ok'].includes(i.level)));
  const aug = (await acc.get('/api/month-close?period=2026-08')).body;
  assert.ok(aug.items.some((i) => i.title === 'Banko operacijos suderintos'), JSON.stringify(aug.items));
  const lock = await admin.post('/api/settings/lock-period', {lockedThrough: '2026-08-31', note: 'Mėnesio uždarymas 2026-08'});
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  assert.equal((await acc.get('/api/month-close?period=2026-08')).body.items.find((i) => i.group === 'Užrakinimas').level, 'ok');
  await admin.post('/api/settings/lock-period', {lockedThrough: null});
});

test('search: one box finds invoices, counterparties, bank operations and journal entries', async () => {
  const r = (await acc.get(`/api/search?q=${encodeURIComponent('Konsultantai')}`)).body;
  assert.ok(r.results.some((x) => x.type === 'Kontrahentas' && /skolu-aktas\?counterparty=/.test(x.link)), JSON.stringify(r));
  assert.ok(r.results.some((x) => x.type === 'Pirkimo sąskaita' && x.label === 'KS 1'), JSON.stringify(r));
  const byAmount = (await acc.get('/api/search?q=300,00')).body;
  assert.ok(byAmount.results.some((x) => x.type === 'Banko operacija'), JSON.stringify(byAmount));
  assert.deepEqual((await acc.get('/api/search?q=a')).body.results, []);
  assert.equal((await acc.get(`/api/search?q=${encodeURIComponent("%' OR 1=1 --")}`)).status, 200);
});
