// Report API with CSV/XLSX export and drill-down endpoints.
import {AppError} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {SECURITY_HEADERS} from '../http.mjs';
import {audit} from '../audit.mjs';
import * as R from '../reports/reports.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {buildIsaf, validateXsd} from '../isaf/isaf.mjs';
import {createDocument, addFile} from '../vault/documents.mjs';
import {tx} from '../db.mjs';
import path from 'node:path';
import {FORMS, buildStatement} from '../reports/statements.mjs';
import {renderStatementPdf} from '../reports/statement-pdf.mjs';
import {debtAct, renderDebtActPdf} from '../reports/debt-act.mjs';
import {readJson} from '../http.mjs';
import {buildRcPackage, renderRcPackagePdf, rcRows} from '../reports/rc-package.mjs';
import {LAYOUT as FR0600_LAYOUT, fr0600Values, applyEdits, toFFData, placements, renderFr0600Pdf} from '../reports/eds-fr0600.mjs';
import {money} from '../lib/money.mjs';

const REPORTS = {
  'trial-balance': (db, q) => R.trialBalance(db, q),
  ledger: (db, q) => { if (!q.account) throw new AppError(400, 'account', 'Nurodykite sąskaitą.'); return R.generalLedger(db, q); },
  'profit-loss': (db, q) => R.profitAndLoss(db, q),
  'balance-sheet': (db, q) => R.balanceSheet(db, q),
  'vat-sales': (db, q) => R.vatRegister(db, {...q, register: 'sales'}),
  'vat-purchases': (db, q) => R.vatRegister(db, {...q, register: 'purchase'}),
  receivables: (db, q) => R.aging(db, {...q, register: 'sales'}),
  payables: (db, q) => R.aging(db, {...q, register: 'purchase'}),
  sales: (db, q) => R.salesReport(db, q),
  'sales-operational': (db, q) => R.operationalSales(db, q),
  purchases: (db, q) => R.purchasesReport(db, q),
  payments: (db, q) => R.paymentsReport(db, q),
  'vat-return': (db, q) => R.vatReturn(db, q),
};

export function register(r, {pool, storage}) {
  const isafCheck = async (query) => {
    const res = await buildIsaf(pool, {from: query.from, to: query.to, dataType: query.type || 'F'});
    const xsd = await validateXsd(res.xml, path.join(storage.baseDir, 'tmp'));
    return {...res, xsd, exportable: !res.errors.length && xsd.valid !== false};
  };
  r.get('/api/isaf/check', async ({user, query}) => {
    requireCap(user, 'read');
    const {xml, ...rest} = await isafCheck(query);
    // preview=1 also returns the XML itself, so the page can show the registers exactly as they will be uploaded.
    return {...rest, size: xml.length, ...(query.preview === '1' && {xml}), note: 'Eksportas nėra pateikimas: failą į VMI i.SAF sistemą įkelkite patys.'};
  });
  r.get('/api/isaf/download', async ({user, query, res}) => {
    requireCap(user, 'approve');
    const c = await isafCheck(query);
    if (!c.exportable) throw new AppError(422, 'isaf_invalid', 'i.SAF failas turi blokuojančių klaidų – peržiūrėkite patikros rezultatus.');
    const name = `isaf_${query.type || 'F'}_${query.from}_${query.to}.xml`;
    await tx(pool, async (db) => {
      const doc = await createDocument(db, {kind: 'other', title: `i.SAF ${query.type || 'F'} ${query.from}–${query.to}`, tags: ['isaf'], workflow: 'generated', processing_status: 'stored', notes: 'Sugeneruotas i.SAF failas (nepateiktas VMI automatiškai).'}, user.id);
      await addFile(db, storage, {documentId: doc.id, buffer: Buffer.from(c.xml, 'utf8'), mime: 'application/xml', originalName: name, role: 'generated', userId: user.id});
      await audit(db, {userId: user.id, action: 'isaf.export', entityType: 'document', entityId: doc.id, details: {from: query.from, to: query.to, type: query.type || 'F', summary: c.summary}});
    });
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store'});
    res.end(c.xml);
  });
  // ---------------------------------------------------------------- PVM deklaracija FR0600 as in VMI EDS
  const frPeriod = (q) => {
    q = {...q, correction: String(q.correction ?? '')};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.to || '') || q.from > q.to) throw new AppError(400, 'period', 'Nurodykite mokestinį laikotarpį.');
    return {from: q.from, to: q.to, correction: q.correction === '1' || q.correction === 'true'};
  };
  r.get('/api/eds/fr0600/layout', async ({user}) => { requireCap(user, 'read'); return FR0600_LAYOUT; });
  r.get('/api/eds/fr0600', async ({user, query}) => {
    requireCap(user, 'read');
    const d = await fr0600Values(pool, frPeriod(query));
    return {...d, placements: placements(d.values), page: FR0600_LAYOUT.page};
  });
  // The on-screen form posts the user's edits (fields the program does not fill); the file is built from the calculated values plus the edits.
  r.post('/api/eds/fr0600/file', async ({req, user, res}) => {
    requireCap(user, 'read');
    const b = await readJson(req);
    const p = frPeriod(b);
    const d = await fr0600Values(pool, p);
    const values = applyEdits(d.values, b.values);
    const pdf = b.format === 'pdf';
    const body = pdf ? await renderFr0600Pdf(values) : Buffer.from(toFFData(values, {login: user.email || 'apskaita', today: todayVilnius()}), 'utf8');
    const name = `FR0600_${p.from}_${p.to}${p.correction ? '_patikslinta' : ''}.${pdf ? 'pdf' : 'ffdata'}`;
    await audit(pool, {userId: user.id, action: 'report.export', entityType: 'report', entityId: 'fr0600', details: {format: pdf ? 'pdf' : 'ffdata', ...p, edited: Object.keys(b.values || {})}});
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': pdf ? 'application/pdf' : 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store'});
    res.end(body);
  });
  // ---------------------------------------------------------------- annual set for Registrų centras
  const rcPkg = (q) => {
    const year = Number(q.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError(400, 'year', 'Nurodykite finansinius metus.');
    return buildRcPackage(pool, {year, category: q.category, forms: q.forms ? String(q.forms).split(',') : null, today: todayVilnius(), precision: q.precision === 'cents' ? 'cents' : 'eur'});
  };
  r.get('/api/rc-package', async ({user, query}) => { requireCap(user, 'read'); return rcPkg(query); });
  r.get('/api/rc-package/file', async ({user, query, res}) => {
    requireCap(user, 'read');
    const pkg = await rcPkg(query);
    let body, type, ext;
    if (query.format === 'pdf') {
      const c = (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
      const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
      body = await renderRcPackagePdf(pkg, {compiled: /^\d{4}-\d{2}-\d{2}$/.test(query.compiled || '') ? query.compiled : todayVilnius(), number: str(query.number, 20),
        managerTitle: c.manager_title, managerName: c.manager, accountantTitle: c.accountant_title, accountantName: c.accountant_name});
      type = 'application/pdf'; ext = 'pdf';
    } else {
      const rep = {title: `Finansinių ataskaitų rinkinys ${pkg.year}`, definition: `${pkg.categoryName}. Sumos eurais, eilutės pagal VAS formas – Registrų centro el. formos pildymui.`,
        columns: [['form', 'Forma'], ['no', 'Eil. Nr.'], ['label', 'Straipsnis'], ['current', 'Finansiniai metai', 'money'], ['previous', 'Praėję finansiniai metai', 'money']], rows: rcRows(pkg)};
      if (query.format === 'xlsx') { body = await R.toXlsx(rep); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ext = 'xlsx'; }
      else { body = Buffer.from(R.toCsv(rep), 'utf8'); type = 'text/csv; charset=utf-8'; ext = 'csv'; }
    }
    await audit(pool, {userId: user.id, action: 'report.export', entityType: 'report', entityId: 'rc-package', details: {format: ext, year: pkg.year, category: pkg.category, forms: pkg.forms}});
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': type, 'Content-Disposition': `attachment; filename="FA_rinkinys_${pkg.year}.${ext}"`, 'Cache-Control': 'no-store'});
    res.end(body);
  });
  // ---------------------------------------------------------------- financial statements (VAS forms)
  r.get('/api/statements', async ({user}) => {
    requireCap(user, 'read');
    return Object.entries(FORMS).map(([key, f]) => ({key, name: f.name, kind: f.kind, standard: f.standard, annex: f.annex, who: f.who}));
  });
  r.get('/api/statements/:key', async ({user, params, query}) => {
    requireCap(user, 'read');
    const st = await buildStatement(pool, params.key, {...query, today: todayVilnius()});
    if (!st) throw new AppError(404, 'not_found', 'Ataskaitos forma nerasta.');
    return st;
  });
  r.get('/api/statements/:key/pdf', async ({user, params, query, res}) => {
    requireCap(user, 'read');
    const st = await buildStatement(pool, params.key, {...query, today: todayVilnius()});
    if (!st) throw new AppError(404, 'not_found', 'Ataskaitos forma nerasta.');
    const c = (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
    const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
    const header = {compiled: /^\d{4}-\d{2}-\d{2}$/.test(query.compiled || '') ? query.compiled : todayVilnius(), number: str(query.number, 20), status: str(query.status, 200),
      managerTitle: str(query.managerTitle) || c.manager_title, managerName: str(query.managerName) || c.manager, accountantTitle: str(query.accountantTitle) || c.accountant_title, accountantName: str(query.accountantName) || c.accountant_name};
    const pdf = await renderStatementPdf(st, header);
    await audit(pool, {userId: user.id, action: 'report.export', entityType: 'report', entityId: params.key, details: {format: 'pdf', period: st.period, precision: st.precision}});
    const name = `${params.key}_${st.period.to}.pdf`;
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `${query.inline ? 'inline' : 'attachment'}; filename="${name}"`, 'Cache-Control': 'no-store'});
    res.end(pdf);
  });
  r.get('/api/debt-act', async ({user, query, res}) => {
    requireCap(user, 'read');
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(query.asOf || '') ? query.asOf : todayVilnius();
    const act = await debtAct(pool, {counterparty: query.counterparty, asOf});
    if (!act) throw new AppError(404, 'not_found', 'Kontrahentas nerastas.');
    if (query.format !== 'pdf') return act;
    const company = (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
    const pdf = await renderDebtActPdf(act, company, {compiled: /^\d{4}-\d{2}-\d{2}$/.test(query.compiled || '') ? query.compiled : todayVilnius(), number: String(query.number || '').slice(0, 20)});
    await audit(pool, {userId: user.id, action: 'report.export', entityType: 'report', entityId: 'debt-act', details: {counterparty: act.counterparty.id, asOf}});
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="skolu_suderinimas_${act.counterparty.id}_${asOf}.pdf"`, 'Cache-Control': 'no-store'});
    res.end(pdf);
  });
  r.put('/api/statements/:key/prior', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const form = Object.hasOwn(FORMS, params.key) ? FORMS[params.key] : null;
    if (!form) throw new AppError(404, 'not_found', 'Ataskaitos forma nerasta.');
    const b = await readJson(req);
    const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(b.periodEnd || '') ? b.periodEnd : null;
    if (!periodEnd) throw new AppError(400, 'period', 'Nurodykite praėjusio laikotarpio pabaigos datą.');
    const leafIds = new Set(form.lines.filter(([, , , s]) => !s.h && !s.sum).map(([id]) => id));
    return tx(pool, async (db) => {
      for (const [id, v] of Object.entries(b.values || {})) {
        if (!leafIds.has(id)) throw new AppError(400, 'line', `Eilutės ${id} redaguoti negalima (suma skaičiuojama).`);
        const raw = v === null || v === undefined ? '' : String(v).trim().replace(/\s/g, '').replace(',', '.');
        if (raw === '') { await db.query('DELETE FROM fs_prior_values WHERE form_key=$1 AND period_end=$2 AND line_id=$3', [params.key, periodEnd, id]); continue; }
        if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new AppError(400, 'amount', `Netinkama suma eilutėje ${id}.`);
        await db.query(`INSERT INTO fs_prior_values(form_key, period_end, line_id, amount, updated_by) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (form_key, period_end, line_id) DO UPDATE SET amount=EXCLUDED.amount, updated_by=EXCLUDED.updated_by, updated_at=now()`, [params.key, periodEnd, id, money.norm(raw), user.id]);
      }
      await audit(db, {userId: user.id, action: 'statement.prior_values', entityType: 'report', entityId: params.key, details: {periodEnd, values: b.values}});
      return {ok: true};
    });
  });
  r.get('/api/dashboard', async ({user, query}) => { requireCap(user, 'read'); return R.dashboard(pool, {...query, today: todayVilnius()}); });
  r.get('/api/reports/:name', async ({user, params, query, res}) => {
    requireCap(user, 'read');
    const fn = Object.hasOwn(REPORTS, params.name) ? REPORTS[params.name] : null;
    if (!fn) throw new AppError(404, 'not_found', 'Ataskaita nerasta.');
    const rep = await fn(pool, {...query, today: todayVilnius()});
    if (query.format === 'csv' || query.format === 'xlsx') {
      await audit(pool, {userId: user.id, action: 'report.export', entityType: 'report', entityId: params.name, details: {format: query.format, filters: rep.filters}});
      const buf = query.format === 'csv' ? Buffer.from(R.toCsv(rep), 'utf8') : await R.toXlsx(rep);
      res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${params.name}.${query.format}"`, 'Cache-Control': 'no-store'});
      res.end(buf);
      return;
    }
    return rep;
  });
  r.get('/api/invoices', async ({user, query}) => {
    requireCap(user, 'read');
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 50, 1), 200), offset = Math.max(Math.trunc(Number(query.offset)) || 0, 0);
    const params = [];
    const where = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.register) add('i.register = ?', query.register);
    if (query.from) add('i.issue_date >= ?', query.from);
    if (query.to) add('i.issue_date <= ?', query.to);
    if (query.store) add('i.store_id = ?', query.store);
    if (query.q) add(`(i.number ILIKE '%'||?||'%' OR i.counterparty_snapshot->>'name' ILIKE '%'||$${params.length + 1}||'%')`, String(query.q).slice(0, 100)), params.push(String(query.q).slice(0, 100));
    const rows = (await pool.query(`SELECT i.id, i.register, i.doc_type, i.series, i.number, i.issue_date, i.due_date, i.net_total, i.vat_total, i.gross_total, i.counterparty_snapshot->>'name' AS counterparty,
        i.document_id, i.related_invoice_id, i.store_id, s.name AS store_name, i.approved_at, i.external_order_id
      FROM invoices i LEFT JOIN stores s ON s.id=i.store_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.issue_date DESC, i.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, params)).rows;
    const roots = rows.filter((x) => !['correction', 'credit_note'].includes(x.doc_type) || !x.related_invoice_id).map((x) => x.id);
    const bal = roots.length ? await invoiceBalances(pool, {ids: roots, limit: 1000}) : [];
    const byId = new Map(bal.map((b) => [String(b.id), b]));
    return {items: rows.slice(0, limit).map((x) => ({...x, balance: byId.get(String(x.id)) || null})), hasMore: rows.length > limit};
  });
  r.get('/api/invoices/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const inv = (await pool.query(`SELECT i.*, u.name AS approved_by_name, s.name AS store_name FROM invoices i JOIN users u ON u.id=i.approved_by LEFT JOIN stores s ON s.id=i.store_id WHERE i.id=$1`, [params.id])).rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Sąskaita nerasta.');
    const lines = (await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no', [inv.id])).rows;
    const vat = (await pool.query('SELECT * FROM invoice_vat_rows WHERE invoice_id=$1', [inv.id])).rows;
    const entry = (await pool.query(`SELECT l.*, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.code=l.account_code WHERE l.entry_id=$1 ORDER BY l.id`, [inv.journal_entry_id])).rows;
    const related = (await pool.query(`SELECT id, doc_type, series, number, issue_date, gross_total FROM invoices WHERE related_invoice_id=$1 OR id=$2 ORDER BY id`, [inv.id, inv.related_invoice_id || 0])).rows.filter((x) => String(x.id) !== String(inv.id));
    const rootId = ['correction', 'credit_note', 'debit_note'].includes(inv.doc_type) && inv.related_invoice_id ? inv.related_invoice_id : inv.id;
    const balance = (await invoiceBalances(pool, {ids: [rootId]}))[0] || null;
    const allocations = (await pool.query(`SELECT a.*, t.booking_date, t.amount AS tx_amount, t.counterparty_name, t.reference FROM allocations a LEFT JOIN bank_transactions t ON t.id=a.transaction_id
      WHERE a.invoice_id IN (SELECT id FROM invoices WHERE id=$1 OR related_invoice_id=$1) ORDER BY a.id`, [rootId])).rows;
    const order = inv.external_order_id ? (await pool.query('SELECT id, store_id, external_id, order_number, external_status, state FROM external_orders WHERE id=$1', [inv.external_order_id])).rows[0] : null;
    return {...inv, lines, vat, entry, related, balance, allocations, order};
  });
}
