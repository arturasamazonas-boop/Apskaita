// Financial statements in the VAS forms (balance sheet 2 VAS annexes 1–3, P&L 3 VAS annexes 1–2), prior-period values, PDF.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';

let t, acc, ro;
const line = (st, id) => st.lines.find((l) => l.id === id);
async function post(date, description, lines) {
  const r = await acc.post('/api/journal', {date, description, lines});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  // 2025: capital 2500 paid in, equipment, a sale and costs; 2026: more activity.
  await post('2025-01-10', 'Įstatinis kapitalas', [{account: '2710', debit: '2500'}, {account: '3011', credit: '2500'}]);
  await post('2025-03-01', 'Įranga', [{account: '1240', debit: '1200'}, {account: '2710', credit: '1200'}]);
  await post('2025-06-30', 'Pardavimas', [{account: '2410', debit: '1210'}, {account: '5001', credit: '1000'}, {account: '4492', credit: '210'}]);
  await post('2025-07-15', 'Nuoma', [{account: '6300', debit: '400'}, {account: '443', credit: '400'}]);
  await post('2025-12-31', 'Nusidėvėjimas', [{account: '6306', debit: '240'}, {account: '1247', credit: '240'}]);
  await post('2026-02-01', 'Prekės', [{account: '204', debit: '500.40'}, {account: '443', credit: '500.40'}]);
  await post('2026-03-01', 'Prekių pardavimas', [{account: '2710', debit: '900'}, {account: '5000', credit: '900'}]);
  await post('2026-03-31', 'Savikaina', [{account: '6000', debit: '300.20'}, {account: '204', credit: '300.20'}]);
  await post('2026-04-30', 'DU', [{account: '6304', debit: '1035.40'}, {account: '4480', credit: '676.39'}, {account: '4481', credit: '166.81'}, {account: '4482', credit: '192.20'}]);
  await post('2026-05-31', 'Palūkanos', [{account: '6802', debit: '12.50'}, {account: '2710', credit: '12.50'}]);
});
after(async () => t.close());

test('full balance sheet (2 VAS annex 1): lines, current-year result, previous year, totals agree', async () => {
  const st = (await ro.get('/api/statements/balansas?to=2026-06-30&precision=cents')).body;
  assert.equal(st.form.annex, '1 priedas');
  assert.deepEqual(st.period, {from: '2026-01-01', to: '2026-06-30'}); assert.equal(st.previousPeriod.to, '2025-12-31');
  assert.equal(line(st, 'A2.5').current, '960.00', 'equipment net of depreciation');
  assert.equal(line(st, 'B1.4').current, '200.20');
  assert.equal(line(st, 'B2.1').current, '1210.00');
  assert.equal(line(st, 'B4').current, '2187.50');
  assert.equal(line(st, 'D1.1').current, '2500.00');
  assert.equal(line(st, 'D5.1').current, '-448.10', '900 − 300.20 − 1035.40 − 12.50');
  assert.equal(line(st, 'D5.2').current, '360.00', '2025 result 1000 − 400 − 240');
  assert.equal(line(st, 'G2.4').current, '900.40');
  assert.equal(line(st, 'G2.9').current, '1035.40');
  assert.equal(line(st, 'G2.10').current, '210.00');
  assert.equal(line(st, 'TA').current, line(st, 'TL').current);
  assert.equal(line(st, 'TA').current, '4557.70');
  assert.equal(line(st, 'D5.1').previous, '360.00', 'previous year: its own result is the current-year result');
  assert.equal(line(st, 'TA').previous, line(st, 'TL').previous);
  assert.deepEqual(st.checks, []);
});

test('short and micro balance sheets and whole-euro rounding', async () => {
  const s = (await ro.get('/api/statements/balansas-sutrumpintas?to=2026-06-30')).body;
  assert.equal(line(s, 'B1').current, '200.00'); assert.equal(line(s, 'D5').current, '-88.00'); assert.equal(line(s, 'G2').current, '2146.00');
  assert.equal(line(s, 'TA').current, '4558.00');
  const m = (await ro.get('/api/statements/balansas-trumpas?to=2026-06-30&precision=cents')).body;
  assert.equal(line(m, 'B2').current, '3397.50', 'receivables + cash'); assert.equal(line(m, 'D').current, '2411.90');
  assert.equal(line(m, 'TA').current, line(m, 'TL').current);
  assert.equal(m.lines.some((l) => l.id === 'D9'), false, 'helper lines are not shown');
});

test('P&L full (3 VAS annex 1) and micro (annex 2) reconcile to the same net result', async () => {
  const p = (await ro.get('/api/statements/pelno-nuostoliu?from=2026-01-01&to=2026-12-31&precision=cents')).body;
  assert.deepEqual(['1', '2', '4', '6', '12', '13', '15'].map((id) => line(p, id).current), ['900.00', '-300.20', '599.80', '-1035.40', '-12.50', '-448.10', '-448.10']);
  assert.deepEqual(['1', '6', '15'].map((id) => line(p, id).previous), ['1000.00', '-640.00', '360.00']);
  const m = (await ro.get('/api/statements/pelno-nuostoliu-trumpa?from=2026-01-01&to=2026-12-31&precision=cents')).body;
  assert.deepEqual(['1', '3', '4', '5', '6', '7', '9'].map((id) => line(m, id).current), ['900.00', '-500.40', '200.20', '-1035.40', '0.00', '-12.50', '-448.10']);
  assert.equal(line(m, '6').previous, '-240.00'); assert.equal(line(m, '7').previous, '-400.00');
  assert.deepEqual(m.checks, []);
});

test('unmapped accounts are reported, prior-period values can be entered by hand', async () => {
  // Previous year entered by hand (books kept elsewhere before).
  const bad = await acc.put('/api/statements/balansas-sutrumpintas/prior', {periodEnd: '2025-12-31', values: {TA: '1'}});
  assert.equal(bad.status, 400, 'totals cannot be overridden');
  assert.equal((await ro.put('/api/statements/balansas-sutrumpintas/prior', {periodEnd: '2025-12-31', values: {B4: '1'}})).status, 403);
  assert.equal((await acc.put('/api/statements/balansas-sutrumpintas/prior', {periodEnd: '2025-12-31', values: {B4: '1 000,50', D1: '1000.50'}})).status, 200);
  const s = (await ro.get('/api/statements/balansas-sutrumpintas?to=2026-06-30&precision=cents')).body;
  assert.equal(line(s, 'B4').previous, '1000.50'); assert.equal(line(s, 'B4').priorOverridden, true);
  assert.equal(line(s, 'B').previous, money(Number(line(s, 'B1').previous) + Number(line(s, 'B2').previous) + Number(line(s, 'B3').previous) + 1000.5));
  await acc.put('/api/statements/balansas-sutrumpintas/prior', {periodEnd: '2025-12-31', values: {B4: '', D1: null}});
  assert.equal(line((await ro.get('/api/statements/balansas-sutrumpintas?to=2026-06-30&precision=cents')).body, 'B4').priorOverridden, false);
});

test('PDF export of a form', async () => {
  const r = await ro.get('/api/statements/pelno-nuostoliu/pdf?from=2026-01-01&to=2026-12-31&number=3&managerName=Jonas%20Jonaitis', {raw: true});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 10000);
  assert.equal((await ro.get('/api/statements/nera')).status, 404);
});

function money(n) { return n.toFixed(2); }
