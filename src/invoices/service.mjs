// Invoice inbox workflow: processing jobs, versioned proposals, edits, approval, corrections.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AppError, tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {money} from '../lib/money.mjs';
import {postEntry} from '../ledger/ledger.mjs';
import {extractPdf, extractImage, extractDocx, plainText} from '../extraction/text.mjs';
import {parseInvoice, PROVIDER} from '../extraction/invoice-parser.mjs';
import {addFile, currentOriginal, createDocument, refreshSearch, loadDocumentForUser} from '../vault/documents.mjs';
import {proposalFromExtraction, computeProposal, contentHash, applyClassification, DOC_TYPES, LINE_TYPES, VAT_TREATMENTS} from './engine.mjs';
import {loadContext, findCounterparty, findDuplicates} from './context.mjs';
import {normalizeVat, normalizeIban, numberKey} from '../extraction/ids.mjs';
import {enqueue} from '../jobs.mjs';
import {applyLlmSuggestions} from '../extraction/llm.mjs';

const run = promisify(execFile);

const KIND_FOR = {vat_invoice: null, invoice: null, credit_note: 'credit_note', debit_note: null, proforma: 'proforma', contract: 'contract', receipt: 'receipt'};
function docKindFor(data) {
  if (KIND_FOR[data.docType]) return KIND_FOR[data.docType];
  if (data.register === 'sales') return 'sales_invoice';
  if (data.register === 'purchase') return 'purchase_invoice';
  return 'unknown';
}

/** Extract text layer for a stored file. */
export async function extractText(storage, file, config) {
  const dir = await storage.tempDir('ext');
  try {
    const buf = await storage.read(file.storage_key);
    const ext = {'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png'}[file.mime] || 'bin';
    const p = path.join(dir, `in.${ext}`);
    await fs.writeFile(p, buf);
    const opts = {languages: config.ocrLanguages};
    if (file.mime === 'application/pdf') return await extractPdf(p, dir, opts);
    if (file.mime.startsWith('image/')) return await extractImage(p, dir, opts);
    if (file.mime.includes('wordprocessingml')) return await extractDocx(buf);
    throw new AppError(415, 'unsupported', 'Šio failo tipo atpažinti negalima.');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

/** Background job: extract → proposal. Safe to retry: one extraction/proposal per original file version. */
export async function processInvoiceDocument({pool, storage, config, llm}, documentId, {force = false} = {}) {
  const doc = (await pool.query('SELECT * FROM documents WHERE id=$1', [documentId])).rows[0];
  if (!doc) return {skipped: 'missing'};
  const file = await currentOriginal(pool, documentId);
  const existing = (await pool.query('SELECT id FROM extractions WHERE file_id=$1 ORDER BY id DESC LIMIT 1', [file.id])).rows[0];
  if (!force && existing && !['uploaded', 'processing', 'failed'].includes(doc.processing_status)) return {skipped: 'already_extracted'};
  if (doc.processing_status !== 'posted') await pool.query(`UPDATE documents SET processing_status='processing', processing_error=NULL, updated_at=now() WHERE id=$1 AND processing_status IN ('uploaded','processing','failed','needs_review','ready')`, [documentId]);
  const textDoc = await extractText(storage, file, config);
  const result = parseInvoice(textDoc);
  return tx(pool, async (db) => {
    const locked = (await db.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [documentId])).rows[0];
    // Previews and page text (derived, separately identifiable from the original).
    const havePreviews = (await db.query(`SELECT page FROM stored_files WHERE derived_from_file_id=$1 AND role='preview'`, [file.id])).rows.map((r) => r.page);
    for (const page of textDoc.pages) {
      if (page.image && !havePreviews.includes(page.page)) {
        await addFile(db, storage, {documentId, buffer: page.image, mime: 'image/png', originalName: `preview-p${page.page}.png`, role: 'preview', page: page.page, derivedFrom: file.id, note: page.method === 'ocr' ? `OCR vaizdas (pasukta ${page.ocr?.rotate || 0}°, ištiesinta)` : 'Peržiūra'});
      }
      await db.query(`INSERT INTO document_pages(document_id, file_id, page, method, text) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (file_id, page) DO UPDATE SET text=EXCLUDED.text, method=EXCLUDED.method`, [documentId, file.id, page.page, page.method, page.rows.map((r) => r.text).join('\n')]);
    }
    const layout = textDoc.pages.map((p) => ({page: p.page, method: p.method, rows: p.rows.map((r) => ({text: r.text, bbox: r.bbox || null, source: r.source || null, segments: (r.segments || []).map((s) => ({text: s.text, bbox: s.bbox || null, source: s.source || null}))}))}));
    const ex = (await db.query(`INSERT INTO extractions(document_id, file_id, provider, provider_version, is_demo, result) VALUES ($1,$2,$3,$4,false,$5) RETURNING id`,
      [documentId, file.id, PROVIDER.name, PROVIDER.version, {...result, layout}])).rows[0];
    await refreshSearch(db, documentId);
    const ctx = await loadContext(db);
    const data0 = proposalFromExtraction(result, {...ctx, findCounterparty: () => null});
    const known = data0.counterparty.name ? await findCounterparty(db, data0.counterparty) : null;
    let data = known ? applyClassification({...data0, counterparty: {...data0.counterparty, id: String(known.id)}}, ctx, {force: true}) : data0;
    if (llm?.enabled && data.register) {
      const open = data.lines.map((l, i) => ({...l, i})).filter((l) => l.suggestion?.source === 'none');
      if (open.length) {
        try {
          const items = await llm.classify(open.map((l) => ({description: l.description, unit: l.unit, net: l.sourceNet})), {accounts: ctx.accounts, register: data.register});
          data = applyLlmSuggestions(data, items.map((it) => ({...it, index: open[it.index].i})), llm.name);
        } catch (e) { data.extractionNotes = [...(data.extractionNotes || []), `Kalbos modelio pasiūlymai nepasiekiami: ${e.message}`]; }
      }
    }
    if (locked.processing_status === 'posted') {
      const inv = (await db.query(`SELECT id FROM invoices WHERE document_id=$1 AND doc_type<>'correction' ORDER BY id LIMIT 1`, [documentId])).rows[0];
      const diff = inv ? await differsFromPosted(db, inv.id, data, ctx) : null;
      if (!diff) { await audit(db, {actor: 'system', action: 'document.reextract_no_change', entityType: 'document', entityId: documentId, details: {extractionId: ex.id}}); return {correction: false}; }
      const p = await createProposalVersion(db, {documentId, kind: 'correction', data: {...data, origin: 'correction'}, extractionId: ex.id, correctsInvoiceId: inv.id, fileSha: null});
      await audit(db, {actor: 'system', action: 'proposal.correction_created', entityType: 'proposal', entityId: p.id, details: {invoiceId: inv.id, differences: diff}});
      return {correction: true, proposalId: p.id};
    }
    const p = await createProposalVersion(db, {documentId, kind: 'invoice', data: {...data, origin: 'extraction'}, extractionId: ex.id, fileSha: file.sha256});
    await db.query('UPDATE documents SET kind=$2, title=COALESCE(NULLIF(title,\'\'), $3), reference_number=$4, issue_date=$5, updated_at=now() WHERE id=$1',
      [documentId, docKindFor(data), `${data.counterparty.name || 'Dokumentas'} ${[data.series, data.number].filter(Boolean).join(' ')}`.trim(), [data.series, data.number].filter(Boolean).join(' '), /^\d{4}-\d{2}-\d{2}$/.test(data.issueDate) ? data.issueDate : null]);
    await audit(db, {actor: 'system', action: 'document.extracted', entityType: 'document', entityId: documentId, details: {extractionId: ex.id, provider: PROVIDER.name, pages: textDoc.pages.length, methods: [...new Set(textDoc.pages.map((x) => x.method))], proposalId: p.id, blocking: p.blocking}});
    return {proposalId: p.id, blocking: p.blocking};
  });
}

async function differsFromPosted(db, invoiceId, data, ctx) {
  const inv = (await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0];
  const c = computeProposal(data, {...ctx, duplicates: {}});
  const diffs = [];
  if (!money.eq(inv.net_total, c.computed.net || '0')) diffs.push(`suma be PVM ${inv.net_total} → ${c.computed.net}`);
  if (!money.eq(inv.vat_total, c.computed.vat || '0')) diffs.push(`PVM ${inv.vat_total} → ${c.computed.vat}`);
  if (inv.issue_date !== data.issueDate) diffs.push(`data ${inv.issue_date} → ${data.issueDate}`);
  if (numberKey(inv.series, inv.number) !== numberKey(data.series, data.number)) diffs.push(`numeris ${inv.series} ${inv.number} → ${data.series} ${data.number}`);
  return diffs.length ? diffs : null;
}

/** Insert a new proposal version (superseding the open one) with server-computed validation. */
export async function createProposalVersion(db, {documentId = null, externalOrderId = null, kind, data, userId = null, extractionId = null, correctsInvoiceId = null, fileSha}) {
  const ctx = await loadContext(db);
  const first = computeProposal(data, {...ctx, duplicates: {}});
  if (fileSha === undefined && documentId) fileSha = (await currentOriginal(db, documentId))?.sha256;
  const duplicates = kind === 'correction' ? {} : await findDuplicates(db, {data, computed: first.computed, documentId, fileSha});
  const related = data.relatedDocument && !data.relatedInvoiceId && data.register ? await findRelatedInvoice(db, data) : null;
  if (related) data = {...data, relatedInvoiceId: String(related.id)};
  const {computed, issues, blocking} = computeProposal(data, {...ctx, duplicates});
  if (kind === 'correction') issues.push({level: 'info', field: 'kind', code: 'correction', message: 'Tai koregavimo pasiūlymas jau užregistruotam dokumentui: patvirtinus bus užregistruotas skirtumas, originalus įrašas nekeičiamas.'});
  const where = documentId ? 'document_id=$1' : 'external_order_id=$1';
  const key = documentId || externalOrderId;
  const prev = (await db.query(`SELECT max(version) AS v FROM proposals WHERE ${where}`, [key])).rows[0];
  await db.query(`UPDATE proposals SET status='superseded' WHERE ${where} AND status='open'`, [key]);
  const r = await db.query(`INSERT INTO proposals(document_id, external_order_id, kind, version, extraction_id, corrects_invoice_id, data, validation, blocking, content_hash, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [documentId, externalOrderId, kind, Number(prev.v || 0) + 1, extractionId, correctsInvoiceId, data, {issues, computed}, blocking, contentHash(data), userId]);
  if (documentId) await db.query(`UPDATE documents SET processing_status=$2, updated_at=now() WHERE id=$1 AND processing_status<>'posted'`, [documentId, blocking ? 'needs_review' : 'ready']);
  return r.rows[0];
}

async function findRelatedInvoice(db, data) {
  const m = /([A-Z]{1,10})?[\s-]*([A-Z0-9][A-Z0-9\-\/]*)$/i.exec(String(data.relatedDocument).trim());
  if (!m) return null;
  const keys = [numberKey('', data.relatedDocument), numberKey(m[1] || '', m[2])];
  const cpKey = computeKeyForRelated(data);
  return (await db.query(`SELECT id FROM invoices WHERE register=$1 AND number_key = ANY($2) AND counterparty_key=$3 AND doc_type IN ('vat_invoice','invoice') LIMIT 1`, [data.register, keys, cpKey])).rows[0] || null;
}
function computeKeyForRelated(data) {
  if (data.register === 'sales') return 'own';
  const c = data.counterparty || {};
  return c.companyCode ? `code:${c.companyCode}` : c.vatCode ? `vat:${normalizeVat(c.vatCode)}` : `name:${String(c.name || '').toLowerCase()}`;
}

// ------------------------------------------------------------------ editing
const str = (v, n = 300) => (v === null || v === undefined ? '' : String(v).slice(0, n));
const amt = (v) => { const s = str(v, 30).trim().replace(',', '.'); return s; };

function sanitizeData(input, prev) {
  const d = input || {};
  const lines = Array.isArray(d.lines) ? d.lines.slice(0, 500) : [];
  const out = {
    docType: DOC_TYPES.includes(d.docType) ? d.docType : prev.docType,
    register: ['purchase', 'sales'].includes(d.register) ? d.register : null,
    registerReason: prev.registerReason,
    series: str(d.series, 20).toUpperCase(), number: str(d.number, 60), issueDate: str(d.issueDate, 10), dueDate: str(d.dueDate, 10), vatPointDate: str(d.vatPointDate, 10),
    currency: str(d.currency, 3).toUpperCase(),
    counterparty: {id: d.counterparty?.id ? String(d.counterparty.id) : null, name: str(d.counterparty?.name), companyCode: str(d.counterparty?.companyCode, 20).replace(/\s/g, ''), vatCode: normalizeVat(str(d.counterparty?.vatCode, 20)), address: str(d.counterparty?.address), country: str(d.counterparty?.country || 'LT', 2).toUpperCase(), iban: normalizeIban(str(d.counterparty?.iban, 40))},
    paymentReference: str(d.paymentReference), orderReference: str(d.orderReference), relatedDocument: str(d.relatedDocument), relatedInvoiceId: d.relatedInvoiceId ? String(d.relatedInvoiceId) : null,
    lines: lines.map((l, i) => {
      const old = prev.lines?.[i] || {};
      const accountChanged = l.accountCode !== old.accountCode || l.lineType !== old.lineType || l.vatTreatment !== old.vatTreatment;
      return {
        description: str(l.description, 500), sku: str(l.sku, 60), quantity: amt(l.quantity), unit: str(l.unit, 20), unitPrice: amt(l.unitPrice), discount: amt(l.discount || '0'),
        sourceNet: amt(l.sourceNet), vatRate: amt(l.vatRate), taxCode: str(l.taxCode, 10), accountCode: str(l.accountCode, 8),
        lineType: LINE_TYPES.includes(l.lineType) ? l.lineType : '', vatTreatment: VAT_TREATMENTS.includes(l.vatTreatment) ? l.vatTreatment : '',
        productId: l.productId ? String(l.productId) : null,
        userClassified: !!(old.userClassified || (accountChanged && l.accountCode)),
        suggestion: accountChanged && l.accountCode ? {source: 'manual', explanation: 'Pasirinkta naudotojo.'} : old.suggestion || null,
        sourceRef: old.sourceRef || null,
      };
    }),
    sourceTotals: {net: amt(d.sourceTotals?.net), vat: amt(d.sourceTotals?.vat), gross: amt(d.sourceTotals?.gross), vatByRate: (d.sourceTotals?.vatByRate || []).slice(0, 10).map((r) => ({rate: amt(r.rate), amount: amt(r.amount)}))},
    acknowledgements: Object.fromEntries(Object.entries(d.acknowledgements || {}).filter(([k, v]) => /^(dup:\d+|near:\d+|splitReviewed)$/.test(k) && v === true).map(([k]) => [k, true])),
    confirmations: Object.fromEntries(Object.entries(d.confirmations || {}).filter(([k, v]) => /^[a-zA-Z0-9_.]{1,80}$/.test(k) && v === true).map(([k]) => [k, true])),
    provenance: prev.provenance || {}, splitHint: prev.splitHint || null, extractionNotes: prev.extractionNotes || [],
    origin: prev.origin, storeId: prev.storeId, externalOrderId: prev.externalOrderId,
  };
  for (const k of ['sourceTotals.net', 'sourceTotals.vat', 'sourceTotals.gross']) if (!/^(-?\d+(\.\d{1,2})?)?$/.test(k.split('.').reduce((o, p) => o?.[p], out) || '')) throw new AppError(400, 'bad_amount', `Netinkama suma: ${k}`);
  return out;
}

/** Mark provenance for every changed field; the extracted value is preserved. */
function trackCorrections(prev, next, user, now) {
  const prov = {...(next.provenance || {})};
  const get = (o, p) => p.split('.').reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
  const paths = new Set(Object.keys(prov));
  for (const k of ['docType', 'register', 'series', 'number', 'issueDate', 'dueDate', 'currency', 'paymentReference', 'orderReference', 'relatedDocument', 'sourceTotals.net', 'sourceTotals.vat', 'sourceTotals.gross']) paths.add(k);
  for (const k of ['name', 'companyCode', 'vatCode', 'address', 'iban']) paths.add(`counterparty.${k}`);
  next.lines.forEach((_, i) => ['description', 'quantity', 'unitPrice', 'discount', 'vatRate', 'sourceNet', 'accountCode', 'taxCode', 'vatTreatment'].forEach((k) => paths.add(`lines.${i}.${k}`)));
  (next.sourceTotals.vatByRate || []).forEach((_, i) => paths.add(`sourceTotals.vatByRate.${i}.amount`));
  for (const p of paths) {
    const before = get(prev, p), after = get(next, p);
    if (String(before ?? '') !== String(after ?? '')) {
      prov[p] = {...(prov[p] || {}), corrected: {by: user.id, byName: user.name || user.email, at: now, from: before ?? null, to: after ?? null}};
    }
  }
  // Line-level net provenance follows sourceNet edits.
  return prov;
}

export async function editProposal(pool, user, proposalId, {contentHash: baseHash, data}) {
  requireCap(user, 'write');
  return tx(pool, async (db) => {
    const p = (await db.query('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [proposalId])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    if (p.document_id) await loadDocumentForUser(db, user, p.document_id);
    if (p.status !== 'open') throw new AppError(409, 'stale', 'Pasiūlymas jau pasikeitė arba užbaigtas. Atnaujinkite puslapį.');
    if (p.content_hash !== baseHash) throw new AppError(409, 'stale', 'Pasiūlymą ką tik pakeitė kitas veiksmas. Atnaujinkite ir pakartokite.');
    let next = sanitizeData(data, p.data);
    next.provenance = trackCorrections(p.data, next, user, new Date().toISOString());
    const ctx = await loadContext(db);
    if (next.register !== p.data.register) next.lines = next.lines.map((l) => ({...l, userClassified: false, taxCode: ''}));
    if (next.issueDate !== p.data.issueDate) next.lines = next.lines.map((l) => ({...l, taxCode: l.taxCode && !String(l.taxCode).startsWith('PVM') ? l.taxCode : ''}));
    next.lines = next.lines.map((l, i) => {
      const o = p.data.lines?.[i];
      return (!o || o.vatRate !== l.vatRate) && !l.userTax ? {...l, taxCode: ''} : l;
    });
    if (next.counterparty.id) {
      const cp = (await db.query('SELECT id FROM counterparties WHERE id=$1', [next.counterparty.id])).rows[0];
      if (!cp) next.counterparty.id = null;
    } else if (next.counterparty.name) {
      const known = await findCounterparty(db, next.counterparty);
      if (known) next.counterparty.id = String(known.id);
    }
    next = applyClassification(next, ctx);
    const created = await createProposalVersion(db, {documentId: p.document_id, externalOrderId: p.external_order_id, kind: p.kind, data: next, userId: user.id, extractionId: p.extraction_id, correctsInvoiceId: p.corrects_invoice_id});
    await audit(db, {userId: user.id, action: 'proposal.edit', entityType: 'proposal', entityId: created.id, details: {previousId: p.id, version: created.version, documentId: p.document_id}});
    return created;
  });
}

export async function rejectProposal(pool, user, proposalId, {contentHash: hash, reason = ''}) {
  requireCap(user, 'approve');
  return tx(pool, async (db) => {
    const p = (await db.query('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [proposalId])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    if (p.document_id) await loadDocumentForUser(db, user, p.document_id);
    if (p.status !== 'open' || p.content_hash !== hash) throw new AppError(409, 'stale', 'Pasiūlymas pasikeitė. Atnaujinkite puslapį.');
    await db.query(`UPDATE proposals SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [p.id, user.id, str(reason, 500)]);
    if (p.document_id && p.kind !== 'correction') await db.query(`UPDATE documents SET processing_status='rejected', updated_at=now() WHERE id=$1`, [p.document_id]);
    if (p.external_order_id) await db.query(`UPDATE external_orders SET state='ignored', state_note=$2, updated_at=now() WHERE id=$1`, [p.external_order_id, `Atmesta: ${str(reason, 200)}`]);
    await audit(db, {userId: user.id, action: 'proposal.reject', entityType: 'proposal', entityId: p.id, details: {reason: str(reason, 500), documentId: p.document_id}});
    return {ok: true};
  });
}

// ------------------------------------------------------------------ approval
/**
 * Approve exactly the reviewed proposal version. One database transaction records the
 * counterparty, register rows, VAT rows and journal entry. Repeated calls are idempotent.
 */
export async function approveProposal(pool, user, proposalId, {contentHash: hash}) {
  requireCap(user, 'approve');
  return tx(pool, async (db) => {
    const p = (await db.query('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [proposalId])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    if (p.document_id) await loadDocumentForUser(db, user, p.document_id);
    if (p.status === 'approved') {
      const inv = (await db.query('SELECT id FROM invoices WHERE proposal_id=$1', [p.id])).rows[0];
      return {alreadyApproved: true, invoiceId: inv?.id || null};
    }
    if (p.status !== 'open') throw new AppError(409, 'stale', 'Ši pasiūlymo versija nebegalioja (buvo pakeista arba atmesta). Peržiūrėkite naujausią versiją.');
    if (p.content_hash !== hash) throw new AppError(409, 'stale', 'Peržiūrėta versija nesutampa su dabartine. Peržiūrėkite iš naujo.');
    // Recompute inside the transaction against current state (locks, duplicates, rules).
    const ctx = await loadContext(db);
    const data = p.data;
    const first = computeProposal(data, {...ctx, duplicates: {}});
    const fileSha = p.document_id ? (await currentOriginal(db, p.document_id))?.sha256 : null;
    const duplicates = p.kind === 'correction' ? {} : await findDuplicates(db, {data, computed: first.computed, documentId: p.document_id, fileSha});
    const {computed, issues, blocking} = computeProposal(data, {...ctx, duplicates});
    if (blocking) throw new AppError(422, 'validation', 'Pasiūlymas turi neišspręstų klaidų.', {issues: issues.filter((i) => i.level === 'error')});
    const company = ctx.company;
    // Counterparty record (created on approval, never from AI alone).
    let cpId = data.counterparty.id;
    if (!cpId) {
      const c = data.counterparty;
      const ins = await db.query(`INSERT INTO counterparties(name, company_code, vat_code, address, country, iban, is_supplier, is_customer)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (company_code) WHERE company_code <> '' DO UPDATE SET name=counterparties.name RETURNING id`,
      [c.name, c.companyCode || '', c.vatCode || '', c.address || '', c.country || 'LT', c.iban || '', data.register === 'purchase', data.register === 'sales']);
      cpId = ins.rows[0].id;
      await audit(db, {userId: user.id, action: 'counterparty.create', entityType: 'counterparty', entityId: cpId, details: {fromProposal: p.id}});
    } else {
      await db.query(`UPDATE counterparties SET is_supplier = is_supplier OR $2, is_customer = is_customer OR $3 WHERE id=$1`, [cpId, data.register === 'purchase', data.register === 'sales']);
    }
    // Numbering for invoices issued in this application (unique under concurrency: row lock + unique index).
    let series = data.series || '', number = data.number;
    if (p.kind === 'manual_invoice' || (p.kind === 'credit_note' && data.register === 'sales' && data.issueHere)) {
      const seriesCode = data.seriesCode;
      const s = (await db.query(`UPDATE document_series SET next_number = next_number + 1 WHERE code=$1 AND active RETURNING next_number - 1 AS n, padding, code`, [seriesCode])).rows[0];
      if (!s) throw new AppError(422, 'series', 'Dokumentų serija nerasta arba neaktyvi.');
      series = s.code; number = String(s.n).padStart(s.padding, '0');
    }
    const invoiceId = (await db.query(`SELECT nextval('invoices_id_seq') AS id`)).rows[0].id;
    const docType = p.kind === 'correction' ? 'correction' : data.docType;
    let lines = computed.lines.map((cl) => ({...data.lines[cl.index], ...cl}));
    let totals = {net: computed.net, vat: computed.vat, gross: computed.gross, deductible: computed.deductibleVat};
    let vatRows = computed.vatGroups.map((g) => ({taxCode: g.taxCode, isafCode: g.isafCode, rate: g.taxCode === 'BE_PVM' ? null : g.rate, taxable: g.taxable, vat: g.vat,
      deductible: data.register === 'purchase' ? money.sum(lines.filter((l) => l.taxCode === g.taxCode && l.vatTreatment === 'deductible').map((l) => l.vat)) : '0.00'}));
    let entryLines = computed.entries.map((e) => ({account: e.account, debit: e.debit, credit: e.credit, counterpartyId: e.counterparty ? cpId : null, description: `${series} ${number}`.trim()}));
    let relatedId = data.relatedInvoiceId || null;
    let numberKeyValue = computed.numberKey;
    if (p.kind === 'correction') {
      const delta = await correctionDelta(db, p.corrects_invoice_id, {lines, totals, vatRows, entryLines});
      ({lines, totals, vatRows, entryLines} = delta);
      relatedId = p.corrects_invoice_id;
      const n = (await db.query(`SELECT count(*) AS n FROM invoices WHERE related_invoice_id=$1 AND doc_type='correction'`, [relatedId])).rows[0].n;
      numberKeyValue = `${computed.numberKey}K${Number(n) + 1}`;
      if (!entryLines.length) throw new AppError(422, 'no_change', 'Koregavimas nekeičia apskaitos sumų.');
    }
    const entry = await postEntry(db, {
      date: data.issueDate, description: `${data.register === 'sales' ? 'Pardavimas' : 'Pirkimas'} ${series} ${number} – ${data.counterparty.name}${p.kind === 'correction' ? ' (koregavimas)' : ''}`,
      sourceType: 'invoice', sourceId: invoiceId, idempotencyKey: `proposal:${p.id}`, userId: user.id, lines: entryLines,
    });
    const cpSnapshot = {...data.counterparty, id: String(cpId)};
    const companySnapshot = {name: company.name, companyCode: company.company_code, vatCode: company.vat_code, address: company.address, vatRegistered: company.vat_registered};
    const external = p.external_order_id ? (await db.query('SELECT store_id FROM external_orders WHERE id=$1', [p.external_order_id])).rows[0] : null;
    await db.query(`INSERT INTO invoices(id, register, doc_type, series, number, number_key, issue_date, vat_point_date, due_date, currency, counterparty_id, counterparty_key,
        counterparty_snapshot, company_snapshot, net_total, vat_total, gross_total, deductible_vat, document_id, proposal_id, journal_entry_id, related_invoice_id,
        store_id, external_order_id, order_reference, payment_reference, approved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [invoiceId, data.register, docType, series, number, p.kind === 'manual_invoice' ? `${series}${Number(number)}` : numberKeyValue, data.issueDate, data.vatPointDate || null, data.dueDate || null, data.currency,
      cpId, computed.counterpartyKey, cpSnapshot, companySnapshot, totals.net, totals.vat, totals.gross, totals.deductible, p.document_id, p.id, entry.id, relatedId,
      external?.store_id || null, p.external_order_id, data.orderReference || '', data.paymentReference || '', user.id]);
    let n = 0;
    for (const l of lines) {
      n++;
      await db.query(`INSERT INTO invoice_lines(invoice_id, line_no, description, sku, product_id, quantity, unit, unit_price, discount, net, tax_code, vat_rate, vat, gross, account_code, line_type, vat_treatment, rule_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [invoiceId, n, l.description, l.sku || '', l.productId || null, l.quantity, l.unit || '', l.unitPrice, money.norm(l.discount || '0'), l.net, l.taxCode, l.rate ?? '0', l.vat, l.gross, l.accountCode, l.lineType, l.vatTreatment, l.suggestion?.source === 'rule' ? l.suggestion.ruleId : null]);
    }
    for (const v of vatRows) {
      await db.query(`INSERT INTO invoice_vat_rows(invoice_id, tax_code, isaf_code, rate, taxable, vat, deductible_vat) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, v.taxCode, v.isafCode || '', v.rate, v.taxable, v.vat, v.deductible]);
    }
    await db.query(`UPDATE proposals SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [p.id, user.id]);
    if (p.document_id) {
      await db.query(`UPDATE documents SET processing_status='posted', kind=CASE WHEN kind IN ('unknown','purchase_invoice','sales_invoice','credit_note','generated_invoice') THEN $2 ELSE kind END,
        counterparty_id=$3, reference_number=$4, issue_date=$5, updated_at=now() WHERE id=$1`, [p.document_id, p.kind === 'correction' ? 'purchase_invoice' : docKindFor(data), cpId, `${series} ${number}`.trim(), data.issueDate]);
      await refreshSearch(db, p.document_id);
    }
    if (p.external_order_id) await db.query(`UPDATE external_orders SET state='posted', invoice_id=COALESCE(invoice_id,$2), updated_at=now() WHERE id=$1`, [p.external_order_id, invoiceId]);
    await audit(db, {userId: user.id, action: 'proposal.approve', entityType: 'proposal', entityId: p.id, details: {invoiceId, journalEntryId: entry.id, version: p.version, contentHash: p.content_hash, documentId: p.document_id, gross: totals.gross}});
    return {invoiceId, journalEntryId: entry.id, number: `${series} ${number}`.trim()};
  });
}

/** Delta between the corrected data and what is currently posted for the invoice group. */
async function correctionDelta(db, invoiceId, next) {
  const group = (await db.query(`SELECT id FROM invoices WHERE id=$1 OR (related_invoice_id=$1 AND doc_type='correction')`, [invoiceId])).rows.map((r) => r.id);
  const oldLines = (await db.query(`SELECT * FROM invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, line_no`, [group])).rows;
  const oldVat = (await db.query(`SELECT tax_code, isaf_code, rate, sum(taxable) AS taxable, sum(vat) AS vat, sum(deductible_vat) AS deductible FROM invoice_vat_rows WHERE invoice_id = ANY($1) GROUP BY 1,2,3`, [group])).rows;
  const oldTotals = (await db.query(`SELECT sum(net_total) AS net, sum(vat_total) AS vat, sum(gross_total) AS gross, sum(deductible_vat) AS ded FROM invoices WHERE id = ANY($1)`, [group])).rows[0];
  const oldEntries = (await db.query(`SELECT l.account_code, l.counterparty_id, sum(l.debit - l.credit) AS amt FROM journal_lines l JOIN invoices i ON i.journal_entry_id = l.entry_id WHERE i.id = ANY($1) GROUP BY 1,2`, [group])).rows;
  const negQty = (q) => (String(q).startsWith('-') ? String(q).slice(1) : `-${q}`);
  const lines = [
    ...oldLines.map((l) => ({description: `Atšaukiama: ${l.description}`, sku: l.sku, productId: l.product_id, quantity: negQty(l.quantity), unit: l.unit, unitPrice: l.unit_price,
      discount: money.neg(l.discount), net: money.neg(l.net), taxCode: l.tax_code, rate: l.vat_rate, vat: money.neg(l.vat), gross: money.neg(l.gross), accountCode: l.account_code, lineType: l.line_type, vatTreatment: l.vat_treatment})),
    ...next.lines,
  ];
  const vatMap = new Map();
  for (const v of oldVat) vatMap.set(v.tax_code, {taxCode: v.tax_code, isafCode: v.isaf_code, rate: v.rate, taxable: money.neg(v.taxable), vat: money.neg(v.vat), deductible: money.neg(v.deductible)});
  for (const v of next.vatRows) {
    const cur = vatMap.get(v.taxCode) || {taxCode: v.taxCode, isafCode: v.isafCode, rate: v.rate, taxable: '0.00', vat: '0.00', deductible: '0.00'};
    vatMap.set(v.taxCode, {...cur, taxable: money.add(cur.taxable, v.taxable), vat: money.add(cur.vat, v.vat), deductible: money.add(cur.deductible, v.deductible)});
  }
  const signed = new Map();
  for (const e of oldEntries) signed.set(`${e.account_code}|${e.counterparty_id || ''}`, money.neg(e.amt));
  for (const e of next.entryLines) { const k = `${e.account}|${e.counterpartyId || ''}`; signed.set(k, money.add(signed.get(k) || '0', money.sub(e.debit, e.credit))); }
  const entryLines = [...signed].filter(([, a]) => !money.isZero(a)).map(([k, a]) => { const [account, cp] = k.split('|'); const pos = money.sign(a) > 0; return {account, debit: pos ? money.norm(a) : '0', credit: pos ? '0' : money.abs(a), counterpartyId: cp || null, description: 'Koregavimas'}; });
  return {lines, vatRows: [...vatMap.values()].filter((v) => !money.isZero(v.taxable) || !money.isZero(v.vat)),
    totals: {net: money.sub(next.totals.net, oldTotals.net), vat: money.sub(next.totals.vat, oldTotals.vat), gross: money.sub(next.totals.gross, oldTotals.gross), deductible: money.sub(next.totals.deductible, oldTotals.ded)}, entryLines};
}

/** Bulk approval: only explicitly selected, fully validated proposals; each in its own transaction. */
export async function bulkApprove(pool, user, items) {
  requireCap(user, 'approve');
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new AppError(400, 'bad_request', 'Pasirinkite nuo 1 iki 100 dokumentų.');
  const results = [];
  for (const it of items) {
    try {
      const r = await approveProposal(pool, user, String(it.proposalId), {contentHash: String(it.contentHash || '')});
      results.push({proposalId: it.proposalId, ok: true, ...r});
    } catch (e) {
      results.push({proposalId: it.proposalId, ok: false, error: e.message, code: e.code, issues: e.details?.issues});
    }
  }
  return results;
}

// ------------------------------------------------------------------ split / re-extract
export async function splitDocument(pool, storage, user, documentId, ranges) {
  requireCap(user, 'write');
  const doc = await loadDocumentForUser(pool, user, documentId);
  if (doc.processing_status === 'posted') throw new AppError(409, 'posted', 'Užregistruoto dokumento skaidyti negalima.');
  const file = await currentOriginal(pool, documentId);
  if (file.mime !== 'application/pdf') throw new AppError(400, 'not_pdf', 'Skaidyti galima tik PDF failus.');
  if (!Array.isArray(ranges) || ranges.length < 2 || ranges.length > 20) throw new AppError(400, 'bad_ranges', 'Nurodykite bent dvi puslapių grupes.');
  const dir = await storage.tempDir('split');
  try {
    const src = path.join(dir, 'in.pdf');
    await fs.writeFile(src, await storage.read(file.storage_key));
    const {stdout} = await run('pdfinfo', [src]);
    const pages = Number(/Pages:\s+(\d+)/.exec(stdout)?.[1] || 0);
    const parts = [];
    for (const [i, r] of ranges.entries()) {
      const from = Number(r.from), to = Number(r.to);
      if (!(from >= 1 && to >= from && to <= pages)) throw new AppError(400, 'bad_ranges', `Netinkamas puslapių intervalas ${r.from}–${r.to}.`);
      const outs = [];
      for (let pg = from; pg <= to; pg++) { const o = path.join(dir, `p${i}-${pg}.pdf`); await run('pdfseparate', ['-f', String(pg), '-l', String(pg), src, o]); outs.push(o); }
      const merged = path.join(dir, `part${i}.pdf`);
      if (outs.length === 1) await fs.copyFile(outs[0], merged); else await run('pdfunite', [...outs, merged]);
      parts.push({from, to, buffer: await fs.readFile(merged)});
    }
    return await tx(pool, async (db) => {
      const created = [];
      for (const part of parts) {
        const child = await createDocument(db, {kind: 'unknown', title: `${doc.title || 'Dokumentas'} (psl. ${part.from}–${part.to})`, confidentiality: doc.confidentiality, workflow: 'invoice', parent_document_id: documentId}, user.id);
        await addFile(db, storage, {documentId: child.id, buffer: part.buffer, mime: 'application/pdf', originalName: `${file.original_name.replace(/\.pdf$/i, '')}-p${part.from}-${part.to}.pdf`, role: 'original', derivedFrom: file.id, userId: user.id, note: `Padalinta iš dokumento #${documentId}, psl. ${part.from}–${part.to}`});
        await db.query(`INSERT INTO document_links(from_document_id, to_document_id, relation, created_by) VALUES ($1,$2,'split_part',$3)`, [documentId, child.id, user.id]);
        await enqueue(db, 'extract_invoice', {documentId: child.id}, {idempotencyKey: `extract:${child.id}:1`});
        created.push(child.id);
      }
      await db.query(`UPDATE proposals SET status='superseded' WHERE document_id=$1 AND status='open'`, [documentId]);
      await db.query(`UPDATE documents SET processing_status='stored', workflow='vault', notes = trim(notes || ' Padalinta į dokumentus: ' || $2), updated_at=now() WHERE id=$1`, [documentId, created.map((c) => `#${c}`).join(', ')]);
      await audit(db, {userId: user.id, action: 'document.split', entityType: 'document', entityId: documentId, details: {parts: created, ranges}});
      return {documents: created};
    });
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

export async function requestReextract(pool, user, documentId) {
  requireCap(user, 'write');
  return tx(pool, async (db) => {
    const doc = await loadDocumentForUser(db, user, documentId, {forUpdate: true});
    if (doc.workflow !== 'invoice') throw new AppError(400, 'not_invoice', 'Dokumentas nėra sąskaitų dėžutėje.');
    if (doc.processing_status !== 'posted') await db.query(`UPDATE documents SET processing_status='processing' WHERE id=$1`, [documentId]);
    const n = (await db.query('SELECT count(*) AS n FROM extractions WHERE document_id=$1', [documentId])).rows[0].n;
    await enqueue(db, 'extract_invoice', {documentId: String(documentId), force: true}, {idempotencyKey: `extract:${documentId}:${Number(n) + 1}:${Date.now()}`});
    await audit(db, {userId: user.id, action: 'document.reextract_requested', entityType: 'document', entityId: documentId});
    return {queued: true};
  });
}

/** Re-run validation against the current database state (duplicates, locks) without a new version. */
export async function liveValidation(db, p) {
  if (p.status !== 'open') return p.validation;
  const ctx = await loadContext(db);
  const first = computeProposal(p.data, {...ctx, duplicates: {}});
  const fileSha = p.document_id ? (await currentOriginal(db, p.document_id))?.sha256 : null;
  const duplicates = p.kind === 'correction' ? {} : await findDuplicates(db, {data: p.data, computed: first.computed, documentId: p.document_id, fileSha});
  const {computed, issues, blocking} = computeProposal(p.data, {...ctx, duplicates});
  if (p.kind === 'correction') issues.push(...(p.validation.issues || []).filter((i) => i.code === 'correction'));
  return {issues, computed, blocking, live: true};
}
