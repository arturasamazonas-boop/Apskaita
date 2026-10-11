// Regressions for bugs found in review: credit-note discounts, VAT on negative lines, hourly pay rounding,
// 60 VDU GPM / VSD ceiling, FR0600 field 25, bad input as 400 instead of 500.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {calcLine, basePay} from '../src/payroll/calc.mjs';

let t, acc, ro;
const mk = async (body) => {
  const r = await acc.post('/api/manual-invoices', body); assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.proposal; assert.equal(p.blocking, false, JSON.stringify(p.validation.issues));
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); assert.equal(ap.status, 200, JSON.stringify(ap.body));
  return {proposal: p, invoiceId: ap.body.invoiceId};
};
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
});
after(() => t?.close());

test('a credit note reverses the discounted net, not the list price', async () => {
  const s = await mk({register: 'sales', issueDate: '2026-08-05', counterparty: {name: 'UAB Nuolaida', companyCode: '300000001', vatCode: 'LT100005748413'},
    lines: [{description: 'Prekė', quantity: '10', unitPrice: '10', discount: '20', taxCode: 'PVM1'}]});
  assert.equal(s.proposal.validation.computed.gross, '96.80');
  const half = await acc.post(`/api/invoices/${s.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '4'}], reason: 'Grąžinimas', issueDate: '2026-08-10'});
  assert.equal(half.status, 200, JSON.stringify(half.body));
  assert.equal(half.body.proposal.validation.computed.net, '-32.00');
  await acc.post(`/api/proposals/${half.body.proposal.id}/approve`, {contentHash: half.body.proposal.content_hash});
  const rest = await acc.post(`/api/invoices/${s.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '6'}], reason: 'Likusios', issueDate: '2026-08-11'});
  assert.equal(rest.body.proposal.validation.computed.net, '-48.00');
  await acc.post(`/api/proposals/${rest.body.proposal.id}/approve`, {contentHash: rest.body.proposal.content_hash});
  const inv = (await ro.get(`/api/invoices/${s.invoiceId}`)).body;
  assert.equal(inv.balance.gross, '0.00');
});

test('VAT on a negative line is negative; FR0600 25 = all purchase VAT, 35 = deductible', async () => {
  const p = await mk({register: 'purchase', series: 'NEG', number: '1', issueDate: '2026-07-06', counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Prekės', quantity: '1', unitPrice: '100', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'},
      {description: 'Grąžinta tara', quantity: '1', unitPrice: '-20', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'non_deductible'}]});
  assert.deepEqual(p.proposal.validation.computed.lines.map((l) => l.vat), ['21.00', '-4.20']);
  assert.equal(p.proposal.validation.computed.deductibleVat, '21.00');
  const fr = (await ro.get('/api/eds/fr0600?from=2026-07-01&to=2026-07-31')).body.values;
  assert.deepEqual([fr.E25, fr.E35], ['17', '21']);
  const old = (await ro.get('/api/reports/vat-return?from=2026-07-01&to=2026-07-31')).body;
  const f = Object.fromEntries(old.rows.map((x) => [x.field, x.amount]));
  assert.deepEqual([f['25'], f['35']], ['16.80', '21.00']);
});

test('payroll: hourly rate with 4 decimals; 32 % GPM and no VSD above 60 VDU a year', () => {
  assert.equal(basePay({pay_type: 'hourly', hourly_rate: '10.1250'}, {workedHours: '176'}), '1782.00');
  const p = {mma: '1153.00', vdu: '2312.15', npd_max: '747.00', npd_coef: '0.49', gpm_rate: '20.00', vsd_rate: '12.52', psd_rate: '6.98', pension_extra_rate: '3.00', employer_rate: '1.77', employer_rate_fixed: '2.49'};
  const emp = {pay_type: 'monthly', base_salary: '20000', apply_npd: true, contract_type: 'indefinite'};
  const inp = {workedDays: '21', normDays: '21'};
  // 60 × 2312.15 = 138 729.00; before this month 128 729.00 → 10 000 within the limit, 10 000 above.
  const c = calcLine(emp, p, inp, {ytdGross: '128729.00'});
  assert.equal(c.gpm, '5200.00'); // 10 000 × 20 % + 10 000 × 32 %
  assert.equal(c.vsd, '1252.00'); // 12.52 % of 10 000 only
  assert.equal(c.psd, '1396.00'); // PSD on all 20 000
  const first = calcLine(emp, p, inp);
  assert.equal(first.gpm, '4000.00');
  assert.equal(first.vsd, '2504.00');
});

test('bad input is a 400/404, not a server error', async () => {
  for (const u of ['/api/employees/abc', '/api/invoices/abc', '/api/payroll/runs/abc', '/api/debt-act?counterparty=abc', '/api/reports/constructor', '/api/statements/constructor', '/api/statements/__proto__',
    '/api/invoices?limit=-5', '/api/reports/ledger?account=2710&limit=abc', '/api/fixed-assets/abc']) {
    const r = await acc.get(u);
    assert.ok(r.status === 400 || r.status === 404 || r.status === 200, `${u} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.notEqual(r.status, 500, u);
  }
});
