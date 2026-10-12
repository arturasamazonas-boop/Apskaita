// Valiutų kursai ir perkainojimas: LB rates (stub service), USD invoice booked in EUR, EUR payment with an exchange
// difference, period-end revaluation of an open invoice and of a USD bank account, cancellation.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startTestApp, ledgerTotals} from './helpers.mjs';
import {parseLbRates, toEur} from '../src/fx/rates.mjs';
import {convertToEur} from '../src/invoices/engine.mjs';

// Lietuvos bankas FxRates stub: USD and GBP for any date, USD history.
const RATES = {'2026-10-01': '1.1298', '2026-10-09': '1.1206', '2026-10-30': '1.0800'};
const lbXml = (rows) => `<?xml version="1.0" encoding="utf-8"?><FxRates xmlns="http://www.lb.lt/WebServices/FxRates">${rows.map(([d, c, a]) =>
  `<FxRate><Tp>EU</Tp><Dt>${d}</Dt><CcyAmt><Ccy>EUR</Ccy><Amt>1</Amt></CcyAmt><CcyAmt><Ccy>${c}</Ccy><Amt>${a}</Amt></CcyAmt></FxRate>`).join('')}</FxRates>`;
let stub, stubUrl, t, acc, ro, admin, calls = 0;
before(async () => {
  stub = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/getFxRates')) {
      const dt = u.searchParams.get('dt');
      const d = Object.keys(RATES).filter((x) => x <= dt).sort().at(-1);
      res.end(lbXml(d ? [[d, 'USD', RATES[d]], [d, 'GBP', '0.8600']] : []));
    } else if (u.pathname.endsWith('/getFxRatesForCurrency')) {
      res.end(lbXml(Object.entries(RATES).filter(([d]) => d >= u.searchParams.get('dtFrom') && d <= u.searchParams.get('dtTo')).map(([d, r]) => [d, u.searchParams.get('ccy'), r])));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${stub.address().port}/webservices/FxRates/FxRates.asmx`;
  t = await startTestApp({config: {fxUrl: stubUrl}});
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  admin = await t.client('admin').login();
});
after(async () => { await t?.close(); stub?.close(); });

test('LB rates: parsing, fetching, latest rate on or before a date, manual rate, EUR conversion', async () => {
  assert.deepEqual(parseLbRates(lbXml([['2026-10-09', 'USD', '1.1206']])), [{currency: 'USD', date: '2026-10-09', rate: '1.1206'}]);
  assert.equal(toEur('1000', '1.1206'), '892.38');
  const f = await acc.post('/api/fx/fetch', {date: '2026-10-09'});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.fetched, 2);
  const h = await acc.post('/api/fx/fetch', {currency: 'USD', from: '2026-10-01', to: '2026-10-31'});
  assert.equal(h.body.fetched, 3);
  // Sunday → the last rate published before it.
  assert.deepEqual((await ro.get('/api/fx/rate?currency=USD&date=2026-10-11')).body, {rate: '1.1206', date: '2026-10-09', source: 'LB'});
  assert.equal((await ro.put('/api/fx/rates', {currency: 'NOK', date: '2026-10-09', rate: '11.5'})).status, 403);
  assert.equal((await acc.put('/api/fx/rates', {currency: 'NOK', date: '2026-10-09', rate: '11,5'})).status, 200);
  assert.equal((await ro.get('/api/fx/rate?currency=NOK&date=2026-10-12')).body.rate, '11.5');
  assert.equal((await acc.put('/api/fx/rates', {currency: 'EUR', date: '2026-10-09', rate: '1'})).status, 400);
  // Conversion keeps lines, VAT and totals consistent to the cent.
  const c = convertToEur({rate: '1.1206', register: 'purchase', lines: [{index: 0, net: '100.00', vat: '21.00', taxCode: 'PVM1', vatTreatment: 'deductible'}, {index: 1, net: '233.33', vat: '49.00', taxCode: 'PVM1', vatTreatment: 'deductible'}],
    vatGroups: [{taxCode: 'PVM1', rate: '21', taxable: '333.33', vat: '70.00'}]});
  assert.deepEqual([c.net, c.vat, c.gross], ['297.46', '62.47', '359.93']);
  assert.equal(c.lines.reduce((s, l) => s + Number(l.vat), 0).toFixed(2), '62.47');
});

let usdInvoice;
test('USD purchase invoice booked in EUR at the LB rate of its date', async () => {
  const r = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'US', number: '1001', issueDate: '2026-10-01', currency: 'USD', counterparty: {name: 'Cloud Inc.', country: 'US'},
    lines: [{description: 'Hosting', quantity: '1', unitPrice: '1000', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.proposal;
  assert.equal(p.data.fxRate, '1.1298');
  assert.equal(p.blocking, false, JSON.stringify(p.validation.issues));
  assert.deepEqual([p.validation.computed.gross, p.validation.computed.fx.gross], ['1210.00', '1070.98']);
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  usdInvoice = ap.body.invoiceId;
  const inv = (await ro.get(`/api/invoices/${usdInvoice}`)).body;
  assert.deepEqual([inv.currency, inv.net_total, inv.vat_total, inv.gross_total, inv.orig_gross, Number(inv.fx_rate)], ['USD', '885.11', '185.87', '1070.98', '1210.00', 1.1298]);
  const e = (await ro.get(`/api/journal/${inv.journal_entry_id}`)).body;
  assert.deepEqual(e.lines.map((l) => [l.account_code, l.debit, l.credit]).sort(), [['2441', '185.87', '0.00'], ['443', '0.00', '1070.98'], ['6300', '885.11', '0.00']]);
  // VAT return takes the EUR amounts.
  const fr = (await ro.get('/api/eds/fr0600?from=2026-10-01&to=2026-10-31')).body.values;
  assert.equal(fr.E25, '186');
  // A manual rate on the document wins over the table.
  const m = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'US', number: '1002', issueDate: '2026-10-01', currency: 'USD', fxRate: '1.2', counterparty: {name: 'Cloud Inc.', country: 'US'},
    lines: [{description: 'Hosting', quantity: '1', unitPrice: '120', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  assert.deepEqual([m.body.proposal.data.fxRate, m.body.proposal.validation.computed.fx.gross], ['1.2', '121.00']);
});

test('EUR bank payment of the USD invoice: payable cleared in full, exchange difference to 6803 / 5803', async () => {
  const bank = (await admin.post('/api/bank/accounts', {iban: 'LT601010012345678901', name: 'EUR', ledger_account: '2710'})).body;
  const csv = 'Data;Gavėjas/Mokėtojas;Sąskaita;Paskirtis;Suma;Valiuta\n2026-10-09;Cloud Inc.;;Invoice US1001;-1079,77;EUR\n';
  const up = await acc.upload([{buffer: Buffer.from(csv), name: 'usd-payment.csv'}], {workflow: 'bank'});
  const imp = await acc.post('/api/bank/statements/import', {documentId: up.body.results[0].documentId, bankAccountId: bank.id, opening: '2000,00', closing: '920,23'});
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const tx = (await t.app.pool.query(`SELECT * FROM bank_transactions WHERE amount='-1079.77'`)).rows[0];
  const cur = (await acc.get(`/api/bank/transactions/${tx.id}`)).body.proposals.find((p) => p.status === 'open');
  const ed = await acc.put(`/api/bank/transactions/${tx.id}/proposal`, {contentHash: cur.content_hash, kind: 'invoice', allocations: [{kind: 'invoice', invoiceId: usdInvoice, amount: '1079.77'}]});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.blocking, false, JSON.stringify(ed.body.validation.issues));
  // 1 210 USD booked at 1.1298 = 1 070.98 EUR; paid 1 079.77 EUR → loss 8.79.
  assert.deepEqual(ed.body.validation.entries.map((l) => [l.account, l.debit, l.credit]), [['2710', '0', '1079.77'], ['443', '1070.98', '0'], ['6803', '8.79', '0']]);
  const ok = await acc.post(`/api/bank/transactions/${tx.id}/approve`, {contentHash: ed.body.content_hash});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bal = (await ro.get(`/api/invoices/${usdInvoice}`)).body.balance;
  assert.deepEqual([Number(bal.outstanding), Number(bal.orig_outstanding)], [0, 0]);
});

test('period-end revaluation of an open USD invoice and a USD bank account; cancel', async () => {
  const r = await acc.post('/api/manual-invoices', {register: 'sales', issueDate: '2026-10-09', counterparty: {name: 'US Customer', country: 'US'}, lines: [{description: 'Paslauga', quantity: '1', unitPrice: '500', taxCode: 'PVM1'}]});
  // Sales invoices issued here are EUR; a USD sales invoice comes from a supplier-style entry: use a purchase for the payable side instead.
  assert.equal(r.body.proposal.data.currency, 'EUR');
  const p2 = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'US', number: '2001', issueDate: '2026-10-09', currency: 'USD', counterparty: {name: 'Cloud Inc.', country: 'US'},
    lines: [{description: 'Licencija', quantity: '1', unitPrice: '1000', taxCode: 'PVM1', accountCode: '6300', lineType: 'expense', vatTreatment: 'deductible'}]});
  const ap = await acc.post(`/api/proposals/${p2.body.proposal.id}/approve`, {contentHash: p2.body.proposal.content_hash});
  const id = ap.body.invoiceId;
  // 1 000 + 210 USD booked at 1.1206 = 892.38 + 187.40 = 1 079.78 EUR; at 2026-10-30 rate 1.08: 1 210 / 1.08 = 1 120.37 → payable +40.59 (loss).
  const usdBank = (await admin.post('/api/bank/accounts', {iban: 'LT121000011101001000', name: 'USD', ledger_account: '2711', currency: 'USD'})).body;
  const csv = 'Data;Gavėjas/Mokėtojas;Sąskaita;Paskirtis;Suma;Valiuta\n2026-10-09;Klientas;;Pajamos;1120,60;USD\n';
  const up = await acc.upload([{buffer: Buffer.from(csv), name: 'usd-account.csv'}], {workflow: 'bank'});
  assert.equal((await acc.post('/api/bank/statements/import', {documentId: up.body.results[0].documentId, bankAccountId: usdBank.id, opening: '0', closing: '1120,60'})).status, 200);
  const tx = (await t.app.pool.query(`SELECT * FROM bank_transactions WHERE amount='1120.60'`)).rows[0];
  const cur = (await acc.get(`/api/bank/transactions/${tx.id}`)).body.proposals.find((p) => p.status === 'open');
  const ed = await acc.put(`/api/bank/transactions/${tx.id}/proposal`, {contentHash: cur.content_hash, kind: 'other', allocations: [{kind: 'other', amount: '1120.60', accountCode: '5001', note: 'Pardavimas'}]});
  // 1 120.60 USD at 1.1206 = 1 000.00 EUR.
  assert.deepEqual(ed.body.validation.entries.map((l) => [l.account, l.debit, l.credit]), [['2711', '1000.00', '0'], ['5001', '0', '1000.00']]);
  assert.equal((await acc.post(`/api/bank/transactions/${tx.id}/approve`, {contentHash: ed.body.content_hash})).status, 200);
  const pv = (await ro.get('/api/fx/revaluation?asOf=2026-10-30')).body;
  assert.deepEqual(pv.missing, []);
  const inv = pv.items.find((x) => x.type === 'invoice');
  const bk = pv.items.find((x) => x.type === 'bank');
  assert.deepEqual([inv.bookBalance, inv.newBalance, inv.diff, inv.gain], ['1079.78', '1120.37', '40.59', false]);
  assert.deepEqual([bk.origBalance, bk.bookBalance, bk.newBalance, bk.diff, bk.gain], ['1120.60', '1000.00', '1037.59', '37.59', true]);
  const before = await ledgerTotals(t.app.pool);
  const post = await acc.post('/api/fx/revaluations', {asOf: '2026-10-30'});
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal((await acc.post('/api/fx/revaluations', {asOf: '2026-10-30'})).status, 409);
  const after1 = await ledgerTotals(t.app.pool);
  const d = (c) => (Number(after1[c] || 0) - Number(before[c] || 0)).toFixed(2);
  assert.deepEqual([d('443'), d('6803'), d('2711'), d('5803')], ['-40.59', '40.59', '37.59', '-37.59']);
  assert.equal(Number((await ro.get(`/api/invoices/${id}`)).body.balance.outstanding), 1120.37);
  // Nothing left to revalue at the same rate.
  assert.equal((await ro.get('/api/fx/revaluation?asOf=2026-10-30')).body.items.length, 0);
  const list = (await ro.get('/api/fx/revaluations')).body;
  assert.equal((await acc.post(`/api/fx/revaluations/${list[0].id}/cancel`, {reason: 'Klaidingas kursas'})).status, 200);
  assert.equal(Number((await ro.get(`/api/invoices/${id}`)).body.balance.outstanding), 1079.78);
  const after2 = await ledgerTotals(t.app.pool);
  assert.equal((Number(after2['6803'] || 0) - Number(before['6803'] || 0)).toFixed(2), '0.00');
});
