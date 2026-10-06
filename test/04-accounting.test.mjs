// Scenario 14 (COGS completeness, reports reconcile with ledger), concurrent numbering,
// credit notes / partial returns, re-extraction corrections, provider failure and retry.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startTestApp, FIX, uploadAndProcess, ledgerTotals} from './helpers.mjs';

let t, acc, admin;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  admin = await t.client('admin').login();
});
after(async () => t.close());

async function sale(lines, issueDate = '2026-09-10', name = 'Pirkėjas') {
  const d = await acc.post('/api/manual-invoices', {register: 'sales', issueDate, counterparty: {name}, lines});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  return d.body.proposal;
}

test('concurrent approvals get unique, gap-free invoice numbers', async () => {
  const drafts = [];
  for (let i = 0; i < 8; i++) drafts.push(await sale([{description: `Prekė ${i}`, quantity: '1', unitPrice: '10.00', taxCode: 'PVM1'}]));
  const res = await Promise.all(drafts.map((p) => acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})));
  assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.body)));
  const nums = res.map((r) => r.body.number).sort();
  assert.deepEqual(nums, Array.from({length: 8}, (_, i) => `PP ${String(i + 1).padStart(6, '0')}`));
});

test('14a. missing cost of sales is visible; COGS posting completes profit; statements reconcile', async () => {
  const pl = (await acc.get('/api/reports/profit-loss?from=2026-01-01&to=2026-12-31')).body;
  assert.ok(pl.incomplete, 'profit flagged incomplete');
  assert.deepEqual(pl.incomplete.periods, ['2026-09']);
  assert.equal(pl.totals.revenue, '80.00');
  // Manual inventory purchase and COGS workflow by the accountant.
  const purch = await acc.post('/api/manual-invoices', {register: 'purchase', series: 'PS', number: '1', issueDate: '2026-09-01', counterparty: {name: 'Tiekėjas', vatCode: 'LT777777716', companyCode: '307777777'},
    lines: [{description: 'Prekė perpardavimui', quantity: '8', unitPrice: '4.00', taxCode: 'PVM1', accountCode: '204', lineType: 'inventory', vatTreatment: 'deductible'}]});
  assert.equal(purch.body.proposal.blocking, false, JSON.stringify(purch.body.proposal.validation.issues));
  assert.equal((await acc.post(`/api/proposals/${purch.body.proposal.id}/approve`, {contentHash: purch.body.proposal.content_hash})).status, 200);
  const cogs = await acc.post('/api/journal', {date: '2026-09-30', kind: 'cogs', cogsPeriod: '2026-09', description: 'Parduotų prekių savikaina 2026-09',
    lines: [{account: '6000', debit: '32.00'}, {account: '204', credit: '32.00'}]});
  assert.equal(cogs.status, 200, JSON.stringify(cogs.body));
  const pl2 = (await acc.get('/api/reports/profit-loss?from=2026-01-01&to=2026-12-31')).body;
  assert.equal(pl2.incomplete, null);
  assert.equal(pl2.totals.result, '48.00');
  const tb = (await acc.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).body;
  assert.equal(tb.balanced, true);
  const bs = (await acc.get('/api/reports/balance-sheet?asOf=2026-12-31')).body;
  assert.equal(bs.balanced, true, JSON.stringify(bs.totals));
  assert.equal(bs.rows.find((r) => r.name.startsWith('Nepaskirstytas')).amount, pl2.totals.result, 'balance sheet result equals P&L');
  for (const name of ['vat-sales', 'vat-purchases', 'sales']) {
    const r = (await acc.get(`/api/reports/${name}?from=2026-09-01&to=2026-09-30`)).body;
    assert.equal(r.reconciliation.ok, true, `${name}: ${JSON.stringify(r.reconciliation)}`);
  }
  const rec = (await acc.get('/api/reports/receivables?asOf=2026-12-31')).body;
  assert.equal(rec.reconciliation.ok, true);
  assert.equal(rec.totals.outstanding, '96.80');
  // Drill-down: ledger rows link to entries and source documents.
  const gl = (await acc.get('/api/reports/ledger?account=5000&from=2026-01-01&to=2026-12-31')).body;
  assert.equal(gl.rows.length, 8);
  assert.ok(gl.rows.every((r) => r.document_id));
  const entry = (await acc.get(`/api/journal/${gl.rows[0].entry_id}`)).body;
  assert.equal(entry.source.type, 'invoice');
  // Exports.
  const csv = await acc.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31&format=csv', {raw: true});
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Sąskaita;Pavadinimas/);
  const xlsx = await acc.get('/api/reports/vat-sales?from=2026-09-01&to=2026-09-30&format=xlsx', {raw: true});
  assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok((await xlsx.arrayBuffer()).byteLength > 1000);
});

test('12b. partial return creates a linked credit note and preserves the original', async () => {
  const p = await sale([{description: 'Puodelis', sku: 'SKU-1', quantity: '5', unitPrice: '6.00', taxCode: 'PVM1'}, {description: 'Pristatymas', quantity: '1', unitPrice: '4.00', taxCode: 'PVM1'}], '2026-10-01', 'Grąžintojas');
  const ap = (await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).body;
  const cn = await acc.post(`/api/invoices/${ap.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '2'}], reason: 'Grąžinti 2 puodeliai', issueDate: '2026-10-03'});
  assert.equal(cn.status, 200, JSON.stringify(cn.body));
  const cp = cn.body.proposal;
  assert.equal(cp.blocking, false, JSON.stringify(cp.validation.issues));
  assert.equal(cp.validation.computed.gross, '-14.52');
  const cap = (await acc.post(`/api/proposals/${cp.id}/approve`, {contentHash: cp.content_hash})).body;
  assert.match(cap.number, /^KS 000001$/);
  const orig = (await acc.get(`/api/invoices/${ap.invoiceId}`)).body;
  assert.equal(orig.gross_total, '41.14', 'original unchanged');
  assert.equal(orig.balance.gross, '26.62');
  assert.ok(orig.related.some((r) => r.doc_type === 'credit_note'));
  const tooMuch = await acc.post(`/api/invoices/${ap.invoiceId}/credit-note`, {lines: [{lineNo: 1, quantity: '4'}], reason: 'per daug'});
  assert.equal(tooMuch.status, 422);
});

test('re-extraction never alters a posted invoice; corrections post only the reviewed difference', async () => {
  const {proposal: p, upload} = await uploadAndProcess(t, acc, path.join(FIX, 'invoices', 'docx-invoice.docx'));
  const ap = (await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).body;
  const before = await ledgerTotals(t.app.pool);
  assert.equal((await acc.post(`/api/documents/${upload.documentId}/reextract`)).status, 200);
  await t.drain();
  const inv = (await acc.get(`/api/invoices/${ap.invoiceId}`)).body;
  assert.equal(inv.gross_total, '762.30');
  assert.ok((await t.app.pool.query(`SELECT 1 FROM audit_log WHERE action='document.reextract_no_change' AND entity_id=$1`, [String(upload.documentId)])).rowCount);
  // A correction proposal (e.g. after the supplier confirms a different quantity) posts the delta only.
  const {createProposalVersion} = await import('../src/invoices/service.mjs');
  const {tx} = await import('../src/db.mjs');
  const data = structuredClone(p.data);
  data.lines[0].quantity = '2'; data.lines[0].sourceNet = '60.00';
  data.sourceTotals = {net: '660.00', vat: '138.60', gross: '798.60', vatByRate: [{rate: '21', amount: '138.60'}]};
  const corr = await tx(t.app.pool, (db) => createProposalVersion(db, {documentId: upload.documentId, kind: 'correction', data: {...data, origin: 'correction'}, correctsInvoiceId: ap.invoiceId}));
  assert.equal(corr.blocking, false, JSON.stringify(corr.validation.issues));
  const ca = await acc.post(`/api/proposals/${corr.id}/approve`, {contentHash: corr.content_hash});
  assert.equal(ca.status, 200, JSON.stringify(ca.body));
  const after = await ledgerTotals(t.app.pool);
  assert.equal((Number(after['6316']) - Number(before['6316'])).toFixed(2), '30.00');
  assert.equal((Number(after['443']) - Number(before['443'])).toFixed(2), '-36.30');
  const orig = (await acc.get(`/api/invoices/${ap.invoiceId}`)).body;
  assert.equal(orig.gross_total, '762.30');
  assert.equal(orig.balance.gross, '798.60');
  const vat = (await acc.get('/api/reports/vat-purchases?from=2026-09-01&to=2026-09-30')).body;
  assert.equal(vat.reconciliation.ok, true, JSON.stringify(vat.reconciliation));
});

test('provider failure is retried, then marked failed with an actionable message; manual retry works', async () => {
  const up = await acc.upload([{name: 'sugadintas.pdf', buffer: Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF')}]);
  const docId = up.body.results[0].documentId;
  for (let i = 0; i < 6; i++) { await t.app.pool.query(`UPDATE jobs SET run_at=now() WHERE status='queued'`); await t.drain(); }
  const job = (await t.app.pool.query(`SELECT * FROM jobs WHERE payload->>'documentId'=$1`, [String(docId)])).rows[0];
  assert.equal(job.status, 'dead');
  assert.equal(job.attempts, 5);
  const doc = (await acc.get(`/api/documents/${docId}`)).body;
  assert.equal(doc.processing_status, 'failed');
  assert.match(doc.processing_error, /rankiniu būdu/);
  const r = await acc.post(`/api/jobs/${job.id}/retry`);
  assert.equal(r.status, 200);
  assert.equal((await t.app.pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'queued');
  // A transient failure followed by success is retried by the worker.
  const {createWorker, enqueue} = await import('../src/jobs.mjs');
  let calls = 0;
  const w = createWorker({pool: t.app.pool, handlers: {flaky: async () => { calls++; if (calls === 1) throw new Error('OCR timeout'); return {ok: true}; }}, log: {warn() {}}});
  await t.app.pool.query(`UPDATE jobs SET status='done' WHERE status IN ('queued','dead')`);
  const j = await enqueue(t.app.pool, 'flaky', {}, {idempotencyKey: 'flaky-1'});
  await w.drain(); await t.app.pool.query(`UPDATE jobs SET run_at=now() WHERE id=$1`, [j.id]); await w.drain();
  const fj = (await t.app.pool.query('SELECT * FROM jobs WHERE id=$1', [j.id])).rows[0];
  assert.deepEqual([fj.status, fj.attempts, calls], ['done', 2, 2]);
  const dup = await enqueue(t.app.pool, 'flaky', {}, {idempotencyKey: 'flaky-1'});
  assert.equal(dup.created, false, 'idempotent enqueue');
});
