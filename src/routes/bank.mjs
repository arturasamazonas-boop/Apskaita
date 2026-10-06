// Bank accounts, statement import, transactions, reconciliation.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {importStatement} from '../bank/import.mjs';
import {FORMATS} from '../bank/parsers.mjs';
import {editRecon, approveRecon, applyAdvance, proposeForTransaction, computeRecon} from '../bank/matching.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {normalizeIban, ibanValid} from '../extraction/ids.mjs';
import {money} from '../lib/money.mjs';

export function register(r, deps) {
  const {pool} = deps;
  r.get('/api/bank/formats', async () => FORMATS);
  r.get('/api/bank/accounts', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT b.*, (SELECT coalesce(sum(l.debit - l.credit),0) FROM journal_lines l WHERE l.account_code=b.ledger_account) AS ledger_balance,
        (SELECT closing_balance FROM bank_statements s WHERE s.bank_account_id=b.id ORDER BY period_to DESC NULLS LAST, id DESC LIMIT 1) AS last_statement_balance,
        (SELECT max(period_to) FROM bank_statements s WHERE s.bank_account_id=b.id) AS last_statement_date
      FROM bank_accounts b ORDER BY b.id`)).rows;
  });
  r.post('/api/bank/accounts', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    const iban = normalizeIban(b.iban);
    if (!ibanValid(iban)) throw new AppError(400, 'bad_iban', 'Netinkamas IBAN (patikrinkite kontrolinius skaitmenis).');
    const acc = (await pool.query('SELECT code FROM accounts WHERE code=$1 AND active', [b.ledger_account || '2710'])).rows[0];
    if (!acc) throw new AppError(400, 'bad_account', 'Didžiosios knygos sąskaita nerasta.');
    const row = (await pool.query(`INSERT INTO bank_accounts(iban, name, bank_name, currency, ledger_account, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [iban, String(b.name || iban).slice(0, 100), String(b.bank_name || '').slice(0, 100), (b.currency || 'EUR').toUpperCase().slice(0, 3), acc.code, b.kind === 'processor' ? 'processor' : 'bank'])).rows[0];
    await audit(pool, {userId: user.id, action: 'bank_account.create', entityType: 'bank_account', entityId: row.id, details: {iban}});
    return row;
  });

  r.post('/api/bank/statements/preview', async ({req, user}) => importStatement(deps, user, {...(await readJson(req)), previewOnly: true}));
  r.post('/api/bank/statements/import', async ({req, user}) => importStatement(deps, user, await readJson(req)));
  r.get('/api/bank/statements', async ({user, query}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT s.*, b.name AS account_name, b.iban, u.name AS resolved_by_name FROM bank_statements s JOIN bank_accounts b ON b.id=s.bank_account_id LEFT JOIN users u ON u.id=s.resolved_by
      WHERE ($1='' OR s.bank_account_id::text=$1) ORDER BY s.period_to DESC NULLS LAST, s.id DESC LIMIT 200`, [String(query.account || '')])).rows;
  });
  r.get('/api/bank/statements/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const s = (await pool.query(`SELECT s.*, b.name AS account_name, b.iban FROM bank_statements s JOIN bank_accounts b ON b.id=s.bank_account_id WHERE s.id=$1`, [params.id])).rows[0];
    if (!s) throw new AppError(404, 'not_found', 'Išrašas nerastas.');
    const rows = (await pool.query(`SELECT r.*, t.status AS tx_status FROM bank_statement_rows r LEFT JOIN bank_transactions t ON t.id=r.transaction_id WHERE r.statement_id=$1 ORDER BY r.row_no`, [s.id])).rows;
    return {...s, rows};
  });
  r.post('/api/bank/statements/:id/resolve', async ({req, user, params}) => {
    requireCap(user, 'resolve');
    const b = await readJson(req);
    const note = String(b.note || '').trim();
    if (note.length < 10) throw new AppError(400, 'note', 'Nurodykite išsamią pastabą (bent 10 simbolių), kodėl neatitikimas priimamas.');
    return tx(pool, async (db) => {
      const s = (await db.query(`UPDATE bank_statements SET resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1 AND balance_status <> 'ok' AND resolved_at IS NULL RETURNING *`, [params.id, user.id, note.slice(0, 1000)])).rows[0];
      if (!s) throw new AppError(409, 'not_needed', 'Išrašas neturi neišspręsto neatitikimo.');
      await audit(db, {userId: user.id, action: 'bank_statement.resolve', entityType: 'bank_statement', entityId: s.id, details: {status: s.balance_status, note}});
      // Revalidate open proposals of affected transactions.
      const txs = (await db.query(`SELECT t.* FROM bank_transactions t JOIN statement_coverage c ON c.transaction_id=t.id WHERE c.statement_id=$1 AND t.status IN ('unmatched','proposed','needs_review')`, [s.id])).rows;
      for (const t of txs) {
        const p = (await db.query(`SELECT * FROM reconciliation_proposals WHERE transaction_id=$1 AND status='open'`, [t.id])).rows[0];
        if (p) { const c = await computeRecon(db, t, p.data); await db.query('UPDATE reconciliation_proposals SET validation=$2, blocking=$3 WHERE id=$1', [p.id, {issues: c.issues, entries: c.entries}, c.blocking]); await db.query('UPDATE bank_transactions SET status=$2 WHERE id=$1', [t.id, !p.data.allocations?.length ? 'unmatched' : c.blocking ? 'needs_review' : 'proposed']); }
      }
      return s;
    });
  });

  r.get('/api/bank/transactions', async ({user, query}) => {
    requireCap(user, 'read');
    const limit = Math.min(Number(query.limit) || 50, 200), offset = Math.max(Number(query.offset) || 0, 0);
    const params = [];
    const where = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
    if (query.status === 'open') where.push(`t.status IN ('unmatched','proposed','needs_review')`); else if (query.status) add('t.status = ?', query.status);
    if (query.account) add('t.bank_account_id = ?', query.account);
    if (query.from) add('t.booking_date >= ?', query.from);
    if (query.to) add('t.booking_date <= ?', query.to);
    if (query.q) add(`(t.counterparty_name ILIKE '%'||?||'%' OR t.reference ILIKE '%'||?||'%')`, String(query.q).slice(0, 100));
    const rows = (await pool.query(`SELECT t.*, b.name AS account_name, p.id AS proposal_id, p.content_hash, p.blocking, p.data->>'kind' AS proposal_kind, p.data->>'status' AS match_status, p.data->>'explanation' AS explanation,
        (SELECT x->>'message' FROM jsonb_array_elements(p.validation->'issues') x WHERE x->>'level'='error' LIMIT 1) AS first_error
      FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_account_id LEFT JOIN reconciliation_proposals p ON p.transaction_id=t.id AND p.status='open'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.booking_date DESC, t.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, params)).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.get('/api/bank/transactions/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const t = (await pool.query(`SELECT t.*, b.name AS account_name, b.iban AS account_iban, b.ledger_account FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_account_id WHERE t.id=$1`, [params.id])).rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Operacija nerasta.');
    const proposals = (await pool.query(`SELECT p.*, u.name AS decided_by_name FROM reconciliation_proposals p LEFT JOIN users u ON u.id=p.decided_by WHERE p.transaction_id=$1 ORDER BY version DESC`, [t.id])).rows;
    const open = proposals.find((p) => p.status === 'open');
    if (open) { const c = await computeRecon(pool, t, open.data); open.validation = {issues: c.issues, entries: c.entries}; open.blocking = c.blocking; }
    const sources = (await pool.query(`SELECT r.statement_id, r.row_no, r.source, r.outcome, s.document_id, s.format FROM bank_statement_rows r JOIN bank_statements s ON s.id=r.statement_id WHERE r.transaction_id=$1 ORDER BY r.id`, [t.id])).rows;
    const allocations = (await pool.query(`SELECT a.*, i.series, i.number, i.register, (SELECT coalesce(sum(x.amount),0) FROM allocations x WHERE x.source_allocation_id=a.id) AS applied FROM allocations a LEFT JOIN invoices i ON i.id=a.invoice_id WHERE a.transaction_id=$1 ORDER BY a.id`, [t.id])).rows;
    return {...t, proposals, sources, allocations};
  });
  r.put('/api/bank/transactions/:id/proposal', async ({req, user, params}) => editRecon(pool, user, params.id, await readJson(req)));
  r.post('/api/bank/transactions/:id/approve', async ({req, user, params}) => approveRecon(pool, user, params.id, await readJson(req)));
  r.post('/api/bank/transactions/:id/resuggest', async ({user, params}) => {
    requireCap(user, 'write');
    return tx(pool, async (db) => {
      const t = (await db.query('SELECT * FROM bank_transactions WHERE id=$1 FOR UPDATE', [params.id])).rows[0];
      if (!t || ['approved', 'ignored'].includes(t.status)) throw new AppError(409, 'closed', 'Operacija jau užbaigta.');
      return proposeForTransaction(db, t, {userId: user.id});
    });
  });
  r.post('/api/bank/transactions/:id/duplicate', async ({req, user, params}) => {
    requireCap(user, 'resolve');
    const b = await readJson(req);
    if (!['duplicate', 'not_duplicate'].includes(b.decision) || String(b.note || '').trim().length < 5) throw new AppError(400, 'bad_request', 'Pasirinkite sprendimą ir įrašykite pastabą.');
    return tx(pool, async (db) => {
      const t = (await db.query('SELECT * FROM bank_transactions WHERE id=$1 FOR UPDATE', [params.id])).rows[0];
      if (!t || t.status === 'approved') throw new AppError(409, 'closed', 'Operacija nerasta arba jau suderinta.');
      if (b.decision === 'duplicate') await db.query(`UPDATE bank_transactions SET status='ignored', duplicate_review=false, duplicate_note=$2 WHERE id=$1`, [t.id, `Dublikatas: ${b.note}`]);
      else {
        await db.query(`UPDATE bank_transactions SET duplicate_review=false, duplicate_note=$2 WHERE id=$1`, [t.id, `Ne dublikatas: ${b.note}`]);
        await proposeForTransaction(db, {...t, duplicate_review: false}, {userId: user.id});
      }
      await db.query(`UPDATE reconciliation_proposals SET status='superseded' WHERE transaction_id=$1 AND status='open' AND $2`, [t.id, b.decision === 'duplicate']);
      await audit(db, {userId: user.id, action: 'bank.duplicate_decision', entityType: 'bank_transaction', entityId: t.id, details: {decision: b.decision, note: String(b.note).slice(0, 500)}});
      return {ok: true};
    });
  });
  r.get('/api/bank/open-invoices', async ({user, query}) => {
    requireCap(user, 'read');
    const rows = await invoiceBalances(pool, {openOnly: true, register: query.register || null, limit: 2000});
    const q = String(query.q || '').toLowerCase();
    return rows.filter((x) => !q || `${x.series} ${x.number} ${x.counterparty_name}`.toLowerCase().includes(q)).slice(0, 100);
  });
  r.get('/api/bank/advances', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT a.id, a.kind, a.amount, a.transaction_id, a.counterparty_id, c.name AS counterparty_name, t.booking_date, t.counterparty_name AS payer, t.reference,
        a.amount - coalesce((SELECT sum(x.amount) * sign(a.amount) FROM allocations x WHERE x.source_allocation_id=a.id),0) AS remaining
      FROM allocations a JOIN bank_transactions t ON t.id=a.transaction_id LEFT JOIN counterparties c ON c.id=a.counterparty_id
      WHERE a.kind IN ('advance','overpayment') ORDER BY t.booking_date DESC`)).rows.filter((x) => !money.isZero(x.remaining));
  });
  r.post('/api/bank/advances/:id/apply', async ({req, user, params}) => applyAdvance(pool, user, params.id, await readJson(req)));
}
