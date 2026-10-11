// GPM313 as in VMI EDS: payroll by payment month, GPM split at the 15th, decimal fields, FFData and PDF.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';
import {GPM313, applyGpm313Edits} from '../src/reports/eds-gpm313.mjs';
import {placements} from '../src/reports/eds-forms.mjs';

let t, acc, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  assert.equal((await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Jonaitis', employment_start: '2025-01-01', base_salary: '2000'})).status, 200);
  // August pay on 10 September (≤ 15th), September pay on 30 September (> 15th).
  for (const [period, payment_date] of [['2026-08', '2026-09-10'], ['2026-09', '2026-09-30']]) {
    const r = await acc.post('/api/payroll/runs', {period, payment_date});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await acc.post(`/api/payroll/runs/${r.body.id}/approve`)).status, 200);
  }
});
after(() => t?.close());

test('GPM313 layout from the VMI template', () => {
  assert.equal(GPM313.formCode, 'GPM313');
  assert.equal(GPM313.formDefId, '{EB03E9EF-39B0-457F-8264-79E86F053009}');
  assert.deepEqual(GPM313.fields.map((f) => f.name), ['B_MM_ID', 'B_MM_Pavadinimas', 'B_ML_Metai', 'B_ML_Menuo', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'B_FormNr', 'B_FormVerNr']);
});

test('September payouts: field 5 gross, 6 GPM up to the 15th, 7 after the 15th', async () => {
  const r = await ro.get('/api/eds/gpm313?year=2026&month=9');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.values;
  const runs = r.body.runs;
  assert.equal(runs.length, 2);
  const gpm = runs.map((x) => x.gpm);
  assert.deepEqual([v.G5, v.G6, v.G7], ['4000,00', gpm[0].replace('.', ','), gpm[1].replace('.', ',')]);
  assert.deepEqual([v.B_ML_Metai, v.B_ML_Menuo, v.B_FormNr, v.B_FormVerNr, v.G8], ['2026', '9', 'GPM313', '01', '']);
  // "4000,00" → digits in the last 6 of 14 cells (the comma is printed on the form).
  const g5 = r.body.placements.find((p) => p.name === 'G5');
  assert.equal(g5.chars.map(([, ch]) => ch).join(''), '400000');
  const cells = GPM313.fields.find((f) => f.name === 'G5').cells.map(String);
  assert.equal(cells.indexOf(String(g5.chars.at(-1)[0])), 13);
  assert.equal((await ro.get('/api/eds/gpm313?year=2026&month=13')).status, 400);
});

test('edits, FFData and PDF', async () => {
  const base = Object.fromEntries(GPM313.fields.map((f) => [f.name, '']));
  assert.equal(applyGpm313Edits(base, {G11: '150.5'}).G11, '150,50');
  assert.throws(() => applyGpm313Edits(base, {G11: '-5'}), /suma eurais/);
  assert.equal(placements(GPM313, {G11: '150,50'})[0].chars.map(([, c]) => c).join(''), '15050');
  const res = await ro.raw('POST', '/api/eds/gpm313/file', {year: 2026, month: 9, format: 'ffdata', values: {G11: '100', G12: '15'}}, {raw: true});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /GPM313_2026-09\.ffdata/);
  const xml = await res.text();
  assert.match(xml, /<Form FormDefId="\{EB03E9EF-39B0-457F-8264-79E86F053009\}">/);
  assert.match(xml, /<Page PageDefName="GPM313" PageNumber="1">\n<Fields Count="14">/);
  for (const s of ['<Field Name="G5">4000,00</Field>', '<Field Name="G11">100,00</Field>', '<Field Name="G12">15,00</Field>', '<Field Name="B_ML_Menuo">9</Field>']) assert.ok(xml.includes(s), s);
  const pdf = await ro.raw('POST', '/api/eds/gpm313/file', {year: 2026, month: 9, format: 'pdf'}, {raw: true});
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});
