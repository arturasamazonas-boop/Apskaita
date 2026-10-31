// Atlyginimai: employees, payroll parameters, monthly payroll sheets (draft → approved → posted).
import {AppError, tx} from '../db.mjs';
import {averagePay} from '../payroll/vdu.mjs';
import {renderContractPdf, contractDefaults} from '../payroll/contract.mjs';
import {SECURITY_HEADERS} from '../http.mjs';
import {workingDayOnOrBefore} from '../tax/calendar.mjs';
import {requireCap, can} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {money} from '../lib/money.mjs';
import {postEntry, reverseEntry, roleAccounts} from '../ledger/ledger.mjs';
import {calcLine, workingDays, workingDates} from '../payroll/calc.mjs';
import {normalizeIban} from '../extraction/ids.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().replace(',', '.').replace(/\s/g, ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v; // a real calendar date
const isNum = (v) => /^-?\d+(\.\d+)?$/.test(String(v));
const periodEnd = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const AMOUNTS = ['base', 'bonus', 'vacation_pay', 'sick_pay', 'other_pay', 'gross', 'npd', 'gpm', 'vsd', 'psd', 'pension', 'net', 'advance', 'to_pay', 'employer_sodra'];

// Personal codes are visible to people who can write accounting data; read-only users see a masked value.
const maskEmp = (e, user) => (can(user, 'write') ? e : {...e, personal_code: e.personal_code ? `${e.personal_code.slice(0, 1)}**********` : ''});

export async function paramsFor(db, date) {
  const p = (await db.query('SELECT * FROM payroll_params WHERE effective_from <= $1 ORDER BY effective_from DESC LIMIT 1', [date])).rows[0];
  if (!p) throw new AppError(422, 'no_params', `Nėra atlyginimų parametrų datai ${date} (Atlyginimai → Tarifai ir parametrai).`);
  return p;
}

const EMP_FIELDS = {
  first_name: (v) => s(v, 80), last_name: (v) => s(v, 80), personal_code: (v) => s(v, 11).replace(/\s/g, ''), sodra_no: (v) => s(v, 20), position: (v) => s(v, 120), department: (v) => s(v, 80),
  employment_start: (v) => v, employment_end: (v) => v || null, contract_type: (v) => (v === 'fixed_term' ? 'fixed_term' : 'indefinite'), pay_type: (v) => (v === 'hourly' ? 'hourly' : 'monthly'),
  base_salary: num, hourly_rate: num, hours_per_week: (v) => num(v) || '40', apply_npd: (v) => v !== false && v !== 'false', npd_fixed: num, pension_extra: (v) => v === true || v === 'true',
  expense_account: (v) => s(v, 8) || '6304', iban: (v) => normalizeIban(s(v, 40)), email: (v) => s(v, 200), address: (v) => s(v, 300), notes: (v) => s(v, 2000), active: (v) => v !== false && v !== 'false',
};

async function saveEmployee(pool, user, id, b) {
  const v = Object.fromEntries(Object.entries(EMP_FIELDS).filter(([k]) => k in b || !id).map(([k, f]) => [k, f(b[k])]));
  if ('first_name' in v && (!v.first_name || !v.last_name)) throw new AppError(400, 'name', 'Nurodykite vardą ir pavardę.');
  if ('employment_start' in v && !isDate(v.employment_start)) throw new AppError(400, 'start', 'Nurodykite darbo pradžios datą.');
  if (v.employment_end && !isDate(v.employment_end)) throw new AppError(400, 'end', 'Netinkama darbo pabaigos data.');
  if (v.employment_end || v.employment_start) {
    const cur = id ? (await pool.query('SELECT employment_start, employment_end FROM employees WHERE id=$1', [id])).rows[0] || {} : {};
    const st = v.employment_start || String(cur.employment_start || '').slice(0, 10), en = 'employment_end' in v ? v.employment_end : (cur.employment_end ? String(cur.employment_end).slice(0, 10) : null);
    if (st && en && en < st) throw new AppError(400, 'end', 'Darbo pabaiga negali būti ankstesnė už darbo pradžią.');
  }
  if (v.personal_code && !/^[3-6]\d{10}$/.test(v.personal_code)) throw new AppError(400, 'personal_code', 'Asmens kodas – 11 skaitmenų.');
  for (const k of ['base_salary', 'hourly_rate', 'hours_per_week', 'npd_fixed']) if (v[k] !== null && v[k] !== undefined && !isNum(v[k])) throw new AppError(400, k, 'Netinkamas skaičius.');
  if (v.hours_per_week !== undefined && !(Number(v.hours_per_week) > 0 && Number(v.hours_per_week) <= 48)) throw new AppError(400, 'hours_per_week', 'Darbo valandų per savaitę – daugiau nei 0 ir ne daugiau kaip 48 (DK 114 str.).');
  const payType = v.pay_type || (id && (await pool.query('SELECT pay_type FROM employees WHERE id=$1', [id])).rows[0]?.pay_type);
  if (!id && payType === 'monthly' && !v.base_salary) throw new AppError(400, 'base_salary', 'Nurodykite mėnesinį atlyginimą (bruto).');
  if (!id && payType === 'hourly' && !v.hourly_rate) throw new AppError(400, 'hourly_rate', 'Nurodykite valandinį įkainį.');
  if (v.expense_account && !(await pool.query('SELECT 1 FROM accounts WHERE code=$1 AND active AND postable AND type=$2', [v.expense_account, 'expense'])).rowCount) throw new AppError(400, 'expense_account', 'Sąnaudų sąskaita nerasta.');
  const keys = Object.keys(v);
  const row = id
    ? (await pool.query(`UPDATE employees SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => v[k])])).rows[0]
    : (await pool.query(`INSERT INTO employees(${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, keys.map((k) => v[k]))).rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Darbuotojas nerastas.');
  await audit(pool, {userId: user.id, action: id ? 'employee.update' : 'employee.create', entityType: 'employee', entityId: row.id, details: {fields: keys.filter((k) => k !== 'personal_code')}});
  return row;
}

async function loadRun(db, id, lock = false) {
  const run = (await db.query(`SELECT * FROM payroll_runs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!run) throw new AppError(404, 'not_found', 'Žiniaraštis nerastas.');
  run.lines = (await db.query(`SELECT l.*, e.first_name, e.last_name, e.position, e.personal_code, e.pay_type, e.base_salary, e.hourly_rate, e.contract_type, e.pension_extra, e.apply_npd, e.npd_fixed, e.iban, e.expense_account, e.employment_end, e.employment_start
    FROM payroll_lines l JOIN employees e ON e.id=l.employee_id WHERE l.run_id=$1 ORDER BY e.last_name, e.first_name`, [id])).rows;
  // People on the sheet who were not employed in this month at all (dates changed on the card after it was made).
  const pStart = `${run.period}-01`, pEnd = periodEnd(run.period);
  run.warnings = run.lines.filter((l) => (l.employment_end && String(l.employment_end).slice(0, 10) < pStart) || String(l.employment_start).slice(0, 10) > pEnd)
    .map((l) => `${l.first_name} ${l.last_name}: pagal kortelę ${String(l.employment_start).slice(0, 10) > pEnd ? `pradeda dirbti ${String(l.employment_start).slice(0, 10)}` : `nebedirba nuo ${String(l.employment_end).slice(0, 10)}`} – patikrinkite, ar jis turi būti šiame žiniaraštyje.`);
  run.totals = Object.fromEntries(AMOUNTS.map((k) => [k, money.sum(run.lines.map((l) => l[k]))]));
  run.totals.sodra_total = money.sum([run.totals.vsd, run.totals.psd, run.totals.pension, run.totals.employer_sodra]);
  run.totals.cost = money.add(run.totals.gross, run.totals.employer_sodra);
  return run;
}

async function recalcLine(db, run, line, emp, inp, params) {
  // Gross earlier in the same year (for the 60 VDU threshold and the VSD ceiling).
  const ytd = (await db.query(`SELECT coalesce(sum(l.gross),0) AS g FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id
    WHERE l.employee_id=$1 AND r.period >= $2 AND r.period < $3`, [emp.id, `${run.period.slice(0, 4)}-01`, run.period])).rows[0].g;
  const c = calcLine(emp, params, {workedDays: inp.worked_days, normDays: run.norm_days, workedHours: inp.worked_hours, base: inp.base_manual ? inp.base : null,
    bonus: inp.bonus, vacation_pay: inp.vacation_pay, sick_pay: inp.sick_pay, other_pay: inp.other_pay, advance: inp.advance}, {ytdGross: ytd});
  await db.query(`UPDATE payroll_lines SET worked_days=$2, worked_hours=$3, ${AMOUNTS.map((k, i) => `${k}=$${i + 4}`).join(', ')}, note=$${AMOUNTS.length + 4} WHERE id=$1`,
    [line.id, inp.worked_days || 0, inp.worked_hours || 0, ...AMOUNTS.map((k) => c[k]), s(inp.note, 300)]);
}

/** Default pay day of a month's payroll: the 10th of the next month; on a day off, the working day before (never late, DK 147). */
function defaultPayDate(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return workingDayOnOrBefore(`${next}-10`);
}

export function register(r, {pool}) {
  r.get('/api/payroll/vdu', async ({user, query}) => {
    requireCap(user, 'read');
    if (!/^\d{4}-\d{2}$/.test(String(query.period || '')) || !query.employee) throw new AppError(400, 'bad_request', 'Nurodykite darbuotoją ir mėnesį.');
    if (query.days && !(Number(query.days) > 0 && Number(query.days) <= 60)) throw new AppError(400, 'days', 'Atostogų dienų skaičius – nuo 1 iki 60.');
    const r2 = await averagePay(pool, {employeeId: query.employee, period: query.period, days: query.days || null});
    if (!r2) throw new AppError(404, 'not_found', 'Darbuotojas nerastas.');
    return r2;
  });
  // ---------------------------------------------------------------- employees
  r.get('/api/employees', async ({user, query}) => {
    requireCap(user, 'read');
    const rows = (await pool.query(`SELECT * FROM employees WHERE ($1 <> 'true' OR active) ORDER BY active DESC, last_name, first_name`, [query.active || ''])).rows;
    return rows.map((e) => maskEmp(e, user));
  });
  // Employment contract: terms not on the card are proposed here and can be changed in the print dialog.
  r.get('/api/employees/:id/contract', async ({user, params}) => {
    requireCap(user, 'write');
    const e = (await pool.query('SELECT * FROM employees WHERE id=$1', [params.id])).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Darbuotojas nerastas.');
    return contractDefaults(e, (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0]);
  });
  r.post('/api/employees/:id/contract', async ({req, user, params, res}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const e = (await pool.query('SELECT * FROM employees WHERE id=$1', [params.id])).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Darbuotojas nerastas.');
    const keys = ['number', 'date', 'place', 'workplace', 'duties', 'probationMonths', 'workTime', 'payDays', 'leaveDays', 'employerRep', 'employerRepTitle'];
    const opts = Object.fromEntries(keys.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, String(b[k]).slice(0, 1500)]));
    if (opts.probationMonths && !/^[0-3]$/.test(opts.probationMonths)) throw new AppError(400, 'probation', 'Išbandymas – nuo 0 iki 3 mėnesių.');
    const start = String(e.employment_start).slice(0, 10), endD = e.employment_end ? String(e.employment_end).slice(0, 10) : null;
    if (e.contract_type === 'fixed_term' && !endD) throw new AppError(422, 'term', 'Terminuotai darbo sutarčiai kortelėje nurodykite darbo pabaigos datą („Dirba iki“, DK 67 str.).');
    // DK 36 str.: for a fixed-term contract shorter than 6 months, probation is at most half of the term.
    if (e.contract_type === 'fixed_term' && endD && Number(opts.probationMonths) > 0) {
      const termDays = (Date.parse(endD) - Date.parse(start)) / 86400000 + 1;
      const plus = (n) => { const p = new Date(`${start}T00:00:00Z`); p.setUTCMonth(p.getUTCMonth() + n); return p.toISOString().slice(0, 10); };
      const probDays = (Date.parse(plus(Number(opts.probationMonths))) - Date.parse(start)) / 86400000;
      const sixMonthsLast = new Date(Date.parse(`${plus(6)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10); // last day of a 6-month term
      if (endD < sixMonthsLast && probDays > termDays / 2) throw new AppError(400, 'probation', `Terminuotai sutarčiai, trumpesnei nei 6 mėn. (${Math.round(termDays)} d.), išbandymas negali būti ilgesnis nei pusė termino (DK 36 str.).`);
    }
    if (opts.date && !isDate(opts.date)) throw new AppError(400, 'date', 'Netinkama sutarties data.');
    const pdf = await renderContractPdf(e, (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0], opts);
    await audit(pool, {userId: user.id, action: 'employee.contract_printed', entityType: 'employee', entityId: e.id, details: {number: opts.number || ''}});
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="darbo-sutartis-${e.id}.pdf"`, 'Cache-Control': 'no-store'});
    res.end(pdf);
  });
  r.get('/api/employees/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const e = (await pool.query('SELECT * FROM employees WHERE id=$1', [params.id])).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Darbuotojas nerastas.');
    const history = (await pool.query(`SELECT r.id AS run_id, r.period, r.status, l.gross, l.net, l.gpm, l.vsd + l.psd + l.pension AS sodra, l.to_pay FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE l.employee_id=$1 ORDER BY r.period DESC LIMIT 24`, [params.id])).rows;
    return {...maskEmp(e, user), history};
  });
  r.post('/api/employees', async ({req, user}) => { requireCap(user, 'write'); return saveEmployee(pool, user, null, await readJson(req)); });
  r.put('/api/employees/:id', async ({req, user, params}) => { requireCap(user, 'write'); return saveEmployee(pool, user, params.id, await readJson(req)); });

  // ---------------------------------------------------------------- parameters
  r.get('/api/payroll/params', async ({user}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM payroll_params ORDER BY effective_from DESC')).rows; });
  r.post('/api/payroll/params', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    if (!isDate(b.effective_from)) throw new AppError(400, 'date', 'Nurodykite galiojimo pradžią.');
    const keys = ['mma', 'vdu', 'npd_max', 'npd_coef', 'gpm_rate', 'gpm_rate_high', 'vsd_rate', 'psd_rate', 'pension_extra_rate', 'employer_rate', 'employer_rate_fixed'];
    const vals = keys.map((k) => num(b[k]) ?? (k === 'gpm_rate_high' ? '32' : null));
    keys.forEach((k, i) => { if ((vals[i] === null && k !== 'vdu') || (vals[i] !== null && !isNum(vals[i]))) throw new AppError(400, k, `Netinkama reikšmė: ${k}.`); });
    const row = (await pool.query(`INSERT INTO payroll_params(effective_from, ${keys.join(', ')}, note) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, $${keys.length + 2})
      ON CONFLICT (effective_from) DO UPDATE SET ${keys.map((k) => `${k}=EXCLUDED.${k}`).join(', ')}, note=EXCLUDED.note RETURNING *`, [b.effective_from, ...vals, s(b.note, 500)])).rows[0];
    await audit(pool, {userId: user.id, action: 'payroll.params', entityType: 'payroll_params', entityId: b.effective_from, details: row});
    return row;
  });
  r.get('/api/payroll/working-days', async ({user, query}) => {
    requireCap(user, 'read');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s(query.period, 7))) throw new AppError(400, 'period', 'Netinkamas laikotarpis.');
    return {period: query.period, days: workingDays(query.period), payment_date: defaultPayDate(query.period)};
  });

  // ---------------------------------------------------------------- payroll runs
  r.get('/api/payroll/runs', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT r.*, count(l.id)::int AS employees, coalesce(sum(l.gross),0) AS gross, coalesce(sum(l.net),0) AS net, coalesce(sum(l.gpm),0) AS gpm,
        coalesce(sum(l.vsd + l.psd + l.pension + l.employer_sodra),0) AS sodra, coalesce(sum(l.to_pay),0) AS to_pay
      FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id=r.id GROUP BY r.id ORDER BY r.period DESC`)).rows;
  });
  r.get('/api/payroll/runs/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const run = await loadRun(pool, params.id);
    run.lines = run.lines.map((l) => maskEmp(l, user));
    run.params = await paramsFor(pool, periodEnd(run.period));
    return run;
  });
  r.post('/api/payroll/runs', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    const period = s(b.period, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError(400, 'period', 'Nurodykite mėnesį (MMMM-MM).');
    const end = periodEnd(period), start = `${period}-01`;
    const params = await paramsFor(pool, end);
    const norm = b.norm_days !== undefined && b.norm_days !== '' ? Number(b.norm_days) : workingDays(period);
    return tx(pool, async (db) => {
      if ((await db.query('SELECT 1 FROM payroll_runs WHERE period=$1', [period])).rowCount) throw new AppError(409, 'exists', `Žiniaraštis už ${period} jau yra.`);
      const run = (await db.query(`INSERT INTO payroll_runs(period, payment_date, norm_days, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [period, isDate(b.payment_date) ? b.payment_date : defaultPayDate(period), norm, s(b.note, 300), user.id])).rows[0];
      // Everyone employed during the month; someone who left this month or later is included even if already marked inactive.
      const emps = (await db.query(`SELECT * FROM employees WHERE (active OR employment_end >= $1) AND employment_start <= $2 AND (employment_end IS NULL OR employment_end >= $1) ORDER BY last_name`, [start, end])).rows;
      for (const e of emps) {
        // Worked days default to the norm, reduced pro rata for a start or end inside the month.
        let days = norm;
        if (e.employment_start > start || (e.employment_end && e.employment_end < end)) {
          const from = e.employment_start > start ? e.employment_start : start, to = e.employment_end && e.employment_end < end ? e.employment_end : end;
          days = workingDates(period).filter((d) => d >= from && d <= to).length;
        }
        const hours = e.pay_type === 'hourly' ? String(Math.round(days * Number(e.hours_per_week) / 5 * 100) / 100) : '0';
        // Leaving this month: the final settlement is paid on the last working day (DK 146 str.), not with the payroll.
        const leaves = e.employment_end && e.employment_end >= start && e.employment_end <= end;
        const line = (await db.query('INSERT INTO payroll_lines(run_id, employee_id, payment_date) VALUES ($1,$2,$3) RETURNING *', [run.id, e.id, leaves ? e.employment_end : null])).rows[0];
        await recalcLine(db, run, line, e, {worked_days: String(days), worked_hours: hours}, params);
      }
      await audit(db, {userId: user.id, action: 'payroll.create', entityType: 'payroll_run', entityId: run.id, details: {period, employees: emps.length, normDays: norm}});
      return loadRun(db, run.id);
    });
  });
  r.put('/api/payroll/runs/:id', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      const run = await loadRun(db, params.id, true);
      if (run.status !== 'draft') throw new AppError(409, 'approved', 'Patvirtinto žiniaraščio keisti negalima – pirmiausia atšaukite patvirtinimą.');
      if (b.norm_days !== undefined) { const n = Number(b.norm_days); if (!Number.isInteger(n) || n < 0 || n > 31) throw new AppError(400, 'norm', 'Netinkama darbo dienų norma.'); run.norm_days = n; }
      if (b.payment_date !== undefined && b.payment_date !== '' && !isDate(b.payment_date)) throw new AppError(400, 'payment_date', 'Netinkama išmokėjimo data.');
      await db.query('UPDATE payroll_runs SET norm_days=$2, payment_date=$3, note=$4 WHERE id=$1', [run.id, run.norm_days, isDate(b.payment_date) ? b.payment_date : run.payment_date, b.note !== undefined ? s(b.note, 300) : run.note]);
      const params2 = await paramsFor(db, periodEnd(run.period));
      const byEmp = new Map((b.lines || []).map((l) => [String(l.employee_id), l]));
      if (b.add_employee_id && !run.lines.some((l) => String(l.employee_id) === String(b.add_employee_id))) {
        const line = (await db.query('INSERT INTO payroll_lines(run_id, employee_id) VALUES ($1,$2) RETURNING *', [run.id, b.add_employee_id])).rows[0];
        run.lines.push({...line, worked_days: String(run.norm_days)});
      }
      if (b.remove_employee_id) await db.query('DELETE FROM payroll_lines WHERE run_id=$1 AND employee_id=$2', [run.id, b.remove_employee_id]);
      for (const l of run.lines) {
        if (String(l.employee_id) === String(b.remove_employee_id)) continue;
        const e = (await db.query('SELECT * FROM employees WHERE id=$1', [l.employee_id])).rows[0];
        const inp = {worked_days: l.worked_days, worked_hours: l.worked_hours, bonus: l.bonus, vacation_pay: l.vacation_pay, sick_pay: l.sick_pay, other_pay: l.other_pay, advance: l.advance, note: l.note, ...(byEmp.get(String(l.employee_id)) || {})};
        for (const k of ['worked_days', 'worked_hours', 'bonus', 'vacation_pay', 'sick_pay', 'other_pay', 'advance', 'base']) {
          if (inp[k] === undefined || inp[k] === null || inp[k] === '') { if (k !== 'base') inp[k] = '0'; continue; }
          inp[k] = num(inp[k]);
          if (!isNum(inp[k]) || Number(inp[k]) < 0) throw new AppError(400, k, `${e.first_name} ${e.last_name}: netinkama reikšmė (${k}).`);
        }
        inp.base_manual = inp.base !== undefined && inp.base !== null && inp.base !== '';
        const own = byEmp.get(String(l.employee_id))?.payment_date;
        const pEnd = periodEnd(run.period), pStart = `${run.period}-01`;
        const leaves = e.employment_end && e.employment_end >= pStart && e.employment_end <= pEnd;
        const cur = l.payment_date ? String(l.payment_date).slice(0, 10) : null;
        // Worked days for the part of the month the person was employed (to = null: until the month end).
        const daysUpTo = (to) => { const from = e.employment_start > pStart ? e.employment_start : pStart; return workingDates(run.period).filter((d) => d >= from && (!to || d <= to)).length; };
        const setDays = (n) => { inp.worked_days = String(n); if (e.pay_type === 'hourly') inp.worked_hours = String(Math.round(n * Number(e.hours_per_week) / 5 * 100) / 100); };
        if (own !== undefined && own !== '' && own !== cur) {
          if (!isDate(own)) throw new AppError(400, 'payment_date', `${e.first_name} ${e.last_name}: netinkama išmokėjimo data.`);
          // Chosen by the user: kept as chosen (also when it equals the sheet's date) and no longer follows the end date.
          await db.query('UPDATE payroll_lines SET payment_date=$2, payment_date_manual=true WHERE id=$1', [l.id, own]);
        } else if (!l.payment_date_manual) {
          // Set by the program: follows the end date. Leaving this month – paid on the leaving day; the end date moved
          // or removed – the date and the pro-rated worked days follow (days changed by hand are kept).
          const want = leaves ? String(e.employment_end).slice(0, 10) : null;
          if (want !== cur) {
            await db.query('UPDATE payroll_lines SET payment_date=$2 WHERE id=$1', [l.id, want]);
            const autoDays = [Number(run.norm_days), daysUpTo(null), ...(cur ? [daysUpTo(cur)] : [])];
            if (autoDays.includes(Number(inp.worked_days))) setDays(want ? daysUpTo(want) : e.employment_start > pStart ? daysUpTo(null) : Number(run.norm_days));
          }
        }
        await recalcLine(db, run, l, e, inp, params2);
      }
      await audit(db, {userId: user.id, action: 'payroll.update', entityType: 'payroll_run', entityId: run.id});
      return loadRun(db, run.id);
    });
  });
  r.post('/api/payroll/runs/:id/approve', async ({user, params}) => {
    requireCap(user, 'approve');
    return tx(pool, async (db) => {
      const run = await loadRun(db, params.id, true);
      if (run.status === 'approved') return run;
      if (!run.lines.length) throw new AppError(422, 'empty', 'Žiniaraštyje nėra darbuotojų.');
      const roles = await roleAccounts(db);
      for (const k of ['payroll_payable', 'payroll_gpm', 'payroll_sodra']) if (!roles[k]) throw new AppError(422, 'mapping_missing', `Nenustatyta sąskaita „${k}“ (Servisas → Kontavimo susiejimai).`);
      const lines = [];
      const byAccount = new Map();
      for (const l of run.lines) byAccount.set(l.expense_account, money.add(byAccount.get(l.expense_account) || '0', l.gross, l.employer_sodra));
      for (const [acc, amt] of byAccount) lines.push({account: acc, debit: amt, description: `DU ir darbdavio Sodra ${run.period}`});
      lines.push({account: roles.payroll_payable, credit: run.totals.net, description: 'Mokėtinas darbo užmokestis'});
      lines.push({account: roles.payroll_gpm, credit: run.totals.gpm, description: 'Išskaičiuotas GPM'});
      lines.push({account: roles.payroll_sodra, credit: run.totals.sodra_total, description: 'VSD, PSD, papildomas kaupimas ir darbdavio Sodra'});
      const no = run.approval_no + 1;
      const e = await postEntry(db, {date: periodEnd(run.period), description: `Darbo užmokestis ${run.period}`, sourceType: 'payroll', sourceId: run.id, idempotencyKey: `payroll:${run.id}:${no}`, userId: user.id, lines});
      await db.query(`UPDATE payroll_runs SET status='approved', approval_no=$2, journal_entry_id=$3, approved_by=$4, approved_at=now() WHERE id=$1`, [run.id, no, e.id, user.id]);
      await audit(db, {userId: user.id, action: 'payroll.approve', entityType: 'payroll_run', entityId: run.id, details: {entryId: e.id, gross: run.totals.gross, net: run.totals.net}});
      return loadRun(db, run.id);
    });
  });
  r.post('/api/payroll/runs/:id/cancel', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (s(b.reason).length < 5) throw new AppError(400, 'reason', 'Nurodykite atšaukimo priežastį.');
    return tx(pool, async (db) => {
      const run = await loadRun(db, params.id, true);
      if (run.status !== 'approved') throw new AppError(409, 'draft', 'Žiniaraštis nepatvirtintas.');
      const rev = await reverseEntry(db, {entryId: run.journal_entry_id, date: periodEnd(run.period), reason: `DU ${run.period}: ${s(b.reason, 200)}`, userId: user.id});
      await db.query(`UPDATE payroll_runs SET status='draft', journal_entry_id=NULL WHERE id=$1`, [run.id]);
      await audit(db, {userId: user.id, action: 'payroll.cancel', entityType: 'payroll_run', entityId: run.id, details: {reversalEntryId: rev.id, reason: s(b.reason, 200)}});
      return loadRun(db, run.id);
    });
  });
  r.delete('/api/payroll/runs/:id', async ({user, params}) => {
    requireCap(user, 'write');
    return tx(pool, async (db) => {
      const run = await loadRun(db, params.id, true);
      if (run.status !== 'draft' || run.approval_no > 0) throw new AppError(409, 'approved', 'Bent kartą patvirtinto žiniaraščio ištrinti negalima.');
      await db.query('DELETE FROM payroll_runs WHERE id=$1', [run.id]);
      await audit(db, {userId: user.id, action: 'payroll.delete', entityType: 'payroll_run', entityId: run.id, details: {period: run.period}});
      return {ok: true};
    });
  });
}

