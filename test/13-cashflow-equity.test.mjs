// Cash flow statement (5 VAS, direct and indirect), equity changes (4 VAS), FR0600 data, debt reconciliation act.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';

let t, acc, ro;
const line = (st, id) => st.lines.find((l) => l.id === id)?.current;
async function post(date, description, lines, kind) {
  const r = await acc.post('/api/journal', {date, description, lines, ...(kind && {kind})});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  await post('2025-01-10', 'Kapitalas', [{account: '2710', debit: '2500'}, {account: '3011', credit: '2500'}]);
  await post('2025-03-01', 'Įranga', [{account: '1240', debit: '1200'}, {account: '2710', credit: '1200'}]);
  await post('2025-06-30', 'Pardavimas skolon', [{account: '2410', debit: '1210'}, {account: '5001', credit: '1000'}, {account: '4492', credit: '210'}]);
  await post('2025-07-15', 'Nuoma', [{account: '6300', debit: '400'}, {account: '443', credit: '400'}]);
  await post('2025-12-31', 'Nusidėvėjimas', [{account: '6306', debit: '240'}, {account: '1247', credit: '240'}]);
  await post('2026-01-20', 'Pirkėjas sumokėjo', [{account: '2710', debit: '1210'}, {account: '2410', credit: '1210'}]);
  await post('2026-01-25', 'Sumokėta tiekėjui', [{account: '443', debit: '400'}, {account: '2710', credit: '400'}]);
  await post('2026-02-01', 'Prekės', [{account: '204', debit: '500.40'}, {account: '443', credit: '500.40'}]);
  await post('2026-03-01', 'Grynųjų pardavimas', [{account: '2710', debit: '900'}, {account: '5000', credit: '900'}]);
  await post('2026-03-31', 'Savikaina', [{account: '6000', debit: '300.20'}, {account: '204', credit: '300.20'}]);
  await post('2026-04-30', 'DU', [{account: '6304', debit: '1035.40'}, {account: '4480', credit: '676.39'}, {account: '4481', credit: '166.81'}, {account: '4482', credit: '192.20'}]);
  await post('2026-05-05', 'DU išmokėtas', [{account: '4480', debit: '676.39'}, {account: '2710', credit: '676.39'}]);
  await post('2026-05-31', 'Palūkanos', [{account: '6802', debit: '12.50'}, {account: '2710', credit: '12.50'}]);
  await post('2026-06-01', 'Paskola', [{account: '2710', debit: '1000'}, {account: '441', credit: '1000'}]);
  await post('2026-09-01', 'Paskolos grąžinimas', [{account: '441', debit: '200'}, {account: '2710', credit: '200'}]);
  await post('2026-06-10', 'Dividendai paskelbti', [{account: '342', debit: '100'}, {account: '4490', credit: '100'}]);
  await post('2026-06-20', 'Dividendai išmokėti', [{account: '4490', debit: '100'}, {account: '2710', credit: '100'}]);
  await post('2026-06-10', 'Privalomasis rezervas', [{account: '342', debit: '50'}, {account: '331', credit: '50'}]);
  await post('2026-07-01', 'Įranga 2', [{account: '1240', debit: '300'}, {account: '2710', credit: '300'}]);
  await post('2026-08-01', 'Įrangos pardavimas', [{account: '2710', debit: '350'}, {account: '1240', credit: '300'}, {account: '5400', credit: '50'}]);
});
after(async () => t.close());

test('indirect cash flow (5 VAS annex 2) reconciles to the change in cash', async () => {
  const st = (await ro.get('/api/statements/pinigu-srautai?from=2026-01-01&to=2026-12-31&precision=cents')).body;
  assert.deepEqual(st.checks, []);
  const got = Object.fromEntries(['I.1', 'I.4', 'I.7', 'I.12', 'I.14', 'I.17', 'I.18', 'I', 'II.1', 'II.2', 'II', 'III.1.4', 'III.2.1.1', 'III.2.2.1', 'III.2.2.3', 'III', 'V', 'VI', 'VII'].map((id) => [id, line(st, id)]));
  assert.deepEqual(got, {'I.1': '-398.10', 'I.4': '-200.20', 'I.7': '1210.00', 'I.12': '100.40', 'I.14': '359.01', 'I.17': '-50.00', 'I.18': '12.50', I: '1033.61',
    'II.1': '-300.00', 'II.2': '350.00', II: '50.00', 'III.1.4': '-100.00', 'III.2.1.1': '1000.00', 'III.2.2.1': '-200.00', 'III.2.2.3': '-12.50', III: '687.50', V: '1771.11', VI: '1300.00', VII: '3071.11'});
  assert.equal(st.form.colTitles[0], 'Finansiniai metai');
  // Previous year: 2500 capital in, 1200 equipment out.
  assert.equal(st.lines.find((l) => l.id === 'VII').previous, '1300.00');
  assert.equal(st.lines.find((l) => l.id === 'I.2').previous, '240.00');
});

test('direct cash flow (5 VAS annex 1): receipts and payments by counterpart account', async () => {
  const st = (await ro.get('/api/statements/pinigu-srautai-tiesioginis?from=2026-01-01&to=2026-12-31&precision=cents')).body;
  assert.deepEqual(st.checks, []);
  assert.deepEqual(['I.1.1', 'I.2.1', 'I.2.2', 'I.2.3', 'I', 'II.1', 'II.2', 'III.1.4', 'III.2.1.1', 'III.2.2.1', 'III.2.2.3', 'V', 'VII'].map((id) => line(st, id)),
    ['2110.00', '-400.00', '-676.39', '0.00', '1033.61', '-300.00', '350.00', '-100.00', '1000.00', '-200.00', '-12.50', '1771.11', '3071.11']);
});

test('statement of changes in equity (4 VAS annex 1): two years, movements reconcile to the balance sheet', async () => {
  const st = (await ro.get('/api/statements/nuosavo-kapitalo-pokyciai?to=2026-12-31&precision=cents')).body;
  const c = st.matrix.cells;
  assert.deepEqual(st.checks, []);
  assert.equal(c['1'].c10, '0.00');
  assert.equal(c['14'].c1, '2500.00', '2025 capital paid in');
  assert.equal(c['9'].c9, '360.00', '2025 result');
  assert.equal(c['17'].c10, '2860.00');
  assert.deepEqual([c['22'].c9, c['23'].c9, c['25'].c9, c['25'].c6], ['-398.10', '-100.00', '-50.00', '50.00']);
  assert.deepEqual([c['30'].c1, c['30'].c6, c['30'].c9, c['30'].c10], ['2500.00', '50.00', '-188.10', '2361.90']);
  const bal = (await ro.get('/api/statements/balansas?to=2026-12-31&precision=cents')).body;
  assert.equal(bal.lines.find((l) => l.id === 'D').current, '2361.90');
  const pdf = await ro.get('/api/statements/nuosavo-kapitalo-pokyciai/pdf?to=2026-12-31', {raw: true});
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('FR0600 data from invoices and the debt reconciliation act', async () => {
  const mk = async (body) => { const r = await acc.post('/api/manual-invoices', body); assert.equal(r.status, 200, JSON.stringify(r.body)); const p = r.body.proposal; const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); assert.equal(ap.status, 200, JSON.stringify(ap.body)); };
  await mk({register: 'sales', issueDate: '2026-10-05', counterparty: {name: 'UAB Klientas', companyCode: '300000001', vatCode: 'LT100005748413'}, lines: [{description: 'Prekė', quantity: '1', unitPrice: '100', taxCode: 'PVM1'}, {description: 'Apgyvendinimas', quantity: '1', unitPrice: '50', taxCode: 'PVM58'}]});
  await mk({register: 'purchase', series: 'T', number: '9', issueDate: '2026-10-06', counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Prekės', quantity: '1', unitPrice: '40', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
  const r = (await ro.get('/api/reports/vat-return?from=2026-10-01&to=2026-10-31')).body;
  const f = Object.fromEntries(r.rows.map((x) => [x.field, x.amount]));
  assert.deepEqual([f['11'], f['29'], f['29A'], f['25'], f['35'], f['36']], ['150.00', '21.00', '6.00', '8.40', '8.40', '18.60']);
  const cp = (await ro.get('/api/counterparties?q=Klientas')).body.items[0];
  const act = (await ro.get(`/api/debt-act?counterparty=${cp.id}&asOf=2026-10-31`)).body;
  assert.deepEqual([act.receivable, act.payable, act.balance, act.open.length], ['177.00', '0.00', '177.00', 1]);
  const pdf = await ro.get(`/api/debt-act?counterparty=${cp.id}&asOf=2026-10-31&format=pdf`, {raw: true});
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});
