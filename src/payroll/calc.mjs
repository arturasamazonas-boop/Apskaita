// Payroll arithmetic (Lithuania). Exact decimals, ROUND_HALF_UP to cents on every tax line.
// Parameters come from the payroll_params table (effective-dated); see docs/PAYROLL.md.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';

/** amount × rate% rounded to cents. */
export function pct(amount, rate) { return fromUnits(divRound(toUnits(amount, 2) * toUnits(rate, 2), 10000n), 2); }
/** a × b / c rounded to cents (a in cents-precision money, b and c plain decimals up to 4 places). */
export function mulDiv(a, b, c) { return fromUnits(divRound(toUnits(a, 2) * toUnits(b, 4), toUnits(c, 4)), 2); }

/** Monthly NPD: npd_max when DU ≤ MMA, otherwise npd_max − coef × (DU − MMA), never below 0 or above DU. */
export function npdFor(gross, p, {apply = true, fixed = null} = {}) {
  if (!apply || money.cmp(gross, '0') <= 0) return '0.00';
  if (fixed !== null && fixed !== undefined && fixed !== '') return money.min(money.norm(fixed), gross);
  let npd = money.norm(p.npd_max);
  if (money.cmp(gross, p.mma) > 0) npd = money.sub(npd, fromUnits(divRound(toUnits(money.sub(gross, p.mma), 2) * toUnits(p.npd_coef, 4), 10000n), 2));
  return money.min(money.max(npd, '0'), gross);
}

/** Base pay for the month: monthly salary pro rata worked days, or hourly rate × hours. */
export function basePay(emp, {workedDays, normDays, workedHours}) {
  if (emp.pay_type === 'hourly') return mulDiv(String(emp.hourly_rate), String(workedHours || 0), '1');
  if (!Number(normDays)) return '0.00';
  if (Number(workedDays) >= Number(normDays)) return money.norm(emp.base_salary);
  return mulDiv(emp.base_salary, String(workedDays || 0), String(normDays));
}

/** One employee's payroll line. Inputs are decimal strings; returns all amounts as strings with 2 decimals. */
export function calcLine(emp, p, inp) {
  const base = inp.base !== undefined && inp.base !== null && inp.base !== '' ? money.norm(inp.base) : basePay(emp, inp);
  const extra = ['bonus', 'vacation_pay', 'sick_pay', 'other_pay'].map((k) => money.norm(inp[k] || '0'));
  const gross = money.sum([base, ...extra]);
  const npd = npdFor(gross, p, {apply: emp.apply_npd, fixed: emp.npd_fixed});
  const gpm = money.max(pct(money.sub(gross, npd), p.gpm_rate), '0');
  const vsd = pct(gross, p.vsd_rate), psd = pct(gross, p.psd_rate);
  const pension = emp.pension_extra ? pct(gross, p.pension_extra_rate) : '0.00';
  const net = money.sub(gross, money.sum([gpm, vsd, psd, pension]));
  const advance = money.norm(inp.advance || '0');
  const employer = pct(gross, emp.contract_type === 'fixed_term' ? p.employer_rate_fixed : p.employer_rate);
  return {base, bonus: extra[0], vacation_pay: extra[1], sick_pay: extra[2], other_pay: extra[3], gross, npd, gpm, vsd, psd, pension, net, advance, to_pay: money.sub(net, advance), employer_sodra: employer};
}

// ---------------------------------------------------------------- working-day calendar (Lithuania)
function easter(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
const iso = (d) => d.toISOString().slice(0, 10);
/** Public holidays (Darbo kodekso 123 str.). Sunday-only holidays do not change the Mon–Fri norm. */
export function holidays(y) {
  const e = easter(y), mon = new Date(e); mon.setUTCDate(e.getUTCDate() + 1);
  return new Set([`${y}-01-01`, `${y}-02-16`, `${y}-03-11`, iso(e), iso(mon), `${y}-05-01`, `${y}-06-24`, `${y}-07-06`, `${y}-08-15`, `${y}-11-01`, `${y}-11-02`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`]);
}
/** Working dates (Mon–Fri, excluding public holidays) of a YYYY-MM period. */
export function workingDates(period) {
  const [y, m] = period.split('-').map(Number);
  const hol = holidays(y), out = [];
  for (let d = new Date(Date.UTC(y, m - 1, 1)); d.getUTCMonth() === m - 1; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6 !== 0 && !hol.has(iso(d))) out.push(iso(d));
  }
  return out;
}
export const workingDays = (period) => workingDates(period).length;
