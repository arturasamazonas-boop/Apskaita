// Sodra SAM v07: rows from the approved payroll sheet, combined rate, persons who left excluded, FFData per the official
// data description (groups, pages of 6 persons), PDF on the official form.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {splitSodraNo, samData, samFFData} from '../src/reports/sam.mjs';

let t, acc, ro, admin;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  admin = await t.client('admin').login();
  const c = (await admin.get('/api/settings/company')).body;
  assert.equal((await admin.put('/api/settings/company', {...c, sodra_code: '1234567'})).status, 200);
  const emps = [
    {first_name: 'Jonas', last_name: 'Jonaitis', personal_code: '38001010000', sodra_no: 'AB1234567', employment_start: '2025-01-01', base_salary: '2000'},
    {first_name: 'Ona', last_name: 'Onaitė', personal_code: '48001010000', sodra_no: 'CD7654321', employment_start: '2025-01-01', base_salary: '1500', contract_type: 'fixed_term', pension_extra: true},
    {first_name: 'Petras', last_name: 'Petraitis', personal_code: '38501010000', employment_start: '2025-01-01', employment_end: '2026-09-15', base_salary: '1200'},
  ];
  for (let i = 0; i < 6; i++) emps.push({first_name: `Darb${i}`, last_name: 'Testas', personal_code: `3900101000${i}`, sodra_no: `EF000000${i}`, employment_start: '2025-01-01', base_salary: '1153'});
  for (const e of emps) assert.equal((await acc.post('/api/employees', e)).status, 200);
  const run = await acc.post('/api/payroll/runs', {period: '2026-09'});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal((await acc.post(`/api/payroll/runs/${run.body.id}/approve`)).status, 200);
});
after(() => t?.close());

test('rows: income, combined rate, contributions; leavers excluded', async () => {
  assert.deepEqual(splitSodraNo('ab 1234567'), {series: 'AB', number: '1234567'});
  const r = await ro.get('/api/sodra/sam?year=2026&month=9');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.rows.length, 8);
  const jonas = d.rows.find((x) => x.lastName === 'Jonaitis'), ona = d.rows.find((x) => x.lastName === 'Onaitė');
  assert.deepEqual([jonas.income, jonas.rate, jonas.payment, jonas.series, jonas.number], ['2000.00', '14.29', '285.80', 'AB', '1234567']);
  assert.deepEqual([ona.rate, ona.payment], ['18.01', '270.15']); // 12.52 + 2.49 (fixed term) + 3 (pension accumulation)
  assert.ok(d.notes.some((n) => /Petras Petraitis/.test(n)));
  assert.equal(d.pages.length, 3); // title page + 2 SAM3SD pages (6 + 2 persons)
  assert.equal(d.pages[0].values.Apdx2PersonCount, '8');
  assert.equal(d.pages[2].values.RowNumber_2, '8');
  assert.equal(d.pages[2].values.RowNumber_3, '');
});

test('FFData per the SAM v07 description and PDF', async () => {
  const res = await ro.get('/api/sodra/sam/file?year=2026&month=9', {raw: true});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /SAM_2026-09\.ffdata/);
  const xml = await res.text();
  assert.match(xml, /<Form FormDefId="\{963BF380-47C3-4B69-A7F7-1B4593572CFE\}" FormLocation="">/);
  assert.match(xml, /<Group Name="Forma">\n<ListPages>\n<ListPage>SAM<\/ListPage>\n<\/ListPages>\n<Group Name="Priedas SAM3SD">/);
  assert.equal((xml.match(/<Group Name="Priedas SAM3SD">/g) || []).length, 2);
  assert.match(xml, /<Page PageDefName="SAM" PageNumber="1">\n<Fields Count="27">/);
  assert.match(xml, /<Page PageDefName="SAM3SD" PageNumber="3">\n<Fields Count="63">/);
  for (const s of ['<Field Name="InsurerCode">1234567</Field>', '<Field Name="CycleMonth">09</Field>', '<Field Name="Appendixes2">1</Field>', '<Field Name="FormVersion">07</Field>',
    '<Field Name="PersonCode_1">', '<Field Name="TaxRate_1">14,29</Field>', '<Field Name="InsuranceSeries_1">AB</Field>']) assert.ok(xml.includes(s), s);
  const pdf = await ro.get('/api/sodra/sam/file?year=2026&month=9&format=pdf', {raw: true});
  const {PDFDocument} = await import('pdf-lib');
  assert.equal((await PDFDocument.load(Buffer.from(await pdf.arrayBuffer()))).getPageCount(), 3);
  assert.equal((await ro.get('/api/sodra/sam/file?year=2026&month=8')).status, 422); // no payroll sheet
  // Without the Sodra employer code the file is refused.
  const d = await samData(t.app.pool, {year: 2026, month: 9});
  assert.ok(samFFData({...d, company: {...d.company, sodraCode: ''}}, {today: '2026-10-12'}).includes('<Field Name="InsurerCode"></Field>'));
});
