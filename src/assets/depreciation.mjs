// Straight-line depreciation by months (tiesiogiai proporcingas metodas), as used for Lithuanian fixed assets:
// depreciation starts the month after the asset is put into use, the monthly amount is (cost − residual) / useful life in months,
// the last month takes the remainder so the total equals exactly cost − residual.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';

export const monthIndex = (p) => { const [y, m] = p.split('-').map(Number); return y * 12 + m - 1; };
export const monthOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (p, n) => monthOf(monthIndex(p) + n);
export const monthEnd = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** Default depreciation and expense accounts for a cost account (12x0 → 12x7 / 6306; 11x0 → 11x8 / 6307). */
export function defaultAccounts(costAccount) {
  const c = String(costAccount || '');
  if (/^11\d0$/.test(c)) return {depreciation: c.slice(0, 3) + '8', expense: '6307'};
  if (/^12\d0$/.test(c)) return {depreciation: c.slice(0, 3) + '7', expense: '6306'};
  return {depreciation: '', expense: '6306'};
}

export const depreciable = (a) => money.sub(a.cost, a.residual_value);
export const monthlyAmount = (a) => fromUnits(divRound(toUnits(depreciable(a), 2), BigInt(a.useful_life_months)), 2);
/** First month depreciated in this program (months up to opening_period are covered by opening_accumulated). */
export const firstMonth = (a) => (a.opening_period && monthIndex(a.opening_period) >= monthIndex(a.depreciation_start) ? addMonths(a.opening_period, 1) : a.depreciation_start);
const disposalMonth = (a) => (a.status === 'disposed' && a.disposed_on ? String(a.disposed_on).slice(0, 7) : null);

/** Charge for one month given the depreciation accumulated before it. */
export function chargeFor(a, period, accumulatedBefore) {
  const idx = monthIndex(period) - monthIndex(a.depreciation_start);
  if (idx < 0 || monthIndex(period) < monthIndex(firstMonth(a))) return '0.00';
  const dm = disposalMonth(a);
  if (dm && monthIndex(period) > monthIndex(dm)) return '0.00';
  const remaining = money.sub(depreciable(a), accumulatedBefore);
  if (money.cmp(remaining, '0') <= 0) return '0.00';
  if (idx >= a.useful_life_months - 1) return remaining; // last month of the useful life (or later, after a gap): the remainder
  return money.min(monthlyAmount(a), remaining);
}

/**
 * State of an asset at a period: accumulated depreciation from postings up to `period`, net book value,
 * and the months since its first program month that have no posting (they must be posted in order).
 * `posted` is a Map period → amount of posted (not cancelled) runs for this asset.
 */
export function assetState(a, posted, period) {
  let acc = money.norm(a.opening_accumulated || '0');
  for (const [p, amt] of posted) if (monthIndex(p) <= monthIndex(period)) acc = money.add(acc, amt);
  const missing = [];
  let sim = money.norm(a.opening_accumulated || '0');
  for (let i = monthIndex(firstMonth(a)); i < monthIndex(period); i++) {
    const p = monthOf(i);
    if (posted.has(p)) { sim = money.add(sim, posted.get(p)); continue; }
    if (!money.isZero(chargeFor(a, p, sim))) missing.push(p);
  }
  return {accumulated: acc, nbv: money.sub(a.cost, acc), missing};
}

/** Remaining schedule from `fromPeriod` on, assuming no gaps: [{period, amount, accumulated, nbv}]. */
export function forecast(a, posted, fromPeriod, limit = 600) {
  let acc = money.norm(a.opening_accumulated || '0');
  for (const amt of posted.values()) acc = money.add(acc, amt);
  const out = [];
  for (let i = Math.max(monthIndex(fromPeriod), monthIndex(firstMonth(a))); out.length < limit; i++) {
    const p = monthOf(i);
    if (posted.has(p)) continue;
    const c = chargeFor(a, p, acc);
    if (money.isZero(c)) break;
    acc = money.add(acc, c);
    out.push({period: p, amount: c, accumulated: acc, nbv: money.sub(a.cost, acc)});
  }
  return out;
}
