// Acceptance scenarios 1–5 and the malicious-document check (invoice inbox end-to-end).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startTestApp, FIX, uploadAndProcess, errors, ledgerTotals} from './helpers.mjs';

let t, acc, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
});
after(async () => t.close());

const inv = (f) => path.join(FIX, 'invoices', f);

test('1. digital purchase invoice: fields, lines, accounts, posts balanced entries only after approval', async () => {
  const {proposal: p, doc} = await uploadAndProcess(t, acc, inv('digital.pdf'));
  const d = p.data;
  assert.equal(d.register, 'purchase');
  assert.equal(d.docType, 'vat_invoice');
  assert.equal(`${d.series} ${d.number}`, 'BT 000123');
  assert.equal(d.issueDate, '2026-09-03');
  assert.equal(d.dueDate, '2026-09-17');
  assert.equal(d.counterparty.name, 'UAB Biuro tiekimas');
  assert.equal(d.counterparty.companyCode, '302222222');
  assert.equal(d.counterparty.iban, 'LT601010012345678901');
  assert.equal(d.lines.length, 3);
  assert.deepEqual(d.lines.map((l) => [l.quantity, l.unitPrice, l.accountCode, l.lineType]), [
    ['10', '4.50', '6308', 'expense'], ['1', '899.00', '1240', 'asset'], ['1', '6.00', '6120', 'service']]);
  assert.ok(d.lines.every((l) => l.vatTreatment === 'deductible' && l.suggestion.explanation));
  assert.equal(p.blocking, false, JSON.stringify(errors(p)));
  assert.equal(doc.processing_status, 'ready');
  const c = p.validation.computed;
  assert.deepEqual([c.net, c.vat, c.gross], ['950.00', '199.50', '1149.50']);
  // Provenance: field linked to page/bbox.
  assert.equal(d.provenance.number.source.page, 1);
  assert.equal(d.provenance['lines.1.unitPrice'].source.bbox.length, 4);
  // Nothing posted before approval.
  assert.equal((await t.app.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count, '0');
  // Read-only users cannot approve.
  assert.equal((await ro.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 403);
  const ap = await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash});
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const totals = await ledgerTotals(t.app.pool);
  assert.deepEqual(totals, {1240: '899.00', 2441: '199.50', 4430: '-1149.50', 6120: '6.00', 6308: '45.00'});
  const tb = await acc.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
  assert.equal(tb.status, 200);
  assert.equal(tb.body.totals.debit, tb.body.totals.credit);
});

test('2. unclear scanned VAT is flagged with source; correction triggers server recalculation', async () => {
  const {proposal: p} = await uploadAndProcess(t, acc, inv('scanned.pdf'));
  const errs = errors(p);
  const vatErr = errs.find((e) => e.field.startsWith('sourceTotals.vat'));
  assert.ok(vatErr, JSON.stringify(errs));
  const prov = p.data.provenance['sourceTotals.vatByRate.0.amount'];
  assert.equal(prov.status, 'uncertain');
  assert.equal(prov.source.page, 1);
  assert.equal(prov.source.method, 'ocr');
  assert.ok(prov.source.bbox);
  assert.ok(p.data.provenance.currency.status === 'defaulted');
  // Approval is refused while blocking.
  assert.equal((await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 422);
  // Human correction: VAT 42.00 → new version, recalculated on the server.
  const data = structuredClone(p.data);
  data.sourceTotals.vatByRate[0].amount = '42.00';
  data.sourceTotals.vat = '42.00';
  data.confirmations = {currency: true};
  const ed = await acc.put(`/api/proposals/${p.id}`, {contentHash: p.content_hash, data});
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.version, p.version + 1);
  assert.equal(ed.body.blocking, false, JSON.stringify(errors(ed.body)));
  assert.equal(ed.body.validation.computed.gross, '242.00');
  const corrected = ed.body.data.provenance['sourceTotals.vatByRate.0.amount'];
  assert.equal(corrected.extractedValue, null, 'original extraction kept');
  assert.equal(corrected.corrected.to, '42.00');
  assert.ok(corrected.source.bbox, 'source link survives correction');
  // Stale version cannot be approved.
  assert.equal((await acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})).status, 409);
  assert.equal((await acc.post(`/api/proposals/${ed.body.id}/approve`, {contentHash: ed.body.content_hash})).status, 200);
});

test('3. DOCX and its PDF copy: duplicate review, never double posting', async () => {
  const a = await uploadAndProcess(t, acc, inv('docx-invoice.docx'));
  const b = await uploadAndProcess(t, acc, inv('docx-invoice-copy.pdf'));
  assert.equal(a.proposal.data.lines.length, 2);
  assert.equal(a.proposal.data.lines[0].sourceRef.kind, 'docx-table');
  const dupB = errors(b.proposal).find((e) => e.code === 'duplicate_open');
  assert.ok(dupB, 'PDF copy flagged as possible duplicate');
  // Exact same file again → not even a new document.
  const again = await acc.upload([inv('docx-invoice.docx')]);
  assert.equal(again.body.results[0].status, 'duplicate');
  // Re-fetch A (its validation may now also show the duplicate) and approve after acknowledging.
  const aDoc = await acc.get(`/api/documents/${a.upload.documentId}`);
  let pa = (await acc.get(`/api/proposals/${aDoc.body.proposals.find((x) => x.status === 'open').id}`)).body;
  const dupA = errors(pa).find((e) => e.code === 'duplicate_open');
  if (dupA) {
    const data = structuredClone(pa.data);
    data.acknowledgements = {[`dup:${b.upload.documentId}`]: true};
    pa = (await acc.put(`/api/proposals/${pa.id}`, {contentHash: pa.content_hash, data})).body;
  }
  assert.equal(pa.blocking, false, JSON.stringify(errors(pa)));
  const apA = await acc.post(`/api/proposals/${pa.id}/approve`, {contentHash: pa.content_hash});
  assert.equal(apA.status, 200, JSON.stringify(apA.body));
  // Even if the reviewer acknowledges B, posting is refused because A is posted.
  const pb0 = b.proposal;
  const data = structuredClone(pb0.data);
  data.acknowledgements = {[`dup:${a.upload.documentId}`]: true};
  const pb = (await acc.put(`/api/proposals/${pb0.id}`, {contentHash: pb0.content_hash, data})).body;
  assert.ok(errors(pb).some((e) => e.code === 'duplicate_posted'));
  assert.equal((await acc.post(`/api/proposals/${pb.id}/approve`, {contentHash: pb.content_hash})).status, 422);
  const n = await t.app.pool.query(`SELECT count(*) FROM invoices WHERE number_key=$1`, ['TP20260456']);
  assert.equal(n.rows[0].count, '1');
});

test('4. double approval clicks and retried jobs produce one posting; stale approvals rejected', async () => {
  const {proposal: p, upload} = await uploadAndProcess(t, acc, inv('rotated-scan.png'));
  assert.equal(p.data.number, '2026-0470');
  assert.equal(p.blocking, false, JSON.stringify(errors(p)));
  // Simulated retry of the extraction job: nothing new.
  const {processInvoiceDocument} = await import('../src/invoices/service.mjs');
  const again = await processInvoiceDocument(t.app.deps, upload.documentId);
  assert.equal(again.skipped, 'already_extracted');
  // Concurrent double click.
  const [r1, r2] = await Promise.all([acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}), acc.post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash})]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.equal([r1.body, r2.body].filter((b) => b.alreadyApproved).length, 1);
  const cnt = await t.app.pool.query(`SELECT count(*) FROM journal_entries WHERE idempotency_key=$1`, [`proposal:${p.id}`]);
  assert.equal(cnt.rows[0].count, '1');
  // Changed proposal invalidates an approval request based on the old version.
  const m = await uploadAndProcess(t, acc, inv('multipage.pdf'));
  assert.equal(m.proposal.data.lines.length, 42);
  assert.equal(m.proposal.validation.computed.net, m.proposal.data.sourceTotals.net);
  const data = structuredClone(m.proposal.data);
  data.dueDate = '2026-10-15';
  const ed = await acc.put(`/api/proposals/${m.proposal.id}`, {contentHash: m.proposal.content_hash, data});
  assert.equal(ed.status, 200);
  const stale = await acc.post(`/api/proposals/${m.proposal.id}/approve`, {contentHash: m.proposal.content_hash});
  assert.equal(stale.status, 409);
  const wrongHash = await acc.post(`/api/proposals/${ed.body.id}/approve`, {contentHash: m.proposal.content_hash});
  assert.equal(wrongHash.status, 409);
  // Goods for resale → inventory, not expense.
  assert.ok(ed.body.data.lines.every((l) => l.accountCode === '2040' && l.lineType === 'inventory'));
});

test('5. authorized supplier rule is reusable and auditable; suggestions never create rules', async () => {
  const rulesBefore = (await t.app.pool.query('SELECT count(*) FROM classification_rules')).rows[0].count;
  assert.equal(rulesBefore, '0', 'no rule was learned from processing/approvals so far');
  const cp = (await t.app.pool.query(`SELECT id FROM counterparties WHERE company_code='303333333'`)).rows[0];
  assert.ok(cp);
  // Read-only cannot create rules.
  const body = {name: 'Tinklo paslaugos – serveriai', register: 'purchase', counterparty_id: cp.id, match_text: 'serverio', priority: 10, effective_from: '2026-01-01', account_code: '6307', line_type: 'service', vat_treatment: 'deductible'};
  assert.equal((await ro.post('/api/rules', body)).status, 403);
  const rule = await acc.post('/api/rules', body);
  assert.equal(rule.status, 200, JSON.stringify(rule.body));
  // The two-invoice file contains page 2 = TP 2026-0470 again; split it and check the rule is applied with explanation.
  const two = await uploadAndProcess(t, acc, inv('two-invoices.pdf'));
  assert.ok(errors(two.proposal).some((e) => e.code === 'split'));
  const sp = await acc.post(`/api/documents/${two.upload.documentId}/split`, {ranges: two.proposal.data.splitHint.ranges});
  assert.equal(sp.status, 200, JSON.stringify(sp.body));
  await t.drain();
  const child = await acc.get(`/api/documents/${sp.body.documents[1]}`);
  const p = (await acc.get(`/api/proposals/${child.body.proposals[0].id}`)).body;
  assert.equal(p.data.lines[0].accountCode, '6307');
  assert.equal(p.data.lines[0].suggestion.source, 'rule');
  assert.match(p.data.lines[0].suggestion.explanation, /Tinklo paslaugos – serveriai.*v1/);
  assert.ok(errors(p).some((e) => e.code === 'duplicate_posted'), 'page 2 is TP 2026-0470 already posted in test 4');
  const auditRows = (await t.app.pool.query(`SELECT * FROM audit_log WHERE action='rule.create'`)).rows;
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].details.signedOffBy, t.users.accountant.id);
  // New version keeps history.
  const v2 = await acc.post('/api/rules', {...body, rule_key: rule.body.rule_key, account_code: '6309'});
  assert.equal(v2.body.version, 2);
  const all = (await acc.get('/api/rules?all=1')).body.filter((x) => x.rule_key === rule.body.rule_key);
  assert.deepEqual(all.map((x) => [x.version, x.status]), [[2, 'active'], [1, 'retired']]);
});

test('malicious document text stays untrusted data and does not change the workflow', async () => {
  const {proposal: p, upload} = await uploadAndProcess(t, acc, inv('malicious.pdf'));
  const docRow = (await t.app.pool.query('SELECT processing_status FROM documents WHERE id=$1', [upload.documentId])).rows[0];
  assert.notEqual(docRow.processing_status, 'posted');
  assert.equal((await t.app.pool.query(`SELECT count(*) FROM invoices WHERE number='666'`)).rows[0].count, '0');
  assert.equal((await t.app.pool.query(`SELECT count(*) FROM users WHERE email='attacker@example.test'`)).rows[0].count, '0');
  assert.equal((await t.app.pool.query(`SELECT count(*) FROM classification_rules WHERE counterparty_id IS NOT NULL AND name ILIKE '%Įtartin%'`)).rows[0].count, '0');
  assert.notEqual(p.data.lines[0].accountCode, '6899');
  const search = await acc.get('/api/documents?q=instruction');
  assert.ok(search.body.items.some((d) => String(d.id) === String(upload.documentId)), 'text is stored as searchable data');
  // A model that echoes the injection is filtered by schema + allowlist.
  const {validateLlmOutput} = await import('../src/extraction/llm.mjs');
  const v = validateLlmOutput('{"suggestions":[{"index":0,"accountCode":"9999","lineType":"expense"},{"index":0,"accountCode":"6310","lineType":"service","approve":true},{"index":0,"accountCode":"6310","lineType":"service","reason":"<script>"}]}', {allowedAccounts: new Set(['6310']), lineCount: 1});
  assert.deepEqual(v.items, [{index: 0, accountCode: '6310', lineType: 'service', reason: 'script'}]);
});
