// Palūkanos: loan agreements, money in/out events and interest calculated to a chosen date. Terms are read from the
// agreement (document vault) or entered by hand; interest always starts on the day the money arrived.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson, readMultipart} from '../http.mjs';
import {audit} from '../audit.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {extractText} from '../invoices/service.mjs';
import {uploadFiles, indexVaultDocument} from '../vault/upload.mjs';
import {loadDocumentForUser, visibilitySql} from '../vault/documents.mjs';
import {calcInterest, simpleInterest, BASES} from '../loans/interest.mjs';
import {parseLoanContract, parseAmount} from '../loans/contract-parser.mjs';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const amt = (v) => { if (v === null || v === undefined || String(v).trim() === '') return null; const a = parseAmount(v); if (!a) throw new AppError(400, 'amount', `Netinkama suma: ${v}`); return a; };
const rateOf = (v) => { const r = String(v ?? '').trim().replace(',', '.').replace(/\s*%$/, ''); if (!/^\d{1,2}(\.\d{1,4})?$/.test(r)) throw new AppError(400, 'rate', 'Palūkanų norma – procentai per metus, pvz. 6,5.'); return r; };
const KINDS = ['disbursement', 'repayment', 'rate_change', 'interest_payment'];
const boolQ = (v, dflt) => (v === 'true' ? true : v === 'false' ? false : dflt);

function loanFields(b, partial = false) {
  const v = {};
  const has = (k) => !partial || k in b;
  if (has('direction')) { if (!['received', 'granted'].includes(b.direction)) throw new AppError(400, 'direction', 'Pasirinkite: paskola gauta ar suteikta.'); v.direction = b.direction; }
  if (has('principal')) { v.principal = amt(b.principal); if (!v.principal || Number(v.principal) <= 0) throw new AppError(400, 'principal', 'Nurodykite paskolos sumą.'); }
  if (has('annual_rate')) v.annual_rate = rateOf(b.annual_rate);
  if (has('basis')) { if (!BASES[b.basis || 'act365']) throw new AppError(400, 'basis', 'Netinkama dienų skaičiavimo bazė.'); v.basis = b.basis || 'act365'; }
  for (const k of ['contract_date', 'maturity_date']) if (has(k)) { if (b[k] && !isDate(b[k])) throw new AppError(400, k, 'Netinkama data.'); v[k] = b[k] || null; }
  if (has('currency')) v.currency = /^[A-Z]{3}$/.test(String(b.currency || 'EUR').toUpperCase()) ? String(b.currency || 'EUR').toUpperCase() : 'EUR';
  for (const [k, n] of [['contract_no', 60], ['counterparty_name', 200], ['notes', 2000]]) if (has(k)) v[k] = s(b[k], n);
  for (const k of ['include_last_day', 'rate_variable']) if (has(k)) v[k] = b[k] === true || b[k] === 'true';
  if (has('counterparty_id')) v.counterparty_id = b.counterparty_id ? String(b.counterparty_id) : null;
  if (has('status')) v.status = b.status === 'closed' ? 'closed' : 'active';
  return v;
}

function eventFields(e) {
  if (!KINDS.includes(e.kind)) throw new AppError(400, 'kind', 'Netinkamas įvykio tipas.');
  if (!isDate(e.date)) throw new AppError(400, 'date', 'Nurodykite datą.');
  if (e.kind === 'rate_change') return {kind: e.kind, date: e.date, amount: null, rate: rateOf(e.rate), note: s(e.note, 300), bank_transaction_id: null};
  const a = amt(e.amount);
  if (!a || Number(a) <= 0) throw new AppError(400, 'amount', 'Nurodykite sumą.');
  return {kind: e.kind, date: e.date, amount: a, rate: null, note: s(e.note, 300), bank_transaction_id: e.bank_transaction_id ? String(e.bank_transaction_id) : null};
}

async function loadLoan(db, id) {
  const l = (await db.query(`SELECT l.*, c.name AS cp_name, c.company_code AS cp_code, d.title AS document_title FROM loans l LEFT JOIN counterparties c ON c.id=l.counterparty_id LEFT JOIN documents d ON d.id=l.document_id WHERE l.id=$1`, [id])).rows[0];
  if (!l) throw new AppError(404, 'not_found', 'Paskola nerasta.');
  l.events = (await db.query(`SELECT * FROM loan_events WHERE loan_id=$1 ORDER BY event_date, id`, [id])).rows;
  return l;
}

function interestFor(l, asOf, includeLastDay) {
  const events = l.events.map((e) => ({date: e.event_date, kind: e.kind, amount: e.amount, rate: e.rate}));
  const c = calcInterest({events, rate: l.annual_rate, basis: l.basis, asOf, includeLastDay});
  const first = l.events.find((e) => e.kind === 'disbursement');
  const notes = [...c.issues];
  if (!first) notes.push('Nenurodyta pinigų gavimo diena – palūkanos neskaičiuojamos. Pridėkite išmokėjimą (pinigų įkritimo dieną).');
  else if (first.event_date > asOf) notes.push(`Pinigai gauti ${first.event_date} – po pasirinktos datos.`);
  if (l.maturity_date && asOf > l.maturity_date && Number(c.balance) > 0) notes.push(`Grąžinimo terminas (${l.maturity_date}) praėjęs, likutis ${c.balance} ${l.currency}.`);
  if (l.rate_variable) notes.push('Kintamos palūkanos: bazinės normos pokyčius įrašykite kaip „Palūkanų normos pakeitimą“.');
  return {...c, firstDisbursement: first?.event_date || null, notes};
}

/** Bank transactions that look like the loan money: incoming for a received loan, outgoing for a granted one. */
async function bankMatches(db, {direction, principal, counterpartyCode, counterpartyName, from}) {
  const sign = direction === 'granted' ? -1 : 1;
  const rows = (await db.query(`SELECT t.id, t.booking_date, t.amount, t.currency, t.counterparty_name, t.counterparty_code, t.reference, a.name AS account_name
      FROM bank_transactions t JOIN bank_accounts a ON a.id=t.bank_account_id
     WHERE sign(t.amount) = $1 AND t.status <> 'ignored' AND ($2::date IS NULL OR t.booking_date >= $2::date - 10)
       AND (abs(t.amount) = $3::numeric OR ($4 <> '' AND t.counterparty_code = $4) OR ($5 <> '' AND t.counterparty_name ILIKE '%'||$5||'%') OR t.reference ILIKE '%paskol%' OR t.reference ILIKE '%loan%')
       AND NOT EXISTS (SELECT 1 FROM loan_events e WHERE e.bank_transaction_id=t.id)
     ORDER BY t.booking_date LIMIT 50`, [sign, from || null, principal || 0, counterpartyCode || '', s(counterpartyName, 60).replace(/^(UAB|AB|MB)\s*/i, '').replace(/[„“"”]/g, '')])).rows;
  return rows.map((t) => {
    let score = 0;
    if (principal && Math.abs(Number(t.amount)) === Number(principal)) score += 3;
    if (counterpartyCode && t.counterparty_code === counterpartyCode) score += 3;
    if (/paskol|loan/i.test(t.reference)) score += 1;
    return {...t, score};
  }).sort((a, b) => b.score - a.score || (a.booking_date < b.booking_date ? -1 : 1)).slice(0, 10);
}

async function companyOf(db) { return (await db.query('SELECT name, company_code FROM company_settings WHERE id=1')).rows[0] || {}; }

async function proposalFor(deps, user, documentId) {
  const {pool} = deps;
  const doc = await loadDocumentForUser(pool, user, documentId);
  let pages = (await pool.query(`SELECT text FROM document_pages WHERE document_id=$1 ORDER BY page`, [doc.id])).rows;
  const warnings = [];
  if (!pages.length) {
    const file = (await pool.query(`SELECT id FROM stored_files WHERE document_id=$1 AND role='original' ORDER BY version DESC LIMIT 1`, [doc.id])).rows[0];
    if (file) {
      try { await indexVaultDocument(deps, {documentId: doc.id, fileId: file.id}, extractText); } catch (e) { warnings.push(`Nepavyko perskaityti dokumento teksto: ${e.message}`); }
      pages = (await pool.query(`SELECT text FROM document_pages WHERE document_id=$1 ORDER BY page`, [doc.id])).rows;
    }
  }
  const text = pages.map((p) => p.text).join('\n');
  if (!text.trim() && !warnings.length) warnings.push('Dokumente nerasta teksto – sąlygas įrašykite ranka.');
  const parsed = parseLoanContract(text, await companyOf(pool));
  const f = parsed.fields;
  const cp = f.counterpartyCode ? (await pool.query('SELECT id, name FROM counterparties WHERE company_code=$1 LIMIT 1', [f.counterpartyCode])).rows[0] : null;
  const matches = f.direction ? await bankMatches(pool, {direction: f.direction, principal: f.principal, counterpartyCode: f.counterpartyCode, counterpartyName: f.counterpartyName, from: f.contractDate}) : [];
  return {documentId: String(doc.id), documentTitle: doc.title, fields: {...f, counterpartyId: cp?.id || null, counterpartyName: f.counterpartyName || cp?.name || null}, evidence: parsed.evidence,
    warnings: [...warnings, ...parsed.warnings], bankMatches: matches, textLength: text.length};
}

export function register(r, deps) {
  const {pool, config} = deps;

  r.get('/api/loans', async ({user, query}) => {
    requireCap(user, 'read');
    const asOf = isDate(query.asOf) ? query.asOf : todayVilnius();
    const ids = (await pool.query(`SELECT id FROM loans WHERE ($1 = 'true' OR status = 'active') ORDER BY direction, contract_date NULLS LAST, id`, [query.all || ''])).rows;
    const items = [];
    for (const {id} of ids) {
      const l = await loadLoan(pool, id);
      const c = interestFor(l, asOf, boolQ(query.includeLastDay, l.include_last_day));
      items.push({...l, events: undefined, calc: {...c, periods: undefined}});
    }
    return {asOf, items, bases: BASES};
  });
  r.get('/api/loans/candidates', async ({user}) => {
    requireCap(user, 'read');
    // Agreements in the vault that look like loan agreements and have no loan yet.
    return (await pool.query(`SELECT d.id, d.title, d.reference_number, d.issue_date, d.created_at, c.name AS counterparty_name
        FROM documents d LEFT JOIN counterparties c ON c.id=d.counterparty_id
       WHERE ${visibilitySql(user)} AND NOT d.archived AND d.kind IN ('contract','other','unknown') AND d.workflow = 'vault'
         AND (d.title ILIKE '%paskol%' OR d.title ILIKE '%loan%' OR 'paskola' = ANY(d.tags)
              OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id=d.id AND (p.text ILIKE '%paskolos sutart%' OR p.text ILIKE '%loan agreement%')))
         AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.document_id=d.id)
       ORDER BY d.created_at DESC LIMIT 100`)).rows;
  });
  r.post('/api/loans/calc', async ({req, user}) => {
    requireCap(user, 'read');
    const b = await readJson(req);
    const amount = amt(b.amount);
    if (!amount) throw new AppError(400, 'amount', 'Nurodykite sumą.');
    if (!isDate(b.from) || !isDate(b.to)) throw new AppError(400, 'dates', 'Nurodykite pradžios ir pabaigos datas.');
    return simpleInterest({amount, from: b.from, to: b.to, rate: rateOf(b.rate), basis: BASES[b.basis] ? b.basis : 'act365', includeLastDay: b.includeLastDay === true || b.includeLastDay === 'true'});
  });
  r.post('/api/loans/read-contract', async ({req, user}) => {
    requireCap(user, 'write');
    const {files} = await readMultipart(req, {maxFileBytes: config.maxUploadBytes, maxFiles: 1});
    if (!files[0]) throw new AppError(400, 'no_file', 'Pasirinkite sutarties failą.');
    const [res] = await uploadFiles(deps, user, files, {workflow: 'vault', meta: {kind: 'contract', tags: ['paskola']}});
    if (res.status !== 'uploaded') throw new AppError(422, 'upload', res.message || 'Failo įkelti nepavyko.');
    return proposalFor(deps, user, res.documentId);
  });
  r.post('/api/loans/read-document/:id', async ({user, params}) => { requireCap(user, 'write'); return proposalFor(deps, user, params.id); });
  r.get('/api/loans/:id', async ({user, params, query}) => {
    requireCap(user, 'read');
    const l = await loadLoan(pool, params.id);
    const asOf = isDate(query.asOf) ? query.asOf : todayVilnius();
    const calc = interestFor(l, asOf, boolQ(query.includeLastDay, l.include_last_day));
    const matches = await bankMatches(pool, {direction: l.direction, principal: l.principal, counterpartyCode: l.cp_code, counterpartyName: l.counterparty_name || l.cp_name, from: l.contract_date});
    return {...l, calc, bankMatches: matches, bases: BASES};
  });
  r.post('/api/loans', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const v = loanFields(b);
    const events = (Array.isArray(b.events) ? b.events : []).map(eventFields);
    return tx(pool, async (db) => {
      let documentId = null;
      if (b.document_id) documentId = (await loadDocumentForUser(db, user, b.document_id)).id;
      if (!v.counterparty_id && b.counterparty_code) v.counterparty_id = (await db.query('SELECT id FROM counterparties WHERE company_code=$1 LIMIT 1', [s(b.counterparty_code, 20)])).rows[0]?.id || null;
      const keys = Object.keys(v);
      const row = (await db.query(`INSERT INTO loans(${keys.join(', ')}, document_id, source, extracted, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 2}, $${keys.length + 3}, $${keys.length + 4}) RETURNING id`,
        [...keys.map((k) => v[k]), documentId, documentId ? 'document' : 'manual', b.extracted ? JSON.stringify(b.extracted) : null, user.id])).rows[0];
      for (const e of events) await insertEvent(db, user, row.id, e);
      await audit(db, {userId: user.id, action: 'loan.create', entityType: 'loan', entityId: row.id, details: {...v, documentId, events: events.length}});
      return loadLoan(db, row.id);
    });
  });
  r.put('/api/loans/:id', async ({req, user, params}) => {
    requireCap(user, 'write');
    const v = loanFields(await readJson(req), true);
    const keys = Object.keys(v);
    if (!keys.length) return loadLoan(pool, params.id);
    const row = (await pool.query(`UPDATE loans SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING id`, [params.id, ...keys.map((k) => v[k])])).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Paskola nerasta.');
    await audit(pool, {userId: user.id, action: 'loan.update', entityType: 'loan', entityId: params.id, details: v});
    return loadLoan(pool, params.id);
  });
  r.delete('/api/loans/:id', async ({user, params}) => {
    requireCap(user, 'write');
    const l = await loadLoan(pool, params.id);
    await pool.query('DELETE FROM loans WHERE id=$1', [l.id]);
    await audit(pool, {userId: user.id, action: 'loan.delete', entityType: 'loan', entityId: l.id, details: {contract_no: l.contract_no, principal: l.principal, events: l.events.length}});
    return {ok: true};
  });
  r.post('/api/loans/:id/events', async ({req, user, params}) => {
    requireCap(user, 'write');
    const e = eventFields(await readJson(req));
    return tx(pool, async (db) => { await loadLoan(db, params.id); await insertEvent(db, user, params.id, e); return loadLoan(db, params.id); });
  });
  r.delete('/api/loans/:id/events/:eventId', async ({user, params}) => {
    requireCap(user, 'write');
    const e = (await pool.query('DELETE FROM loan_events WHERE id=$1 AND loan_id=$2 RETURNING *', [params.eventId, params.id])).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Įrašas nerastas.');
    await audit(pool, {userId: user.id, action: 'loan.event_delete', entityType: 'loan', entityId: params.id, details: e});
    return loadLoan(pool, params.id);
  });
}

async function insertEvent(db, user, loanId, e) {
  if (e.bank_transaction_id) {
    const t = (await db.query('SELECT id FROM bank_transactions WHERE id=$1', [e.bank_transaction_id])).rows[0];
    if (!t) throw new AppError(400, 'bank', 'Banko operacija nerasta.');
    if ((await db.query('SELECT 1 FROM loan_events WHERE bank_transaction_id=$1', [t.id])).rowCount) throw new AppError(409, 'bank', 'Ši banko operacija jau priskirta paskolai.');
  }
  await db.query(`INSERT INTO loan_events(loan_id, event_date, kind, amount, rate, bank_transaction_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [loanId, e.date, e.kind, e.amount, e.rate, e.bank_transaction_id, e.note, user.id]);
  await audit(db, {userId: user.id, action: `loan.${e.kind}`, entityType: 'loan', entityId: loanId, details: e});
}
