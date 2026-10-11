// Metų uždarymas: close classes 5 and 6 into 341 at the year end; move the result from 341 to 342 on 1 January.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {money} from '../lib/money.mjs';
import {postEntry} from '../ledger/ledger.mjs';
import {NOT_CLOSING} from '../ledger/closing.mjs';

const yearOf = (v) => { const y = Number(v); if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError(400, 'year', 'Nurodykite metus.'); return y; };

async function state(db, year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const accounts = (await db.query(`SELECT l.account_code AS code, a.name, sum(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE e.entry_date BETWEEN $1 AND $2 AND l.account_code ~ '^[56]' GROUP BY 1, 2 HAVING sum(l.debit - l.credit) <> 0 ORDER BY 1`, [from, to])).rows.map((r) => ({...r, bal: money.norm(r.bal)}));
  // Result of the year from income and expense, without closing entries (positive = profit).
  const result = money.neg((await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.entry_date BETWEEN $1 AND $2 AND l.account_code ~ '^[56]' AND ${NOT_CLOSING}`, [from, to])).rows[0].v);
  const live = async (type) => (await db.query(`SELECT e.id, e.entry_date FROM journal_entries e WHERE e.source_type=$1 AND e.source_id=$2
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id) ORDER BY e.id DESC LIMIT 1`, [type, String(year)])).rows[0] || null;
  const b341 = money.norm((await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code LIKE '341%' AND e.entry_date <= $1`, [to])).rows[0].v);
  return {year, result, accounts, open: accounts.length > 0, closing: await live('year_close'), transfer: await live('year_transfer'), balance341: money.neg(b341)};
}

export function register(r, {pool}) {
  r.get('/api/year-end', async ({user, query}) => { requireCap(user, 'read'); return state(pool, yearOf(query.year)); });
  r.post('/api/year-end/close', async ({req, user}) => {
    requireCap(user, 'approve');
    const year = yearOf((await readJson(req)).year);
    return tx(pool, async (db) => {
      const st = await state(db, year);
      if (!st.accounts.length) throw new AppError(409, 'closed', `${year} m. pajamų ir sąnaudų sąskaitų likučių nėra – metai jau uždaryti.`);
      const lines = st.accounts.map((a) => (money.sign(a.bal) > 0 ? {account: a.code, credit: a.bal} : {account: a.code, debit: money.abs(a.bal)}));
      const net = money.sum(st.accounts.map((a) => a.bal)); // debit balance overall = loss
      if (!money.isZero(net)) lines.push(money.sign(net) > 0 ? {account: '341', debit: net, description: 'Ataskaitinių metų nuostoliai'} : {account: '341', credit: money.abs(net), description: 'Ataskaitinių metų pelnas'});
      const n = (await db.query(`SELECT count(*) AS n FROM journal_entries WHERE source_type='year_close' AND source_id=$1`, [String(year)])).rows[0].n;
      const e = await postEntry(db, {date: `${year}-12-31`, description: `${year} m. pajamų ir sąnaudų sąskaitų uždarymas`, sourceType: 'year_close', sourceId: String(year), idempotencyKey: `year-close:${year}:${n}`, userId: user.id, lines});
      await audit(db, {userId: user.id, action: 'year.close', entityType: 'journal_entry', entityId: e.id, details: {year, result: money.neg(net)}});
      return {entryId: String(e.id), result: money.neg(net)};
    });
  });
  r.post('/api/year-end/transfer', async ({req, user}) => {
    requireCap(user, 'approve');
    const year = yearOf((await readJson(req)).year);
    return tx(pool, async (db) => {
      const st = await state(db, year);
      if (st.open) throw new AppError(409, 'not_closed', `Pirmiausia uždarykite ${year} m. pajamų ir sąnaudų sąskaitas.`);
      if (st.transfer) throw new AppError(409, 'done', `${year} m. rezultatas į 342 jau perkeltas.`);
      if (money.isZero(st.balance341)) throw new AppError(409, 'empty', '341 sąskaitoje likučio nėra.');
      const amt = money.abs(st.balance341), profit = money.sign(st.balance341) > 0;
      const lines = profit ? [{account: '341', debit: amt}, {account: '342', credit: amt}] : [{account: '342', debit: amt}, {account: '341', credit: amt}];
      const n = (await db.query(`SELECT count(*) AS n FROM journal_entries WHERE source_type='year_transfer' AND source_id=$1`, [String(year)])).rows[0].n;
      const e = await postEntry(db, {date: `${year + 1}-01-01`, description: `${year} m. rezultato perkėlimas į ankstesnių metų nepaskirstytąjį pelną`, sourceType: 'year_transfer', sourceId: String(year), idempotencyKey: `year-transfer:${year}:${n}`, userId: user.id, lines});
      await audit(db, {userId: user.id, action: 'year.transfer', entityType: 'journal_entry', entityId: e.id, details: {year, amount: st.balance341}});
      return {entryId: String(e.id), amount: st.balance341};
    });
  });
}
