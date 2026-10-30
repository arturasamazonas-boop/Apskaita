// Changing a sales invoice issued here after it was approved.
// The ledger and the invoice register are append-only, so a change is a correction with the same number: the old
// amounts are reversed and the new ones posted (the invoice PDF is issued again, marked as corrected). Annulment
// is a correction to zero; the number stays used and is shown as annulled, so the numbering has no gaps.
// Allowed only while nothing depends on the invoice: not paid, no credit note, period not locked, VAT return and
// i.SAF for that month not marked as filed.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {money} from '../lib/money.mjs';
import {createProposalVersion, approveProposal, rejectProposal} from '../invoices/service.mjs';

/** Reasons why the invoice can no longer be corrected or annulled (empty = allowed). */
export async function changeBlockers(db, invoiceId) {
  const inv = (await db.query(`SELECT i.*, d.workflow FROM invoices i LEFT JOIN documents d ON d.id=i.document_id WHERE i.id=$1`, [invoiceId])).rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Sąskaita nerasta.');
  const out = [];
  if (inv.register !== 'sales') out.push('Taisyti galima tik čia išrašytas pardavimo sąskaitas (pirkimo – iš naujo nuskaičius dokumentą).');
  if (!['invoice', 'vat_invoice'].includes(inv.doc_type)) out.push('Taisoma pati sąskaita, ne jos kreditinė sąskaita ar koregavimas.');
  if (inv.workflow !== 'generated' || inv.external_order_id) out.push('Sąskaita išrašyta ne šioje programoje (pvz., parduotuvės užsakymas).');
  const group = (await db.query(`SELECT id, doc_type, gross_total FROM invoices WHERE id=$1 OR related_invoice_id=$1`, [inv.id])).rows;
  if (group.some((g) => ['credit_note', 'debit_note'].includes(g.doc_type))) out.push('Sąskaitai jau išrašyta kreditinė / debetinė sąskaita.');
  const paid = (await db.query(`SELECT coalesce(sum(amount),0) AS v, count(*) AS n FROM allocations WHERE invoice_id = ANY($1::bigint[])`, [group.map((g) => g.id)])).rows[0];
  if (Number(paid.n) && !money.isZero(paid.v)) out.push(`Sąskaita (iš dalies) apmokėta (${money.norm(paid.v)} €) – pirmiausia atšaukite apmokėjimą arba išrašykite kreditinę sąskaitą.`);
  const company = (await db.query('SELECT locked_through FROM company_settings WHERE id=1')).rows[0];
  const date = String(inv.vat_point_date || inv.issue_date).slice(0, 10);
  if (company.locked_through && String(inv.issue_date).slice(0, 10) <= String(company.locked_through).slice(0, 10)) out.push(`Laikotarpis užrakintas (iki ${String(company.locked_through).slice(0, 10)}).`);
  const filed = (await db.query(`SELECT form FROM tax_filings WHERE period=$1 AND form IN ('FR0600','ISAF')`, [date.slice(0, 7)])).rows.map((r) => r.form);
  if (filed.length) out.push(`${date.slice(0, 7)} ${filed.join(' ir ')} jau pažymėta kaip pateikta – pakeitimą įforminkite kreditine sąskaita.`);
  const annulled = group.length > 1 && money.isZero(money.sum(group.map((g) => g.gross_total)));
  if (annulled) out.push('Sąskaita anuliuota.');
  return {invoice: inv, blockers: out, annulled};
}

/** Latest approved data of the invoice (the original or its last correction), as the starting point of a change. */
async function currentData(db, inv) {
  const p = (await db.query(`SELECT p.data FROM invoices i JOIN proposals p ON p.id=i.proposal_id WHERE i.id=$1 OR (i.related_invoice_id=$1 AND i.doc_type='correction') ORDER BY i.id DESC LIMIT 1`, [inv.id])).rows[0];
  const data = structuredClone(p.data);
  delete data.annul;
  // The correction keeps the issued number; it is not numbered again.
  return {...data, series: inv.series, number: inv.number, seriesCode: inv.series, issueHere: false, relatedInvoiceId: null, origin: 'correction',
    counterparty: {...data.counterparty, id: inv.counterparty_id ? String(inv.counterparty_id) : data.counterparty?.id}, acknowledgements: {}, confirmations: {}};
}

/** Open the invoice for changing: a correction proposal with its current content, reviewed and approved as usual. */
export async function startCorrection(pool, user, invoiceId) {
  requireCap(user, 'write');
  return tx(pool, async (db) => {
    const {invoice: inv, blockers} = await changeBlockers(db, invoiceId);
    if (blockers.length) throw new AppError(409, 'locked', blockers.join(' '));
    const data = await currentData(db, inv);
    const p = await createProposalVersion(db, {documentId: inv.document_id, kind: 'correction', data, userId: user.id, correctsInvoiceId: inv.id});
    await db.query(`UPDATE documents SET processing_status='needs_review', updated_at=now() WHERE id=$1`, [inv.document_id]);
    return {documentId: String(inv.document_id), proposalId: String(p.id)};
  });
}

/** Annul: every posted amount is reversed; the number stays (shown as annulled). */
export async function annulInvoice(pool, user, invoiceId, {reason}) {
  requireCap(user, 'approve');
  reason = String(reason || '').trim().slice(0, 300);
  if (reason.length < 3) throw new AppError(400, 'reason', 'Nurodykite anuliavimo priežastį.');
  const p = await tx(pool, async (db) => {
    const {invoice: inv, blockers} = await changeBlockers(db, invoiceId);
    if (blockers.length) throw new AppError(409, 'locked', blockers.join(' '));
    const data = {...(await currentData(db, inv)), annul: true, lines: [], notes: `Anuliuota: ${reason}`};
    return createProposalVersion(db, {documentId: inv.document_id, kind: 'correction', data, userId: user.id, correctsInvoiceId: inv.id});
  });
  try {
    const r = await approveProposal(pool, user, p.id, {contentHash: p.content_hash});
    return {ok: true, correctionId: String(r.invoiceId)};
  } catch (e) {
    await rejectProposal(pool, user, p.id, {contentHash: p.content_hash, reason: `Anuliuoti nepavyko: ${e.message}`.slice(0, 300)}).catch(() => {});
    throw e;
  }
}
