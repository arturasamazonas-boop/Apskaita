// SAM – „Pranešimas apie apdraustuosius už ataskaitinį laikotarpį“ (version 07) for Sodra EDAS, monthly, by the 15th
// of the next month. Structure from the official data description (SAM aprašas v07, annex to Sodra order V-243 as amended):
// FFData with the SAM title page and SAM3SD annex pages (6 insured persons per page).
// Values from approved payroll sheets of the month: insured income = gross pay, contributions = income × combined rate.
import {AppError} from '../db.mjs';
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';

export const SAM_FORM_DEF_ID = '{963BF380-47C3-4B69-A7F7-1B4593572CFE}';
const PER_PAGE = 6;
const comma = (v) => money.norm(v).replace('.', ',');
const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAM_FIELDS = ['InsurerName', 'InsurerCode', 'JuridicalPersonCode', 'InsurerPhone', 'InsurerAddress', 'DocDate', 'DocNumber', 'CycleYear', 'CycleMonth', 'RevisedDocument', 'RevisedCycleYear', 'RevisedCycleMonth',
  'Appendixes2', 'Apdx2PageCount', 'Apdx2PersonCount', 'Apdx2InsIncomeSum', 'Apdx2PaymentSum', 'Appendixes3', 'Apdx3PageCount', 'Apdx3PersonCount', 'Apdx3InsIncomeSum', 'Apdx3PaymentSum',
  'ApdxPageCountTotal', 'ManagerFullName', 'PreparatorDetails', 'FormCode', 'FormVersion'];
const ROW_FIELDS = ['RowNumber', 'PersonCode', 'InsuranceSeries', 'InsuranceNumber', 'InsIncomeSum', 'TaxRate', 'PaymentSum', 'PersonFirstName', 'PersonLastName'];
const PAGE_FIELDS = ['InsIncomePage', 'PaymentPage', 'InsurerCode', 'PageNumber', 'PageTotal', 'DocDate', 'DocNumber', 'FormCode', 'FormVersion'];

/** Social insurance number "AB1234567" → series "AB" and number "1234567". */
export function splitSodraNo(s) {
  const m = String(s || '').replace(/\s/g, '').toUpperCase().match(/^([A-Z]{2})(\d{1,7})$/);
  return m ? {series: m[1], number: m[2]} : {series: '', number: ''};
}

export async function samData(db, {year, month, revised = false, preparator = ''}) {
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const run = (await db.query('SELECT * FROM payroll_runs WHERE period=$1', [period])).rows[0];
  const notes = [], errors = [];
  if (!run) errors.push(`Nėra ${period} darbo užmokesčio žiniaraščio.`);
  else if (run.status !== 'approved') errors.push(`${period} žiniaraštis nepatvirtintas – SAM formuojamas iš patvirtinto žiniaraščio.`);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10), monthStart = `${period}-01`;
  // The same parameters as the payroll sheet: those in force on the last day of the month.
  const p = run ? (await db.query('SELECT * FROM payroll_params WHERE effective_from <= $1 ORDER BY effective_from DESC LIMIT 1', [monthEnd])).rows[0] : null;
  const lines = run && run.status === 'approved' ? (await db.query(`SELECT l.*, e.first_name, e.last_name, e.personal_code, e.sodra_no, e.contract_type, e.pension_extra, e.employment_end
    FROM payroll_lines l JOIN employees e ON e.id=l.employee_id WHERE l.run_id=$1 ORDER BY e.last_name, e.first_name`, [run.id])).rows : [];
  const rows = [], left = [];
  for (const l of lines) {
    const end = l.employment_end ? String(l.employment_end instanceof Date ? l.employment_end.toISOString() : l.employment_end).slice(0, 10) : null;
    // Income of a person who left during the month is reported in the 2-SD notice, not in SAM3SD (rules p. 48–55).
    if (end && end >= monthStart && end <= monthEnd) { left.push(`${l.first_name} ${l.last_name}`); continue; }
    if (money.cmp(l.gross, '0') <= 0) continue;
    // Combined rate (P3, "bendras įmokų tarifas", insurer + insured): employee VSD + PSD + employer contributions
    // (+ pension accumulation if joined), e.g. 12.52 + 6.98 + 1.77 = 21.27 %.
    const rate = money.add(money.add(money.add(p.vsd_rate, p.psd_rate), l.contract_type === 'fixed_term' ? p.employer_rate_fixed : p.employer_rate), l.pension_extra ? p.pension_extra_rate : '0');
    const income = money.norm(l.gross);
    const pay = fromUnits(divRound(toUnits(income, 2) * toUnits(rate, 2), 10000n), 2);
    const sn = splitSodraNo(l.sodra_no);
    if (!/^\d{11}$/.test(l.personal_code || '')) errors.push(`${l.first_name} ${l.last_name}: nėra asmens kodo.`);
    if (!sn.series) notes.push(`${l.first_name} ${l.last_name}: nenurodytas socialinio draudimo numeris (serija ir numeris, pvz. AB1234567) – laukeliai paliekami tušti.`);
    rows.push({firstName: l.first_name, lastName: l.last_name, personalCode: l.personal_code, series: sn.series, number: sn.number, income, rate: money.norm(rate), payment: pay});
  }
  if (left.length) notes.push(`Atleisti per mėnesį (pajamos teikiamos 2-SD pranešime, į SAM neįtraukti): ${left.join(', ')}.`);
  if (!company.sodra_code) errors.push('Nenurodytas Sodros draudėjo kodas (Servisas → Įmonės duomenys).');
  notes.push('Bendras įmokų tarifas = darbuotojo VSD + PSD + darbdavio įmokos (+ papildomas pensijų kaupimas, jei dalyvauja). Įmokas nuo pajamų, viršijančių metines lubas, Sodra perskaičiuoja pati (taisyklių 120.4 p.).');
  const totals = {persons: rows.length, income: money.sum(rows.map((r) => r.income)), payment: money.sum(rows.map((r) => r.payment))};
  const pages = Math.ceil(rows.length / PER_PAGE);
  return {period, year, month, company: {name: company.name, code: company.company_code, sodraCode: company.sodra_code, phone: company.phone, email: company.email, manager: company.manager},
    revised, preparator, rows, totals, pages, notes, errors, exportable: !errors.length && rows.length > 0};
}

/** Values per page (SAM title page, then one SAM3SD page per 6 insured persons), with every field of the data description. */
export function samPages(d, {today}) {
  const sam = {
    InsurerName: d.company.name.slice(0, 68), InsurerCode: d.company.sodraCode, JuridicalPersonCode: d.company.code, InsurerPhone: (d.company.phone || '').slice(0, 15), InsurerAddress: (d.company.email || '').slice(0, 68),
    DocDate: today, DocNumber: '', CycleYear: String(d.year), CycleMonth: String(d.month).padStart(2, '0'),
    RevisedDocument: d.revised ? '1' : '0', RevisedCycleYear: '', RevisedCycleMonth: '',
    Appendixes2: d.pages ? '1' : '0', Apdx2PageCount: String(d.pages), Apdx2PersonCount: String(d.totals.persons), Apdx2InsIncomeSum: comma(d.totals.income), Apdx2PaymentSum: comma(d.totals.payment),
    Appendixes3: '0', Apdx3PageCount: '', Apdx3PersonCount: '', Apdx3InsIncomeSum: '', Apdx3PaymentSum: '',
    ApdxPageCountTotal: String(d.pages), ManagerFullName: (d.company.manager || '').slice(0, 68), PreparatorDetails: (d.preparator || '').slice(0, 68), FormCode: 'SAM', FormVersion: '07',
  };
  const pages = [{code: 'SAM', names: SAM_FIELDS, values: sam}];
  for (let pg = 0; pg < d.pages; pg++) {
    const chunk = d.rows.slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE);
    const v = {InsIncomePage: comma(money.sum(chunk.map((r) => r.income))), PaymentPage: comma(money.sum(chunk.map((r) => r.payment))), InsurerCode: d.company.sodraCode,
      PageNumber: String(pg + 1), PageTotal: String(d.pages), DocDate: today, DocNumber: '', FormCode: 'SAM3SD', FormVersion: '07'};
    const names = [];
    for (let i = 1; i <= PER_PAGE; i++) {
      const r = chunk[i - 1];
      const val = r ? {RowNumber: String(pg * PER_PAGE + i), PersonCode: r.personalCode, InsuranceSeries: r.series, InsuranceNumber: r.number, InsIncomeSum: comma(r.income), TaxRate: comma(r.rate), PaymentSum: comma(r.payment),
        PersonFirstName: r.firstName, PersonLastName: r.lastName} : {};
      for (const k of ROW_FIELDS) { names.push(`${k}_${i}`); v[`${k}_${i}`] = val[k] ?? ''; }
    }
    pages.push({code: 'SAM3SD', names: [...names, ...PAGE_FIELDS], values: v});
  }
  return pages;
}

/** FFData for upload to Sodra EDAS. */
export function samFFData(d, {login = 'apskaita', today}) {
  const field = (n, v) => `<Field Name="${n}">${xmlEsc(v)}</Field>`;
  const pages = samPages(d, {today});
  const xmlPages = pages.map((p, i) => `<Page PageDefName="${p.code}" PageNumber="${i + 1}">\n<Fields Count="${p.names.length}">\n${p.names.map((k) => field(k, p.values[k])).join('\n')}\n</Fields>\n</Page>`);
  const groups = pages.slice(1).map(() => '<Group Name="Priedas SAM3SD">\n<ListPages>\n<ListPage>SAM3SD</ListPage>\n</ListPages>\n</Group>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<FFData Version="1" CreatedByApp="Apskaita" CreatedByLogin="${xmlEsc(login)}" CreatedOn="${today}">
<Form FormDefId="${SAM_FORM_DEF_ID}" FormLocation="">
<DocumentPages>
<Group Name="Forma">
<ListPages>
<ListPage>SAM</ListPage>
</ListPages>
${groups}
</Group>
</DocumentPages>
<Pages Count="${pages.length}">
${xmlPages.join('\n')}
</Pages>
</Form>
</FFData>
`;
}

export function checkSamPeriod(q) {
  const year = Number(q.year), month = Number(q.month);
  if (!Number.isInteger(year) || year < 2019 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new AppError(400, 'period', 'Nurodykite metus ir mėnesį.');
  return {year, month};
}
