// Statement import: parse → validate balances/gaps → deduplicate → store rows and transactions
// (separately from postings) → create reconciliation proposals.
import crypto from 'node:crypto';
import {AppError, tx} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {money} from '../lib/money.mjs';
import {fold, normalizeIban} from '../extraction/ids.mjs';
import {loadDocumentForUser, currentOriginal} from '../vault/documents.mjs';
import {detectType} from '../vault/filetypes.mjs';
import {parseTable, readCsvTable, readXlsxTable, parseCamt053, parseMt940, parseStatementText} from './parsers.mjs';
import {extractText} from '../invoices/service.mjs';
import {proposeForTransaction} from './matching.mjs';

export async function parseStatementFile({storage, config}, file, {mapping, opening, closing} = {}) {
  const buf = await storage.read(file.storage_key);
  const type = await detectType(buf, file.original_name);
  let st;
  if (type === 'camt053') st = parseCamt053(buf);
  else if (type === 'mt940') st = parseMt940(buf);
  else if (type === 'csv') st = parseTable(readCsvTable(buf), {mapping, format: 'csv'});
  else if (type === 'xlsx') st = parseTable(await readXlsxTable(buf), {mapping, format: 'xlsx'});
  else if (['pdf', 'jpeg', 'png'].includes(type)) st = parseStatementText(await extractText(storage, file, config));
  else throw new AppError(415, 'unsupported', `Išrašo formatas „${type}“ nepalaikomas.`);
  // Balances typed by the user for formats without them (CSV/XLSX) are marked as manual.
  if (opening !== undefined && opening !== null && opening !== '') { st.opening = money.norm(String(opening).replace(',', '.')); st.manualBalances = true; }
  if (closing !== undefined && closing !== null && closing !== '') { st.closing = money.norm(String(closing).replace(',', '.')); st.manualBalances = true; }
  return st;
}

export function fingerprint(accountId, r) {
  const norm = (s) => fold(String(s || '')).replace(/[^a-z0-9]+/g, '');
  return crypto.createHash('sha256').update([accountId, r.bookingDate, money.norm(r.amount), normalizeIban(r.counterpartyIban), norm(r.counterpartyName), norm(r.reference)].join('|')).digest('hex');
}

export function balanceCheck(st, validRows) {
  const credits = money.sum(validRows.filter((r) => money.sign(r.amount) > 0).map((r) => r.amount));
  const debits = money.neg(money.sum(validRows.filter((r) => money.sign(r.amount) < 0).map((r) => r.amount)));
  if (st.opening === null || st.opening === undefined || st.closing === null || st.closing === undefined) {
    return {status: 'missing', credits, debits, message: 'Išraše nėra pradinio ir/ar galutinio likučio – negalima patikrinti, ar importuotos visos operacijos. Įveskite likučius arba patvirtinkite su pastaba.'};
  }
  const expected = money.add(st.opening, money.sub(credits, debits));
  if (!money.eq(expected, st.closing)) return {status: 'mismatch', credits, debits, expected, message: `Likučiai nesutampa: pradinis ${st.opening} + įplaukos ${credits} − išmokos ${debits} = ${expected}, o išraše galutinis ${st.closing} (skirtumas ${money.sub(st.closing, expected)}).`};
  return {status: 'ok', credits, debits, expected, message: 'Pradinis likutis + įplaukos − išmokos = galutinis likutis.'};
}

export async function importStatement(deps, user, {documentId, bankAccountId = null, mapping = null, opening, closing, previewOnly = false}) {
  requireCap(user, previewOnly ? 'read' : 'write');
  const {pool} = deps;
  const doc = await loadDocumentForUser(pool, user, documentId);
  if (doc.workflow !== 'bank') throw new AppError(400, 'not_bank', 'Dokumentas nėra banko išrašas.');
  const file = await currentOriginal(pool, documentId);
  const st = await parseStatementFile(deps, file, {mapping, opening, closing});
  let account = null;
  if (st.iban) account = (await pool.query('SELECT * FROM bank_accounts WHERE iban=$1', [st.iban])).rows[0];
  if (bankAccountId) {
    const chosen = (await pool.query('SELECT * FROM bank_accounts WHERE id=$1', [bankAccountId])).rows[0];
    if (!chosen) throw new AppError(404, 'not_found', 'Banko sąskaita nerasta.');
    if (st.iban && chosen.iban !== st.iban) throw new AppError(422, 'iban_mismatch', `Išrašo sąskaita ${st.iban} nesutampa su pasirinkta ${chosen.iban}.`);
    account = chosen;
  }
  const validRows = st.rows.filter((r) => !r.issue && r.bookingDate && r.amount !== null && !money.isZero(r.amount));
  const issues = [...(st.issues || [])];
  for (const r of st.rows) if (r.issue) issues.push({level: 'error', message: `Eilutė ${r.rowNo}: ${r.issue}`, row: r.rowNo});
  if (account) for (const r of validRows) if (r.currency && r.currency !== account.currency) { r.issue = `Valiuta ${r.currency} nesutampa su sąskaitos valiuta ${account.currency}.`; issues.push({level: 'error', message: `Eilutė ${r.rowNo}: ${r.issue}`, row: r.rowNo}); }
  const rowsOk = validRows.filter((r) => !r.issue);
  const balance = balanceCheck(st, st.rows.filter((r) => r.bookingDate && r.amount !== null && !money.isZero(r.amount)));
  if (balance.status !== 'ok') issues.push({level: 'error', message: balance.message, code: `balance_${balance.status}`});
  if (st.manualBalances) issues.push({level: 'info', message: 'Likučiai įvesti rankiniu būdu (formatas jų neturi).'});
  if (previewOnly || !account) {
    return {preview: true, account, needsAccount: !account, iban: st.iban, format: st.format, statementRef: st.statementRef, periodFrom: st.periodFrom, periodTo: st.periodTo, opening: st.opening, closing: st.closing,
      balance, issues, headers: st.headers, mapping: st.mapping, rows: st.rows.slice(0, 200), totalRows: st.rows.length};
  }
  return tx(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(727100, $1::int)', [Number(account.id)]);
    const exists = (await db.query('SELECT id FROM bank_statements WHERE file_id=$1', [file.id])).rows[0];
    if (exists) return {statementId: exists.id, alreadyImported: true};
    // Gaps / overlaps with earlier statements of the same account.
    const prev = (await db.query(`SELECT * FROM bank_statements WHERE bank_account_id=$1 AND period_to IS NOT NULL ORDER BY period_to DESC LIMIT 1`, [account.id])).rows[0];
    if (prev && st.periodFrom) {
      const dayAfter = new Date(Date.parse(prev.period_to) + 86400000).toISOString().slice(0, 10);
      if (st.periodFrom > dayAfter) issues.push({level: 'warning', message: `Tarpas tarp išrašų: ankstesnis baigėsi ${prev.period_to}, šis prasideda ${st.periodFrom}.`, code: 'gap'});
      else if (st.periodFrom === dayAfter && prev.closing_balance !== null && st.opening !== null && !money.eq(prev.closing_balance, st.opening)) issues.push({level: 'error', message: `Ankstesnio išrašo galutinis likutis ${prev.closing_balance} nesutampa su šio pradiniu ${st.opening}.`, code: 'continuity'});
      else if (st.periodFrom <= prev.period_to) issues.push({level: 'info', message: `Laikotarpis persidengia su ankstesniu išrašu (${prev.period_from}–${prev.period_to}); pasikartojančios operacijos neįtraukiamos antrą kartą.`, code: 'overlap'});
    }
    const blocking = issues.some((i) => i.level === 'error');
    const stmt = (await db.query(`INSERT INTO bank_statements(bank_account_id, document_id, file_id, format, statement_ref, period_from, period_to, opening_balance, closing_balance, credits_total, debits_total, balance_status, issues, imported_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [account.id, documentId, file.id, st.format, st.statementRef || '', st.periodFrom, st.periodTo, st.opening, st.closing, balance.credits, balance.debits, balance.status === 'ok' && !blocking ? 'ok' : balance.status === 'ok' ? 'mismatch' : balance.status, JSON.stringify(issues), user.id])).rows[0];
    // Deduplicate: stable bank IDs first; otherwise fingerprint + occurrence index within this statement.
    const occurrences = new Map();
    let nNew = 0, nDup = 0, nReview = 0;
    const newTx = [];
    for (const r of st.rows) {
      if (r.issue || !r.bookingDate || r.amount === null || money.isZero(r.amount)) {
        await db.query(`INSERT INTO bank_statement_rows(statement_id, row_no, raw, source, outcome, issue) VALUES ($1,$2,$3,$4,'invalid',$5)`, [stmt.id, r.rowNo, r, r.source, r.issue || 'Netinkama eilutė']);
        continue;
      }
      const fp = fingerprint(account.id, r);
      const k = (occurrences.get(fp) || 0) + 1;
      occurrences.set(fp, k);
      const key = r.bankTxId ? `id:${r.bankTxId}` : `fp:${fp}:${k}`;
      const existing = (await db.query('SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND dedupe_key=$2', [account.id, key])).rows[0];
      if (existing) {
        nDup++;
        await db.query(`INSERT INTO bank_statement_rows(statement_id, row_no, raw, source, outcome, transaction_id) VALUES ($1,$2,$3,$4,'duplicate',$5)`, [stmt.id, r.rowNo, r, r.source, existing.id]);
        await db.query('INSERT INTO statement_coverage VALUES ($1,$2) ON CONFLICT DO NOTHING', [stmt.id, existing.id]);
        continue;
      }
      // Possible duplicate across formats (e.g. CSV without IDs vs CAMT with IDs): same date and amount, different identity.
      const similar = (await db.query(`SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND booking_date=$2 AND amount=$3 AND dedupe_key<>$4
        AND (fingerprint=$5
             OR ((bank_tx_id IS NULL) <> ($7 = ''))
             OR (bank_tx_id IS NULL AND $7 = '' AND counterparty_iban <> '' AND counterparty_iban=$6))
        AND NOT EXISTS (SELECT 1 FROM statement_coverage c WHERE c.transaction_id = bank_transactions.id AND c.statement_id = $8) LIMIT 1`,
      [account.id, r.bookingDate, r.amount, key, fp, normalizeIban(r.counterpartyIban), r.bankTxId || '', stmt.id])).rows[0];
      const dupNote = similar ? `Galimas dublikatas: operacija #${similar.id} ta pačia data ir suma, bet kitu identifikatoriumi. Patikrinkite.` : null;
      const t = (await db.query(`INSERT INTO bank_transactions(bank_account_id, first_statement_id, dedupe_key, bank_tx_id, fingerprint, occurrence, booking_date, value_date, amount, currency,
          counterparty_name, counterparty_iban, counterparty_code, reference, description, end_to_end_id, duplicate_review, duplicate_note, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [account.id, stmt.id, key, r.bankTxId, fp, k, r.bookingDate, r.valueDate, r.amount, r.currency || account.currency, String(r.counterpartyName || '').slice(0, 300), normalizeIban(r.counterpartyIban),
        r.counterpartyCode || '', String(r.reference || '').slice(0, 1000), String(r.description || '').slice(0, 1000), r.endToEndId || '', !!similar, dupNote, 'unmatched'])).rows[0];
      await db.query(`INSERT INTO bank_statement_rows(statement_id, row_no, raw, source, outcome, transaction_id, issue) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [stmt.id, r.rowNo, r, r.source, similar ? 'review' : 'new', t.id, dupNote]);
      await db.query('INSERT INTO statement_coverage VALUES ($1,$2) ON CONFLICT DO NOTHING', [stmt.id, t.id]);
      if (similar) nReview++; else nNew++;
      newTx.push(t);
    }
    await db.query('UPDATE bank_statements SET rows_total=$2, rows_new=$3, rows_duplicate=$4, rows_review=$5 WHERE id=$1', [stmt.id, st.rows.length, nNew, nDup, nReview]);
    await db.query(`UPDATE documents SET processing_status='stored', reference_number=$2, issue_date=$3, title=$4, updated_at=now() WHERE id=$1`,
      [documentId, st.statementRef || '', st.periodTo, `Išrašas ${account.name} ${st.periodFrom || ''}–${st.periodTo || ''}`]);
    for (const t of newTx) await proposeForTransaction(db, t, {userId: null});
    await audit(db, {userId: user.id, action: 'bank.import', entityType: 'bank_statement', entityId: stmt.id, details: {documentId, format: st.format, rows: st.rows.length, new: nNew, duplicate: nDup, review: nReview, balance: balance.status}});
    return {statementId: stmt.id, rows: st.rows.length, new: nNew, duplicate: nDup, review: nReview, balance, issues};
  });
}
