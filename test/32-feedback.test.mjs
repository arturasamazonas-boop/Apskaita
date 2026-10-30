// Fixes from the accountant's feedback (1_dalis.docx).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';

let t, acc, admin;
before(async () => { t = await startTestApp(); acc = await t.client('accountant').login(); admin = await t.client('admin').login(); });
after(async () => t.close());

test('GPM313 for October: September pay paid in October plus the final pay of someone who left in October', async () => {
  const stay = (await acc.post('/api/employees', {first_name: 'Jonas', last_name: 'Liekantis', employment_start: '2025-01-01', base_salary: '2000', iban: 'LT121000011101001000'})).body;
  const leave = (await acc.post('/api/employees', {first_name: 'Ona', last_name: 'Išeinanti', employment_start: '2025-01-01', employment_end: '2026-10-20', base_salary: '1500', iban: 'LT121000011101001000'})).body;
  assert.ok(stay.id && leave.id);
  const sep = (await acc.post('/api/payroll/runs', {period: '2026-09'})).body;
  assert.equal(sep.payment_date, '2026-10-09'); // default: 10 October is a Saturday → Friday 9 October (never late)
  const oct = (await acc.post('/api/payroll/runs', {period: '2026-10'})).body;
  assert.equal(oct.payment_date, '2026-11-10');
  const leaving = oct.lines.find((l) => String(l.employee_id) === String(leave.id));
  assert.equal(leaving.payment_date, '2026-10-20');
  assert.equal(oct.lines.find((l) => String(l.employee_id) === String(stay.id)).payment_date, null);
  for (const r of [sep, oct]) assert.equal((await acc.post(`/api/payroll/runs/${r.id}/approve`)).status, 200);
  const g = (await acc.get('/api/eds/gpm313?year=2026&month=10')).body;
  const sepGross = sep.lines.reduce((s, l) => s + Number(l.gross), 0);
  const expected = (sepGross + Number(leaving.gross)).toFixed(2).replace('.', ',');
  assert.equal(g.values.G5, expected, JSON.stringify(g.runs));
  // Someone whose leaving date is entered after the sheet was made, and who is already inactive, still gets the final pay date.
  const late = (await acc.post('/api/employees', {first_name: 'Rimas', last_name: 'Vėlyvas', employment_start: '2025-01-01', base_salary: '1000', iban: 'LT121000011101001000'})).body;
  const nov = (await acc.post('/api/payroll/runs', {period: '2026-11'})).body;
  await acc.put(`/api/employees/${late.id}`, {...(await acc.get(`/api/employees/${late.id}`)).body, employment_end: '2026-11-13', active: false});
  const nov2 = (await acc.put(`/api/payroll/runs/${nov.id}`, {lines: []})).body;
  assert.equal(nov2.lines.find((l) => String(l.employee_id) === String(late.id)).payment_date, '2026-11-13');
  const dec = (await acc.post('/api/payroll/runs', {period: '2026-12'})).body;
  assert.ok(!dec.lines.some((l) => String(l.employee_id) === String(late.id)), 'left in November: not in December');
  await acc.del(`/api/payroll/runs/${nov.id}`); await acc.del(`/api/payroll/runs/${dec.id}`);
  assert.equal((await acc.get('/api/eds/gpm313?year=2026&month=11')).body.values.G5, (Number(oct.lines.find((l) => String(l.employee_id) === String(stay.id)).gross)).toFixed(2).replace('.', ','));
});

test('depreciation: all missing months up to the chosen one in one action, each month its own entry', async () => {
  const c = await acc.post('/api/fixed-assets', {inv_no: 'ST-1', name: 'Staklės', cost_account: '1240', acquisition_date: '2025-12-10', cost: '1200', useful_life_months: 12});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const p = (await acc.get('/api/depreciation/preview?period=2026-09')).body;
  assert.ok(p.blocked.length);
  const r = await acc.post('/api/depreciation/runs', {period: '2026-09', catchUp: true});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.months, r.body.from, r.body.to, r.body.total], [9, '2026-01', '2026-09', '900.00']);
  const again = await acc.post('/api/depreciation/runs', {period: '2026-09', catchUp: true});
  assert.equal(again.status, 422);
  assert.equal((await acc.get('/api/depreciation/runs')).body.filter((x) => x.status === 'posted').length, 9);
});

test('cash orders: correct with the same number, delete only the last one, cash book stays clean', async () => {
  const mk = (b) => acc.post('/api/cash/orders', {purpose: 'other', accountCode: '305', personName: 'Savininkas', basis: 'Įnešimas', ...b});
  const a = (await mk({kind: 'receipt', date: '2026-10-05', amount: '100'})).body;
  const b = (await mk({kind: 'receipt', date: '2026-10-06', amount: '50'})).body;
  assert.ok(a.id && b.id, JSON.stringify([a, b]));
  const ed = await acc.put(`/api/cash/orders/${a.id}`, {purpose: 'other', accountCode: '305', personName: 'Savininkas', basis: 'Įnešimas (pataisyta)', date: '2026-10-05', amount: '80', reason: 'Neteisinga suma'});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.deepEqual([ed.body.number, ed.body.amount], [a.number, '80.00']);
  const book = (await acc.get('/api/cash/book?from=2026-10-01&to=2026-10-31')).body;
  assert.equal(book.closing, '130.00');
  assert.deepEqual(book.days.flatMap((d) => d.rows.map((r) => r.document)), [`${a.series} ${a.number}`, `${b.series} ${b.number}`]);
  assert.equal((await acc.del(`/api/cash/orders/${a.id}`)).status, 409, 'not the last one');
  const d = await acc.del(`/api/cash/orders/${b.id}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const c = (await mk({kind: 'receipt', date: '2026-10-07', amount: '10'})).body;
  assert.equal(c.number, b.number, 'the freed number is used again');
  assert.equal((await acc.get('/api/cash/book?from=2026-10-01&to=2026-10-31')).body.closing, '90.00');
  const pay = (await mk({kind: 'payment', date: '2026-10-08', amount: '85'})).body;
  assert.ok(pay.id, JSON.stringify(pay));
  // Lowering the receipt below what was paid out later would make the cash negative.
  const tooLow = await acc.put(`/api/cash/orders/${a.id}`, {purpose: 'other', accountCode: '305', personName: 'Savininkas', date: '2026-10-05', amount: '20', reason: 'Bandymas'});
  assert.equal(tooLow.status, 422, JSON.stringify(tooLow.body));
});

test('purchase invoice without a "Pardavėjas" label: supplier letterhead, number in the title, "10 vnt." quantities, "PVM (21%)"', async () => {
  const {default: PDFDocument} = await import('pdfkit');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {uploadAndProcess} = await import('./helpers.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), 'tiekejas.pdf');
  await new Promise((res) => {
    const d = new PDFDocument({size: 'A4', margin: 40}); const ws = fs.createWriteStream(file); d.pipe(ws);
    d.registerFont('r', new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url).pathname); d.font('r');
    d.fontSize(10).text('UAB „Biuro tiekimas“', 40, 40); d.fontSize(8).text('Kodas 302222222, PVM mokėtojo kodas LT222222219\nSavanorių pr. 100, LT-03150 Vilnius\nLT601010012345678901 AB SEB bankas', 40, 55);
    d.fontSize(14).text('PVM SĄSKAITA – FAKTŪRA BS-2026/118', 40, 120);
    d.fontSize(9).text('Išrašymo data 2026 m. spalio 20 d.', 40, 140);
    d.text('Gavėjas: UAB Pavyzdinė prekyba, į. k. 305555555, PVM k. LT100015555519', 40, 160);
    let y = 200;
    d.text('Prekė / paslauga', 40, y); d.text('Kiekis', 300, y); d.text('Vnt. kaina', 360, y); d.text('Suma', 470, y); y += 16;
    d.text('Popierius A4 80 g', 40, y); d.text('10 vnt.', 300, y); d.text('4.20', 360, y); d.text('42.00', 470, y); y += 14;
    d.text('Rašikliai mėlyni', 40, y); d.text('20 vnt.', 300, y); d.text('0.55', 360, y); d.text('11.00', 470, y); y += 24;
    d.text('Viso be PVM', 360, y); d.text('53.00', 470, y); y += 14; d.text('PVM (21%)', 360, y); d.text('11.13', 470, y); y += 14; d.text('Mokėti', 360, y); d.text('64.13 EUR', 470, y);
    d.text('Apmokėti iki: 2026-11-03', 40, y + 30);
    d.end(); ws.on('finish', res);
  });
  const r = await uploadAndProcess(t, acc, file);
  const p = r.proposal.data;
  assert.equal(p.register, 'purchase');
  assert.deepEqual([p.number, p.issueDate, p.dueDate], ['BS-2026/118', '2026-10-20', '2026-11-03']);
  assert.deepEqual([p.counterparty.name, p.counterparty.companyCode, p.counterparty.vatCode, p.counterparty.iban, p.counterparty.address],
    ['UAB „Biuro tiekimas“', '302222222', 'LT222222219', 'LT601010012345678901', 'Savanorių pr. 100, LT-03150 Vilnius']);
  assert.deepEqual(p.lines.map((l) => [l.description, l.quantity, l.unit, l.unitPrice, l.sourceNet]), [['Popierius A4 80 g', '10', 'vnt.', '4.20', '42.00'], ['Rašikliai mėlyni', '20', 'vnt.', '0.55', '11.00']]);
  assert.deepEqual([p.sourceTotals.net, p.sourceTotals.vat, p.sourceTotals.gross], ['53.00', '11.13', '64.13']);
});

test('cost of sales with the sale; a return by credit note puts the goods back at the cost of that sale', async () => {
  const prod = (await acc.post('/api/products', {sku: 'GRZ-1', name: 'Gręžtuvas', kind: 'goods', unit: 'vnt.', unit_price: '50', purchase_price: '30', track_stock: true})).body;
  const buy = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'T', number: 'G1', issueDate: '2026-09-01', counterparty: {name: 'UAB Įrankiai', companyCode: '302222222', vatCode: 'LT222222219'}, lines: [{productId: String(prod.id), quantity: '10', unitPrice: '25', taxCode: 'PVM1'}]});
  assert.equal((await acc.post(`/api/proposals/${buy.body.proposal.id}/approve`, {contentHash: buy.body.proposal.content_hash})).status, 200);
  const sale = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-09-10', counterparty: {name: 'UAB Meistras', companyCode: '301111111'}, lines: [{productId: String(prod.id), quantity: '3', unitPrice: '50', taxCode: 'PVM1'}]});
  const ap = (await acc.post(`/api/proposals/${sale.body.proposal.id}/approve`, {contentHash: sale.body.proposal.content_hash})).body;
  assert.equal(ap.cogs, '75.00'); // 3 × 25.00
  const cn = await acc.post(`/api/invoices/${ap.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '1'}], reason: 'Grąžintas 1 vnt.', issueDate: '2026-09-15'});
  assert.equal(cn.status, 200, JSON.stringify(cn.body));
  const p = cn.body.proposal || cn.body;
  const ok = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.cogs, '-25.00');
  const bal = (await t.app.pool.query(`SELECT sum(debit - credit) AS v FROM journal_lines WHERE account_code='6000'`)).rows[0].v;
  assert.equal(bal, '50.00');
});

test('employment contract printed from the employee card', async () => {
  const {execFileSync} = await import('node:child_process');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  await admin.put('/api/settings/company', {...(await admin.get('/api/settings/company')).body, manager: 'Petras Petraitis', manager_title: 'Direktorius', address: 'Gedimino pr. 1, LT-01103 Vilnius'});
  const e = (await acc.post('/api/employees', {first_name: 'Asta', last_name: 'Astaitė', personal_code: '48501011234', address: 'Vilniaus g. 5, Kaunas', position: 'Buhalterė', employment_start: '2026-11-02', base_salary: '1850.50', iban: 'LT121000011101001000'})).body;
  const d = (await acc.get(`/api/employees/${e.id}/contract`)).body;
  assert.equal(d.place, 'Vilnius'); assert.equal(d.employerRep, 'Petras Petraitis');
  const res = await acc.raw('POST', `/api/employees/${e.id}/contract`, {number: 'DS-7', probationMonths: '3'}, {raw: true});
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-')), 'ds.pdf'); fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const text = execFileSync('pdftotext', [file, '-']).toString().replace(/\s+/g, ' ');
  for (const re of [/DARBO SUTARTIS/, /2026 m\. lapkričio 2 d\. Nr\. DS-7/, /Asta Astaitė, asmens kodas 48501011234/, /Buhalterė/, /1 850,50 Eur \(tūkstantis aštuoni šimtai penkiasdešimt eurų 50 ct\)/,
    /Neterminuota darbo sutartis/, /3 mėn\. išbandymo/, /20 darbo dienų/, /kuriam atstovauja direktorius Petras Petraitis/, /lapkričio 2 d\. 2\. Darbo funkcija/]) assert.match(text, re);
  assert.equal((await acc.raw('POST', `/api/employees/${e.id}/contract`, {probationMonths: '6'})).status, 400);
  // Fixed term of 2 months: probation at most 1 month (DK 36 str.); a fixed-term contract needs its end date.
  const ft = (await acc.post('/api/employees', {first_name: 'Tomas', last_name: 'Terminuotas', employment_start: '2026-11-02', employment_end: '2026-12-31', contract_type: 'fixed_term', base_salary: '1200'})).body;
  assert.equal((await acc.raw('POST', `/api/employees/${ft.id}/contract`, {probationMonths: '2'})).status, 400);
  assert.equal((await acc.raw('POST', `/api/employees/${ft.id}/contract`, {probationMonths: '1', employerRep: null}, {raw: true})).status, 200);
});
