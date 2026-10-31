// Palūkanų kaupimas DK. An accrual books the difference between the interest calculated to its date (with the
// loan's own "include the repayment day" setting) and the interest already accrued, so later changes to the loan
// (a repayment entered late, a rate change) are caught up by the next accrual. Received loan: D interest expense
// (6802) / K accrued expenses (491). Granted loan: D accrued income (292) / K interest income (5802). A negative
// difference books the opposite entry. Only the latest accrual of a loan can be cancelled (by a reversing entry).
import {AppError} from '../db.mjs';
import {money} from '../lib/money.mjs';
import {postEntry, reverseEntry, roleAccounts} from '../ledger/ledger.mjs';
import {rateFor, toEur} from '../fx/rates.mjs';
import {calcInterest} from './interest.mjs';

const DEFAULTS = {interest_expense: '6802', interest_accrued: '491', interest_income: '5802', interest_receivable: '292'};
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

export async function loadLoanForAccrual(db, id, {lock = false} = {}) {
  const l = (await db.query(`SELECT * FROM loans WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!l) throw new AppError(404, 'not_found', 'Paskola nerasta.');
  l.events = (await db.query('SELECT * FROM loan_events WHERE loan_id=$1 ORDER BY event_date, id', [id])).rows;
  l.accruals = (await db.query(`SELECT a.*, u.name AS user_name FROM loan_accruals a LEFT JOIN users u ON u.id=a.created_by WHERE a.loan_id=$1 ORDER BY a.as_of, a.id`, [id])).rows;
  return l;
}

export async function accrualAccounts(db, loan) {
  const roles = await roleAccounts(db);
  const r = (k) => roles[k] || DEFAULTS[k];
  return loan.direction === 'received'
    ? {interest: loan.interest_account || r('interest_expense'), accrual: loan.accrual_account || r('interest_accrued')}
    : {interest: loan.interest_account || r('interest_income'), accrual: loan.accrual_account || r('interest_receivable')};
}

/** What an accrual to `asOf` would book. Never throws for business reasons: problems are in `blockers`. */
export async function accrualPreview(db, loan, asOf) {
  const posted = loan.accruals.filter((a) => a.status === 'posted');
  const last = posted.at(-1) || null;
  const booked = money.sum(posted.map((a) => a.amount));
  const calc = calcInterest({events: loan.events.map((e) => ({date: e.event_date, kind: e.kind, amount: e.amount, rate: e.rate})), rate: loan.annual_rate, basis: loan.basis, asOf, includeLastDay: loan.include_last_day, includeEndDay: true});
  const amount = money.sub(calc.interest, booked);
  const acc = await accrualAccounts(db, loan);
  const blockers = [];
  if (last && asOf <= last.as_of) blockers.push(`Palūkanos jau sukauptos iki ${last.as_of}. Pasirinkite vėlesnę datą arba atšaukite paskutinį kaupimą.`);
  if (!loan.events.some((e) => e.kind === 'disbursement')) blockers.push('Nenurodyta pinigų gavimo diena.');
  if (money.isZero(amount) && !blockers.length) blockers.push('Kaupti nėra ką – palūkanos jau užregistruotos.');
  const locked = (await db.query('SELECT locked_through FROM company_settings WHERE id=1')).rows[0]?.locked_through;
  if (locked && asOf <= String(locked).slice(0, 10)) blockers.push(`Laikotarpis užrakintas iki ${String(locked).slice(0, 10)} – pasirinkite vėlesnę datą.`);
  let amountEur = amount, rate = null;
  if (loan.currency !== 'EUR' && !money.isZero(amount)) {
    const fx = await rateFor(db, loan.currency, asOf);
    if (!fx) blockers.push(`Nėra ${loan.currency} kurso ${asOf} datai (Finansai → Valiutų kursai).`);
    else { rate = fx.rate; amountEur = toEur(amount, fx.rate); }
  }
  const positive = money.sign(amount) > 0;
  // Received: expense up = D interest / K accrual. Granted: accrued income up = D accrual / K interest.
  const debit = loan.direction === 'received' ? (positive ? acc.interest : acc.accrual) : (positive ? acc.accrual : acc.interest);
  const credit = debit === acc.interest ? acc.accrual : acc.interest;
  return {asOf, from: last ? nextDay(last.as_of) : loan.events.find((e) => e.kind === 'disbursement')?.event_date || null, interestTotal: calc.interest, booked, amount, amountEur: money.abs(amountEur), signedEur: amountEur, fxRate: rate,
    includeLastDay: loan.include_last_day, debit, credit, lastAccrual: last?.as_of || null, blockers};
}

export async function postAccrual(db, user, loanId, asOf) {
  await db.query('SELECT pg_advisory_xact_lock(727101, $1::int)', [Number(loanId) % 2147483647]);
  const loan = await loadLoanForAccrual(db, loanId, {lock: true});
  const p = await accrualPreview(db, loan, asOf);
  if (p.blockers.length) throw new AppError(422, 'accrual', p.blockers.join(' '));
  const row = (await db.query(`INSERT INTO loan_accruals(loan_id, as_of, period_from, interest_total, amount, amount_eur, fx_rate, include_last_day, debit_account, credit_account, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [loan.id, asOf, p.from, p.interestTotal, p.amount, p.signedEur, p.fxRate, p.includeLastDay, p.debit, p.credit, user.id])).rows[0];
  const what = `${loan.direction === 'received' ? 'Gautos' : 'Suteiktos'} paskolos${loan.contract_no ? ` ${loan.contract_no}` : ''} palūkanos ${p.from || ''}–${asOf}${money.sign(p.amount) < 0 ? ' (koregavimas)' : ''}`.slice(0, 200);
  const e = await postEntry(db, {date: asOf, description: `Palūkanų kaupimas: ${what}`, sourceType: 'loan_accrual', sourceId: row.id, idempotencyKey: `loan-accrual:${row.id}`, userId: user.id,
    lines: [{account: p.debit, debit: p.amountEur, credit: '0', counterpartyId: loan.counterparty_id, description: what}, {account: p.credit, debit: '0', credit: p.amountEur, counterpartyId: loan.counterparty_id, description: what}]});
  await db.query('UPDATE loan_accruals SET journal_entry_id=$2 WHERE id=$1', [row.id, e.id]);
  return {id: String(row.id), entryId: String(e.id), amount: p.amount, amountEur: p.amountEur, debit: p.debit, credit: p.credit, from: p.from, asOf};
}

export async function cancelAccrual(db, user, loanId, accrualId, reason) {
  const loan = await loadLoanForAccrual(db, loanId, {lock: true});
  const posted = loan.accruals.filter((a) => a.status === 'posted');
  const a = posted.find((x) => String(x.id) === String(accrualId));
  if (!a) throw new AppError(404, 'not_found', 'Galiojantis kaupimas nerastas.');
  if (posted.at(-1).id !== a.id) throw new AppError(409, 'later', 'Atšaukti galima tik paskutinį kaupimą.');
  // Reversed on the accrual's own date, or on the first open day when that period is locked.
  const locked = (await db.query('SELECT locked_through FROM company_settings WHERE id=1')).rows[0]?.locked_through;
  const at = locked && String(a.as_of).slice(0, 10) <= String(locked).slice(0, 10) ? nextDay(String(locked).slice(0, 10)) : a.as_of;
  const rev = await reverseEntry(db, {entryId: a.journal_entry_id, date: at, reason: `palūkanų kaupimas ${a.as_of}: ${reason}`, userId: user.id});
  await db.query(`UPDATE loan_accruals SET status='cancelled', cancel_entry_id=$2 WHERE id=$1`, [a.id, rev.id]);
  return {ok: true};
}
