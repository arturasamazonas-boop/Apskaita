// Annual financial statements set for Registrų centras: forms by size category, cross-form checks, PDF set and line export.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {startTestApp} from './helpers.mjs';

let t, acc, ro;
async function post(date, description, lines) {
  const r = await acc.post('/api/journal', {date, description, lines});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  await post('2025-01-10', 'Kapitalas', [{account: '2710', debit: '2500'}, {account: '3011', credit: '2500'}]);
  await post('2025-06-30', 'Pardavimas', [{account: '2410', debit: '1210'}, {account: '5001', credit: '1000'}, {account: '4492', credit: '210'}]);
  await post('2025-07-15', 'Nuoma', [{account: '6300', debit: '400'}, {account: '443', credit: '400'}]);
});
after(() => t?.close());

test('size category, required forms and RC checks', async () => {
  const r = await ro.get('/api/rc-package?year=2025');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body;
  assert.equal(p.category, 'labai-maza');
  assert.deepEqual(p.forms, ['balansas-trumpas', 'pelno-nuostoliu-trumpa']);
  assert.deepEqual([p.size.assets, p.size.revenue], [3710, 1000]);
  assert.ok(p.checks.some((c) => c.level === 'ok' && /Grynasis pelnas \(600\.00\)/.test(c.message)), JSON.stringify(p.checks));
  assert.ok(!p.checks.some((c) => c.level === 'error'));
  assert.equal(p.deadlines.approveBy, '2026-04-30');
  // A medium company set: full balance, P&L, cash flow and equity; cash and equity cross-checks pass.
  const m = (await ro.get('/api/rc-package?year=2025&category=vidutine')).body;
  assert.deepEqual(m.forms, ['balansas', 'pelno-nuostoliu', 'pinigu-srautai', 'nuosavo-kapitalo-pokyciai']);
  assert.ok(!m.checks.some((c) => c.level === 'error'), JSON.stringify(m.checks));
  // Choosing an alternative form allowed for the category; forms not allowed are dropped.
  const alt = (await ro.get('/api/rc-package?year=2025&category=maza&forms=balansas,pelno-nuostoliu,pinigu-srautai')).body;
  assert.deepEqual(alt.forms, ['balansas', 'pelno-nuostoliu']);
  assert.equal((await ro.get('/api/rc-package?year=abc')).status, 400);
});

test('result closed into 341 before the year end is flagged', async () => {
  await post('2025-12-31', 'Rezultato uždarymas', [{account: '5001', debit: '1000'}, {account: '6300', credit: '400'}, {account: '341', credit: '600'}]);
  const p = (await ro.get('/api/rc-package?year=2025&category=maza')).body;
  assert.ok(p.checks.some((c) => c.level === 'error' && /nesutampa su balanso „Ataskaitinių metų pelnas/.test(c.message)), JSON.stringify(p.checks));
  await post('2025-12-31', 'Uždarymo atšaukimas', [{account: '5001', credit: '1000'}, {account: '6300', debit: '400'}, {account: '341', debit: '600'}]);
});

test('set as one PDF and line data for the RC e-form', async () => {
  const pdf = await ro.get('/api/rc-package/file?year=2025&category=vidutine&format=pdf', {raw: true});
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const doc = await PDFDocument.load(Buffer.from(await pdf.arrayBuffer()));
  assert.ok(doc.getPageCount() >= 4, `pages ${doc.getPageCount()}`);
  const csv = await (await ro.get('/api/rc-package/file?year=2025&format=csv', {raw: true})).text();
  assert.match(csv, /Forma;Eil\. Nr\.;Straipsnis;Finansiniai metai;Praėję finansiniai metai/);
  assert.match(csv, /TURTO IŠ VISO;3710,00;0,00/);
  const x = await ro.get('/api/rc-package/file?year=2025&format=xlsx', {raw: true});
  assert.match(x.headers.get('content-disposition'), /FA_rinkinys_2025\.xlsx/);
});
