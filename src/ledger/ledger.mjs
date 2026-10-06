// Double-entry posting. Every posting passes server validation here and the
// database's deferred balance trigger, period-lock trigger and immutability triggers.
import {AppError} from '../db.mjs';
import {money, toUnits} from '../lib/money.mjs';

export async function roleAccounts(db) {
  const r = await db.query('SELECT system_role, code FROM accounts WHERE system_role IS NOT NULL');
  return Object.fromEntries(r.rows.map((x) => [x.system_role, x.code]));
}

export async function roleAccount(db, role) {
  const code = (await roleAccounts(db))[role];
  if (!code) throw new AppError(422, 'mapping_missing', `Nenustatyta sąskaita vaidmeniui „${role}“ (Nustatymai → Kontavimo susiejimai).`);
  return code;
}

export function validateLines(lines) {
  const errors = [];
  if (!Array.isArray(lines) || lines.length < 2) errors.push('Įrašas turi turėti bent dvi eilutes.');
  let d = 0n, c = 0n;
  for (const [i, l] of (lines || []).entries()) {
    const dr = toUnits(l.debit || '0'), cr = toUnits(l.credit || '0');
    if (!l.account) errors.push(`${i + 1} eilutė: nenurodyta sąskaita.`);
    if (dr < 0n || cr < 0n) errors.push(`${i + 1} eilutė: neigiamos sumos neleidžiamos.`);
    if ((dr === 0n) === (cr === 0n)) errors.push(`${i + 1} eilutė: nurodykite arba debetą, arba kreditą.`);
    d += dr; c += cr;
  }
  if (d !== c) errors.push(`Debetas (${money.norm(d)}) nelygus kreditui (${money.norm(c)}).`);
  if (d === 0n) errors.push('Įrašo suma lygi nuliui.');
  return {ok: errors.length === 0, errors, debit: money.norm(d), credit: money.norm(c)};
}

/**
 * Post a journal entry inside the caller's transaction. Idempotent per key:
 * a repeated key returns the existing entry and never posts twice.
 */
export async function postEntry(db, {date, description, sourceType, sourceId = null, idempotencyKey, lines, userId = null, reversesEntryId = null}) {
  if (!idempotencyKey) throw new Error('idempotencyKey required');
  const norm = lines.filter((l) => !money.isZero(l.debit || '0') || !money.isZero(l.credit || '0')).map((l) => ({
    account: String(l.account), debit: money.norm(l.debit || '0'), credit: money.norm(l.credit || '0'),
    counterpartyId: l.counterpartyId || null, description: l.description || '',
  }));
  const v = validateLines(norm);
  if (!v.ok) throw new AppError(422, 'unbalanced', v.errors.join(' '), {errors: v.errors});
  const codes = [...new Set(norm.map((l) => l.account))];
  const acc = await db.query('SELECT code FROM accounts WHERE code = ANY($1) AND active', [codes]);
  if (acc.rowCount !== codes.length) {
    const found = new Set(acc.rows.map((r) => r.code));
    throw new AppError(422, 'bad_account', `Nežinoma arba neaktyvi sąskaita: ${codes.filter((c) => !found.has(c)).join(', ')}`);
  }
  const ins = await db.query(`INSERT INTO journal_entries(entry_date, description, source_type, source_id, idempotency_key, created_by, reverses_entry_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
  [date, description, sourceType, sourceId === null ? null : String(sourceId), idempotencyKey, userId, reversesEntryId]);
  if (!ins.rows[0]) {
    const existing = await db.query('SELECT id FROM journal_entries WHERE idempotency_key=$1', [idempotencyKey]);
    return {id: existing.rows[0].id, duplicate: true};
  }
  const id = ins.rows[0].id;
  for (const l of norm) {
    await db.query('INSERT INTO journal_lines(entry_id, account_code, debit, credit, counterparty_id, description) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, l.account, l.debit, l.credit, l.counterpartyId, l.description]);
  }
  return {id, duplicate: false};
}

export async function entryLines(db, entryId) {
  return (await db.query(`SELECT l.*, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.code=l.account_code
    WHERE entry_id=$1 ORDER BY l.id`, [entryId])).rows;
}

/** Reverse an entry by posting the mirror image (never edits the original). */
export async function reverseEntry(db, {entryId, date, reason, userId}) {
  const lines = await entryLines(db, entryId);
  if (!lines.length) throw new AppError(404, 'not_found', 'Įrašas nerastas.');
  return postEntry(db, {
    date, description: `Atšaukimas: ${reason}`, sourceType: 'reversal', sourceId: entryId,
    idempotencyKey: `reverse:${entryId}`, userId, reversesEntryId: entryId,
    lines: lines.map((l) => ({account: l.account_code, debit: l.credit, credit: l.debit, counterpartyId: l.counterparty_id, description: l.description})),
  });
}
