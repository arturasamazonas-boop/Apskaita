// Loads the reference context used by proposal computation.
import {roleAccounts} from '../ledger/ledger.mjs';
import {normalizeVat, normalizeIban, normalizeName, numberKey} from '../extraction/ids.mjs';
import {money} from '../lib/money.mjs';

export function todayVilnius(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius'}).format(now);
}

export async function loadContext(db, {now} = {}) {
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const accounts = new Map((await db.query('SELECT code, name, type FROM accounts WHERE active')).rows.map((a) => [a.code, a]));
  const taxCodes = (await db.query('SELECT * FROM tax_codes')).rows;
  const rules = (await db.query(`SELECT * FROM classification_rules WHERE status='active'`)).rows;
  const products = (await db.query('SELECT * FROM products WHERE active')).rows;
  return {company, accounts, taxCodes, rules, products, roles: await roleAccounts(db), today: todayVilnius(now)};
}

export async function findCounterparty(db, c) {
  if (c.companyCode) { const r = await db.query('SELECT * FROM counterparties WHERE company_code=$1', [c.companyCode]); if (r.rows[0]) return r.rows[0]; }
  if (c.vatCode) { const r = await db.query('SELECT * FROM counterparties WHERE upper(vat_code)=$1 LIMIT 1', [normalizeVat(c.vatCode)]); if (r.rows[0]) return r.rows[0]; }
  if (c.iban) { const r = await db.query('SELECT * FROM counterparties WHERE iban=$1 LIMIT 1', [normalizeIban(c.iban)]); if (r.rows[0]) return r.rows[0]; }
  if (c.name && !c.companyCode && !c.vatCode) {
    const r = await db.query('SELECT * FROM counterparties WHERE lower(name)=lower($1) LIMIT 2', [c.name]);
    if (r.rows.length === 1) return r.rows[0];
  }
  return null;
}

/** Business and file duplicate indicators for a proposal. */
export async function findDuplicates(db, {data, computed, documentId, fileSha}) {
  const out = {posted: [], open: [], near: [], sameFile: null};
  if (fileSha && documentId) {
    const r = await db.query(`SELECT DISTINCT f.document_id FROM stored_files f JOIN documents d ON d.id=f.document_id
      WHERE f.sha256=$1 AND f.role='original' AND f.document_id<>$2 AND d.processing_status<>'rejected' LIMIT 1`, [fileSha, documentId]);
    if (r.rows[0]) out.sameFile = r.rows[0].document_id;
  }
  if (!data.register || !data.number || data.issueHere) return out;
  const key = computed.numberKey, cpKey = computed.counterpartyKey;
  const docType = data.docType === 'vat_invoice' || data.docType === 'invoice' ? ['vat_invoice', 'invoice'] : [data.docType];
  const posted = await db.query(`SELECT id, series, number, issue_date, gross_total FROM invoices WHERE register=$1 AND counterparty_key=$2 AND number_key=$3 AND doc_type = ANY($4)`,
    [data.register, cpKey, key, docType]);
  out.posted = posted.rows.map((r) => ({id: r.id, label: `${r.series} ${r.number}, ${r.issue_date}, ${r.gross_total} EUR`.trim()}));
  if (documentId) {
    const open = await db.query(`SELECT p.document_id, p.data FROM proposals p JOIN documents d ON d.id=p.document_id
      WHERE p.status='open' AND p.document_id<>$1 AND d.processing_status NOT IN ('rejected','posted')
        AND p.data->>'register'=$2 AND p.data->>'number' IS NOT NULL`, [documentId, data.register]);
    for (const r of open.rows) {
      const od = r.data;
      if (numberKey(od.series, od.number) !== key) continue;
      const same = (a, b) => (a && b ? normalizeVat(a) === normalizeVat(b) : false);
      if (same(od.counterparty?.companyCode, data.counterparty?.companyCode) || same(od.counterparty?.vatCode, data.counterparty?.vatCode) || normalizeName(od.counterparty?.name) === normalizeName(data.counterparty?.name)) {
        out.open.push({documentId: r.document_id, label: `${od.series || ''} ${od.number}`.trim()});
      }
    }
  }
  if (computed.gross && data.issueDate) {
    const near = await db.query(`SELECT id, series, number FROM invoices WHERE register=$1 AND counterparty_key=$2 AND issue_date=$3 AND gross_total=$4 AND number_key<>$5`,
      [data.register, cpKey, data.issueDate, money.norm(computed.gross), key]);
    out.near = near.rows.map((r) => ({id: r.id, label: `užregistruota ${r.series} ${r.number}`.trim()}));
  }
  return out;
}
