// Valiutinių straipsnių perkainojimas: at a reporting date, monetary items in foreign currency are restated at the rate of
// that date (VAS: monetary items at the closing rate). Open foreign-currency invoices: the EUR balance becomes
// own-currency balance / rate; foreign-currency bank accounts: the EUR ledger balance becomes the currency balance / rate.
// Differences go to 5803 (gain) / 6803 (loss); the next revaluation starts from the restated amounts.
import {AppError} from '../db.mjs';
import {money} from '../lib/money.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {postEntry, reverseEntry, roleAccounts} from '../ledger/ledger.mjs';
import {rateFor, toEur} from './rates.mjs';

export async function revaluationPreview(db, asOf) {
  const roles = await roleAccounts(db);
  const gainAcc = roles.fx_gain || '5803', lossAcc = roles.fx_loss || '6803';
  const items = [], missing = new Set();
  const open = (await invoiceBalances(db, {asOf, openOnly: true, limit: 5000})).filter((i) => i.currency !== 'EUR');
  for (const i of open) {
    const r = await rateFor(db, i.currency, asOf);
    if (!r) { missing.add(i.currency); continue; }
    const target = toEur(i.orig_outstanding, r.rate), diff = money.sub(target, i.outstanding);
    if (money.isZero(diff)) continue;
    const account = i.register === 'sales' ? roles.receivable : roles.payable;
    // Receivable up = gain, payable up = loss (and the other way round).
    const gain = i.register === 'sales' ? money.sign(diff) > 0 : money.sign(diff) < 0;
    items.push({type: 'invoice', invoiceId: String(i.id), label: `${i.series || ''} ${i.number}`.trim(), counterparty: i.counterparty_name, register: i.register, counterpartyId: i.counterparty_id ? String(i.counterparty_id) : null,
      currency: i.currency, origBalance: money.norm(i.orig_outstanding), rate: r.rate, rateDate: r.date, bookBalance: money.norm(i.outstanding), newBalance: target, diff, account, gain});
  }
  const banks = (await db.query(`SELECT * FROM bank_accounts WHERE currency <> 'EUR' AND active`)).rows;
  for (const b of banks) {
    const ccy = money.norm((await db.query(`SELECT coalesce(sum(amount),0) AS s FROM bank_transactions WHERE bank_account_id=$1 AND status='approved' AND booking_date <= $2`, [b.id, asOf])).rows[0].s);
    const book = money.norm((await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS s FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date <= $2`, [b.ledger_account, asOf])).rows[0].s);
    const r = await rateFor(db, b.currency, asOf);
    if (!r) { missing.add(b.currency); continue; }
    const target = toEur(ccy, r.rate), diff = money.sub(target, book);
    if (money.isZero(diff)) continue;
    items.push({type: 'bank', bankAccountId: String(b.id), label: `${b.name} ${b.iban}`, currency: b.currency, origBalance: ccy, rate: r.rate, rateDate: r.date, bookBalance: book, newBalance: target, diff, account: b.ledger_account, gain: money.sign(diff) > 0});
  }
  const gain = money.sum(items.filter((x) => x.gain).map((x) => money.abs(x.diff))), loss = money.sum(items.filter((x) => !x.gain).map((x) => money.abs(x.diff)));
  return {asOf, items, gain, loss, net: money.sub(gain, loss), missing: [...missing], gainAccount: gainAcc, lossAccount: lossAcc,
    posted: (await db.query(`SELECT id FROM fx_revaluations WHERE as_of=$1 AND status='posted'`, [asOf])).rows[0]?.id || null};
}

export async function postRevaluation(db, user, asOf) {
  await db.query('LOCK TABLE fx_revaluations IN EXCLUSIVE MODE');
  const p = await revaluationPreview(db, asOf);
  if (p.posted) throw new AppError(409, 'posted', `Perkainojimas ${asOf} datai jau užregistruotas.`);
  if (p.missing.length) throw new AppError(422, 'fx_rate', `Nėra kursų ${asOf} datai: ${p.missing.join(', ')}.`);
  const later = (await db.query(`SELECT as_of FROM fx_revaluations WHERE status='posted' AND as_of > $1`, [asOf])).rows;
  if (later.length) throw new AppError(409, 'later', `Jau yra vėlesnis perkainojimas (${later.map((x) => String(x.as_of instanceof Date ? x.as_of.toISOString() : x.as_of).slice(0, 10)).join(', ')}).`);
  if (!p.items.length) throw new AppError(422, 'empty', 'Perkainoti nėra ką – kursų skirtumų nėra.');
  const rev = (await db.query(`INSERT INTO fx_revaluations(as_of, lines, gain, loss, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [asOf, JSON.stringify(p.items), p.gain, p.loss, user.id])).rows[0];
  const lines = [];
  for (const x of p.items) {
    // The item's account moves by diff (EUR value up = debit for an asset, credit for a payable); the opposite side is 5803/6803.
    const debitItem = x.type === 'bank' || x.register === 'sales' ? money.sign(x.diff) > 0 : money.sign(x.diff) < 0;
    const a = money.abs(x.diff), desc = `Perkainojimas ${x.label} (${x.origBalance} ${x.currency} / ${x.rate})`.slice(0, 200);
    lines.push({account: x.account, debit: debitItem ? a : '0', credit: debitItem ? '0' : a, counterpartyId: x.counterpartyId || null, description: desc});
    lines.push({account: x.gain ? p.gainAccount : p.lossAccount, debit: x.gain ? '0' : a, credit: x.gain ? a : '0', description: desc});
  }
  const e = await postEntry(db, {date: asOf, description: `Valiutinių straipsnių perkainojimas ${asOf}`, sourceType: 'fx_revaluation', sourceId: rev.id, idempotencyKey: `fx-revaluation:${rev.id}`, userId: user.id, lines});
  await db.query('UPDATE fx_revaluations SET journal_entry_id=$2 WHERE id=$1', [rev.id, e.id]);
  // The invoice's EUR balance follows: an allocation of −diff (sales) / −diff (purchase, balance positive = debt).
  for (const x of p.items.filter((i) => i.type === 'invoice')) {
    await db.query(`INSERT INTO allocations(fx_revaluation_id, kind, invoice_id, counterparty_id, account_code, amount, orig_amount, journal_entry_id, note, approved_by) VALUES ($1,'fx_revaluation',$2,$3,$4,$5,0,$6,$7,$8)`,
      [rev.id, x.invoiceId, x.counterpartyId, x.account, money.neg(x.diff), e.id, `Perkainojimas ${asOf}`, user.id]);
  }
  return {id: String(rev.id), entryId: String(e.id), gain: p.gain, loss: p.loss, items: p.items.length};
}

export async function cancelRevaluation(db, user, id, reason) {
  const r = (await db.query(`SELECT * FROM fx_revaluations WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!r || r.status !== 'posted') throw new AppError(404, 'not_found', 'Galiojantis perkainojimas nerastas.');
  const later = (await db.query(`SELECT 1 FROM fx_revaluations WHERE status='posted' AND as_of > $1`, [r.as_of])).rowCount;
  if (later) throw new AppError(409, 'later', 'Pirmiausia atšaukite vėlesnį perkainojimą.');
  const asOf = String(r.as_of instanceof Date ? r.as_of.toISOString() : r.as_of).slice(0, 10);
  const rev = await reverseEntry(db, {entryId: r.journal_entry_id, date: asOf, reason: `perkainojimas ${asOf}: ${reason}`, userId: user.id});
  for (const a of (await db.query(`SELECT * FROM allocations WHERE fx_revaluation_id=$1`, [id])).rows) {
    await db.query(`INSERT INTO allocations(fx_revaluation_id, kind, invoice_id, counterparty_id, account_code, amount, orig_amount, journal_entry_id, note, approved_by) VALUES ($1,'fx_revaluation',$2,$3,$4,$5,0,$6,$7,$8)`,
      [id, a.invoice_id, a.counterparty_id, a.account_code, money.neg(a.amount), rev.id, `Atšauktas perkainojimas ${asOf}`, user.id]);
  }
  await db.query(`UPDATE fx_revaluations SET status='cancelled', cancel_entry_id=$2 WHERE id=$1`, [id, rev.id]);
  return {ok: true};
}
