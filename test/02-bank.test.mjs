// Acceptance scenarios 7–11: statement import, deduplication, balance checks, matching, allocations.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startTestApp, FIX, ledgerTotals} from './helpers.mjs';

let t, acc, ro, admin, mainAccount;
const bank = (f) => path.join(FIX, 'bank', f);

before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
  admin = await t.client('admin').login();
  mainAccount = (await admin.post('/api/bank/accounts', {iban: 'LT977044060000000001', name: 'Pagrindinė', bank_name: 'Pavyzdžio bankas', ledger_account: '2710'})).body;
  assert.ok(mainAccount.id, JSON.stringify(mainAccount));
  const savings = await admin.post('/api/bank/accounts', {iban: 'LT037300010000000002', name: 'Taupomoji', ledger_account: '2711'});
  assert.equal(savings.status, 200, JSON.stringify(savings.body));
  await t.app.pool.query(`UPDATE document_series SET next_number=41 WHERE code='PP'`);
});
after(async () => t.close());

async function importFile(client, file, opts = {}) {
  const up = await client.upload([typeof file === 'string' ? file : file], {workflow: 'bank'});
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const documentId = up.body.results[0].documentId;
  assert.ok(documentId, JSON.stringify(up.body));
  const r = await client.post('/api/bank/statements/import', {documentId, ...opts});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function txs(where = '') { return (await t.app.pool.query(`SELECT * FROM bank_transactions ${where} ORDER BY id`)).rows; }
async function openProposal(txId) { return (await acc.get(`/api/bank/transactions/${txId}`)).body.proposals.find((p) => p.status === 'open'); }
async function approveTx(txId) {
  const p = await openProposal(txId);
  const r = await acc.post(`/api/bank/transactions/${txId}/approve`, {contentHash: p.content_hash});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function manualSale({name, iban = '', code = '', lines, issueDate = '2026-09-20', paymentReference = ''}) {
  const d = await acc.post('/api/manual-invoices', {register: 'sales', issueDate, dueDate: '2026-10-05', counterparty: {name, iban, companyCode: code}, lines, paymentReference});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const p = d.body.proposal;
  assert.equal(p.blocking, false, JSON.stringify(p.validation.issues));
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  return ap.body;
}

test('7. overlapping CSV statements import each real transaction once and keep two identical payments', async () => {
  const preview = await acc.post('/api/bank/statements/preview', {documentId: (await acc.upload([bank('statement-a.csv')], {workflow: 'bank'})).body.results[0].documentId, bankAccountId: mainAccount.id});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.mapping.date, 0);
  assert.equal(preview.body.balance.status, 'missing');
  const docA = (await t.app.pool.query(`SELECT id FROM documents WHERE workflow='bank' ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const a = (await acc.post('/api/bank/statements/import', {documentId: docA, bankAccountId: mainAccount.id, opening: '1000,00', closing: '1355,50'})).body;
  assert.equal(a.new, 5);
  assert.equal(a.balance.status, 'ok');
  const b = await importFile(acc, bank('statement-b.csv'), {bankAccountId: mainAccount.id, opening: '1497.50', closing: '293.20'});
  assert.deepEqual([b.new, b.duplicate, b.review], [2, 3, 0]);
  assert.ok(b.issues.some((i) => i.code === 'overlap'));
  const all = await txs();
  assert.equal(all.length, 7);
  assert.equal(all.filter((x) => x.amount === '50.00' && x.counterparty_name === 'Jonas Jonaitis').length, 2, 'two legitimate identical payments preserved');
  // Same file again → reported as already uploaded, no new rows.
  const again = await acc.upload([bank('statement-a.csv')], {workflow: 'bank'});
  assert.equal(again.body.results[0].status, 'duplicate');
  assert.equal((await txs()).length, 7);
  // Own transfer and bank fee are recognised.
  const transfer = all.find((x) => x.amount === '-300.00');
  assert.equal((await openProposal(transfer.id)).data.kind, 'own_transfer');
  await approveTx(transfer.id);
  const fee = all.find((x) => x.amount === '-2.50');
  assert.equal((await openProposal(fee.id)).data.kind, 'fee');
  await approveTx(fee.id);
  const l = await ledgerTotals(t.app.pool);
  assert.equal(l['273'], '300.00');
  assert.equal(l['6314'], '2.50');
});

test('8. statement balance mismatch is visible and cannot be silently approved', async () => {
  const r = await importFile(acc, bank('camt053-mismatch.xml'));
  assert.equal(r.balance.status, 'mismatch');
  const st = (await acc.get(`/api/bank/statements/${r.statementId}`)).body;
  assert.equal(st.balance_status, 'mismatch');
  assert.match(st.issues.find((i) => i.code === 'balance_mismatch').message, /skirtumas/);
  const tx = (await txs(`WHERE first_statement_id=${r.statementId}`))[0];
  const p = await openProposal(tx.id);
  const ed = await acc.put(`/api/bank/transactions/${tx.id}/proposal`, {contentHash: p.content_hash, kind: 'advance', allocations: [{kind: 'advance', amount: '50.00', note: 'Avansas'}]});
  assert.equal(ed.status, 200);
  assert.ok(ed.body.validation.issues.some((i) => i.code === 'statement_unresolved'));
  assert.equal((await acc.post(`/api/bank/transactions/${tx.id}/approve`, {contentHash: ed.body.content_hash})).status, 422);
  assert.equal((await ro.post(`/api/bank/statements/${r.statementId}/resolve`, {note: 'Bandau patvirtinti be teisių'})).status, 403);
  assert.equal((await acc.post(`/api/bank/statements/${r.statementId}/resolve`, {note: 'trumpa'})).status, 400);
  const res = await acc.post(`/api/bank/statements/${r.statementId}/resolve`, {note: 'Bankas patvirtino, kad galutinis likutis išraše klaidingas; operacijos teisingos.'});
  assert.equal(res.status, 200);
  const p2 = await openProposal(tx.id);
  assert.equal(p2.blocking, false, JSON.stringify(p2.validation.issues));
  const audit = (await t.app.pool.query(`SELECT * FROM audit_log WHERE action='bank_statement.resolve'`)).rows;
  assert.equal(audit.length, 1);
  assert.match(audit[0].details.note, /Bankas patvirtino/);
});

test('9. EUR 60 + EUR 61 settle a EUR 121 invoice without new revenue or VAT', async () => {
  const inv = await manualSale({name: 'UAB Klientas ir partneriai', iban: 'LT078888888888888888', code: '308888888', lines: [{description: 'Konsultacija', quantity: '1', unitPrice: '100.00', taxCode: 'PVM1'}], issueDate: '2026-09-25'});
  assert.equal(inv.number, 'PP 000041');
  await t.drain(); // PDF rendering job
  const pdf = await acc.get(`/api/invoices/${inv.invoiceId}/pdf-link`);
  assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
  const before = await ledgerTotals(t.app.pool);
  assert.equal(before['5001'] ?? before['5000'], '-100.00');
  const r = await importFile(acc, bank('camt053-october.xml'));
  assert.equal(r.balance.status, 'ok');
  const [p60, p61] = (await txs(`WHERE first_statement_id=${r.statementId}`)).slice(0, 2);
  const prop60 = await openProposal(p60.id);
  assert.equal(prop60.data.allocations[0].invoiceId, String(inv.invoiceId));
  assert.ok(prop60.data.allocations[0].evidence.some((e) => /numeris/.test(e)), 'evidence shown');
  await approveTx(p60.id);
  let bal = (await acc.get(`/api/invoices/${inv.invoiceId}`)).body.balance;
  assert.equal(bal.outstanding, '61.00');
  assert.equal(bal.payment_status, 'partial');
  await approveTx(p61.id);
  bal = (await acc.get(`/api/invoices/${inv.invoiceId}`)).body.balance;
  assert.equal(bal.outstanding, '0.00');
  assert.equal(bal.payment_status, 'paid');
  const after = await ledgerTotals(t.app.pool);
  for (const code of ['5000', '5001', '4492']) assert.equal(after[code], before[code], `account ${code} unchanged by settlement`);
  assert.equal(after['2410'], '0.00');
  // Double approval click on a settled transaction is idempotent.
  const again = await acc.post(`/api/bank/transactions/${p61.id}/approve`, {contentHash: (await acc.get(`/api/bank/transactions/${p61.id}`)).body.proposals[0].content_hash});
  assert.equal(again.body.alreadyApproved, true);
});

test('10. one payment settles several invoices; equal-amount invoices without evidence stay ambiguous', async () => {
  const i1 = await manualSale({name: 'UAB Daugiamokė', iban: 'LT091234567890123456', lines: [{description: 'Prekės A', quantity: '2', unitPrice: '50.00', taxCode: 'PVM1'}]});
  const i2 = await manualSale({name: 'UAB Daugiamokė', iban: 'LT091234567890123456', lines: [{description: 'Prekės B', quantity: '1', unitPrice: '200.00', taxCode: 'PVM1'}]});
  const t1 = await manualSale({name: 'Dvynė A', lines: [{description: 'Paslauga', quantity: '1', unitPrice: '40.00', taxCode: 'PVM1'}]});
  const t2 = await manualSale({name: 'Dvynė B', lines: [{description: 'Paslauga', quantity: '1', unitPrice: '40.00', taxCode: 'PVM1'}]});
  const csv = ['Data;Mokėtojas;Sąskaita;Paskirtis;Suma', `2026-10-10;UAB Daugiamokė;LT091234567890123456;Apmokame ${i1.number.replace(' ', '')} ir ${i2.number};363,00`, '2026-10-11;Nežinomas mokėtojas;;Apmokėjimas;48,40'].join('\n');
  const r = await importFile(acc, {name: 'multi.csv', buffer: Buffer.from(csv)}, {bankAccountId: mainAccount.id, opening: '0', closing: '411.40'});
  assert.equal(r.balance.status, 'ok');
  const [multi, twin] = await txs(`WHERE first_statement_id=${r.statementId}`);
  const pm = await openProposal(multi.id);
  assert.deepEqual(pm.data.allocations.map((a) => [a.invoiceId, a.amount]), [[String(i1.invoiceId), '121.00'], [String(i2.invoiceId), '242.00']]);
  await approveTx(multi.id);
  const pt = await openProposal(twin.id);
  assert.equal(pt.data.status, 'ambiguous');
  assert.ok(pt.data.candidates.length >= 2);
  assert.equal(pt.blocking, true);
  assert.equal((await acc.post(`/api/bank/transactions/${twin.id}/approve`, {contentHash: pt.content_hash})).status, 422);
  // The reviewer chooses explicitly.
  const ed = await acc.put(`/api/bank/transactions/${twin.id}/proposal`, {contentHash: pt.content_hash, kind: 'invoice', allocations: [{kind: 'invoice', invoiceId: t2.invoiceId, amount: '48.40'}]});
  assert.equal(ed.body.blocking, false, JSON.stringify(ed.body.validation.issues));
  await approveTx(twin.id);
  assert.equal((await acc.get(`/api/invoices/${t1.invoiceId}`)).body.balance.outstanding, '48.40');
});

test('11. net sales 100, VAT 21, processor fee 2, payout 119 reconcile separately', async () => {
  const before = await ledgerTotals(t.app.pool);
  const inv = await manualSale({name: 'Internetinės parduotuvės pirkėjas', lines: [{description: 'Užsakymas #5001', quantity: '1', unitPrice: '100.00', taxCode: 'PVM1'}], issueDate: '2026-10-05'});
  const stripe = (await txs(`WHERE counterparty_name LIKE 'Stripe%'`))[0];
  const re = await acc.post(`/api/bank/transactions/${stripe.id}/resuggest`);
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const p = await openProposal(stripe.id);
  assert.equal(p.data.kind, 'processor_payout', JSON.stringify(p.data));
  assert.deepEqual(p.data.allocations.map((a) => [a.kind, a.amount]), [['invoice', '121.00'], ['fee', '2.00']]);
  await approveTx(stripe.id);
  const after = await ledgerTotals(t.app.pool);
  const diff = (c) => (Number(after[c] || 0) - Number(before[c] || 0)).toFixed(2);
  assert.equal(diff('5000'), '-100.00', 'sales');
  assert.equal(diff('4492'), '-21.00', 'VAT');
  assert.equal(diff('6205'), '2.00', 'processor fees');
  assert.equal(diff('2710'), '119.00', 'bank payout');
  assert.equal(diff('2410'), '0.00', 'receivable settled');
  const fee = (await txs(`WHERE amount='-1.20'`))[0];
  await approveTx(fee.id);
  const vat = await acc.get('/api/reports/vat-sales?from=2026-09-01&to=2026-10-31');
  assert.equal(vat.body.reconciliation.ok, true, JSON.stringify(vat.body.reconciliation));
  const rec = await acc.get('/api/reports/receivables?asOf=2026-10-31');
  assert.equal(rec.body.reconciliation.ok, true, JSON.stringify(rec.body.reconciliation));
});

test('advance before invoice uses the clearing account; later application moves no cash', async () => {
  const adv = (await txs(`WHERE amount='500.00'`))[0];
  const p = await openProposal(adv.id);
  assert.equal(p.data.kind, 'none');
  const cp = (await t.app.pool.query(`SELECT id FROM counterparties WHERE company_code='308888888'`)).rows[0];
  const ed = await acc.put(`/api/bank/transactions/${adv.id}/proposal`, {contentHash: p.content_hash, kind: 'advance', allocations: [{kind: 'advance', amount: '500.00', counterpartyId: cp.id, note: 'Avansas pagal sutartį'}]});
  assert.equal(ed.body.blocking, false, JSON.stringify(ed.body.validation.issues));
  await approveTx(adv.id);
  const inv = await manualSale({name: 'UAB Klientas ir partneriai', code: '308888888', lines: [{description: 'Prekės pagal sutartį', quantity: '1', unitPrice: '300.00', taxCode: 'PVM1'}], issueDate: '2026-10-01'});
  const cashBefore = (await ledgerTotals(t.app.pool))['2710'];
  const allocation = (await acc.get('/api/bank/advances')).body.find((a) => String(a.transaction_id) === String(adv.id));
  const ap = await acc.post(`/api/bank/advances/${allocation.id}/apply`, {invoiceId: inv.invoiceId, amount: '363.00'});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.remaining, '137.00');
  const l = await ledgerTotals(t.app.pool);
  assert.equal(l['2710'], cashBefore, 'no second cash movement');
  assert.equal(l['442'], '-137.00');
  assert.equal((await acc.get(`/api/invoices/${inv.invoiceId}`)).body.balance.payment_status, 'paid');
  // Trial balance stays balanced overall.
  const tb = (await acc.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).body;
  assert.equal(tb.balanced, true);
});
