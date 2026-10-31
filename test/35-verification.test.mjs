// Findings of the second verification round: stock value after returns, cost of a sale in a confirmed month,
// sales invoice drafts and header-only corrections, payroll leavers and pay dates, contract checks, locked depreciation.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startTestApp} from './helpers.mjs';

let t, acc, admin;
before(async () => { t = await startTestApp(); acc = await t.client('accountant').login(); admin = await t.client('admin').login(); });
after(async () => t.close());

let n = 0;
const supplier = {name: 'UAB Tiekėjas', companyCode: '302222222', vatCode: 'LT222222219'};
const buyer = {name: 'UAB Pirkėjas', companyCode: '301111111'};
const approve = async (p) => { const r = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const invoice = async (register, date, lines, extra = {}) => {
  const d = await acc.post('/api/manual-invoices', {register, ...(register === 'purchase' && {series: 'VT', number: `V${++n}`}), issueDate: date, counterparty: register === 'sales' ? buyer : supplier,
    lines: lines.map((l) => ({taxCode: 'PVM1', ...l})), ...extra});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  return d.body.proposal;
};
const balance = async (code) => (await t.app.pool.query(`SELECT coalesce(sum(debit - credit),0) AS v FROM journal_lines WHERE account_code=$1`, [code])).rows[0].v;
const stockValue = async (sku) => (await acc.get('/api/stock?asOf=2026-12-31')).body.items.find((x) => x.sku === sku);
const pdfText = async (invoiceId) => {
  await t.drain();
  const {url} = (await acc.get(`/api/invoices/${invoiceId}/pdf-link`)).body;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')), 'i.pdf');
  fs.writeFileSync(file, Buffer.from(await (await acc.raw('GET', url, null, {raw: true})).arrayBuffer()));
  return execFileSync('pdftotext', ['-layout', file, '-']).toString();
};

test('returns keep the stock value equal to the inventory account (customer credit note, return to the supplier)', async () => {
  const p = (await acc.post('/api/products', {sku: 'RT-1', name: 'RT-1', kind: 'goods', unit: 'vnt.', track_stock: true})).body;
  const line = (q, price) => ({productId: String(p.id), quantity: q, unitPrice: price});
  await approve(await invoice('purchase', '2026-03-01', [line('10', '10')]));
  const sale = await approve(await invoice('sales', '2026-03-02', [line('4', '30')]));
  assert.equal(sale.cogs, '40.00');
  await approve(await invoice('purchase', '2026-03-03', [line('10', '20')])); // 6 @ 10 + 10 @ 20
  // The customer returns 2: they come back at the cost of that sale (10), not at today's average.
  const cn = await acc.post(`/api/invoices/${sale.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '2'}], reason: 'Grąžinimas', issueDate: '2026-03-04'});
  assert.equal(cn.status, 200, JSON.stringify(cn.body));
  await approve(cn.body.proposal || (await acc.get(`/api/proposals/${cn.body.proposalId}`)).body);
  let s = await stockValue('RT-1');
  assert.equal(s.value, await balance('204'));
  // Return 5 to the supplier at their own price (20).
  const ret = await invoice('purchase', '2026-03-05', [line('5', '20')]);
  const ed = (await acc.put(`/api/proposals/${ret.id}`, {contentHash: ret.content_hash, data: {...ret.data, docType: 'credit_note', relatedDocument: 'VT V2', lines: ret.data.lines.map((l) => ({...l, quantity: '-5'}))}})).body;
  await approve(ed);
  s = await stockValue('RT-1');
  assert.equal(s.value, await balance('204'));
  // Selling everything left empties the account.
  await approve(await invoice('sales', '2026-03-06', [line(String(Number(s.stock)), '30')]));
  assert.equal(await balance('204'), '0.00');
});

test('a new sale in a month whose cost of sales is already confirmed gets its cost at once; selling more than in stock is reported', async () => {
  await admin.put('/api/settings/company', {...(await admin.get('/api/settings/company')).body, auto_cogs: false});
  try {
    const p = (await acc.post('/api/products', {sku: 'CM-1', name: 'CM-1', kind: 'goods', unit: 'vnt.', track_stock: true})).body;
    const line = (q, price) => ({productId: String(p.id), quantity: q, unitPrice: price});
    await approve(await invoice('purchase', '2026-07-01', [line('5', '10')]));
    assert.equal((await acc.post('/api/cogs/confirm', {period: '2026-07', note: 'Patikrinta'})).status, 200);
    const late = await approve(await invoice('sales', '2026-07-20', [line('2', '30')]));
    assert.equal(late.cogs, '20.00');
    const over = await approve(await invoice('sales', '2026-07-21', [line('4', '30')]));
    assert.deepEqual(over.cogsShort, ['CM-1']);
  } finally {
    await admin.put('/api/settings/company', {...(await admin.get('/api/settings/company')).body, auto_cogs: true});
  }
});

test('a sales draft edited before approval keeps its series and notes; a correction may change only the due date and notes', async () => {
  const d = await invoice('sales', '2026-10-01', [{description: 'Paslauga', quantity: '1', unitPrice: '100'}], {dueDate: '2026-10-15', notes: 'Ačiū, kad perkate'});
  const ed = await acc.put(`/api/proposals/${d.id}`, {contentHash: d.content_hash, data: {...d.data, lines: d.data.lines.map((l) => ({...l, unitPrice: '110'}))}});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.data.issueHere, true); assert.equal(ed.body.data.notes, 'Ačiū, kad perkate');
  const s = await approve(ed.body);
  assert.match(await pdfText(s.invoiceId), /Ačiū, kad perkate/);
  // Header-only correction: nothing to post, a new PDF with the new due date and notes.
  const c = (await acc.post(`/api/invoices/${s.invoiceId}/correct`, {})).body;
  const p = (await acc.get(`/api/proposals/${c.proposalId}`)).body;
  const e2 = (await acc.put(`/api/proposals/${p.id}`, {contentHash: p.content_hash, data: {...p.data, dueDate: '2026-10-31', notes: 'Terminas pratęstas'}})).body;
  const r = await approve(e2);
  assert.equal(r.journalEntryId, null);
  const card = (await acc.get(`/api/invoices/${s.invoiceId}`)).body;
  assert.equal(card.corrected.dueDate, '2026-10-31'); assert.equal(card.corrected.gross, '133.10');
  assert.equal(card.change.annulled, false);
  const text = await pdfText(s.invoiceId);
  assert.match(text, /Terminas pratęstas/); assert.match(text, /Pataisyta/);
  // The same again changes nothing: refused.
  const c2 = (await acc.post(`/api/invoices/${s.invoiceId}/correct`, {})).body;
  const p2 = (await acc.get(`/api/proposals/${c2.proposalId}`)).body;
  const no = await acc.post(`/api/proposals/${p2.id}/approve`, {contentHash: p2.content_hash});
  assert.equal(no.status, 422);
  await acc.post(`/api/proposals/${p2.id}/reject`, {contentHash: p2.content_hash, reason: 'Nereikia'});
  // The card shows the corrected lines and totals.
  const c3 = (await acc.post(`/api/invoices/${s.invoiceId}/correct`, {})).body;
  const p3 = (await acc.get(`/api/proposals/${c3.proposalId}`)).body;
  await approve((await acc.put(`/api/proposals/${p3.id}`, {contentHash: p3.content_hash, data: {...p3.data, lines: p3.data.lines.map((l) => ({...l, quantity: '2'}))}})).body);
  const card2 = (await acc.get(`/api/invoices/${s.invoiceId}`)).body;
  assert.deepEqual([card2.currentLines.length, Number(card2.currentLines[0].quantity), card2.corrected.gross], [1, 2, '266.20']);
});

test('a fully credited invoice is not shown as annulled', async () => {
  const s = await approve(await invoice('sales', '2026-10-02', [{description: 'Prekė', quantity: '1', unitPrice: '50'}]));
  const cn = await acc.post(`/api/invoices/${s.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '1'}], reason: 'Grąžinta', issueDate: '2026-10-03'});
  await approve(cn.body.proposal || (await acc.get(`/api/proposals/${cn.body.proposalId}`)).body);
  const card = (await acc.get(`/api/invoices/${s.invoiceId}`)).body;
  assert.equal(card.change.annulled, false);
  assert.match(card.change.blockers.join(' '), /kreditinė/);
});

test('payroll: someone leaving next month is on this month\'s sheet; a chosen pay date stays; worked days follow a later end date; holidays move the pay day', async () => {
  const mk = async (b) => (await acc.post('/api/employees', {employment_start: '2025-01-01', base_salary: '1500', iban: 'LT121000011101001000', ...b})).body;
  const early = await mk({first_name: 'Asta', last_name: 'Ankstyva', employment_end: '2027-02-05', active: false});
  const run = (await acc.post('/api/payroll/runs', {period: '2027-01'})).body;
  assert.ok(run.lines.some((l) => String(l.employee_id) === String(early.id)), 'January pay of someone leaving in February');
  await acc.del(`/api/payroll/runs/${run.id}`);
  // A leaver paid together with the payroll: the date equal to the sheet's pay date is kept.
  const feb = (await acc.post('/api/payroll/runs', {period: '2027-02'})).body;
  const line = feb.lines.find((l) => String(l.employee_id) === String(early.id));
  assert.equal(line.payment_date, '2027-02-05');
  const kept = (await acc.put(`/api/payroll/runs/${feb.id}`, {lines: [{employee_id: early.id, payment_date: feb.payment_date}]})).body;
  assert.equal(kept.lines.find((l) => String(l.employee_id) === String(early.id)).payment_date, feb.payment_date);
  const again = (await acc.put(`/api/payroll/runs/${feb.id}`, {lines: []})).body;
  assert.equal(again.lines.find((l) => String(l.employee_id) === String(early.id)).payment_date, feb.payment_date);
  await acc.del(`/api/payroll/runs/${feb.id}`);
  // End date entered after the sheet was made: worked days cut to the end date.
  const late = await mk({first_name: 'Rokas', last_name: 'Vėlesnis'});
  const mar = (await acc.post('/api/payroll/runs', {period: '2027-03'})).body;
  await acc.put(`/api/employees/${late.id}`, {...(await acc.get(`/api/employees/${late.id}`)).body, employment_end: '2027-03-12'});
  const mar2 = (await acc.put(`/api/payroll/runs/${mar.id}`, {lines: []})).body;
  const l2 = mar2.lines.find((l) => String(l.employee_id) === String(late.id));
  assert.deepEqual([l2.payment_date, Number(l2.worked_days)], ['2027-03-12', 9]);
  await acc.del(`/api/payroll/runs/${mar.id}`);
  // 10 April 2034 is Easter Monday: the proposed pay day is Friday 7 April.
  assert.equal((await acc.get('/api/payroll/working-days?period=2034-03')).body.payment_date, '2034-04-07');
});

test('employment contract: DK 36 compares the term with six calendar months; real dates only', async () => {
  const fixed = (await acc.post('/api/employees', {first_name: 'Tomas', last_name: 'Terminuotas', employment_start: '2027-03-01', employment_end: '2027-08-30', contract_type: 'fixed_term', base_salary: '1200'})).body;
  const c = (b) => acc.raw('POST', `/api/employees/${fixed.id}/contract`, b, {raw: true});
  assert.equal((await c({probationMonths: '3'})).status, 400); // shorter than 6 months: at most half
  assert.equal((await c({probationMonths: '2'})).status, 200);
  assert.equal((await c({date: '2026-13-45'})).status, 400);
  const open = (await acc.post('/api/employees', {first_name: 'Nora', last_name: 'Neterminuota', employment_start: '2026-11-01', employment_end: '2026-12-15', base_salary: '1200'})).body;
  assert.equal((await acc.raw('POST', `/api/employees/${open.id}/contract`, {probationMonths: '2'}, {raw: true})).status, 200);
});

test('depreciation in a locked period says from which month it can be calculated', async () => {
  const a = await acc.post('/api/fixed-assets', {inv_no: 'LK-1', name: 'Užrakintas', cost_account: '1240', acquisition_date: '2026-01-10', cost: '1200', useful_life_months: 12});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await admin.post('/api/settings/lock-period', {lockedThrough: '2026-03-31'})).status, 200);
  try {
    const r = await acc.post('/api/depreciation/runs', {period: '2026-06', catchUp: true});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /užrakintas iki 2026-03-31/); assert.match(r.body.error, /nuo 2026-04/);
    assert.doesNotMatch(r.body.error, /PERIOD_LOCKED/);
  } finally {
    await admin.post('/api/settings/lock-period', {lockedThrough: null});
  }
});

test('cash order history shows what changed; a deleted order keeps its number on the card; ledger exports are not cut', async () => {
  const mk = (b) => acc.post('/api/cash/orders', {purpose: 'other', accountCode: '305', personName: 'Savininkas', basis: 'Įnešimas', kind: 'receipt', ...b});
  const a = (await mk({date: '2026-11-05', amount: '100'})).body;
  const ed = await acc.put(`/api/cash/orders/${a.id}`, {purpose: 'other', accountCode: '305', personName: 'Savininkas', basis: 'Įnešimas', date: '2026-11-05', amount: '80', reason: 'Neteisinga suma'});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const card = (await acc.get(`/api/cash/orders/${a.id}`)).body;
  assert.equal(card.revisions[0].changes, 'Suma: 100.00 → 80.00');
  assert.equal(card.cash_account, a.cash_account, 'stays in its cash account');
  const del = await acc.del(`/api/cash/orders/${a.id}`, {reason: 'Įvesta per klaidą'});
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const gone = (await acc.get(`/api/cash/orders/${a.id}`)).body;
  assert.equal(gone.display_number, a.number);
  const {generalLedger} = await import('../src/reports/reports.mjs');
  const all = await generalLedger(t.app.pool, {account: '', from: '2026-01-01', to: '2026-12-31', today: '2026-12-31', limit: Infinity});
  const page = await generalLedger(t.app.pool, {account: '', from: '2026-01-01', to: '2026-12-31', today: '2026-12-31', limit: 5});
  assert.ok(all.rows.length > 5 && page.rows.length === 5);
});

test('round 3: six-month term is not shorter than six months; end before start refused; a leaver\'s automatic date follows the end date', async () => {
  const six = (await acc.post('/api/employees', {first_name: 'Šešis', last_name: 'Mėnesiai', employment_start: '2026-09-01', employment_end: '2027-02-28', contract_type: 'fixed_term', base_salary: '1200'})).body;
  assert.equal((await acc.raw('POST', `/api/employees/${six.id}/contract`, {probationMonths: '3'}, {raw: true})).status, 200);
  assert.equal((await acc.post('/api/employees', {first_name: 'Atgal', last_name: 'Datos', employment_start: '2026-09-01', employment_end: '2026-08-01', base_salary: '1200'})).status, 400);
  assert.equal((await acc.post('/api/employees', {first_name: 'Per', last_name: 'Daug', employment_start: '2026-09-01', hours_per_week: '200', base_salary: '1200'})).status, 400);
  const e = (await acc.post('/api/employees', {first_name: 'Judrus', last_name: 'Išėjimas', employment_start: '2025-01-01', base_salary: '1500'})).body;
  const run = (await acc.post('/api/payroll/runs', {period: '2028-03'})).body;
  const card = async (end) => acc.put(`/api/employees/${e.id}`, {...(await acc.get(`/api/employees/${e.id}`)).body, employment_end: end});
  const lineOf = (r) => r.lines.find((l) => String(l.employee_id) === String(e.id));
  await card('2028-03-10');
  let r = (await acc.put(`/api/payroll/runs/${run.id}`, {lines: []})).body;
  assert.deepEqual([lineOf(r).payment_date, Number(lineOf(r).worked_days)], ['2028-03-10', 8]);
  await card('2028-03-24'); // moved later in the month: date and days follow
  r = (await acc.put(`/api/payroll/runs/${run.id}`, {lines: []})).body;
  assert.deepEqual([lineOf(r).payment_date, Number(lineOf(r).worked_days)], ['2028-03-24', 18]);
  await card('2028-04-15'); // postponed to next month: paid with the payroll again, full month
  r = (await acc.put(`/api/payroll/runs/${run.id}`, {lines: []})).body;
  assert.deepEqual([lineOf(r).payment_date, Number(lineOf(r).worked_days)], [null, Number(r.norm_days)]);
  await card('2028-02-20'); // left before this month: the sheet warns
  r = (await acc.get(`/api/payroll/runs/${run.id}`)).body;
  assert.ok(r.warnings.some((w) => /Judrus Išėjimas/.test(w)));
  await acc.del(`/api/payroll/runs/${run.id}`);
});

test('round 3: selling all leaves 0.00 despite rounding; a purchase entered later re-prices a sale made before it; stock = ledger', async () => {
  const p = (await acc.post('/api/products', {sku: 'R3-1', name: 'R3-1', kind: 'goods', unit: 'vnt.', track_stock: true})).body;
  const line = (q, price) => ({productId: String(p.id), quantity: q, unitPrice: price});
  // This product's part of the inventory account: entries of its invoices and of its cost adjustments.
  const bal = async (to) => (await t.app.pool.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code='204' AND e.entry_date <= $1
    AND (e.id IN (SELECT i.journal_entry_id FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.id WHERE il.product_id=$2) OR e.id IN (SELECT journal_entry_id FROM stock_cost_adjustments WHERE product_id=$2))`, [to, p.id])).rows[0].v;
  const value = async (asOf) => (await acc.get(`/api/stock?asOf=${asOf}`)).body.items.find((x) => x.sku === 'R3-1').value;
  await approve(await invoice('purchase', '2026-08-01', [line('100', '0.33')]));
  await approve(await invoice('purchase', '2026-08-02', [line('200', '0.335')]));
  const all = await approve(await invoice('sales', '2026-08-03', [line('300', '1')]));
  assert.equal(all.cogs, '100.00');
  // Sold before the purchase invoice was entered: costed at the last known price, re-priced when it arrives.
  const short = await approve(await invoice('sales', '2026-09-10', [line('5', '10')]));
  assert.deepEqual(short.cogsShort, ['R3-1']);
  await approve(await invoice('purchase', '2026-09-05', [line('6', '10')]));
  const next = await approve(await invoice('sales', '2026-09-20', [line('1', '10')]));
  assert.equal(next.cogs, '10.00');
  for (const d of ['2026-08-31', '2026-09-30']) assert.equal(await bal(d), await value(d));
});

test('round 3: a corrected due date reaches receivables; a correction cannot change the number; same-day loan events in any order', async () => {
  const s = await approve(await invoice('sales', '2026-10-05', [{description: 'Paslauga', quantity: '1', unitPrice: '100'}], {dueDate: '2026-10-10'}));
  const c = (await acc.post(`/api/invoices/${s.invoiceId}/correct`, {})).body;
  const p = (await acc.get(`/api/proposals/${c.proposalId}`)).body;
  await approve((await acc.put(`/api/proposals/${p.id}`, {contentHash: p.content_hash, data: {...p.data, dueDate: '2026-11-30', paymentReference: 'NAUJA-REF'}})).body);
  const {invoiceBalances} = await import('../src/ledger/balances.mjs');
  const [b] = await invoiceBalances(t.app.pool, {ids: [s.invoiceId]});
  assert.deepEqual([String(b.due_date).slice(0, 10), b.payment_reference], ['2026-11-30', 'NAUJA-REF']);
  const c2 = (await acc.post(`/api/invoices/${s.invoiceId}/correct`, {})).body;
  const p2 = (await acc.get(`/api/proposals/${c2.proposalId}`)).body;
  const e2 = (await acc.put(`/api/proposals/${p2.id}`, {contentHash: p2.content_hash, data: {...p2.data, series: 'ZZ', number: '999', notes: 'x'}})).body;
  const r2 = await acc.post(`/api/proposals/${e2.id}/approve`, {contentHash: e2.content_hash});
  assert.equal(r2.status, 422); assert.match(r2.body.error, /numerį/);
  const {calcInterest} = await import('../src/loans/interest.mjs');
  const one = calcInterest({events: [{date: '2025-03-10', kind: 'repayment', amount: '1000'}, {date: '2025-03-10', kind: 'disbursement', amount: '1000'}], rate: '10', basis: 'act365', asOf: '2025-12-31'});
  assert.equal(one.interest, '0.00');
  const spreadsheet = calcInterest({events: [{date: '2024-07-01', kind: 'disbursement', amount: '100000'}, {date: '2025-06-27', kind: 'repayment', amount: '100000'}], rate: '15', basis: 'actact', asOf: '2025-06-27', includeLastDay: true});
  assert.equal(spreadsheet.interest, '14856.05');
});
