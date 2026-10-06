// Manual invoices (sales issued here, manual purchases), credit notes and PDF rendering.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import {AppError, tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {ROOT} from '../config.mjs';
import {money} from '../lib/money.mjs';
import {createDocument, addFile, loadDocumentForUser} from '../vault/documents.mjs';
import {createProposalVersion} from '../invoices/service.mjs';
import {applyClassification} from '../invoices/engine.mjs';
import {loadContext, todayVilnius} from '../invoices/context.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const amt = (v) => s(v, 30).replace(',', '.');

async function counterpartyData(db, b) {
  if (b.counterpartyId) {
    const c = (await db.query('SELECT * FROM counterparties WHERE id=$1', [b.counterpartyId])).rows[0];
    if (!c) throw new AppError(404, 'not_found', 'Kontrahentas nerastas.');
    return {id: String(c.id), name: c.name, companyCode: c.company_code, vatCode: c.vat_code, address: c.address, country: c.country, iban: c.iban};
  }
  const c = b.counterparty || {};
  return {id: null, name: s(c.name), companyCode: s(c.companyCode, 20), vatCode: s(c.vatCode, 20).toUpperCase(), address: s(c.address), country: s(c.country || 'LT', 2).toUpperCase(), iban: s(c.iban, 40)};
}

async function linesData(db, lines, register, taxDefault) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 300) throw new AppError(400, 'lines', 'Įveskite eilutes (1–300).');
  const out = [];
  for (const l of lines) {
    const p = l.productId ? (await db.query('SELECT * FROM products WHERE id=$1', [l.productId])).rows[0] : null;
    const taxCode = s(l.taxCode || p?.tax_code || taxDefault, 10);
    const tc = (await db.query(`SELECT rate FROM tax_codes WHERE code=$1 ORDER BY effective_from DESC LIMIT 1`, [taxCode])).rows[0];
    out.push({description: s(l.description || p?.name, 500), sku: s(l.sku || p?.sku, 60), quantity: amt(l.quantity || '1'), unit: s(l.unit || p?.unit || 'vnt.', 20),
      unitPrice: amt(l.unitPrice ?? p?.unit_price ?? ''), discount: amt(l.discount || '0'), sourceNet: '', vatRate: taxCode === 'BE_PVM' ? '' : (tc?.rate ?? ''), taxCode,
      accountCode: s(l.accountCode, 8), lineType: s(l.lineType, 20), vatTreatment: register === 'sales' ? 'output' : s(l.vatTreatment, 20), productId: p ? String(p.id) : null,
      userClassified: !!l.accountCode, suggestion: l.accountCode ? {source: 'manual', explanation: 'Pasirinkta naudotojo.'} : null, sourceRef: null});
  }
  return out;
}

/** Create a draft manual invoice (proposal + document). Number is assigned only on approval. */
export async function createManualInvoice(pool, user, b) {
  requireCap(user, 'write');
  const register = b.register === 'purchase' ? 'purchase' : 'sales';
  return tx(pool, async (db) => {
    const ctx = await loadContext(db);
    const counterparty = await counterpartyData(db, b);
    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(b.issueDate || '') ? b.issueDate : todayVilnius();
    const lines = await linesData(db, b.lines, register, ctx.company.vat_registered ? 'PVM1' : 'BE_PVM');
    let data = {
      docType: register === 'sales' ? (ctx.company.vat_registered ? 'vat_invoice' : 'invoice') : (b.docType === 'invoice' ? 'invoice' : 'vat_invoice'),
      register, registerReason: 'Įvesta rankiniu būdu.', origin: 'manual',
      issueHere: register === 'sales', seriesCode: register === 'sales' ? s(b.seriesCode || 'PP', 10).toUpperCase() : undefined,
      series: register === 'purchase' ? s(b.series, 20) : '', number: register === 'purchase' ? s(b.number, 60) : '',
      issueDate, dueDate: s(b.dueDate, 10), vatPointDate: s(b.vatPointDate, 10), currency: 'EUR', counterparty,
      paymentReference: s(b.paymentReference), orderReference: s(b.orderReference), relatedDocument: '', relatedInvoiceId: null,
      lines, sourceTotals: {net: '', vat: '', gross: '', vatByRate: []}, acknowledgements: {}, confirmations: {}, provenance: {}, splitHint: null, extractionNotes: [], notes: s(b.notes, 1000),
    };
    data = applyClassification(data, ctx);
    const doc = await createDocument(db, {kind: register === 'sales' ? 'generated_invoice' : 'purchase_invoice', title: `${register === 'sales' ? 'Pardavimo sąskaita' : 'Pirkimas'} – ${counterparty.name}`,
      workflow: register === 'sales' ? 'generated' : 'invoice', processing_status: 'needs_review'}, user.id);
    const p = await createProposalVersion(db, {documentId: doc.id, kind: register === 'sales' ? 'manual_invoice' : 'invoice', data, userId: user.id, fileSha: null});
    await audit(db, {userId: user.id, action: 'invoice.manual_draft', entityType: 'document', entityId: doc.id, details: {register, proposalId: p.id}});
    return {documentId: doc.id, proposal: p};
  });
}

/** Sales credit note (return/discount) linked to a posted invoice; lines and prices copied from the snapshot. */
export async function createCreditNote(pool, user, invoiceId, b) {
  requireCap(user, 'write');
  return tx(pool, async (db) => {
    const inv = (await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Sąskaita nerasta.');
    if (inv.register !== 'sales' || !['vat_invoice', 'invoice'].includes(inv.doc_type)) throw new AppError(422, 'not_sales', 'Kreditinę sąskaitą galima išrašyti tik pardavimo sąskaitai. Tiekėjų kreditines įkelkite į dokumentų dėžutę.');
    const orig = (await db.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no', [inv.id])).rows;
    const credited = (await db.query(`SELECT l.description, l.sku, sum(l.quantity) AS q FROM invoices c JOIN invoice_lines l ON l.invoice_id=c.id WHERE c.related_invoice_id=$1 AND c.doc_type='credit_note' GROUP BY 1,2`, [inv.id])).rows;
    const lines = [];
    for (const req of b.lines || []) {
      const o = orig.find((x) => String(x.line_no) === String(req.lineNo));
      if (!o) throw new AppError(400, 'bad_line', `Eilutė ${req.lineNo} nerasta.`);
      const q = amt(req.quantity);
      if (!/^\d+(\.\d{1,4})?$/.test(q) || Number(q) <= 0) throw new AppError(400, 'bad_qty', 'Kiekis turi būti teigiamas.');
      const already = Math.abs(Number(credited.find((c) => c.description === o.description && c.sku === o.sku)?.q || 0));
      if (Number(q) + already > Number(o.quantity) + 1e-9) throw new AppError(422, 'too_much', `Eilutė ${o.line_no}: kredituojama ${q}, jau kredituota ${already}, parduota ${Number(o.quantity)}.`);
      lines.push({description: o.description, sku: o.sku, quantity: `-${q}`, unit: o.unit, unitPrice: o.unit_price, discount: '0', sourceNet: '', vatRate: o.vat_rate, taxCode: o.tax_code,
        accountCode: o.account_code, lineType: o.line_type, vatTreatment: 'output', productId: o.product_id, userClassified: true, suggestion: {source: 'original', explanation: `Kopija iš sąskaitos ${inv.series} ${inv.number} eilutės ${o.line_no}.`}, sourceRef: null});
    }
    if (!lines.length) throw new AppError(400, 'lines', 'Pasirinkite kredituojamas eilutes.');
    const cp = inv.counterparty_snapshot;
    const data = {docType: 'credit_note', register: 'sales', registerReason: 'Kreditinė sąskaita.', origin: 'manual', issueHere: true, seriesCode: s(b.seriesCode || 'KS', 10).toUpperCase(), series: '', number: '',
      issueDate: /^\d{4}-\d{2}-\d{2}$/.test(b.issueDate || '') ? b.issueDate : todayVilnius(), dueDate: '', vatPointDate: '', currency: inv.currency,
      counterparty: {...cp, id: String(inv.counterparty_id)}, paymentReference: '', orderReference: inv.order_reference, relatedDocument: `${inv.series} ${inv.number}`, relatedInvoiceId: String(inv.id),
      lines, sourceTotals: {net: '', vat: '', gross: '', vatByRate: []}, acknowledgements: {}, confirmations: {}, provenance: {}, splitHint: null, extractionNotes: [], notes: s(b.reason, 500)};
    const doc = await createDocument(db, {kind: 'credit_note', title: `Kreditinė sąskaita – ${inv.series} ${inv.number}`, workflow: 'generated', processing_status: 'needs_review'}, user.id);
    if (inv.document_id) await db.query(`INSERT INTO document_links(from_document_id, to_document_id, relation, created_by) VALUES ($1,$2,'credit_note',$3) ON CONFLICT DO NOTHING`, [inv.document_id, doc.id, user.id]);
    const p = await createProposalVersion(db, {documentId: doc.id, kind: 'credit_note', data, userId: user.id, fileSha: null});
    await audit(db, {userId: user.id, action: 'invoice.credit_note_draft', entityType: 'invoice', entityId: inv.id, details: {proposalId: p.id, reason: s(b.reason, 500)}});
    return {documentId: doc.id, proposal: p};
  });
}

// ------------------------------------------------------------------ PDF
const fmt = (v) => money.norm(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function renderInvoicePdf(inv, lines, vatRows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({size: 'A4', margin: 40, info: {Title: `${inv.series} ${inv.number}`, Producer: 'Apskaita'}});
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('r', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf')); doc.registerFont('b', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
    const title = inv.doc_type === 'credit_note' ? 'KREDITINĖ PVM SĄSKAITA FAKTŪRA' : inv.doc_type === 'vat_invoice' ? 'PVM SĄSKAITA FAKTŪRA' : 'SĄSKAITA FAKTŪRA';
    doc.font('b').fontSize(16).text(inv.doc_type === 'credit_note' && !inv.company_snapshot.vatRegistered ? 'KREDITINĖ SĄSKAITA FAKTŪRA' : title, {align: 'center'});
    doc.font('r').fontSize(10).text(`Serija ${inv.series} Nr. ${inv.number}`, {align: 'center'});
    doc.moveDown(0.5).fontSize(9).text(`Išrašymo data: ${inv.issue_date}`);
    if (inv.vat_point_date) doc.text(`PVM apskaičiavimo (tiekimo) data: ${inv.vat_point_date}`);
    if (inv.due_date) doc.text(`Apmokėti iki: ${inv.due_date}`);
    if (inv.related) doc.text(`Koreguojama sąskaita: ${inv.related}`);
    if (inv.order_reference) doc.text(`Užsakymo Nr.: ${inv.order_reference}`);
    const y0 = doc.y + 10;
    const party = (x, t, p) => {
      doc.font('b').fontSize(10).text(t, x, y0); doc.font('r').fontSize(9);
      for (const l of [p.name, p.companyCode ? `Įmonės kodas: ${p.companyCode}` : null, p.vatCode ? `PVM mokėtojo kodas: ${p.vatCode}` : null, p.address ? `Adresas: ${p.address}` : null, p.iban ? `A/s: ${p.iban}` : null].filter(Boolean)) doc.text(l, x, doc.y, {width: 250});
      return doc.y;
    };
    const ya = party(40, 'Pardavėjas', {...inv.company_snapshot, iban: inv.company_iban});
    const yb = party(310, 'Pirkėjas', inv.counterparty_snapshot);
    let y = Math.max(ya, yb) + 16;
    const cols = [[40, 'Nr.'], [62, 'Pavadinimas'], [300, 'Kiekis'], [345, 'Vnt.'], [385, 'Kaina'], [440, 'PVM %'], [485, 'Suma be PVM']];
    doc.font('b').fontSize(8.5); for (const [x, t] of cols) doc.text(t, x, y, {lineBreak: false}); doc.moveTo(40, y + 12).lineTo(555, y + 12).stroke(); y += 18; doc.font('r');
    for (const l of lines) {
      if (y > 740) { doc.addPage(); y = 50; }
      const h = doc.heightOfString(l.description, {width: 232});
      doc.text(String(l.line_no), 40, y, {lineBreak: false}); doc.text(l.description, 62, y, {width: 232});
      doc.text(String(Number(l.quantity)).replace('.', ','), 300, y, {lineBreak: false}); doc.text(l.unit, 345, y, {lineBreak: false});
      doc.text(fmt(l.unit_price), 385, y, {lineBreak: false}); doc.text(l.tax_code === 'BE_PVM' ? '–' : String(Number(l.vat_rate)), 440, y, {lineBreak: false}); doc.text(fmt(l.net), 485, y, {lineBreak: false});
      y += Math.max(h, 12) + 4;
    }
    doc.moveTo(40, y).lineTo(555, y).stroke(); y += 8;
    doc.fontSize(9).text('Suma be PVM:', 360, y); doc.text(fmt(inv.net_total), 485, y); y += 13;
    for (const v of vatRows) { if (v.rate === null) continue; doc.text(`PVM ${Number(v.rate)} %:`, 360, y); doc.text(fmt(v.vat), 485, y); y += 13; }
    doc.font('b').text('Iš viso su PVM:', 360, y); doc.text(`${fmt(inv.gross_total)} ${inv.currency}`, 470, y); doc.font('r'); y += 24;
    if (!inv.company_snapshot.vatRegistered) { doc.text('Pardavėjas nėra PVM mokėtojas.', 40, y); y += 14; }
    if (inv.payment_reference) doc.text(`Mokėjimo paskirtis: ${inv.payment_reference}`, 40, y);
    else doc.text(`Mokėjimo paskirtis: ${inv.series}${inv.number}`, 40, y);
    doc.end();
  });
}

export async function renderAndStorePdf({pool, storage}, invoiceId) {
  const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0];
  if (!inv?.document_id) return {skipped: true};
  const have = (await pool.query(`SELECT 1 FROM stored_files WHERE document_id=$1 AND role='generated'`, [inv.document_id])).rowCount;
  if (have) return {skipped: 'exists'};
  const lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no', [inv.id])).rows;
  const vat = (await pool.query('SELECT * FROM invoice_vat_rows WHERE invoice_id=$1', [inv.id])).rows;
  const rel = inv.related_invoice_id ? (await pool.query('SELECT series, number FROM invoices WHERE id=$1', [inv.related_invoice_id])).rows[0] : null;
  const iban = (await pool.query(`SELECT iban FROM bank_accounts WHERE active AND kind='bank' ORDER BY id LIMIT 1`)).rows[0]?.iban || '';
  const buf = await renderInvoicePdf({...inv, related: rel ? `${rel.series} ${rel.number}` : '', company_iban: iban}, lines, vat);
  await tx(pool, async (db) => {
    // The issued PDF is the immutable original of this generated document.
    await addFile(db, storage, {documentId: inv.document_id, buffer: buf, mime: 'application/pdf', originalName: `${inv.series}${inv.number}.pdf`, role: 'generated', note: 'Sugeneruota patvirtinus'});
  });
  return {ok: true};
}

export async function salesInvoiceForUser(pool, user, id) {
  const inv = (await pool.query('SELECT * FROM invoices WHERE id=$1', [id])).rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Sąskaita nerasta.');
  if (inv.document_id) await loadDocumentForUser(pool, user, inv.document_id);
  return inv;
}

export {invoiceBalances};
