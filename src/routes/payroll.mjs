// Atlyginimai: employees, payroll parameters, monthly payroll sheets (draft → approved → posted).
import {AppError, tx} from '../db.mjs';
import {requireCap, can} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {money} from '../lib/money.mjs';
import {postEntry, reverseEntry, roleAccounts} from '../ledger/ledger.mjs';
import {calcLine, workingDays, workingDates} from '../payroll/calc.mjs';
import {normalizeIban} from '../extraction/ids.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().replace(',', '.').replace(/\s/g, ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
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
  if (v.personal_code && !/^[3-6]\d{10}$/.test(v.personal_code)) throw new AppError(400, 'personal_code', 'Asmens kodas – 11 skaitmenų.');
  for (const k of ['base_salary', 'hourly_rate', 'hours_per_week', 'npd_fixed']) if (v[k] !== null && v[k] !== undefined && !isNum(v[k])) throw new AppError(400, k, 'Netinkamas skaičius.');
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
  run.lines = (await db.query(`SELECT l.*, e.first_name, e.last_name, e.position, e.personal_code, e.pay_type, e.base_salary, e.hourly_rate, e.contract_type, e.pension_extra, e.apply_npd, e.npd_fixed, e.iban, e.expense_account
    FROM payroll_lines l JOIN employees e ON e.id=l.employee_id WHERE l.run_id=$1 ORDER BY e.last_name, e.first_name`, [id])).rows;
  run.totals = Object.fromEntries(AMOUNTS.map((k) => [k, money.sum(run.lines.map((l) => l[k]))]));
  run.totals.sodra_total = money.sum([run.totals.vsd, run.totals.psd, run.totals.pension, run.totals.employer_sodra]);
  run.totals.cost = money.add(run.totals.gross, run.totals.employer_sodra);
  return run;
}

async function recalcLine(db, run, line, emp, inp, params) {
  const c = calcLine(emp, params, {workedDays: inp.worked_days, normDays: run.norm_days, workedHours: inp.worked_hours, base: inp.base_manual ? inp.base : null,
    bonus: inp.bonus, vacation_pay: inp.vacation_pay, sick_pay: inp.sick_pay, other_pay: inp.other_pay, advance: inp.advance});
  await db.query(`UPDATE payroll_lines SET worked_days=$2, worked_hours=$3, ${AMOUNTS.map((k, i) => `${k}=$${i + 4}`).join(', ')}, note=$${AMOUNTS.length + 4} WHERE id=$1`,
    [line.id, inp.worked_days || 0, inp.worked_hours || 0, ...AMOUNTS.map((k) => c[k]), s(inp.note, 300)]);
}

export function register(r, {pool}) {
  // ---------------------------------------------------------------- employees
  r.get('/api/employees', async ({user, query}) => {
    requireCap(user, 'read');
    const rows = (await pool.query(`SELECT * FROM employees WHERE ($1 <> 'true' OR active) ORDER BY active DESC, last_name, first_name`, [query.active || ''])).rows;
    return rows.map((e) => maskEmp(e, user));
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
    const keys = ['mma', 'vdu', 'npd_max', 'npd_coef', 'gpm_rate', 'vsd_rate', 'psd_rate', 'pension_extra_rate', 'employer_rate', 'employer_rate_fixed'];
    const vals = keys.map((k) => num(b[k]));
    keys.forEach((k, i) => { if ((vals[i] === null && k !== 'vdu') || (vals[i] !== null && !isNum(vals[i]))) throw new AppError(400, k, `Netinkama reikšmė: ${k}.`); });
    const row = (await pool.query(`INSERT INTO payroll_params(effective_from, ${keys.join(', ')}, note) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, $${keys.length + 2})
      ON CONFLICT (effective_from) DO UPDATE SET ${keys.map((k) => `${k}=EXCLUDED.${k}`).join(', ')}, note=EXCLUDED.note RETURNING *`, [b.effective_from, ...vals, s(b.note, 500)])).rows[0];
    await audit(pool, {userId: user.id, action: 'payroll.params', entityType: 'payroll_params', entityId: b.effective_from, details: row});
    return row;
  });
  r.get('/api/payroll/working-days', async ({user, query}) => {
    requireCap(user, 'read');
    if (!/^\d{4}-\d{2}$/.test(s(query.period, 7))) throw new AppError(400, 'period', 'Netinkamas laikotarpis.');
    return {period: query.period, days: workingDays(query.period)};
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
        [period, isDate(b.payment_date) ? b.payment_date : end, norm, s(b.note, 300), user.id])).rows[0];
      const emps = (await db.query(`SELECT * FROM employees WHERE active AND employment_start <= $2 AND (employment_end IS NULL OR employment_end >= $1) ORDER BY last_name`, [start, end])).rows;
      for (const e of emps) {
        // Worked days default to the norm, reduced pro rata for a start or end inside the month.
        let days = norm;
        if (e.employment_start > start || (e.employment_end && e.employment_end < end)) {
          const from = e.employment_start > start ? e.employment_start : start, to = e.employment_end && e.employment_end < end ? e.employment_end : end;
          days = workingDates(period).filter((d) => d >= from && d <= to).length;
        }
        const hours = e.pay_type === 'hourly' ? String(Math.round(days * Number(e.hours_per_week) / 5 * 100) / 100) : '0';
        const line = (await db.query('INSERT INTO payroll_lines(run_id, employee_id) VALUES ($1,$2) RETURNING *', [run.id, e.id])).rows[0];
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

