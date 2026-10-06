// Document vault: metadata, immutable versions, access control, search, lifecycle.
import crypto from 'node:crypto';
import {AppError} from '../db.mjs';
import {audit} from '../audit.mjs';
import {can} from '../auth/auth.mjs';

const KINDS = ['unknown', 'purchase_invoice', 'sales_invoice', 'credit_note', 'proforma', 'contract', 'bank_statement', 'receipt', 'generated_invoice', 'other'];
const CONTRACT_STATES = ['draft', 'active', 'expired', 'terminated', 'archived'];

/** SQL predicate restricting documents to what the user may see. */
export function visibilitySql(user, alias = 'd') {
  const levels = ['normal'];
  if (can(user, 'restricted')) levels.push('restricted');
  if (can(user, 'admin_only')) levels.push('admin_only');
  return `${alias}.confidentiality IN (${levels.map((l) => `'${l}'`).join(',')})`;
}

export async function loadDocumentForUser(db, user, id, {forUpdate = false} = {}) {
  if (!/^\d+$/.test(String(id))) throw new AppError(404, 'not_found', 'Dokumentas nerastas.');
  const r = await db.query(`SELECT d.* FROM documents d WHERE d.id=$1 AND ${visibilitySql(user)}${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  // Same response for missing and forbidden documents, so existence is not disclosed.
  if (!r.rows[0]) throw new AppError(404, 'not_found', 'Dokumentas nerastas arba neturite teisės jo matyti.');
  return r.rows[0];
}

export async function createDocument(db, fields, userId) {
  const f = sanitizeMeta(fields);
  const r = await db.query(`INSERT INTO documents(kind, title, counterparty_id, reference_number, issue_date, start_date, end_date,
      contract_status, contract_value, contract_currency, tags, notes, confidentiality, workflow, processing_status, parent_document_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
  [f.kind || 'unknown', f.title || '', f.counterparty_id || null, f.reference_number || '', f.issue_date || null, f.start_date || null, f.end_date || null,
    f.contract_status || null, f.contract_value ?? null, f.contract_currency || null, f.tags || [], f.notes || '', f.confidentiality || 'normal',
    fields.workflow || 'vault', fields.processing_status || 'uploaded', fields.parent_document_id || null, userId]);
  await audit(db, {userId, action: 'document.create', entityType: 'document', entityId: r.rows[0].id, details: {kind: r.rows[0].kind, workflow: r.rows[0].workflow}});
  return r.rows[0];
}

export async function addFile(db, storage, {documentId, buffer, mime, originalName, role = 'original', page = null, derivedFrom = null, userId = null, note = ''}) {
  const stored = await storage.put(buffer);
  let version = 1;
  if (role === 'original') {
    const v = await db.query(`SELECT coalesce(max(version),0)+1 AS v FROM stored_files WHERE document_id=$1 AND role='original'`, [documentId]);
    version = Number(v.rows[0].v);
  } else {
    const v = await db.query(`SELECT coalesce(max(version),1) AS v FROM stored_files WHERE document_id=$1 AND role='original'`, [documentId]);
    version = Number(v.rows[0].v);
  }
  const r = await db.query(`INSERT INTO stored_files(document_id, version, role, page, sha256, size_bytes, mime, original_name, storage_key, derived_from_file_id, uploaded_by, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [documentId, version, role, page, stored.sha256, stored.size, mime, String(originalName).slice(0, 255), stored.key, derivedFrom, userId, note]);
  if (role === 'original') await audit(db, {userId, action: version > 1 ? 'document.new_version' : 'document.file_added', entityType: 'document', entityId: documentId, details: {fileId: r.rows[0].id, version, sha256: stored.sha256, name: originalName}});
  return r.rows[0];
}

export async function currentOriginal(db, documentId) {
  return (await db.query(`SELECT * FROM stored_files WHERE document_id=$1 AND role='original' ORDER BY version DESC LIMIT 1`, [documentId])).rows[0];
}

function sanitizeMeta(m) {
  const out = {};
  if (m.kind !== undefined) { if (!KINDS.includes(m.kind)) throw new AppError(400, 'bad_kind', 'Netinkamas dokumento tipas.'); out.kind = m.kind; }
  for (const k of ['title', 'reference_number', 'notes']) if (m[k] !== undefined) out[k] = String(m[k] ?? '').slice(0, k === 'notes' ? 5000 : 300);
  for (const k of ['issue_date', 'start_date', 'end_date', 'retain_until']) if (m[k] !== undefined) {
    if (m[k] && !/^\d{4}-\d{2}-\d{2}$/.test(m[k])) throw new AppError(400, 'bad_date', `Netinkama data: ${k}`);
    out[k] = m[k] || null;
  }
  if (m.contract_status !== undefined) {
    if (m.contract_status && !CONTRACT_STATES.includes(m.contract_status)) throw new AppError(400, 'bad_status', 'Netinkama sutarties būsena.');
    out.contract_status = m.contract_status || null;
  }
  if (m.contract_value !== undefined) {
    if (m.contract_value !== null && m.contract_value !== '' && !/^-?\d+(\.\d{1,2})?$/.test(String(m.contract_value))) throw new AppError(400, 'bad_value', 'Netinkama sutarties vertė.');
    out.contract_value = m.contract_value === '' ? null : m.contract_value;
  }
  if (m.contract_currency !== undefined) out.contract_currency = m.contract_currency ? String(m.contract_currency).toUpperCase().slice(0, 3) : null;
  if (m.tags !== undefined) out.tags = (Array.isArray(m.tags) ? m.tags : String(m.tags).split(',')).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 30);
  if (m.confidentiality !== undefined) {
    if (!['normal', 'restricted', 'admin_only'].includes(m.confidentiality)) throw new AppError(400, 'bad_conf', 'Netinkamas konfidencialumo lygis.');
    out.confidentiality = m.confidentiality;
  }
  if (m.counterparty_id !== undefined) out.counterparty_id = m.counterparty_id ? String(m.counterparty_id) : null;
  if (m.archived !== undefined) out.archived = !!m.archived;
  if (m.legal_hold !== undefined) out.legal_hold = !!m.legal_hold;
  return out;
}

export async function updateMetadata(db, user, id, changes) {
  const doc = await loadDocumentForUser(db, user, id, {forUpdate: true});
  const f = sanitizeMeta(changes);
  if (f.confidentiality === 'admin_only' && !can(user, 'admin_only')) throw new AppError(403, 'forbidden', 'Tik administratorius gali nustatyti šį lygį.');
  if (f.contract_status !== undefined) f.contract_status_manual = true;
  if ((f.kind && f.kind !== doc.kind) && ['posted'].includes(doc.processing_status)) throw new AppError(409, 'posted', 'Užregistruoto dokumento tipo keisti negalima.');
  const keys = Object.keys(f);
  if (!keys.length) return doc;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`);
  const r = await db.query(`UPDATE documents SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => f[k])]);
  const before = Object.fromEntries(keys.map((k) => [k, doc[k]]));
  await audit(db, {userId: user.id, action: 'document.metadata', entityType: 'document', entityId: id, details: {before, after: f}});
  await refreshSearch(db, id);
  return r.rows[0];
}

export async function refreshSearch(db, id) {
  await db.query(`UPDATE documents d SET search_text =
      setweight(to_tsvector('simple', coalesce(d.title,'') || ' ' || coalesce(d.reference_number,'') || ' ' ||
        coalesce((SELECT c.name || ' ' || c.company_code || ' ' || c.vat_code FROM counterparties c WHERE c.id = d.counterparty_id), '') || ' ' ||
        array_to_string(d.tags,' ')), 'A') ||
      setweight(to_tsvector('simple', coalesce(d.notes,'')), 'B') ||
      setweight(to_tsvector('simple', coalesce((SELECT string_agg(left(p.text, 20000), ' ') FROM document_pages p WHERE p.document_id=d.id), '')), 'C')
    WHERE d.id=$1`, [id]);
}

/** Effective contract status from dates unless manually set (configurable via `today`). */
export function contractStatusFor(doc, today) {
  if (doc.kind !== 'contract') return null;
  if (doc.contract_status_manual && doc.contract_status) return doc.contract_status;
  if (doc.archived) return 'archived';
  if (!doc.start_date) return doc.contract_status || 'draft';
  if (doc.end_date && doc.end_date < today) return 'expired';
  if (doc.start_date <= today) return 'active';
  return 'draft';
}

export async function searchDocuments(db, user, {q = '', kind = '', status = '', workflow = '', tag = '', counterpartyId = '', from = '', to = '', archived = 'false', limit = 50, offset = 0}) {
  const where = [visibilitySql(user)];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (q) {
    const terms = String(q).toLowerCase().replace(/[^\p{L}\p{N}\s\-_.\/]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map((t) => `${t}:*`);
    const raw = String(q).trim().slice(0, 100);
    const ts = terms.length ? `d.search_text @@ to_tsquery('simple', ${p(terms.join(' & '))})` : 'false';
    where.push(`(${ts} OR d.reference_number ILIKE ${p('%' + raw.replace(/[%_\\]/g, '') + '%')} OR d.title ILIKE $${params.length})`);
  }
  if (kind) where.push(`d.kind = ${p(kind)}`);
  if (workflow) where.push(`d.workflow = ${p(workflow)}`);
  if (status) where.push(`d.processing_status = ${p(status)}`);
  if (tag) where.push(`${p(tag)} = ANY(d.tags)`);
  if (counterpartyId) where.push(`d.counterparty_id = ${p(counterpartyId)}`);
  if (from) where.push(`d.created_at >= ${p(from)}::date`);
  if (to) where.push(`d.created_at < ${p(to)}::date + 1`);
  if (archived !== 'all') where.push(`d.archived = ${p(archived === 'true')}`);
  const lim = Math.min(Number(limit) || 50, 200), off = Math.max(Number(offset) || 0, 0);
  const rows = (await db.query(`SELECT d.id, d.kind, d.title, d.reference_number, d.issue_date, d.start_date, d.end_date, d.contract_status,
      d.contract_status_manual, d.archived, d.tags, d.confidentiality, d.workflow, d.processing_status, d.created_at, d.counterparty_id,
      c.name AS counterparty_name,
      (SELECT count(*) FROM stored_files f WHERE f.document_id=d.id AND f.role='original') AS versions
    FROM documents d LEFT JOIN counterparties c ON c.id=d.counterparty_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ${lim + 1} OFFSET ${off}`, params)).rows;
  return {items: rows.slice(0, lim), hasMore: rows.length > lim, offset: off};
}

// Short-lived signed download tokens (still require a valid session at use time).
export function signDownload(secret, fileId, userId, ttlSec = 300, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSec;
  const mac = crypto.createHmac('sha256', secret).update(`${fileId}.${userId}.${exp}`).digest('hex').slice(0, 32);
  return `${exp}.${mac}`;
}
export function checkDownload(secret, fileId, userId, token, now = Date.now()) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac || Number(exp) < Math.floor(now / 1000)) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${fileId}.${userId}.${exp}`).digest('hex').slice(0, 32);
  return mac.length === expect.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}

/** Deletion guard: documents linked to postings or under hold cannot be removed. */
export async function deletionBlockers(db, id) {
  const reasons = [];
  const d = (await db.query('SELECT legal_hold, processing_status FROM documents WHERE id=$1', [id])).rows[0];
  if (d?.legal_hold) reasons.push('Dokumentui taikomas saugojimo draudimas (legal hold).');
  if ((await db.query('SELECT 1 FROM invoices WHERE document_id=$1', [id])).rowCount) reasons.push('Dokumentas yra užregistruotos sąskaitos įrodymas.');
  if ((await db.query('SELECT 1 FROM bank_statements WHERE document_id=$1', [id])).rowCount) reasons.push('Dokumentas yra importuotas banko išrašas.');
  return reasons;
}
