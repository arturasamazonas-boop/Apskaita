// Palūkanų skaičiavimas. Interest accrues on the outstanding principal day by day:
//  - from the day the money arrived (išmokėjimo / pinigų įkritimo diena), never from the signing date;
//  - a repayment stops interest on the repaid part from the next day when `includeLastDay` is set
//    (the repayment day is charged), otherwise from the repayment day itself;
//  - the calculation runs to `asOf`, which is likewise included only when `includeLastDay` is set;
//  - a rate change applies from its date.
// Amounts are exact: each period's interest is kept in 1/10 000 cent and only the total is rounded to cents.
import {AppError} from '../db.mjs';
import {toUnits, fromUnits, divRound} from '../lib/money.mjs';

export const BASES = {
  act365: 'Faktinės dienos / 365',
  act360: 'Faktinės dienos / 360',
  actact: 'Faktinės dienos / faktinės metų dienos (365 arba 366)',
  '30e360': '30E/360 (mėnuo – 30 dienų, metai – 360)',
};

const DAY = 86400000;
const toDay = (s) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new AppError(400, 'date', `Netinkama data: ${s}`); return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY; };
const iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
const yearOf = (d) => new Date(d * DAY).getUTCFullYear();
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** 30E/360 day count between day numbers a (inclusive) and b (exclusive). */
function days30e360(a, b) {
  const x = new Date(a * DAY), y = new Date(b * DAY);
  const d1 = Math.min(x.getUTCDate(), 30), d2 = Math.min(y.getUTCDate(), 30);
  return 360 * (y.getUTCFullYear() - x.getUTCFullYear()) + 30 * (y.getUTCMonth() - x.getUTCMonth()) + (d2 - d1);
}

/** Pieces of [a, b) with their day count and year basis; actact splits at 1 January. */
function pieces(a, b, basis) {
  if (basis === 'act365') return [{a, b, days: b - a, denom: 365}];
  if (basis === 'act360') return [{a, b, days: b - a, denom: 360}];
  if (basis === '30e360') return [{a, b, days: days30e360(a, b), denom: 360}];
  if (basis !== 'actact') throw new AppError(400, 'basis', 'Netinkama dienų skaičiavimo bazė.');
  const out = [];
  for (let s = a; s < b;) {
    const y = yearOf(s), next = Math.min(b, Date.UTC(y + 1, 0, 1) / DAY);
    out.push({a: s, b: next, days: next - s, denom: leap(y) ? 366 : 365});
    s = next;
  }
  return out;
}

/**
 * events: [{date, kind: 'disbursement'|'repayment'|'rate_change'|'interest_payment', amount?, rate?}]
 * Returns periods [{from, to (inclusive), days, balance, rate, basisDays, interest}], total, paid, due, balance.
 */
export function calcInterest({events = [], rate, basis = 'act365', asOf, includeLastDay = false, includeEndDay = includeLastDay}) {
  // includeLastDay: a repayment day still earns interest on the repaid amount. includeEndDay: the "to" date itself
  // earns interest (always for ledger accruals – the last day of the month belongs to that month).
  const end = toDay(asOf) + (includeEndDay ? 1 : 0);
  const changes = [];
  let paid = 0n;
  for (const e of events) {
    const d = toDay(e.date);
    if (e.kind === 'disbursement') changes.push({at: d, dBal: toUnits(e.amount, 2)});
    else if (e.kind === 'repayment') changes.push({at: d + (includeLastDay ? 1 : 0), dBal: -toUnits(e.amount, 2), repayDay: d});
    else if (e.kind === 'rate_change') changes.push({at: d, rate: toUnits(e.rate, 4)});
    else if (e.kind === 'interest_payment') { if (d <= toDay(asOf)) paid += toUnits(e.amount, 2); }
  }
  // Same day: rate changes first (a disbursement that day already earns the new rate), then money in, then money out –
  // whatever order the events were entered in.
  const order = (c) => (c.rate !== undefined ? 0 : c.dBal > 0n ? 1 : 2);
  changes.sort((x, y) => x.at - y.at || order(x) - order(y));
  const firstMoney = changes.find((c) => c.dBal !== undefined && c.dBal > 0n)?.at;
  let bal = 0n, r = toUnits(rate ?? '0', 4), micro = 0n;
  const periods = [], issues = [];
  const flush = (a, b) => {
    if (a >= b || bal <= 0n || firstMoney === undefined) return; // nothing outstanding (an overpayment earns nothing)
    let periodMicro = 0n, days = 0;
    const parts = [];
    for (const p of pieces(a, b, basis)) {
      // cents × 10 000 = 1/10 000 cent; rate has 4 decimals and is a percentage.
      const m = divRound(bal * 10000n * r * BigInt(p.days), BigInt(p.denom) * 100n * 10000n);
      periodMicro += m; days += p.days;
      parts.push({from: iso(p.a), to: iso(p.b - 1), days: p.days, denom: p.denom, interest: fromUnits(divRound(m, 10000n), 2)});
    }
    // Shown per period so that the periods add up to the (once rounded) total: each takes the change of the rounded running sum.
    const shown = divRound(micro + periodMicro, 10000n) - divRound(micro, 10000n);
    micro += periodMicro;
    periods.push({from: iso(a), to: iso(b - 1), days, balance: fromUnits(bal, 2), rate: fromUnits(r, 4), interest: fromUnits(shown, 2), parts});
  };
  let cursor = firstMoney;
  for (const c of changes) {
    if (cursor !== undefined && c.at > cursor) { flush(cursor, Math.min(c.at, end)); cursor = Math.max(cursor, Math.min(c.at, end)); }
    if (c.dBal !== undefined) {
      bal += c.dBal;
      // An overpayment is set off against later money: the balance is not reset to 0.
      if (bal < 0n && c.dBal < 0n) issues.push(`Grąžinta daugiau, nei paskolinta (${iso(c.repayDay)}).`);
    }
    if (c.rate !== undefined) r = c.rate;
  }
  if (cursor !== undefined && cursor < end) flush(cursor, end);
  const total = divRound(micro, 10000n);
  let principal = 0n;
  for (const e of events) if (toDay(e.date) <= toDay(asOf)) principal += e.kind === 'disbursement' ? toUnits(e.amount, 2) : e.kind === 'repayment' ? -toUnits(e.amount, 2) : 0n;
  return {asOf, includeLastDay, basis, periods, interest: fromUnits(total, 2), paid: fromUnits(paid, 2), due: fromUnits(total - paid, 2),
    balance: fromUnits(principal, 2), days: periods.reduce((s, p) => s + p.days, 0), issues};
}

/** One amount from `from` to `to` (both inclusive when includeLastDay; the start day always counts). */
export function simpleInterest({amount, from, to, rate, basis = 'act365', includeLastDay = false}) {
  if (toDay(to) < toDay(from)) throw new AppError(400, 'dates', 'Pabaigos data ankstesnė už pradžios datą.');
  return calcInterest({events: [{date: from, kind: 'disbursement', amount}], rate, basis, asOf: to, includeLastDay});
}
