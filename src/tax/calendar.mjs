// Mokesčių kalendorius: the company's returns and payments with their deadlines, and whether each was filed.
// Deadlines that fall on a weekend or public holiday move to the next working day.
import {holidays} from '../payroll/calc.mjs';

const iso = (d) => d.toISOString().slice(0, 10);
const nextMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const addMonths = (p, n) => { let x = p; for (let i = 0; i < Math.abs(n); i++) x = n > 0 ? nextMonth(x) : prevMonth(x); return x; };
const prevMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

/** The date itself if it is a working day, otherwise the next working day (Mon–Fri, not a public holiday). */
export function workingDayOnOrAfter(date) {
  const d = new Date(`${date}T00:00:00Z`);
  for (;;) {
    const s = iso(d);
    if (d.getUTCDay() % 6 !== 0 && !holidays(d.getUTCFullYear()).has(s)) return s;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// Monthly obligations for period P, due in the following month. `when` decides whether the company has it.
const MONTHLY = [
  {form: 'GPM313', title: 'GPM313 pajamų mokesčio deklaracija', day: 15, link: '#/gpm313', when: (c) => c.payroll, note: 'Už mėnesį išmokėtas su darbo santykiais susijusias pajamas.'},
  {form: 'SAM', title: 'SAM pranešimas Sodrai', day: 15, link: '#/sam', when: (c) => c.payroll, note: 'Mėnesinis pranešimas apie apdraustuosius.'},
  {form: 'MOKESCIAI_DU', title: 'GPM ir Sodros įmokų sumokėjimas', day: 15, link: '#/atlyginimai', when: (c) => c.payroll, payment: true, note: 'Išskaičiuotas GPM ir socialinio draudimo įmokos už mėnesį.'},
  {form: 'ISAF', title: 'i.SAF registrai', day: 20, link: '#/ataskaitos/isaf', when: (c) => c.vat, note: 'Išrašytų ir gautų sąskaitų registrai.'},
  {form: 'FR0600', title: 'PVM deklaracija FR0600 ir PVM sumokėjimas', day: 25, link: '#/fr0600', when: (c) => c.vat, note: 'Mokestinis laikotarpis – kalendorinis mėnuo.'},
  {form: 'FR0564', title: 'FR0564 – prekių tiekimas ES PVM mokėtojams', day: 25, link: '#/ataskaitos/fr0564', when: (c, p) => c.euSupplies.has(p), note: 'Teikiama tik už mėnesius, kuriais buvo tiekimų į kitas ES valstybes.'},
];
// Annual obligations for year Y, due in Y+1.
const ANNUAL = [
  {form: 'PLN204', title: 'PLN204 pelno mokesčio deklaracija ir mokesčio sumokėjimas', md: '06-15', link: '#/pln204', when: () => true},
  {form: 'RC_RINKINYS', title: 'Metinių finansinių ataskaitų rinkinys Registrų centrui', md: '05-30', link: '#/rc-rinkinys', when: () => true, note: 'Rinkinys tvirtinamas per 4 mėn. po metų pabaigos ir pateikiamas per 30 d. nuo patvirtinimo.'},
];

/**
 * Obligations with a deadline between `from` and `to` (dates), with their status.
 * Status: filed, overdue (deadline passed, not filed), soon (within 7 days), upcoming.
 */
export async function taxCalendar(db, {from, to, today}) {
  const company = (await db.query('SELECT vat_registered FROM company_settings WHERE id=1')).rows[0];
  const payroll = Number((await db.query(`SELECT (SELECT count(*) FROM employees WHERE active) + (SELECT count(*) FROM payroll_runs) AS n`)).rows[0].n) > 0;
  const euSupplies = new Set((await db.query(`SELECT DISTINCT to_char(i.issue_date, 'YYYY-MM') AS p FROM invoice_vat_rows v JOIN invoices i ON i.id=v.invoice_id WHERE v.tax_code='PVM13'`)).rows.map((r) => r.p));
  const ctx = {vat: !!company.vat_registered, payroll, euSupplies};
  const filed = new Map((await db.query(`SELECT f.*, u.name AS filed_by_name FROM tax_filings f LEFT JOIN users u ON u.id=f.filed_by`)).rows.map((r) => [`${r.form}:${r.period}`, r]));
  const items = [];
  const push = (o, period, statutory) => {
    const due = workingDayOnOrAfter(statutory);
    if (due < from || due > to) return;
    const f = filed.get(`${o.form}:${period}`);
    const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
    items.push({form: o.form, period, title: o.title, due, statutory, link: o.link, note: o.note || '', payment: !!o.payment,
      status: f ? 'filed' : days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'upcoming', daysLeft: days,
      filed: f ? {on: f.filed_on, reference: f.reference, by: f.filed_by_name} : null});
  };
  // Monthly: periods whose deadline month falls in the range.
  for (let p = addMonths(from.slice(0, 7), -1); p < to.slice(0, 7); p = nextMonth(p)) {
    const dueMonth = nextMonth(p);
    for (const o of MONTHLY) if (o.when(ctx, p)) push(o, p, `${dueMonth}-${String(o.day).padStart(2, '0')}`);
  }
  for (let y = Number(from.slice(0, 4)) - 1; y < Number(to.slice(0, 4)); y++) for (const o of ANNUAL) if (o.when(ctx)) push(o, String(y), `${y + 1}-${o.md}`);
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.form < b.form ? -1 : 1));
  return {from, to, today, items, summary: {overdue: items.filter((i) => i.status === 'overdue').length, soon: items.filter((i) => i.status === 'soon').length}};
}

export const TAX_FORMS = new Set([...MONTHLY, ...ANNUAL].map((o) => o.form));
