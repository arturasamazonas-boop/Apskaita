// Atlyginimai: monthly payroll sheets, employees, payroll parameters, payslips.
import {h, clear, get, post, put, del, pageHeader, section, table, money, eur, date, guard, select, input, field, can, modal, today, confirmDialog, promptDialog, badge} from '../core.mjs';

const STATUS = {draft: ['Juodraštis', 'warn'], approved: ['Patvirtinta ir kontuota', 'done']};
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Žiniaraščiai'], ['darbuotojai', 'Darbuotojai'], ['parametrai', 'Tarifai ir parametrai']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/atlyginimai${k ? '/' + k : ''}`}, t)));
const fullName = (e) => `${e.first_name} ${e.last_name}`;

export async function render(main, rest, state) {
  if (rest[0] === 'darbuotojai') return rest[1] ? employeeCard(main, rest[1] === 'naujas' ? null : rest[1], state) : employees(main, state);
  if (rest[0] === 'parametrai') return params(main, state);
  if (rest[0] === 'naujas') return newRun(main, state);
  if (rest[0]) return runSheet(main, rest[0], state);
  return runs(main, state);
}

async function runs(main, state) {
  const rows = await get('/api/payroll/runs');
  clear(main, pageHeader('Darbo užmokestis', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: '#/atlyginimai/naujas'}, '+ Naujas žiniaraštis') : null), tabs(''),
    table([{label: 'Mėnuo', key: 'period'}, {label: 'Būsena', render: (r) => badge(STATUS, r.status)}, {label: 'Darbuotojų', num: true, key: 'employees'}, {label: 'Priskaičiuota (bruto)', num: true, render: (r) => money(r.gross)},
      {label: 'GPM', num: true, render: (r) => money(r.gpm)}, {label: 'Sodra (visa)', num: true, render: (r) => money(r.sodra)}, {label: 'Išmokėti', num: true, render: (r) => money(r.to_pay)}, {label: 'Išmokėjimo data', render: (r) => date(r.payment_date)}],
    rows, {onRow: (r) => { location.hash = `#/atlyginimai/${r.id}`; }, empty: 'Žiniaraščių dar nėra. Pirmiausia įveskite darbuotojus, tada sukurkite mėnesio žiniaraštį.'}));
}

async function newRun(main, state) {
  const d = new Date();
  const period = input({type: 'month', value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`});
  const norm = input({inputmode: 'numeric'}), pay = input({type: 'date'});
  const refresh = async () => {
    if (!/^\d{4}-\d{2}$/.test(period.value)) return;
    norm.value = (await get(`/api/payroll/working-days?period=${period.value}`)).days;
    const [y, m] = period.value.split('-').map(Number); pay.value = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };
  period.addEventListener('change', () => guard(refresh));
  clear(main, pageHeader('Naujas darbo užmokesčio žiniaraštis'), tabs(''),
    section(null, h('form', {onsubmit: async (e) => { e.preventDefault(); const r = await guard(() => post('/api/payroll/runs', {period: period.value, norm_days: norm.value, payment_date: pay.value}), 'Žiniaraštis sukurtas.'); if (r) location.hash = `#/atlyginimai/${r.id}`; }},
      h('div', {class: 'form-grid'}, field('Mėnuo', period), field('Darbo dienų norma', norm, 'Pagal darbo dienas be švenčių; galite pakeisti'), field('Išmokėjimo data', pay)),
      h('p', {class: 'hint'}, 'Į žiniaraštį įtraukiami visi aktyvūs tą mėnesį dirbę darbuotojai. Dirbtos dienos užpildomos pagal normą (pradėjusiems ar baigusiems darbą mėnesio viduryje – proporcingai) – jas galėsite pakeisti.'),
      h('button', {class: 'btn btn-primary'}, 'Sukurti žiniaraštį'))));
  await refresh();
}

async function runSheet(main, id, state) {
  const [run, emps] = await Promise.all([get(`/api/payroll/runs/${id}`), get('/api/employees?active=true')]);
  const draft = run.status === 'draft' && can(state.user, 'write');
  const inputs = new Map();
  const num = (v, attrs = {}) => input({value: Number(v) ? String(v).replace(/\.00$/, '') : '', inputmode: 'decimal', class: 'num-input', disabled: !draft, ...attrs});
  const cols = [
    {label: 'Darbuotojas', render: (l) => h('div', null, h('a', {href: `#/atlyginimai/darbuotojai/${l.employee_id}`}, `${l.first_name} ${l.last_name}`), h('div', {class: 'hint'}, l.position || '', l.pay_type === 'hourly' ? ` · ${money(l.hourly_rate)} €/val.` : ` · ${money(l.base_salary)} €/mėn.`))},
    {label: 'Dirbta d.', render: (l) => inputs.get(l.employee_id).worked_days},
    {label: 'Val.', render: (l) => (l.pay_type === 'hourly' ? inputs.get(l.employee_id).worked_hours : '')},
    {label: 'Priedai', render: (l) => inputs.get(l.employee_id).bonus},
    {label: 'Atostoginiai', render: (l) => inputs.get(l.employee_id).vacation_pay},
    {label: 'Ligos (darbd.)', render: (l) => inputs.get(l.employee_id).sick_pay},
    {label: 'Kita', render: (l) => inputs.get(l.employee_id).other_pay},
    {label: 'Bruto', num: true, render: (l) => h('strong', null, money(l.gross))},
    {label: 'NPD', num: true, render: (l) => money(l.npd)},
    {label: 'GPM', num: true, render: (l) => money(l.gpm)},
    {label: 'VSD+PSD', num: true, render: (l) => money(Number(l.vsd) + Number(l.psd))},
    {label: 'Pens. kaup.', num: true, render: (l) => money(l.pension)},
    {label: 'Neto', num: true, render: (l) => money(l.net)},
    {label: 'Avansas', render: (l) => inputs.get(l.employee_id).advance},
    {label: 'Išmokėti', num: true, render: (l) => h('strong', null, money(l.to_pay))},
    {label: 'Darbd. Sodra', num: true, render: (l) => money(l.employer_sodra)},
    {label: '', render: (l) => h('span', {class: 'row-actions'}, h('button', {class: 'btn btn-small', type: 'button', onclick: () => payslip(run, [l], state.company?.name)}, 'Algalapis'),
      draft ? h('button', {class: 'btn btn-small', type: 'button', title: 'Pašalinti iš žiniaraščio', onclick: () => guard(async () => { await put(`/api/payroll/runs/${id}`, {remove_employee_id: l.employee_id}); runSheet(main, id, state); })}, '×') : null)},
  ];
  for (const l of run.lines) inputs.set(l.employee_id, {worked_days: num(l.worked_days, {'aria-label': `${fullName(l)} dirbta dienų`}), worked_hours: num(l.worked_hours, {'aria-label': `${fullName(l)} valandos`}),
    bonus: num(l.bonus, {'aria-label': `${fullName(l)} priedai`}), vacation_pay: num(l.vacation_pay, {'aria-label': `${fullName(l)} atostoginiai`}), sick_pay: num(l.sick_pay, {'aria-label': `${fullName(l)} ligos`}),
    other_pay: num(l.other_pay, {'aria-label': `${fullName(l)} kitos išmokos`}), advance: num(l.advance, {'aria-label': `${fullName(l)} avansas`})});
  const norm = input({value: run.norm_days, inputmode: 'numeric', disabled: !draft, class: 'num-input'}), pay = input({type: 'date', value: run.payment_date, disabled: !draft});
  const save = () => guard(async () => {
    await put(`/api/payroll/runs/${id}`, {norm_days: norm.value, payment_date: pay.value, lines: run.lines.map((l) => ({employee_id: l.employee_id, ...Object.fromEntries(Object.entries(inputs.get(l.employee_id)).map(([k, v]) => [k, v.value]))}))});
    runSheet(main, id, state);
  }, 'Perskaičiuota ir išsaugota.');
  const missing = emps.filter((e) => !run.lines.some((l) => String(l.employee_id) === String(e.id)));
  const addSel = select([['', '+ Pridėti darbuotoją…'], ...missing.map((e) => [e.id, fullName(e)])], '', {onchange: () => addSel.value && guard(async () => { await put(`/api/payroll/runs/${id}`, {add_employee_id: addSel.value}); runSheet(main, id, state); })});
  const t = run.totals, p = run.params;
  const actions = [];
  if (draft) actions.push(h('button', {class: 'btn', onclick: save}, 'Perskaičiuoti ir išsaugoti'));
  if (run.status === 'draft' && can(state.user, 'approve')) actions.push(h('button', {class: 'btn btn-primary', onclick: async () => { if (await confirmDialog('Patvirtinti žiniaraštį?', `Bus užregistruotas DK įrašas už ${run.period}: D ${[...new Set(run.lines.map((l) => l.expense_account))].join(', ')} ${money(t.cost)} / K 4480 ${money(t.net)}, K 4481 ${money(t.gpm)}, K 4482 ${money(t.sodra_total)}.`, 'Patvirtinti ir kontuoti')) { if (await guard(() => post(`/api/payroll/runs/${id}/approve`), 'Patvirtinta ir užregistruota DK.')) runSheet(main, id, state); } }}, 'Patvirtinti ir kontuoti'));
  if (run.status === 'approved' && can(state.user, 'approve')) actions.push(h('button', {class: 'btn', onclick: async () => { const reason = await promptDialog('Atšaukti patvirtinimą', 'Priežastis (DK įrašas bus atšauktas atvirkštiniu įrašu)', {minLength: 5}); if (reason && await guard(() => post(`/api/payroll/runs/${id}/cancel`, {reason}), 'Patvirtinimas atšauktas.')) runSheet(main, id, state); }}, 'Atšaukti patvirtinimą'));
  if (run.status === 'draft' && !run.approval_no && can(state.user, 'write')) actions.push(h('button', {class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Ištrinti žiniaraštį?', `Žiniaraštis už ${run.period} bus ištrintas.`, 'Ištrinti')) { if (await guard(() => del(`/api/payroll/runs/${id}`), 'Ištrinta.')) location.hash = '#/atlyginimai'; } }}, 'Ištrinti'));
  if (run.lines.length) actions.push(h('button', {class: 'btn', onclick: () => payslip(run, run.lines, state.company?.name)}, 'Visi algalapiai'));
  clear(main, pageHeader(`Darbo užmokesčio žiniaraštis ${run.period}`, badge(STATUS, run.status), ...actions), tabs(''),
    h('div', {class: 'filters'}, field('Darbo dienų norma', norm), field('Išmokėjimo data', pay), draft && missing.length ? field('Darbuotojai', addSel) : null,
      run.journal_entry_id ? h('a', {class: 'btn btn-small', href: `#/ataskaitos/zurnalas/${run.journal_entry_id}`}, `DK įrašas #${run.journal_entry_id}`) : null),
    h('div', {class: 'table-wrap'}, h('table', {class: 'grid lines payroll-grid'},
      h('thead', null, h('tr', null, cols.map((c) => h('th', {class: c.num ? 'num' : null}, c.label)))),
      h('tbody', null, run.lines.length ? run.lines.map((l) => h('tr', null, cols.map((c) => h('td', {class: c.num ? 'num' : null, 'data-label': c.label}, c.render(l))))) : h('tr', null, h('td', {colspan: cols.length, class: 'empty'}, 'Žiniaraštyje nėra darbuotojų.'))),
      h('tfoot', null, h('tr', null, h('th', null, 'Iš viso'), h('th'), h('th'), ['bonus', 'vacation_pay', 'sick_pay', 'other_pay'].map((k) => h('th', {class: 'num'}, money(t[k]))),
        ...['gross', 'npd', 'gpm'].map((k) => h('th', {class: 'num'}, money(t[k]))), h('th', {class: 'num'}, money(Number(t.vsd) + Number(t.psd))), h('th', {class: 'num'}, money(t.pension)), h('th', {class: 'num'}, money(t.net)),
        h('th', {class: 'num'}, money(t.advance)), h('th', {class: 'num'}, money(t.to_pay)), h('th', {class: 'num'}, money(t.employer_sodra)), h('th'))))),
    h('div', {class: 'cols'},
      section('Mokėtinos sumos', h('dl', {class: 'dl'}, h('dt', null, 'Išmokėti darbuotojams'), h('dd', null, eur(t.to_pay)), h('dt', null, 'GPM į VMI'), h('dd', null, eur(t.gpm)),
        h('dt', null, 'Sodrai (VSD+PSD+kaupimas+darbdavio)'), h('dd', null, eur(t.sodra_total)), h('dt', null, 'Darbo vietos kaina'), h('dd', null, h('strong', null, eur(t.cost)))),
      h('p', {class: 'hint'}, 'Išmokėjimą registruokite banke kaip „Kita (pasirinkta sąskaita)“ su sąskaita 4480, GPM – 4481, Sodrą – 4482.')),
      section('Taikyti parametrai', h('dl', {class: 'dl'}, h('dt', null, 'Galioja nuo'), h('dd', null, date(p.effective_from)), h('dt', null, 'MMA'), h('dd', null, eur(p.mma)),
        h('dt', null, 'NPD'), h('dd', null, `${money(p.npd_max)} − ${Number(p.npd_coef)} × (DU − MMA)`), h('dt', null, 'GPM'), h('dd', null, `${Number(p.gpm_rate)} %`),
        h('dt', null, 'Darbuotojo Sodra'), h('dd', null, `VSD ${Number(p.vsd_rate)} % + PSD ${Number(p.psd_rate)} %`), h('dt', null, 'Papildomas kaupimas'), h('dd', null, `${Number(p.pension_extra_rate)} %`),
        h('dt', null, 'Darbdavio Sodra'), h('dd', null, `${Number(p.employer_rate)} % (terminuota – ${Number(p.employer_rate_fixed)} %)`)))));
}

function payslipBody(run, l, company) {
  const row = (t, v, strong) => h('tr', null, h('td', null, t), h('td', {class: 'num'}, strong ? h('strong', null, money(v)) : money(v)));
  return h('div', {class: 'payslip'},
    company ? h('p', {class: 'hint'}, company) : null, h('h3', null, `Algalapis ${run.period}: ${l.first_name} ${l.last_name}`), h('p', null, `${l.position || ''} · darbo dienų norma ${run.norm_days}, dirbta ${Number(l.worked_days)}${Number(l.worked_hours) ? `, valandų ${Number(l.worked_hours)}` : ''} · išmokėjimo data ${date(run.payment_date)}`),
    h('table', {class: 'grid'}, h('tbody', null, h('tr', null, h('th', {colspan: 2}, 'Priskaičiuota')), row('Darbo užmokestis', l.base), Number(l.bonus) ? row('Priedai, premijos', l.bonus) : null,
      Number(l.vacation_pay) ? row('Atostoginiai', l.vacation_pay) : null, Number(l.sick_pay) ? row('Ligos išmoka (darbdavio)', l.sick_pay) : null, Number(l.other_pay) ? row('Kitos išmokos', l.other_pay) : null,
      row('Iš viso priskaičiuota', l.gross, true), h('tr', null, h('th', {colspan: 2}, 'Išskaičiuota')), row(`GPM (taikytas NPD ${money(l.npd)})`, l.gpm), row('VSD', l.vsd), row('PSD', l.psd),
      Number(l.pension) ? row('Papildomas pensijų kaupimas', l.pension) : null, row('Iš viso išskaičiuota', (Number(l.gpm) + Number(l.vsd) + Number(l.psd) + Number(l.pension)).toFixed(2), true),
      Number(l.advance) ? row('Išmokėtas avansas', l.advance) : null, row('Išmokėti', l.to_pay, true), row('Darbdavio Sodros įmokos (informacija)', l.employer_sodra))));
}

function payslip(run, lines, company) {
  modal(lines.length > 1 ? `Algalapiai ${run.period}` : 'Algalapis', h('div', {class: 'print-area'}, lines.map((l) => payslipBody(run, l, company)),
    h('div', {class: 'actions no-print'}, h('button', {class: 'btn btn-primary', onclick: () => window.print()}, 'Spausdinti'))), {wide: true});
}

async function employees(main, state) {
  const rows = await get('/api/employees');
  clear(main, pageHeader('Darbuotojai', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: '#/atlyginimai/darbuotojai/naujas'}, '+ Naujas darbuotojas') : null), tabs('darbuotojai'),
    table([{label: 'Vardas, pavardė', render: (e) => fullName(e)}, {label: 'Pareigos', key: 'position'}, {label: 'Padalinys', key: 'department'}, {label: 'Dirba nuo', render: (e) => date(e.employment_start)},
      {label: 'Iki', render: (e) => date(e.employment_end)}, {label: 'Sutartis', render: (e) => (e.contract_type === 'fixed_term' ? 'Terminuota' : 'Neterminuota')},
      {label: 'Atlyginimas', num: true, render: (e) => (e.pay_type === 'hourly' ? `${money(e.hourly_rate)} €/val.` : `${money(e.base_salary)} €/mėn.`)}, {label: 'NPD', render: (e) => (e.apply_npd ? 'taip' : 'ne')},
      {label: 'Būsena', render: (e) => (e.active ? '' : 'neaktyvus')}], rows, {onRow: (e) => { location.hash = `#/atlyginimai/darbuotojai/${e.id}`; }, empty: 'Darbuotojų dar nėra.'}));
}

async function employeeCard(main, id, state) {
  const [e, accounts] = await Promise.all([id ? get(`/api/employees/${id}`) : {pay_type: 'monthly', contract_type: 'indefinite', apply_npd: true, active: true, hours_per_week: '40', expense_account: '6304', employment_start: today()}, get('/api/accounts')]);
  const ro = !can(state.user, 'write');
  const f = {first_name: input({value: e.first_name || '', required: true}), last_name: input({value: e.last_name || '', required: true}), personal_code: input({value: e.personal_code || '', inputmode: 'numeric', maxlength: 11}),
    sodra_no: input({value: e.sodra_no || ''}), position: input({value: e.position || ''}), department: input({value: e.department || ''}),
    employment_start: input({type: 'date', value: e.employment_start || ''}), employment_end: input({type: 'date', value: e.employment_end || ''}),
    contract_type: select([['indefinite', 'Neterminuota'], ['fixed_term', 'Terminuota']], e.contract_type), pay_type: select([['monthly', 'Mėnesinis atlyginimas'], ['hourly', 'Valandinis įkainis']], e.pay_type),
    base_salary: input({value: e.base_salary ?? '', inputmode: 'decimal'}), hourly_rate: input({value: e.hourly_rate ?? '', inputmode: 'decimal'}), hours_per_week: input({value: e.hours_per_week ?? '40', inputmode: 'decimal'}),
    apply_npd: h('input', {type: 'checkbox', checked: e.apply_npd}), npd_fixed: input({value: e.npd_fixed ?? '', inputmode: 'decimal'}), pension_extra: h('input', {type: 'checkbox', checked: e.pension_extra}),
    expense_account: select(accounts.filter((a) => a.active && a.type === 'expense').map((a) => [a.code, `${a.code} ${a.name}`]), e.expense_account || '6304'),
    iban: input({value: e.iban || ''}), email: input({type: 'email', value: e.email || ''}), address: input({value: e.address || ''}), notes: h('textarea', {rows: 3}, e.notes || ''), active: h('input', {type: 'checkbox', checked: e.active !== false})};
  Object.values(f).forEach((x) => { x.disabled = ro; });
  const body = () => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type === 'checkbox' ? v.checked : v.value]));
  clear(main, pageHeader(id ? `Darbuotojas: ${fullName(e)}` : 'Naujas darbuotojas', h('a', {class: 'btn', href: '#/atlyginimai/darbuotojai'}, '← Sąrašas')),
    h('form', {onsubmit: async (ev) => { ev.preventDefault(); const r = await guard(() => (id ? put(`/api/employees/${id}`, body()) : post('/api/employees', body())), 'Išsaugota.'); if (r && !id) location.hash = `#/atlyginimai/darbuotojai/${r.id}`; }},
      section('Asmens duomenys', h('div', {class: 'form-grid'}, field('Vardas', f.first_name), field('Pavardė', f.last_name), field('Asmens kodas', f.personal_code), field('Sodros pažymėjimo nr.', f.sodra_no),
        field('El. paštas', f.email), field('Adresas', f.address), field('Banko sąskaita (IBAN)', f.iban))),
      section('Darbo sutartis', h('div', {class: 'form-grid'}, field('Pareigos', f.position), field('Padalinys', f.department), field('Dirba nuo', f.employment_start), field('Dirba iki', f.employment_end), field('Sutarties rūšis', f.contract_type),
        field('Darbo valandų per savaitę', f.hours_per_week), h('label', {class: 'check'}, f.active, ' Aktyvus'))),
      section('Darbo užmokestis ir mokesčiai', h('div', {class: 'form-grid'}, field('Apmokėjimo būdas', f.pay_type), field('Mėnesinis atlyginimas (bruto)', f.base_salary), field('Valandinis įkainis (bruto)', f.hourly_rate),
        h('label', {class: 'check'}, f.apply_npd, ' Taikyti NPD (pateiktas prašymas)'), field('Fiksuotas NPD', f.npd_fixed, 'Tik dėl darbingumo lygio (pvz. 1127 arba 1057 €); kitaip palikite tuščią'),
        h('label', {class: 'check'}, f.pension_extra, ' Papildomas kaupimas pensijų fonde (3 %)'), field('Sąnaudų sąskaita', f.expense_account, '6304 – administracija, 6203 – pardavimai, 6003 – gamyba'))),
      section('Pastabos', field('Pastabos', f.notes)),
      ro ? null : h('div', {class: 'actions sticky-actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))),
    id && e.history?.length ? section('Darbo užmokesčio istorija', table([{label: 'Mėnuo', render: (x) => h('a', {href: `#/atlyginimai/${x.run_id}`}, x.period)}, {label: 'Būsena', render: (x) => badge(STATUS, x.status)},
      {label: 'Bruto', num: true, render: (x) => money(x.gross)}, {label: 'GPM', num: true, render: (x) => money(x.gpm)}, {label: 'Sodra', num: true, render: (x) => money(x.sodra)}, {label: 'Neto', num: true, render: (x) => money(x.net)}], e.history)) : null);
}

async function params(main, state) {
  const rows = await get('/api/payroll/params');
  const latest = rows[0] || {};
  const keys = [['effective_from', 'Galioja nuo', 'date'], ['mma', 'MMA, €'], ['vdu', 'VDU, €'], ['npd_max', 'NPD maks., €'], ['npd_coef', 'NPD koeficientas'], ['gpm_rate', 'GPM, %'], ['vsd_rate', 'Darbuotojo VSD, %'],
    ['psd_rate', 'Darbuotojo PSD, %'], ['pension_extra_rate', 'Papild. kaupimas, %'], ['employer_rate', 'Darbdavio Sodra, %'], ['employer_rate_fixed', 'Darbdavio Sodra (terminuota), %']];
  const f = Object.fromEntries(keys.map(([k, , t]) => [k, input({type: t || 'text', inputmode: t ? null : 'decimal', value: t ? '' : latest[k] ?? ''})]));
  const note = input();
  clear(main, pageHeader('Atlyginimų tarifai ir parametrai'), tabs('parametrai'),
    h('p', {class: 'hint'}, 'Parametrai taikomi pagal žiniaraščio mėnesio paskutinę dieną. Naujiems metams pridėkite naują eilutę – senų žiniaraščių skaičiavimas nesikeis. Reikšmes patikrinkite su buhalteriu (VMI, Sodra).'),
    table([...keys.map(([k, label]) => ({label, num: k !== 'effective_from', render: (r) => (k === 'effective_from' ? date(r[k]) : r[k] === null ? '—' : String(Number(r[k])))})), {label: 'Pastaba', key: 'note'}], rows),
    can(state.user, 'settings') ? section('Nauji parametrai', h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/payroll/params', {...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])), note: note.value}), 'Išsaugota.')) params(main, state); }},
      h('div', {class: 'form-grid'}, keys.map(([k, label]) => field(label, f[k])), field('Pastaba', note)), h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))) : null);
}
