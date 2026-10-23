// Regression tests for the issues found by the 2026-10 audit (accountant time-savers and accounting errors).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {referenceKeys, suggest} from '../src/bank/matching.mjs';
import {alignPrev} from '../src/invoices/service.mjs';
import {toCsv} from '../src/reports/reports.mjs';

let t, acc;
before(async () => { t = await startTestApp(); acc = await t.client('accountant').login(); });
after(async () => { await t?.close(); });

test('bank: invoice numbers are matched as whole words, never inside dates', () => {
  assert.ok(!referenceKeys('Apmokėjimas 2026-10-25').has('1025'));
  assert.ok(referenceKeys('Sąskaita PP 000012').has('PP12'));
  assert.ok(referenceKeys('sf nr. 2026-1001').has('SF20261001'));
  assert.ok(referenceKeys('Apmokėjimas pagal sąskaitą MG2026-1001').has('MG20261001'));
});

test('bank: taxes and payments to suppliers are not "bank fees"', async () => {
  const s = (o) => suggest(t.app.pool, {bank_account_id: 0, amount: '-45.00', currency: 'EUR', counterparty_name: '', counterparty_iban: '', reference: '', description: '', ...o});
  assert.equal((await s({reference: 'Mokestis už sąskaitos aptarnavimą'})).kind, 'fee');
  assert.notEqual((await s({counterparty_name: 'Valstybinė mokesčių inspekcija', counterparty_iban: 'LT247300010112394300', reference: 'Gyventojų pajamų mokestis už 09'})).kind, 'fee');
  assert.notEqual((await s({counterparty_name: 'UAB Serveris', counterparty_iban: 'LT117044060099990101', reference: 'Aptarnavimo mokestis už spalį'})).kind, 'fee');
});

test('review: deleting a line does not move its flags or OCR status onto the next line', () => {
  const prev = {lines: [{lineId: 'x1', description: 'Iš viso'}, {lineId: 'x2', description: 'Prekė'}], provenance: {'lines.0.description': {status: 'uncertain'}, 'lines.1.quantity': {status: 'conflict'}}};
  const a = alignPrev(prev, [{lineId: 'x2'}]);
  assert.deepEqual(a.lines.map((l) => l.description), ['Prekė']);
  assert.deepEqual(a.provenance, {'lines.0.quantity': {status: 'conflict'}});
});

test('exports: totals at the bottom, formula-looking text neutralised', () => {
  const csv = toCsv({columns: [['n', 'Pavadinimas'], ['v', 'Suma', 'money']], rows: [{n: '=HYPERLINK("x")', v: '10.50'}], totals: {debit: '10.50'}, opening: '2.00'});
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /Likutis pradžioje;2,00/); assert.match(csv, /Debetas;10,50/);
});

test('cash: a backdated payment cannot make a later day negative', async () => {
  const r = (b) => acc.post('/api/cash/orders', {purpose: 'other', accountCode: '305', personName: 'Savininkas', basis: 'Įnešimas / išmoka', ...b});
  assert.equal((await r({kind: 'receipt', date: '2026-10-10', amount: '100'})).status, 200);
  assert.equal((await r({kind: 'payment', date: '2026-10-15', amount: '100'})).status, 200);
  const back = await r({kind: 'payment', date: '2026-10-10', amount: '50'});
  assert.equal(back.status, 422); assert.match(back.body.error, /vėlesnių/);
});

test('journal: the same form cannot post twice; a reversal cannot be dated before the entry', async () => {
  const body = {date: '2026-09-30', description: 'Koregavimas', idempotencyKey: 'form-1', lines: [{account: '6312', debit: '10'}, {account: '2710', credit: '10'}]};
  const a = await acc.post('/api/journal', body), b = await acc.post('/api/journal', body);
  assert.equal(a.body.id, b.body.id); assert.equal(b.body.duplicate, true);
  assert.equal((await acc.post(`/api/journal/${a.body.id}/reverse`, {date: '2026-09-01', reason: 'Per anksti'})).status, 400);
  assert.equal((await acc.post(`/api/journal/${a.body.id}/reverse`, {date: '2026-09-30', reason: 'Klaida'})).status, 200);
});

test('ledger: the running balance is right over the whole period', async () => {
  for (let i = 1; i <= 3; i++) await acc.post('/api/journal', {date: `2026-08-0${i}`, description: `Įrašas ${i}`, lines: [{account: '6312', debit: '1'}, {account: '2711', credit: '1'}]});
  const g = (await acc.get('/api/reports/ledger?account=2711&from=2026-08-01&to=2026-08-31')).body;
  assert.deepEqual(g.rows.map((r) => r.balance), ['-1.00', '-2.00', '-3.00']);
  assert.equal(g.hasMore, false);
});

test('sales: a company that is not a VAT payer cannot charge VAT; 0 % EU supply needs an EU VAT code', async () => {
  const sale = (b) => acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-10-01', counterparty: {name: 'Pirkėjas', country: 'LV', vatCode: ''}, lines: [{description: 'Prekė', quantity: '1', unitPrice: '100', taxCode: 'PVM13'}], ...b});
  const eu = await sale({});
  assert.ok(eu.body.proposal.validation.issues.some((i) => i.code === 'eu_vat_required'), 'PVM13 without an EU VAT code is blocked');
  const ok = await sale({counterparty: {name: 'SIA Pircējs', country: 'LV', vatCode: 'LV40003000000'}});
  assert.ok(!ok.body.proposal.validation.issues.some((i) => i.code === 'eu_vat_required'));
  await t.app.pool.query('UPDATE company_settings SET vat_registered=false WHERE id=1');
  try {
    const nv = await sale({counterparty: {name: 'Pirkėjas'}, lines: [{description: 'Paslauga', quantity: '1', unitPrice: '100', taxCode: 'PVM1'}]});
    assert.ok(nv.body.proposal.validation.issues.some((i) => i.code === 'not_vat_payer'));
  } finally { await t.app.pool.query('UPDATE company_settings SET vat_registered=true WHERE id=1'); }
});
