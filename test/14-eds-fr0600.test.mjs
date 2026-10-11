// PVM deklaracija FR0600 as in VMI EDS: field values, edits on the form, FFData file and PDF on the official form background.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {LAYOUT, applyEdits, placements, toFFData} from '../src/reports/eds-fr0600.mjs';

let t, acc, ro;
const Q = 'from=2026-10-01&to=2026-10-31';
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  const mk = async (body) => { const r = await acc.post('/api/manual-invoices', body); assert.equal(r.status, 200, JSON.stringify(r.body)); const p = r.body.proposal; const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); assert.equal(ap.status, 200, JSON.stringify(ap.body)); };
  await mk({register: 'sales', issueDate: '2026-10-05', counterparty: {name: 'UAB Klientas', companyCode: '300000001', vatCode: 'LT100005748413'}, lines: [{description: 'Prekė', quantity: '1', unitPrice: '100', taxCode: 'PVM1'}, {description: 'Apgyvendinimas', quantity: '1', unitPrice: '50', taxCode: 'PVM58'}]});
  await mk({register: 'purchase', series: 'T', number: '9', issueDate: '2026-10-06', counterparty: {name: 'UAB Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Prekės', quantity: '1', unitPrice: '40', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
});
after(() => t?.close());

test('FR0600 v3 layout matches the VMI template', () => {
  assert.equal(LAYOUT.formCode, 'FR0600');
  assert.equal(LAYOUT.formDefId, '{0AC6FE8F-6B47-4A22-81C5-8D790D3212B1}');
  assert.equal(LAYOUT.fields.length, 45);
  const f = Object.fromEntries(LAYOUT.fields.map((x) => [x.name, x]));
  assert.equal(f.E11.cells.length, 10); assert.equal(f.E36.cells.length, 9); assert.equal(f.E36.readOnly, true);
  assert.deepEqual(f.E8.items, ['B_Pirmine', 'B_Patikslinta']);
});

test('FR0600 values in whole euros, empty fields stay empty', async () => {
  const r = await ro.get(`/api/eds/fr0600?${Q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.values;
  assert.deepEqual([v.E11, v.E29, v.E29A, v.E25, v.E35, v.E36], ['150', '21', '6', '8', '8', '19']);
  assert.deepEqual([v.E12, v.E13, v.E30, v.E31, v.B_MM_Adresas, v.B_UzpildData, v.E10], ['', '', '', '', '', '', '']);
  assert.deepEqual([v.B_ML_DataNuo, v.B_ML_DataIki, v.B_Pirmine, v.B_Patikslinta, v.E8, v['E9-1'], v.E9], ['2026-10-01', '2026-10-31', '1', '', 'B_Pirmine', '1', 'E9-1']);
  assert.deepEqual([v.B_FormNr, v.B_FormVerNr, v.LT], ['FR0600', '03', 'LT']);
  const corr = (await ro.get(`/api/eds/fr0600?${Q}&correction=1`)).body.values;
  assert.deepEqual([corr.B_Pirmine, corr.B_Patikslinta, corr.E8], ['', '1', 'B_Patikslinta']);
  // E11 "150" sits in the last three of its ten cells (right-justified as on the form).
  const e11 = r.body.placements.find((p) => p.name === 'E11');
  const cells = LAYOUT.fields.find((x) => x.name === 'E11').cells.map(String);
  assert.deepEqual(e11.chars.map(([c, ch]) => [cells.indexOf(String(c)), ch]), [[7, '1'], [8, '5'], [9, '0']]);
  // Dates skip the printed dashes.
  assert.equal(r.body.placements.find((p) => p.name === 'B_ML_DataNuo').chars.map(([, ch]) => ch).join(''), '20261001');
  assert.equal(await (await ro.get('/api/eds/fr0600?from=2026-10-31&to=2026-10-01')).status, 400);
});

test('edits on the form: field 36 recalculated, read-only fields kept, invalid amounts refused', () => {
  const base = {...Object.fromEntries(LAYOUT.fields.map((f) => [f.name, ''])), E29: '21', E35: '8', E36: '13', B_Pirmine: '1', E8: 'B_Pirmine'};
  const v = applyEdits(base, {E32: '5', E36: '999', B_MM_Adresas: 'X', B_Patikslinta: '1', B_Pirmine: ''});
  assert.deepEqual([v.E32, v.E36, v.B_MM_Adresas, v.B_Patikslinta, v.B_Pirmine, v.E8], ['5', '18', '', '1', '', 'B_Patikslinta']);
  assert.equal(applyEdits(base, {E35: '30'}).E36, '-9');
  assert.throws(() => applyEdits(base, {E12: '10,50'}), /sveikieji/);
  assert.throws(() => applyEdits(base, {E28: '120'}), /procentas/);
  assert.throws(() => applyEdits(base, {Nera: '1'}), /Nežinomas/);
  const checks = placements(v).filter((p) => p.mark).map((p) => p.name);
  assert.deepEqual(checks, ['B_Patikslinta']);
});

test('EDS file (.ffdata) and PDF downloads', async () => {
  const res = await ro.raw('POST', '/api/eds/fr0600/file', {from: '2026-10-01', to: '2026-10-31', format: 'ffdata', values: {E32: '5'}}, {raw: true});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /FR0600_2026-10-01_2026-10-31\.ffdata/);
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<FFData Version="1" CreatedByApp="Apskaita"/);
  assert.match(xml, /<Form FormDefId="\{0AC6FE8F-6B47-4A22-81C5-8D790D3212B1\}">/);
  assert.match(xml, /<Group Name="Visa forma">\n<ListPages>\n<ListPage>FR0600<\/ListPage>/);
  assert.match(xml, /<Page PageDefName="FR0600" PageNumber="1">\n<Fields Count="45">/);
  for (const [k, x] of [['E11', '150'], ['E32', '5'], ['E36', '24'], ['E12', ''], ['B_ML_DataNuo', '2026-10-01'], ['E8', 'B_Pirmine'], ['B_FormVerNr', '03']]) assert.ok(xml.includes(`<Field Name="${k}">${x}</Field>`), `${k}=${x}`);
  assert.equal((xml.match(/<Field Name=/g) || []).length, 45);
  const pdf = await ro.raw('POST', '/api/eds/fr0600/file', {from: '2026-10-01', to: '2026-10-31', format: 'pdf'}, {raw: true});
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const bad = await ro.post('/api/eds/fr0600/file', {from: '2026-10-01', to: '2026-10-31', values: {E12: 'abc'}});
  assert.equal(bad.status, 400);
  assert.ok(toFFData({}, {today: '2026-10-11'}).includes('CreatedOn="2026-10-11"'));
});
