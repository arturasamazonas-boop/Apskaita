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

test('year-end closing into 341 keeps the P&L and the balance consistent; transfer to 342', async () => {
  const st = (await ro.get('/api/year-end?year=2025')).body;
  assert.deepEqual([st.result, st.open, st.accounts.length], ['600.00', true, 2]);
  const c = await acc.post('/api/year-end/close', {year: 2025});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await acc.post('/api/year-end/close', {year: 2025})).status, 409);
  const e = (await ro.get(`/api/journal/${c.body.entryId}`)).body;
  assert.deepEqual(e.lines.map((l) => [l.account_code, l.debit, l.credit]).sort(), [['341', '0.00', '600.00'], ['5001', '1000.00', '0.00'], ['6300', '0.00', '400.00']]);
  // The statements still show the year's result: closing entries are not income or expense.
  const p = (await ro.get('/api/rc-package?year=2025&category=maza')).body;
  assert.ok(p.checks.some((x) => x.level === 'ok' && /Grynasis pelnas \(600\.00\)/.test(x.message)), JSON.stringify(p.checks));
  assert.ok(!p.checks.some((x) => x.level === 'error'), JSON.stringify(p.checks));
  const pl = (await ro.get('/api/reports/profit-loss?from=2025-01-01&to=2025-12-31')).body;
  assert.equal(pl.totals.result, '600.00');
  // 2026: the 341 balance is a prior-year result (balance D5.2), not this year's (D5.1).
  const t = await acc.post('/api/year-end/transfer', {year: 2025});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const bal = (await ro.get('/api/statements/balansas?to=2026-12-31&precision=cents')).body;
  const line = (id) => bal.lines.find((l) => l.id === id).current;
  assert.deepEqual([line('D5.1'), line('D5.2')], ['0.00', '600.00']);
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
