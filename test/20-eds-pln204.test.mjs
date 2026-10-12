// PLN204 as in VMI EDS: ledger → 18/19, non-deductible rules → PLN204S → 20, the template's calculation chain,
// rate code by year, edits, multi-page FFData (annex group) and PDF.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {recompute, rateFor, PLN204_LAYOUTS} from '../src/reports/eds-pln204.mjs';

let t, acc, ro;
async function post(date, description, lines) {
  const r = await acc.post('/api/journal', {date, description, lines});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  await post('2026-03-01', 'Pardavimai', [{account: '2710', debit: '100000'}, {account: '5001', credit: '100000'}]);
  await post('2026-03-02', 'Nuoma', [{account: '6300', debit: '40000'}, {account: '2710', credit: '40000'}]);
  await post('2026-03-03', 'Reprezentacija', [{account: '6319', debit: '1000'}, {account: '2710', credit: '1000'}]);
  await post('2026-03-04', 'Bauda', [{account: '6311', debit: '200.40'}, {account: '2710', credit: '200.40'}]);
  await post('2026-12-31', 'Pelno mokestis', [{account: '6900', debit: '5000'}, {account: '447', credit: '5000'}]);
});
after(() => t?.close());

test('template layouts and rates by year', () => {
  assert.equal(PLN204_LAYOUTS.PLN204.formDefId, '{B09451AC-AFF5-464B-AF35-057CC01B7699}');
  assert.deepEqual(PLN204_LAYOUTS.PLN204.listPages, ['PLN204', 'PLN204_2']);
  assert.equal(PLN204_LAYOUTS.PLN204S.fields.filter((f) => /^S2-/.test(f.name)).length, 32);
  assert.deepEqual([rateFor(1, 2026), rateFor(2, 2026), rateFor(1, 2025), rateFor(2, 2024), rateFor(3, 2026)], ['17', '7', '16', '5', '0']);
  // Loss: 41 holds the absolute amount, nothing taxable.
  const v = recompute({B_ML_DataNuo: '2026-01-01', E19: '-500'});
  assert.deepEqual([v.E37, v.E40, v.E41, v.E48, v.E55], ['-500', '', '500', '', '']);
});

test('values from the ledger: 18, 19, PLN204S rows, 20, and the chain to 64', async () => {
  const r = await ro.get('/api/eds/pln204?year=2026');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.values;
  // Profit before tax: 100 000 − 40 000 − 1 000 − 200,40 = 58 799,60 → 58 800 (profit tax 6900 excluded).
  assert.deepEqual([v.E18, v.E19], ['100000', '58800']);
  // Non-deductible: 6311 baudos 100 % → code 01: 200; 6319 reprezentacija 50 % → code 06: 500.
  assert.deepEqual([v['S1-1'], v['S2-1'], v['S1-2'], v['S2-2'], v.S3, v.E20], ['01', '200', '06', '500', '700', '700']);
  assert.deepEqual([v.E37, v.E40, v.E43, v.E48, v.E52, v.E52A], ['59500', '59500', '59500', '59500', '59500', '59500']);
  // No employees, income ≤ 300 000 → reduced rate code 2 (7 % in 2026).
  assert.deepEqual([v.E4, v.E53A, v.E54A, v.E55A, v.E55, v.E59, v.E62, v.E64], ['0', '2', '7,0', '4165', '4165', '4165', '4165', '-4165']);
  assert.deepEqual([v.E9, v.E10, v.B_FormVerNr], ['N', 'N', '08']);
});

test('edits: standard rate, loss carried forward within 70 %, list and amount validation', async () => {
  const j = async (values) => (await acc.post('/api/eds/pln204/file', {year: 2026, format: 'json', values}));
  const a = (await j({E53A: '1', E45: '10000'})).body.values;
  assert.deepEqual([a.E54A, a.E48, a.E55A, a.E64], ['17,0', '49500', '8415', '-8415']);
  assert.equal((await j({E53A: '1', E45: '50000'})).status, 400); // > 70 % of 59 500
  assert.equal((await j({E53A: '2', E45: '50000'})).status, 200); // reduced rate: no 70 % limit
  assert.equal((await j({E9: 'X'})).status, 400);
  assert.equal((await j({E21: '1,5'})).status, 400);
  const b = (await j({E36: '1000'})).body.values; // tax depreciation reduces profit
  assert.equal(b.E37, '58500');
});

test('multi-page FFData with the annex group, and PDF', async () => {
  const res = await ro.raw('POST', '/api/eds/pln204/file', {year: 2026, format: 'ffdata'}, {raw: true});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /PLN204_2026\.ffdata/);
  const xml = await res.text();
  assert.match(xml, /<Form FormDefId="\{B09451AC-AFF5-464B-AF35-057CC01B7699\}">/);
  assert.match(xml, /<Group Name="Visa forma">\n<ListPages>\n<ListPage>PLN204<\/ListPage>\n<ListPage>PLN204_2<\/ListPage>\n<\/ListPages>\n<Group Name="Priedas_PLN204S">\n<ListPages>\n<ListPage>PLN204S<\/ListPage>/);
  assert.match(xml, /<Pages Count="3">/);
  assert.match(xml, /<Page PageDefName="PLN204_2" PageNumber="2">\n<Fields Count="49">/);
  assert.match(xml, /<Page PageDefName="PLN204S" PageNumber="3">\n<Fields Count="69">/);
  for (const s of ['<Field Name="E19">58800</Field>', '<Field Name="S3">700</Field>', '<Field Name="E54A">7,0</Field>', '<Field Name="B_FormNr">PLN204S</Field>']) assert.ok(xml.includes(s), s);
  const pdf = await ro.raw('POST', '/api/eds/pln204/file', {year: 2026, format: 'pdf'}, {raw: true});
  const {PDFDocument} = await import('pdf-lib');
  assert.equal((await PDFDocument.load(Buffer.from(await pdf.arrayBuffer()))).getPageCount(), 3);
  // Rules: editing replaces them; a non-expense account is refused.
  assert.equal((await acc.put('/api/tax/nondeductible-rules', {rules: [{account_code: '2710', code: '01', percent: 100}]})).status, 400);
  assert.equal((await acc.put('/api/tax/nondeductible-rules', {rules: [{account_code: '6319', code: '06', percent: 50}]})).status, 200);
  assert.equal((await ro.get('/api/eds/pln204?year=2026')).body.values.S3, '500');
});
