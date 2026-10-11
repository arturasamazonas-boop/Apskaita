// Ilgalaikis turtas: straight-line depreciation by months, runs posted to the ledger in order, cancel, disposal, register reconciliation.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {chargeFor, assetState, forecast, defaultAccounts} from '../src/assets/depreciation.mjs';

let t, acc, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  const r = await acc.post('/api/journal', {date: '2026-01-15', description: 'Kompiuteris', lines: [{account: '1240', debit: '1000'}, {account: '2710', credit: '1000'}]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
after(() => t?.close());

test('depreciation math: monthly amount, last month remainder, opening balance', () => {
  const a = {cost: '1000.00', residual_value: '0.00', useful_life_months: 36, depreciation_start: '2026-02', opening_accumulated: '0.00', opening_period: null, status: 'active'};
  assert.equal(chargeFor(a, '2026-01', '0'), '0.00');
  assert.equal(chargeFor(a, '2026-02', '0'), '27.78');
  const f = forecast(a, new Map(), '2026-01');
  assert.equal(f.length, 36);
  assert.equal(f.at(-1).period, '2029-01');
  assert.equal(f.at(-1).amount, '27.70'); // 35 × 27.78 = 972.30, remainder 27.70
  assert.equal(f.at(-1).nbv, '0.00');
  // Taken over with 500.00 accumulated up to 2027-07: program starts 2027-08, 18 months left at 27.78, last one the remainder.
  const b = {...a, opening_accumulated: '500.00', opening_period: '2027-07'};
  const fb = forecast(b, new Map(), '2026-01');
  assert.equal(fb[0].period, '2027-08');
  assert.equal(fb.at(-1).accumulated, '1000.00');
  assert.deepEqual(assetState(a, new Map([['2026-02', '27.78']]), '2026-04').missing, ['2026-03']);
  assert.deepEqual(defaultAccounts('1240'), {depreciation: '1247', expense: '6306'});
  assert.deepEqual(defaultAccounts('1130'), {depreciation: '1138', expense: '6307'});
});

test('asset card, depreciation runs in order, cancel, register reconciliation, disposal', async () => {
  const bad = await acc.post('/api/fixed-assets', {inv_no: 'IT-1', name: 'Kompiuteris', cost_account: '2710', acquisition_date: '2026-01-15', cost: '1000', useful_life_months: 36});
  assert.equal(bad.status, 400);
  const c = await acc.post('/api/fixed-assets', {inv_no: 'IT-1', name: 'Kompiuteris', cost_account: '1240', acquisition_date: '2026-01-15', cost: '1000', useful_life_months: 36});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id;
  const card = (await ro.get(`/api/fixed-assets/${id}`)).body;
  assert.deepEqual([card.depreciation_start, card.depreciation_account, card.expense_account, card.monthly], ['2026-02', '1247', '6306', '27.78']);
  assert.equal((await acc.post('/api/fixed-assets', {inv_no: 'IT-1', name: 'X', cost_account: '1240', acquisition_date: '2026-01-15', cost: '10', useful_life_months: 12})).status, 409);
  // March cannot be posted before February.
  const p3 = await ro.get('/api/depreciation/preview?period=2026-03');
  assert.deepEqual(p3.body.blocked[0].missing, ['2026-02']);
  assert.equal((await acc.post('/api/depreciation/runs', {period: '2026-03'})).status, 409);
  const r2 = await acc.post('/api/depreciation/runs', {period: '2026-02'});
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.total, '27.78');
  assert.equal((await acc.post('/api/depreciation/runs', {period: '2026-02'})).status, 409);
  const r3 = await acc.post('/api/depreciation/runs', {period: '2026-03'});
  assert.equal(r3.status, 200);
  const e = (await ro.get(`/api/journal/${r3.body.entryId}`)).body;
  assert.deepEqual(e.lines.map((l) => [l.account_code, l.debit, l.credit]), [['6306', '27.78', '0.00'], ['1247', '0.00', '27.78']]);
  assert.equal(e.entry_date.slice(0, 10), '2026-03-31');
  // Financial fields are frozen once depreciated; descriptive ones are not.
  assert.equal((await acc.put(`/api/fixed-assets/${id}`, {cost: '1200'})).status, 409);
  assert.equal((await acc.put(`/api/fixed-assets/${id}`, {location: 'Biuras'})).status, 200);
  // Register reconciles with the ledger.
  const reg = (await ro.get('/api/fixed-assets?asOf=2026-03-31')).body;
  assert.deepEqual([reg.totals.cost, reg.totals.accumulated, reg.totals.nbv], ['1000.00', '55.56', '944.44']);
  assert.ok(reg.reconciliation.every((x) => x.diff === '0.00'), JSON.stringify(reg.reconciliation));
  // Only the latest run can be cancelled.
  const runs = (await ro.get('/api/depreciation/runs')).body;
  const feb = runs.find((x) => x.period === '2026-02'), mar = runs.find((x) => x.period === '2026-03');
  assert.equal((await acc.post(`/api/depreciation/runs/${feb.id}/cancel`, {reason: 'Klaida skaičiuojant'})).status, 409);
  assert.equal((await acc.post(`/api/depreciation/runs/${mar.id}/cancel`, {reason: 'Klaida skaičiuojant'})).status, 200);
  assert.equal((await ro.get('/api/fixed-assets?asOf=2026-03-31')).body.totals.accumulated, '27.78');
  // Disposal in April needs March and April depreciation first; then D 1247 + D 6400 / K 1240.
  assert.equal((await acc.post(`/api/fixed-assets/${id}/dispose`, {date: '2026-04-20'})).status, 409);
  await acc.post('/api/depreciation/runs', {period: '2026-03'});
  await acc.post('/api/depreciation/runs', {period: '2026-04'});
  const d = await acc.post(`/api/fixed-assets/${id}/dispose`, {date: '2026-04-20', kind: 'writeoff', note: 'Sugedo'});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.nbv, '916.66');
  const de = (await ro.get(`/api/journal/${d.body.entryId}`)).body;
  assert.deepEqual(de.lines.map((l) => [l.account_code, l.debit, l.credit]), [['1247', '83.34', '0.00'], ['6400', '916.66', '0.00'], ['1240', '0.00', '1000.00']]);
  const after = (await ro.get('/api/fixed-assets?asOf=2026-04-30')).body;
  assert.ok(after.reconciliation.every((x) => x.diff === '0.00'), JSON.stringify(after.reconciliation));
  assert.equal((await ro.get('/api/depreciation/preview?period=2026-05')).body.lines.length, 0);
  assert.equal((await ro.post('/api/depreciation/runs', {period: '2026-05'})).status, 403);
});
