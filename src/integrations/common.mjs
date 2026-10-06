// Platform-independent order ingestion: idempotent upsert keyed by (store, external id), out-of-order
// protection, status mapping, proposal creation, refunds → credit-note proposals. Never edits postings.
import crypto from 'node:crypto';
import {money} from '../lib/money.mjs';
import {audit} from '../audit.mjs';
import {loadContext, todayVilnius} from '../invoices/context.mjs';
import {applyClassification, contentHash, taxCodeFor} from '../invoices/engine.mjs';
import {createProposalVersion} from '../invoices/service.mjs';

export const DEFAULT_STATUS_MAPPING = {
  saleor: {UNCONFIRMED: 'wait', UNFULFILLED: 'wait', PARTIALLY_FULFILLED: 'wait', FULFILLED: 'invoice', PARTIALLY_RETURNED: 'invoice', RETURNED: 'invoice', CANCELED: 'ignore', DRAFT: 'ignore', EXPIRED: 'ignore'},
  opencart: {Pending: 'wait', Processing: 'wait', Shipped: 'invoice', Complete: 'invoice', Canceled: 'ignore', Denied: 'ignore', Refunded: 'invoice', Reversed: 'ignore', Failed: 'ignore', Expired: 'ignore', Voided: 'ignore', 'Canceled Reversal': 'wait', Chargeback: 'wait', Processed: 'invoice'},
};

export function canonicalHash(obj) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(canon(obj))).digest('hex');
}

/** Validate a normalized order (adapter output) before storing; returns list of problems. */
export function validateOrder(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['Netinkamas užsakymas.'];
  if (!o.externalId) p.push('Nėra užsakymo ID.');
  if (!/^[A-Z]{3}$/.test(o.currency || '')) p.push('Netinkama valiuta.');
  if (!Array.isArray(o.lines)) p.push('Nėra eilučių.');
  for (const l of o.lines || []) if (!/^-?\d+(\.\d+)?$/.test(String(l.quantity)) || !/^-?\d+(\.\d{1,4})?$/.test(String(l.unitNet))) p.push(`Netinkama eilutė: ${l.name}`);
  return p;
}

async function findOrCreateCustomer(db, store, c) {
  if (c.companyCode) {
    const r = (await db.query('SELECT * FROM counterparties WHERE company_code=$1', [c.companyCode])).rows[0];
    if (r) return r;
  }
  if (c.email && !c.companyCode) {
    const r = (await db.query(`SELECT * FROM counterparties WHERE lower(email)=lower($1) AND company_code='' LIMIT 1`, [c.email])).rows[0];
    if (r) return r;
  }
  return null;
}

export async function orderToProposalData(db, store, order, ctx) {
  const mode = store.invoice_mode;
  const ext0 = order.invoices?.[0];
  const supplyDate = (order.fulfilledAt || order.createdAt || '').slice(0, 10);
  // Issued here: invoice date = date the proposal is first prepared (kept stable across re-syncs); supply date as VAT point.
  const issueDate = mode === 'import_external' ? ((ext0?.createdAt || order.createdAt || '').slice(0, 10) || todayVilnius()) : (ctx.keepIssueDate || todayVilnius());
  const known = await findOrCreateCustomer(db, store, order.customer || {});
  const c = order.customer || {};
  const refs = (await db.query('SELECT r.external_id, p.id, p.revenue_account, p.kind FROM product_external_refs r JOIN products p ON p.id=r.product_id WHERE r.store_id=$1', [store.id])).rows;
  const notes = [];
  const lines = order.lines.map((l) => {
    const map = refs.find((r) => r.external_id === String(l.productExternalId || ''));
    const rate = l.taxRate === null || l.taxRate === undefined ? '' : money.norm(String(l.taxRate));
    return {description: l.name, sku: l.sku || '', quantity: String(l.quantity), unit: 'vnt.', unitPrice: String(l.unitNet), discount: money.norm(l.discountNet || '0'),
      sourceNet: l.totalNet ? money.norm(l.totalNet) : '', vatRate: rate, taxCode: '', accountCode: map?.revenue_account || '', lineType: '', vatTreatment: 'output',
      productId: map ? String(map.id) : null, userClassified: !!map?.revenue_account, suggestion: map ? {source: 'product', explanation: `Parduotuvės prekė susieta su kortele #${map.id}.`} : null, sourceRef: {kind: 'store', externalLineId: l.externalLineId}};
  });
  if (order.shipping && !money.isZero(order.shipping.net || '0')) {
    lines.push({description: 'Pristatymas', sku: '', quantity: '1', unit: 'vnt.', unitPrice: money.norm(order.shipping.net), discount: '0', sourceNet: money.norm(order.shipping.net),
      vatRate: order.shipping.taxRate === null || order.shipping.taxRate === undefined ? '' : money.norm(String(order.shipping.taxRate)), taxCode: '', accountCode: ctx.roles.revenue_shipping || '', lineType: 'revenue_services', vatTreatment: 'output',
      productId: null, userClassified: true, suggestion: {source: 'store', explanation: 'Pristatymo eilutė iš užsakymo.'}, sourceRef: {kind: 'store', shipping: true}});
  }
  for (const d of order.orderDiscounts || []) {
    lines.push({description: `Nuolaida: ${d.name || ''}`.trim(), sku: '', quantity: '1', unit: 'vnt.', unitPrice: money.neg(money.abs(d.net)), discount: '0', sourceNet: money.neg(money.abs(d.net)),
      vatRate: d.taxRate === undefined || d.taxRate === null ? '' : money.norm(String(d.taxRate)), taxCode: '', accountCode: ctx.roles.revenue_goods || '', lineType: 'revenue_goods', vatTreatment: 'output',
      productId: null, userClassified: true, suggestion: {source: 'store', explanation: 'Užsakymo lygio nuolaida (kuponas).'}, sourceRef: {kind: 'store', discount: true}});
    if (d.taxRate === undefined || d.taxRate === null) notes.push('Nuolaidos PVM tarifas nežinomas – patikrinkite.');
  }
  const ext = order.invoices?.[0];
  const data = {
    docType: ctx.company.vat_registered ? 'vat_invoice' : 'invoice', register: 'sales', registerReason: `Parduotuvės „${store.name}“ užsakymas ${order.number}.`,
    origin: mode === 'import_external' ? 'store_external' : 'store', storeId: String(store.id), externalOrderId: null,
    issueHere: mode === 'issue_here', seriesCode: mode === 'issue_here' ? (store.config?.seriesCode || 'PP') : undefined,
    series: '', number: mode === 'import_external' ? String(ext?.number || '') : '', issueDate, dueDate: issueDate, vatPointDate: supplyDate && supplyDate !== issueDate && supplyDate < issueDate ? supplyDate : '', currency: order.currency,
    counterparty: {id: known ? String(known.id) : null, name: c.name || c.email || `Pirkėjas (${store.name})`, companyCode: c.companyCode || '', vatCode: c.vatCode || '', address: c.address || '', country: c.country || 'LT', iban: ''},
    paymentReference: `Užsakymas ${order.number}`, orderReference: String(order.number), relatedDocument: '', relatedInvoiceId: null,
    lines, sourceTotals: {net: order.totals?.net ? money.norm(order.totals.net) : '', vat: order.totals?.tax ? money.norm(order.totals.tax) : '', gross: order.totals?.gross ? money.norm(order.totals.gross) : '', vatByRate: []},
    acknowledgements: {}, confirmations: {}, provenance: {}, splitHint: null, extractionNotes: [...notes, ...(store.is_demo ? ['DEMONSTRACINĖ parduotuvė – duomenys iš testinių rinkinių.'] : [])],
  };
  if (mode === 'import_external' && !ext?.number) data.extractionNotes.push('Parduotuvėje sąskaita dar neišrašyta – laukiama išorinio numerio.');
  return applyClassification(data, ctx);
}

/**
 * Ingest a normalized order. Returns {result: 'created'|'updated'|'unchanged'|'stale'|'invalid', ...}.
 * Duplicate/delayed/out-of-order deliveries are harmless: older updatedAt never overwrites newer state.
 */
export async function ingestOrder(db, store, order, source) {
  const problems = validateOrder(order);
  if (problems.length) return {result: 'invalid', problems};
  const hash = canonicalHash(order);
  const cur = (await db.query('SELECT * FROM external_orders WHERE store_id=$1 AND external_id=$2 FOR UPDATE', [store.id, String(order.externalId)])).rows[0];
  if (cur && cur.external_updated_at && order.updatedAt && new Date(order.updatedAt) < new Date(cur.external_updated_at)) {
    await db.query(`INSERT INTO external_order_versions(external_order_id, data_hash, data, external_updated_at, source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [cur.id, hash, order, order.updatedAt, `${source}:stale`]);
    return {result: 'stale', id: cur.id};
  }
  if (cur && cur.data_hash === hash) return {result: 'unchanged', id: cur.id};
  let row;
  if (!cur) {
    row = (await db.query(`INSERT INTO external_orders(store_id, external_id, order_number, external_status, currency, external_updated_at, data, data_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [store.id, String(order.externalId), String(order.number), order.status || '', order.currency, order.updatedAt || null, order, hash])).rows[0];
  } else {
    row = (await db.query(`UPDATE external_orders SET order_number=$2, external_status=$3, currency=$4, external_updated_at=$5, data=$6, data_hash=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, String(order.number), order.status || '', order.currency, order.updatedAt || null, order, hash])).rows[0];
  }
  await db.query(`INSERT INTO external_order_versions(external_order_id, data_hash, data, external_updated_at, source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [row.id, hash, order, order.updatedAt || null, source]);
  await applyOrderState(db, store, row, order, {previous: cur});
  return {result: cur ? 'updated' : 'created', id: row.id};
}

async function setState(db, id, state, note) { await db.query('UPDATE external_orders SET state=$2, state_note=$3, updated_at=now() WHERE id=$1', [id, state, note || null]); }

async function applyOrderState(db, store, row, order, {previous}) {
  const mapping = {...DEFAULT_STATUS_MAPPING[store.platform], ...(store.status_mapping || {})};
  const action = mapping[order.status] || 'wait';
  const posted = row.invoice_id ? (await db.query('SELECT * FROM invoices WHERE id=$1', [row.invoice_id])).rows[0] : (await db.query(`SELECT * FROM invoices WHERE external_order_id=$1 AND doc_type IN ('vat_invoice','invoice')`, [row.id])).rows[0];
  if (posted) {
    // Posted invoices are never changed. Refunds → credit-note proposals; other changes → review flag.
    const handled = await handleRefunds(db, store, row, order, posted);
    const prevCore = previous ? canonicalHash({lines: previous.data.lines, shipping: previous.data.shipping, totals: previous.data.totals}) : null;
    const nowCore = canonicalHash({lines: order.lines, shipping: order.shipping, totals: order.totals});
    if (previous && prevCore !== nowCore) await setState(db, row.id, 'changed_after_post', 'Užsakymas pakeistas po sąskaitos užregistravimo. Užregistruota sąskaita nekeista – peržiūrėkite ir, jei reikia, išrašykite kreditinę sąskaitą.');
    else if (!handled) await setState(db, row.id, 'posted', null);
    return;
  }
  if (order.currency !== 'EUR') { await setState(db, row.id, 'needs_review', `Valiuta ${order.currency} automatiškai nepalaikoma.`); return; }
  if (action === 'ignore') {
    await db.query(`UPDATE proposals SET status='rejected', decision_note='Užsakymo būsena ignoruojama' WHERE external_order_id=$1 AND status='open'`, [row.id]);
    await setState(db, row.id, 'ignored', `Būsena „${order.status}“ susieta su „ignoruoti“.`);
    return;
  }
  if (action !== 'invoice') { await setState(db, row.id, 'waiting_status', `Laukiama būsenos, kuriai išrašoma sąskaita (dabar „${order.status}“).`); return; }
  const ctx = await loadContext(db);
  const open = (await db.query(`SELECT * FROM proposals WHERE external_order_id=$1 AND status='open'`, [row.id])).rows[0];
  const data = await orderToProposalData(db, store, order, {...ctx, keepIssueDate: open?.data?.issueDate});
  data.externalOrderId = String(row.id);
  if (open && open.content_hash === contentHash(data)) return;
  const p = await createProposalVersion(db, {externalOrderId: row.id, kind: 'invoice', data, fileSha: null});
  await setState(db, row.id, p.blocking ? 'needs_review' : 'proposed', p.blocking ? (p.validation.issues.find((i) => i.level === 'error')?.message || 'Reikia peržiūros') : null);
}

async function handleRefunds(db, store, row, order, posted) {
  let created = false;
  for (const rf of order.refunds || []) {
    const ins = await db.query(`INSERT INTO external_refunds(store_id, external_order_id, external_id, amount, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (store_id, external_id) DO NOTHING RETURNING id`,
      [store.id, row.id, String(rf.externalId), money.norm(rf.amount), rf]);
    if (!ins.rows[0]) continue;
    created = true;
    const lines = (await db.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no', [posted.id])).rows;
    const out = [];
    const notes = [];
    for (const rl of rf.lines || []) {
      const o = lines.find((l) => (rl.sku && l.sku === rl.sku) || l.description === rl.name);
      if (!o) { notes.push(`Grąžinta eilutė „${rl.name || rl.sku}“ nerasta sąskaitoje.`); continue; }
      out.push({description: o.description, sku: o.sku, quantity: `-${rl.quantity}`, unit: o.unit, unitPrice: o.unit_price, discount: '0', sourceNet: '', vatRate: o.vat_rate, taxCode: o.tax_code,
        accountCode: o.account_code, lineType: o.line_type, vatTreatment: 'output', productId: o.product_id, userClassified: true, suggestion: {source: 'original', explanation: `Grąžinimas ${rf.externalId}: kopija iš eilutės ${o.line_no}.`}, sourceRef: null});
    }
    if (rf.shipping) {
      const s = lines.find((l) => l.description === 'Pristatymas');
      if (s) out.push({description: s.description, sku: '', quantity: '-1', unit: s.unit, unitPrice: s.unit_price, discount: '0', sourceNet: '', vatRate: s.vat_rate, taxCode: s.tax_code, accountCode: s.account_code, lineType: s.line_type, vatTreatment: 'output', productId: null, userClassified: true, suggestion: {source: 'original', explanation: 'Grąžintas pristatymo mokestis.'}, sourceRef: null});
    }
    const ctx = await loadContext(db);
    const data = {docType: 'credit_note', register: 'sales', registerReason: `Grąžinimas parduotuvėje „${store.name}“.`, origin: store.invoice_mode === 'import_external' ? 'store_external' : 'store', storeId: String(store.id),
      issueHere: store.invoice_mode === 'issue_here', seriesCode: store.invoice_mode === 'issue_here' ? (store.config?.creditSeriesCode || 'KS') : undefined,
      series: '', number: store.invoice_mode === 'import_external' ? String(rf.creditNoteNumber || '') : '', issueDate: (rf.createdAt || '').slice(0, 10) || todayVilnius(), dueDate: '', vatPointDate: '', currency: posted.currency,
      counterparty: {...posted.counterparty_snapshot, id: String(posted.counterparty_id)}, paymentReference: '', orderReference: posted.order_reference, relatedDocument: `${posted.series} ${posted.number}`, relatedInvoiceId: String(posted.id),
      lines: out, sourceTotals: {net: '', vat: '', gross: money.neg(rf.amount), vatByRate: []}, acknowledgements: {}, confirmations: {}, provenance: {}, splitHint: null, extractionNotes: notes, externalOrderId: String(row.id)};
    const doc = (await db.query(`INSERT INTO documents(kind, title, workflow, processing_status) VALUES ('credit_note',$1,'generated','needs_review') RETURNING id`, [`Grąžinimas ${order.number} (${store.name})`])).rows[0];
    const p = await createProposalVersion(db, {documentId: doc.id, kind: 'credit_note', data: applyClassification(data, ctx), fileSha: null});
    await db.query('UPDATE external_refunds SET proposal_id=$2 WHERE id=$1', [ins.rows[0].id, p.id]);
    await setState(db, row.id, 'needs_review', `Gautas grąžinimas ${rf.externalId} (${rf.amount} EUR) – peržiūrėkite kreditinės sąskaitos pasiūlymą.`);
    await audit(db, {actor: 'system', action: 'store.refund_proposal', entityType: 'external_order', entityId: row.id, details: {refund: rf.externalId, proposalId: p.id}});
  }
  return created;
}

export {taxCodeFor};
