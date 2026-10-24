// Tax calendar with filing marks, remembered bank column mapping, FR0564 data, approve-and-next support.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startTestApp} from './helpers.mjs';
import {workingDayOnOrAfter, taxCalendar} from '../src/tax/calendar.mjs';

let t, acc, admin;
before(async () => { t = await startTestApp(); acc = await t.client('accountant').login(); admin = await t.client('admin').login(); });
after(async () => t.close());

test('deadlines on a weekend or holiday move to the next working day', () => {
  assert.equal(workingDayOnOrAfter('2026-11-15'), '2026-11-16'); // Sunday
  assert.equal(workingDayOnOrAfter('2026-12-25'), '2026-12-28'); // Christmas, then the weekend
  assert.equal(workingDayOnOrAfter('2026-10-26'), '2026-10-26');
});

test('calendar: VAT and payroll returns by period, marking one as filed', async () => {
  await t.app.pool.query(`INSERT INTO payroll_runs(period, payment_date) VALUES ('2026-09','2026-10-05') ON CONFLICT DO NOTHING`).catch(() => {});
  const c = await taxCalendar(t.app.pool, {from: '2026-10-01', to: '2026-10-31', today: '2026-10-21'});
  const f = (form) => c.items.find((i) => i.form === form && i.period === '2026-09');
  assert.equal(f('FR0600').due, '2026-10-26'); // 25 October 2026 is a Sunday
  assert.equal(f('ISAF').due, '2026-10-20');
  assert.equal(f('ISAF').status, 'overdue');
  assert.equal(f('FR0600').status, 'soon');
  assert.ok(!c.items.some((i) => i.form === 'FR0564'), 'no EU supplies, no FR0564');
  const m = await acc.post('/api/tax-filings', {form: 'ISAF', period: '2026-09', filedOn: '2026-10-19', reference: 'ISAF-123'});
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const api = (await acc.get('/api/tax-calendar?from=2026-10-01&to=2026-10-31')).body;
  const isaf = api.items.find((i) => i.form === 'ISAF' && i.period === '2026-09');
  assert.equal(isaf.status, 'filed'); assert.equal(isaf.filed.reference, 'ISAF-123');
  assert.equal((await acc.post('/api/tax-filings', {form: 'NERA', period: '2026-09'})).status, 400);
  const mc = (await acc.get('/api/month-close?period=2026-09')).body;
  assert.ok(mc.items.some((i) => i.group === 'Deklaracijos ir mokėjimai' && i.title.startsWith('i.SAF') && i.level === 'ok'), JSON.stringify(mc.items));
  const dash = (await acc.get('/api/dashboard')).body;
  assert.ok(dash.cards.some((x) => x.key === 'tax'));
});

test('bank: a column mapping chosen once is used for the next file with the same headers', async () => {
  const account = (await admin.post('/api/bank/accounts', {iban: 'LT977044060000000001', name: 'Pagrindinė', ledger_account: '2710'})).body;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apskaita-'));
  // Headers the guesser does not know: "Kada" (date) and "Kiek" (amount).
  const write = (name, rows) => { const p = path.join(dir, name); fs.writeFileSync(p, ['Kada;Kas;Kiek;Kam', ...rows].join('\n')); return p; };
  const up = async (file) => (await acc.upload([file], {workflow: 'bank'})).body.results[0].documentId;
  const d1 = await up(write('a.csv', ['2026-09-01;UAB A;10,00;Pirmas']));
  const p1 = (await acc.post('/api/bank/statements/preview', {documentId: d1, bankAccountId: account.id})).body;
  assert.ok(p1.issues.some((i) => /datos stulpelis/.test(i.message)), JSON.stringify(p1.issues));
  const mapping = {date: 0, counterparty: 1, amount: 2, reference: 3};
  const i1 = await acc.post('/api/bank/statements/import', {documentId: d1, bankAccountId: account.id, mapping, opening: '0', closing: '10'});
  assert.equal(i1.status, 200, JSON.stringify(i1.body));
  const d2 = await up(write('b.csv', ['2026-09-02;UAB B;5,00;Antras']));
  const p2 = (await acc.post('/api/bank/statements/preview', {documentId: d2, bankAccountId: account.id, opening: '10', closing: '15'})).body;
  assert.deepEqual(p2.mapping, mapping);
  assert.ok(p2.issues.some((i) => i.code === 'saved_mapping'));
  assert.equal(p2.rows[0].amount, '5.00');
});

test('FR0564: EU supplies per buyer VAT code; a buyer without an EU code is flagged', async () => {
  const sale = async (cp) => {
    const d = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-09-15', counterparty: cp, lines: [{description: 'Prekė', quantity: '1', unitPrice: '1000.40', taxCode: 'PVM13'}]});
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const p = d.body.proposal;
    if (p.blocking) return null;
    return acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  };
  assert.equal((await sale({name: 'SIA Pircējs', country: 'LV', vatCode: 'LV40003000000'})).status, 200);
  const r = (await acc.get('/api/reports/fr0564?from=2026-09-01&to=2026-09-30')).body;
  assert.deepEqual(r.rows.map((x) => [x.country, x.vat_number, x.taxable, x.taxable_whole]), [['LV', '40003000000', '1000.40', '1000']]);
  assert.equal(r.incomplete, null);
  const c = await taxCalendar(t.app.pool, {from: '2026-10-01', to: '2026-10-31', today: '2026-10-21'});
  assert.ok(c.items.some((i) => i.form === 'FR0564' && i.period === '2026-09'));
});

test('cost of sales: quantity sold × weighted average cost, then posted once', async () => {
  const prod = await acc.post('/api/products', {sku: 'VAMZ-1', name: 'Vamzdis', kind: 'goods', unit: 'vnt.', unit_price: '15', purchase_price: '5', track_stock: true});
  assert.equal(prod.status, 200, JSON.stringify(prod.body));
  const pid = String(prod.body.id);
  const invoice = async (register, n, qty, price, date) => {
    const d = await acc.post('/api/manual-invoices', {register, series: 'T', number: n, issueDate: date, counterparty: {name: register === 'sales' ? 'UAB Pirkėjas' : 'UAB Tiekėjas', companyCode: register === 'sales' ? '301111111' : '302222222', vatCode: register === 'sales' ? '' : 'LT100002222219'},
      lines: [{productId: pid, quantity: qty, unitPrice: price, taxCode: 'PVM1'}]});
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const p = d.body.proposal;
    const a = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
    assert.equal(a.status, 200, JSON.stringify({a: a.body, issues: p.validation.issues}));
  };
  await invoice('purchase', 'P1', '10', '5', '2026-07-02');
  await invoice('purchase', 'P2', '10', '7', '2026-07-10');
  await invoice('sales', '', '4', '15', '2026-07-20');
  const c = (await acc.get('/api/cogs/proposal?period=2026-07')).body;
  const row = c.rows.find((r) => r.sku === 'VAMZ-1');
  assert.deepEqual([row.quantity, row.unitCost, row.source, row.amount], ['4.0000', '6.0000', 'average', '24.00']);
  assert.equal(c.total, '24.00'); assert.equal(c.posted, null);
  const post = await acc.post('/api/journal', {date: c.date, kind: 'cogs', cogsPeriod: '2026-07', description: 'Savikaina 2026-07', lines: [{account: c.accounts.debit, debit: c.total}, {account: c.accounts.credit, credit: c.total}]});
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.ok((await acc.get('/api/cogs/proposal?period=2026-07')).body.posted);
  assert.equal((await acc.get('/api/cogs/proposal?period=2026-13')).status, 400);
});

test('recurring invoices: drafts on their dates, catching up, end of month kept, never twice', async () => {
  const {nextOccurrence} = await import('../src/sales/recurring.mjs');
  assert.equal(nextOccurrence('2026-01-31', 1, 31), '2026-02-28');
  assert.equal(nextOccurrence('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(nextOccurrence('2026-11-15', 3, 15), '2027-02-15');
  const cp = (await acc.post('/api/counterparties', {name: 'UAB Nuomininkas', company_code: '303333333', is_customer: true, country: 'LT'})).body;
  assert.ok(cp.id, JSON.stringify(cp));
  const bad = await acc.post('/api/recurring-invoices', {name: 'Nuoma', counterpartyId: cp.id, lines: [], nextDate: '2026-08-31'});
  assert.equal(bad.status, 400);
  const tpl = await acc.post('/api/recurring-invoices', {name: 'Patalpų nuoma', counterpartyId: cp.id, nextDate: '2026-07-31', intervalMonths: 1, dueDays: 10, endDate: '2026-10-15',
    lines: [{description: 'Patalpų nuoma', quantity: '1', unitPrice: '500', taxCode: 'PVM1'}]});
  assert.equal(tpl.status, 200, JSON.stringify(tpl.body));
  const g = await acc.post('/api/recurring-invoices/generate', {asOf: '2026-09-30'});
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.created.map((c) => c.issueDate), ['2026-07-31', '2026-08-31', '2026-09-30']);
  assert.ok(g.body.created.every((c) => !c.blocking), JSON.stringify(g.body));
  assert.deepEqual((await acc.post('/api/recurring-invoices/generate', {asOf: '2026-09-30'})).body.created, []);
  const l = (await acc.get('/api/recurring-invoices')).body;
  assert.equal(l.templates[0].next_date, '2026-10-31');
  assert.equal(l.drafts.length, 3);
  // The draft is an ordinary proposal: approving it issues a numbered invoice dated as planned.
  const doc = (await acc.get(`/api/documents/${l.drafts[0].document_id}`)).body;
  const p = (await acc.get(`/api/proposals/${doc.proposals.find((x) => x.status === 'open').id}`)).body;
  assert.equal(p.data.dueDate, '2026-08-10');
  const a = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await acc.get('/api/recurring-invoices')).body.drafts.length, 2);
  // The next date (31 October) is past the end date (15 October): the template stops without a draft.
  assert.deepEqual((await acc.post('/api/recurring-invoices/generate', {})).body.created, []);
  assert.equal((await acc.get('/api/recurring-invoices')).body.templates[0].active, false);
});

test('vacation pay: average daily pay of the last 3 months × vacation days', async () => {
  const e = await acc.post('/api/employees', {first_name: 'Rūta', last_name: 'Rūtaitė', employment_start: '2026-01-01', base_salary: '2000', iban: 'LT121000011101001000'});
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const none = (await acc.get(`/api/payroll/vdu?employee=${e.body.id}&period=2026-07&days=5`)).body;
  assert.equal(none.source, 'salary'); // no earlier months: salary / working days of July (22)
  assert.equal(none.daily, '90.91');
  let days = 0;
  for (const period of ['2026-07', '2026-08', '2026-09']) {
    const run = await acc.post('/api/payroll/runs', {period, payment_date: `${period}-28`});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const sheet = (await acc.get(`/api/payroll/runs/${run.body.id}`)).body;
    const line = sheet.lines.find((l) => String(l.employee_id) === String(e.body.id));
    days += Number(line.worked_days);
    assert.equal((await acc.post(`/api/payroll/runs/${run.body.id}/approve`)).status, 200);
  }
  const v = (await acc.get(`/api/payroll/vdu?employee=${e.body.id}&period=2026-10&days=5`)).body;
  assert.equal(v.source, 'history');
  assert.equal(v.earnings, '6000.00');
  assert.equal(v.workedDays, days);
  const daily = (Math.round((6000 / days) * 100) / 100).toFixed(2);
  assert.equal(v.daily, daily);
  assert.equal(v.amount, (Math.round(Number(daily) * 5 * 100) / 100).toFixed(2));
  assert.equal((await acc.get(`/api/payroll/vdu?employee=${e.body.id}&period=2026-10&days=99`)).status, 400);
});
