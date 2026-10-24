// Pasikartojančios sąskaitos: templates that create draft sales invoices on their dates (rent, subscriptions, service fees).
// A draft is a normal manual-invoice proposal: the number is assigned and the invoice posted only when it is approved.
import {AppError, tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {createManualDraft} from './service.mjs';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);

/** The date `months` later on `day` (clamped to the month's last day). */
export function nextOccurrence(date, months, day) {
  const [y, m] = date.split('-').map(Number);
  const t = (m - 1) + months, ny = y + Math.floor(t / 12), nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

function clean(b) {
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 100).map((l) => ({description: s(l.description, 500), productId: l.productId ? String(l.productId) : null, quantity: s(l.quantity || '1', 20).replace(',', '.'),
    unit: s(l.unit, 20), unitPrice: s(l.unitPrice, 20).replace(',', '.'), taxCode: s(l.taxCode, 10), accountCode: s(l.accountCode, 8)})).filter((l) => l.description || l.productId) : [];
  if (!s(b.name)) throw new AppError(400, 'name', 'Įveskite pavadinimą.');
  if (!b.counterpartyId) throw new AppError(400, 'counterparty', 'Pasirinkite pirkėją.');
  if (!lines.length) throw new AppError(400, 'lines', 'Įveskite bent vieną eilutę.');
  if (lines.some((l) => !/^-?\d+(\.\d+)?$/.test(l.unitPrice) || !/^-?\d+(\.\d+)?$/.test(l.quantity))) throw new AppError(400, 'lines', 'Eilutėse nurodykite kiekį ir kainą.');
  if (!isDate(b.nextDate)) throw new AppError(400, 'date', 'Nurodykite pirmos sąskaitos datą.');
  if (b.endDate && !isDate(b.endDate)) throw new AppError(400, 'date', 'Netinkama pabaigos data.');
  const interval = Math.trunc(Number(b.intervalMonths) || 1), due = Math.trunc(Number(b.dueDays ?? 14));
  if (interval < 1 || interval > 12) throw new AppError(400, 'interval', 'Periodiškumas – nuo 1 iki 12 mėn.');
  if (!(due >= 0 && due <= 365)) throw new AppError(400, 'due', 'Apmokėjimo terminas – nuo 0 iki 365 d.');
  return {name: s(b.name, 120), counterparty_id: String(b.counterpartyId), series_code: s(b.seriesCode || 'PP', 10).toUpperCase(), lines, interval_months: interval,
    day_of_month: Number(b.nextDate.slice(8, 10)), next_date: b.nextDate, end_date: b.endDate || null, due_days: due, notes: s(b.notes, 1000), active: b.active !== false};
}

export async function listRecurring(pool, user) {
  requireCap(user, 'read');
  const templates = (await pool.query(`SELECT r.*, c.name AS counterparty_name FROM recurring_invoices r JOIN counterparties c ON c.id=r.counterparty_id ORDER BY r.active DESC, r.next_date, r.id`)).rows;
  // Drafts created from templates that still wait for approval.
  const drafts = (await pool.query(`SELECT d.id AS document_id, d.title, p.data->>'issueDate' AS issue_date, p.validation->'computed'->>'gross' AS gross, p.blocking,
      (SELECT a.details->>'recurringId' FROM audit_log a WHERE a.action='invoice.manual_draft' AND a.entity_id=d.id::text LIMIT 1) AS recurring_id
    FROM documents d JOIN proposals p ON p.document_id=d.id AND p.status='open'
    WHERE d.workflow='generated' AND p.kind='manual_invoice' ORDER BY p.data->>'issueDate', d.id`)).rows.filter((d) => d.recurring_id);
  return {templates, drafts};
}

export async function saveRecurring(pool, user, id, b) {
  requireCap(user, 'write');
  const v = clean(b);
  return tx(pool, async (db) => {
    const cp = (await db.query('SELECT id FROM counterparties WHERE id=$1', [v.counterparty_id])).rows[0];
    if (!cp) throw new AppError(404, 'not_found', 'Pirkėjas nerastas.');
    const cols = Object.keys(v), vals = cols.map((k) => (k === 'lines' ? JSON.stringify(v[k]) : v[k]));
    const row = id
      ? (await db.query(`UPDATE recurring_invoices SET ${cols.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...vals])).rows[0]
      : (await db.query(`INSERT INTO recurring_invoices(${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`, [...vals, user.id])).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Šablonas nerastas.');
    await audit(db, {userId: user.id, action: id ? 'recurring.update' : 'recurring.create', entityType: 'recurring_invoice', entityId: row.id, details: {name: v.name, nextDate: v.next_date}});
    return row;
  });
}

/**
 * Create the drafts that are due by `asOf` (catching up missed periods), each with its own date, and move the
 * template to its next date. Each template is locked, so two runs never create the same draft twice.
 */
export async function generateRecurring(pool, user, {asOf, id = null}) {
  if (user.role !== 'system') requireCap(user, 'write');
  const ids = (await pool.query(`SELECT id FROM recurring_invoices WHERE active AND next_date <= $1 ${id ? 'AND id=$2' : ''} ORDER BY next_date, id`, id ? [asOf, id] : [asOf])).rows.map((r) => r.id);
  const created = [];
  for (const rid of ids) {
    await tx(pool, async (db) => {
      const r = (await db.query('SELECT * FROM recurring_invoices WHERE id=$1 FOR UPDATE', [rid])).rows[0];
      let next = r.next_date, last = r.last_document_id, n = 0;
      while (r.active && next <= asOf && (!r.end_date || next <= r.end_date) && n < 24) {
        const due = new Date(Date.parse(next) + r.due_days * 86400000).toISOString().slice(0, 10);
        const d = await createManualDraft(db, user, {register: 'sales', counterpartyId: r.counterparty_id, issueDate: next, dueDate: due, seriesCode: r.series_code, lines: r.lines, notes: r.notes, recurringId: r.id});
        created.push({recurringId: String(r.id), name: r.name, documentId: String(d.documentId), issueDate: next, blocking: d.proposal.blocking});
        last = d.documentId; n++;
        next = nextOccurrence(next, r.interval_months, r.day_of_month);
      }
      const active = r.active && (!r.end_date || next <= r.end_date);
      await db.query('UPDATE recurring_invoices SET next_date=$2, last_document_id=$3, last_run_at=now(), active=$4 WHERE id=$1', [r.id, next, last, active]);
    });
  }
  return {created};
}
