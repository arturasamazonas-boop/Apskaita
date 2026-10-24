// Vidutinis darbo užmokestis (VDU) for vacation pay, following the Darbo užmokesčio apskaičiavimo tvarkos aprašas
// (Vyriausybės nutarimas Nr. 496): earnings of the last 3 calendar months before the month of the vacation divided by
// the days actually worked in them. Vacation pay and sick pay paid earlier are not earnings for this purpose.
// Simplifications (shown to the user): annual/quarterly bonuses are taken in the month they were paid, and an
// employee without worked months uses the monthly salary divided by the month's working days.
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {workingDays} from './calc.mjs';

const prev = (p) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

export async function averagePay(db, {employeeId, period, days = null}) {
  const emp = (await db.query('SELECT id, first_name, last_name, pay_type, base_salary, hourly_rate FROM employees WHERE id=$1', [employeeId])).rows[0];
  if (!emp) return null;
  const periods = [prev(period), prev(prev(period)), prev(prev(prev(period)))];
  const rows = (await db.query(`SELECT r.period, sum(l.base + l.bonus + l.other_pay) AS earnings, sum(l.worked_days) AS days
    FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
    WHERE l.employee_id=$1 AND r.status='approved' AND r.period = ANY($2) GROUP BY r.period ORDER BY r.period`, [employeeId, periods])).rows;
  const earnings = money.sum(rows.map((r) => r.earnings)), worked = rows.reduce((s, r) => s + Number(r.days), 0);
  let daily, source;
  if (worked > 0) {
    daily = fromUnits(divRound(toUnits(earnings, 2) * 100n, BigInt(Math.round(worked * 100))), 2);
    source = 'history';
  } else {
    const norm = workingDays(period);
    const monthly = emp.pay_type === 'hourly' ? money.norm(Number(emp.hourly_rate || 0) * 8 * norm) : money.norm(emp.base_salary || 0);
    daily = fromUnits(divRound(toUnits(monthly, 2), BigInt(norm || 1)), 2);
    source = 'salary';
  }
  const n = days === null || days === '' ? null : Number(days);
  const amount = n && n > 0 ? fromUnits(divRound(toUnits(daily, 2) * BigInt(Math.round(n * 100)), 100n), 2) : null;
  return {employeeId: String(emp.id), name: `${emp.first_name} ${emp.last_name}`, period, months: rows.map((r) => ({period: r.period, earnings: money.norm(r.earnings), days: Number(r.days)})),
    earnings: money.norm(earnings), workedDays: worked, daily, days: n, amount, source,
    explanation: source === 'history'
      ? `${periods.slice().reverse().join(', ')}: uždarbis ${earnings} € (be atostoginių ir ligos išmokų) / ${worked} dirbtų d. = ${daily} € per dieną.`
      : `Ankstesnių 3 mėnesių su dirbtomis dienomis nėra – imamas mėnesinis atlyginimas / ${workingDays(period)} darbo d. (${period}) = ${daily} € per dieną.`};
}
