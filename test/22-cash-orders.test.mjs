// Kasos orderiai: KPO settling a sales invoice, KIO paying a supplier, bank transfer, accountable person, cash cannot go negative,
// numbering, cancellation (reversal + allocation back), cash book, PDF; amounts in Lithuanian words.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {amountInWords} from '../src/lib/lt-words.mjs';

let t, acc, ro, salesId, purchaseId, empId;
const mk = async (body) => { const r = await acc.post('/api/manual-invoices', body); const p = r.body.proposal; const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); assert.equal(ap.status, 200, JSON.stringify(ap.body)); return ap.body.invoiceId; };
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  salesId = await mk({register: 'sales', issueDate: '2026-10-01', counterparty: {name: 'UAB Klientas', companyCode: '300000001', vatCode: 'LT100005748413'}, lines: [{description: 'Prekė', quantity: '1', unitPrice: '100', taxCode: 'PVM1'}]});
  purchaseId = await mk({register: 'purchase', series: 'T', number: '5', issueDate: '2026-10-02', counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Paslauga', quantity: '1', unitPrice: '50', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  empId = (await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', employment_start: '2025-01-01', base_salary: '2000'})).body.id;
});
after(() => t?.close());

test('amounts in words', () => {
  assert.equal(amountInWords('1234.56'), 'Vienas tūkstantis du šimtai trisdešimt keturi Eur 56 ct');
  assert.equal(amountInWords('21.10'), 'Dvidešimt vienas Eur 10 ct');
  assert.equal(amountInWords('15000'), 'Penkiolika tūkstančių Eur 00 ct');
  assert.equal(amountInWords('302000.05'), 'Trys šimtai du tūkstančiai Eur 05 ct');
});

test('KPO for a sales invoice, KIO for a supplier and an accountable person; cash cannot go negative', async () => {
  // Paying out before any cash came in is refused.
  const early = await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-03', purpose: 'invoice', invoiceId: purchaseId, amount: '60.50'});
  assert.equal(early.status, 422);
  const kpo = await acc.post('/api/cash/orders', {kind: 'receipt', date: '2026-10-03', purpose: 'invoice', invoiceId: salesId, amount: '121'});
  assert.equal(kpo.status, 200, JSON.stringify(kpo.body));
  assert.deepEqual([kpo.body.series, kpo.body.number, kpo.body.account_code, kpo.body.person_name], ['KPO', '000001', '2410', 'UAB Klientas']);
  const e = (await ro.get(`/api/journal/${kpo.body.journal_entry_id}`)).body;
  assert.deepEqual(e.lines.map((l) => [l.account_code, l.debit, l.credit]), [['272', '121.00', '0.00'], ['2410', '0.00', '121.00']]);
  assert.equal(Number((await ro.get(`/api/invoices/${salesId}`)).body.balance.outstanding), 0);
  assert.equal((await acc.post('/api/cash/orders', {kind: 'receipt', date: '2026-10-03', purpose: 'invoice', invoiceId: salesId, amount: '1'})).status, 400); // already paid
  const kio = await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-04', purpose: 'invoice', invoiceId: purchaseId, amount: '60.50'});
  assert.equal(kio.status, 200, JSON.stringify(kio.body));
  assert.deepEqual([kio.body.series, kio.body.number, kio.body.account_code], ['KIO', '000001', '443']);
  const adv = await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-05', purpose: 'accountable', employeeId: empId, amount: '50', basis: 'Avansas kurui'});
  assert.equal(adv.status, 200, JSON.stringify(adv.body));
  assert.deepEqual([adv.body.account_code, adv.body.person_name], ['2445', 'Jonas Jonaitis']);
  assert.equal((await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-05', purpose: 'bank', amount: '20'})).status, 422); // 10.50 left
  const bank = await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-05', purpose: 'bank', amount: '10.50'});
  assert.equal(bank.body.account_code, '273');
  assert.equal((await acc.post('/api/cash/orders', {kind: 'payment', date: '2026-10-05', purpose: 'other', accountCode: '272', personName: 'X', amount: '1'})).status, 400);
  assert.equal((await ro.post('/api/cash/orders', {kind: 'receipt', date: '2026-10-05', purpose: 'other', accountCode: '5001', personName: 'X', amount: '1'})).status, 403);
});

test('cash book by day, cancellation, PDF', async () => {
  const b = (await ro.get('/api/cash/book?from=2026-10-01&to=2026-10-31')).body;
  assert.deepEqual([b.opening, b.receipts, b.payments, b.closing], ['0.00', '121.00', '121.00', '0.00']);
  assert.equal(b.days.length, 3);
  assert.deepEqual(b.days[0].rows.map((r) => r.document), ['KPO 000001']);
  const list = (await ro.get('/api/cash/orders?from=2026-10-01&to=2026-10-31')).body;
  const kio = list.find((o) => o.series === 'KIO' && o.number === '000001');
  // Cancelling the KPO would leave the cash desk negative.
  const kpo = list.find((o) => o.series === 'KPO');
  assert.equal((await acc.post(`/api/cash/orders/${kpo.id}/cancel`, {reason: 'Klaidingas įrašas'})).status, 422);
  assert.equal((await acc.post(`/api/cash/orders/${kio.id}/cancel`, {reason: 'Klaidingas įrašas'})).status, 200);
  const inv = (await ro.get(`/api/invoices/${purchaseId}`)).body;
  assert.deepEqual([Number(inv.balance.paid), Number(inv.balance.outstanding)], [0, 60.5]); // cancelled payment no longer counts
  assert.equal((await ro.get('/api/cash/book?from=2026-10-01&to=2026-10-31')).body.closing, '60.50');
  const pdf = await ro.get(`/api/cash/orders/${kpo.id}/pdf`, {raw: true});
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});
