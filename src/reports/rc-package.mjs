// Annual financial statements set for Registrų centras (Juridinių asmenų registras): which forms the company submits by its size
// category, the cross-form checks RC applies to the e-form, a combined PDF of the set and the line data for filling the e-form.
import {PDFDocument} from 'pdf-lib';
import {money} from '../lib/money.mjs';
import {FORMS, buildStatement} from './statements.mjs';
import {renderStatementPdf} from './statement-pdf.mjs';

// Company size categories (Finansinių ataskaitų įstatymo 5 str., 2024 m. pakeitimai – thresholds raised by Directive (EU) 2023/2775).
// A company belongs to a category if on the balance sheet date it does not exceed two of the three thresholds.
export const CATEGORIES = {
  'labai-maza': {name: 'Labai maža įmonė', assets: 450000, revenue: 900000, staff: 10,
    forms: ['balansas-trumpas', 'pelno-nuostoliu-trumpa'], alt: {'balansas-trumpas': ['balansas-sutrumpintas', 'balansas'], 'pelno-nuostoliu-trumpa': ['pelno-nuostoliu']},
    docs: ['Aiškinamasis raštas (labai maža įmonė jo gali nerengti, jei FAĮ nustatytą informaciją pateikia po balansu)', 'Pelno (nuostolių) paskirstymo projektas ir dalyvių sprendimas dėl tvirtinimo']},
  maza: {name: 'Maža įmonė', assets: 5000000, revenue: 10000000, staff: 50,
    forms: ['balansas-sutrumpintas', 'pelno-nuostoliu'], alt: {'balansas-sutrumpintas': ['balansas']},
    docs: ['Aiškinamasis raštas', 'Pelno (nuostolių) paskirstymo projektas ir dalyvių sprendimas dėl tvirtinimo', 'Metinis pranešimas (jei rengiamas)', 'Auditoriaus išvada (jei auditas privalomas ar atliktas)']},
  vidutine: {name: 'Vidutinė įmonė', assets: 25000000, revenue: 50000000, staff: 250,
    forms: ['balansas', 'pelno-nuostoliu', 'pinigu-srautai', 'nuosavo-kapitalo-pokyciai'], alt: {'pinigu-srautai': ['pinigu-srautai-tiesioginis']},
    docs: ['Aiškinamasis raštas', 'Metinis pranešimas', 'Auditoriaus išvada', 'Pelno (nuostolių) paskirstymo projektas ir dalyvių sprendimas dėl tvirtinimo']},
  didele: {name: 'Didelė įmonė', assets: Infinity, revenue: Infinity, staff: Infinity,
    forms: ['balansas', 'pelno-nuostoliu', 'pinigu-srautai', 'nuosavo-kapitalo-pokyciai'], alt: {'pinigu-srautai': ['pinigu-srautai-tiesioginis']},
    docs: ['Aiškinamasis raštas', 'Metinis pranešimas', 'Auditoriaus išvada', 'Pelno (nuostolių) paskirstymo projektas ir dalyvių sprendimas dėl tvirtinimo']},
};
const ORDER = ['labai-maza', 'maza', 'vidutine', 'didele'];

/** Size indicators from the ledger and the employee list, and the category they give. */
export async function sizeIndicators(db, year) {
  const to = `${year}-12-31`, today = to;
  const bal = await buildStatement(db, 'balansas', {to, today});
  const pl = await buildStatement(db, 'pelno-nuostoliu', {from: `${year}-01-01`, to, today});
  const assets = Number(bal.lines.find((l) => l.id === 'TA').current);
  const revenue = Number(pl.lines.find((l) => l.id === '1').current);
  // Average staff approximated by the number of employees employed on the balance sheet date.
  const staff = Number((await db.query(`SELECT count(*) AS n FROM employees WHERE employment_start <= $1 AND (employment_end IS NULL OR employment_end >= $1)`, [to]).catch(() => ({rows: [{n: 0}]}))).rows[0].n);
  const fits = (c) => [assets <= c.assets, revenue <= c.revenue, staff <= c.staff].filter(Boolean).length >= 2;
  const category = ORDER.find((k) => fits(CATEGORIES[k]));
  return {assets, revenue, staff, category};
}

const sum2 = (st, id) => st?.lines.find((l) => l.id === id);

/** Build the set: statements, RC checks, deadlines. */
export async function buildRcPackage(db, {year, category, forms: chosen, today, precision = 'eur'}) {
  const size = await sizeIndicators(db, year);
  const cat = CATEGORIES[category] ? category : size.category;
  const def = CATEGORIES[cat];
  const allowed = (k) => def.forms.includes(k) || Object.values(def.alt).some((a) => a.includes(k));
  const formKeys = Array.isArray(chosen) && chosen.length ? chosen.filter((k) => FORMS[k] && allowed(k)) : def.forms;
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const statements = [];
  for (const k of formKeys) statements.push(await buildStatement(db, k, {from, to, today, precision}));
  const checks = [];
  for (const st of statements) for (const c of st.checks) checks.push({...c, form: st.form.name});
  // Cross-form checks done by the RC e-form, against the full balance (always built, its lines hold the details).
  const full = await buildStatement(db, 'balansas', {to, today, precision});
  const tol = precision === 'cents' ? '0' : '2';
  const differs = (a, b) => money.cmp(money.abs(money.sub(a, b)), tol) > 0;
  const pl = statements.find((s) => s.form.kind === 'pl');
  if (pl) {
    const net = pl.lines.find((l) => l.grand).current;
    const res = sum2(full, 'D5.1').current;
    if (differs(net, res)) checks.push({level: 'error', form: 'Balansas ir P(N)A', message: `Pelno (nuostolių) ataskaitos grynasis pelnas ${net} nesutampa su balanso „Ataskaitinių metų pelnas (nuostoliai)“ ${res}. Patikrinkite, ar metų rezultatas neuždarytas per anksti ar ar nėra pajamų / sąnaudų už ataskaitinio laikotarpio ribų.`});
    else checks.push({level: 'ok', form: 'Balansas ir P(N)A', message: `Grynasis pelnas (${net}) sutampa su balanso ataskaitinių metų rezultatu.`});
  }
  const cf = statements.find((s) => s.form.kind === 'cf');
  if (cf) {
    const cash = sum2(full, 'B4').current, vii = cf.lines.find((l) => l.id === 'VII')?.current;
    if (vii !== undefined && differs(vii, cash)) checks.push({level: 'error', form: 'Pinigų srautai ir balansas', message: `Pinigų srautų ataskaitos pinigų likutis pabaigoje ${vii} nesutampa su balanso pinigais ${cash}.`});
  }
  const eq = statements.find((s) => s.form.kind === 'equity');
  if (eq) {
    const end = eq.matrix.cells['30'].c10, d = sum2(full, 'D').current;
    if (differs(end, d)) checks.push({level: 'error', form: 'Nuosavo kapitalo pokyčiai ir balansas', message: `Nuosavo kapitalo likutis pabaigoje ${end} nesutampa su balanso nuosavu kapitalu ${d}.`});
  }
  for (const st of statements) {
    const manual = st.lines.filter((l) => l.priorOverridden).length;
    if (manual) checks.push({level: 'warning', form: st.form.name, message: `Praėjusių metų stulpelyje ${manual} eil. įvesta ranka – jos turi sutapti su pernai Registrų centrui pateiktu rinkiniu (RC formoje šie duomenys įkeliami iš praėjusių metų rinkinio).`});
  }
  if (precision !== 'eur') checks.push({level: 'warning', form: 'Rinkinys', message: 'Registrų centro el. formoje sumos pildomos eurais be centų – rinkite tikslumą „eurais“.'});
  // Deadlines: the ordinary general meeting approves the set within 4 months after the year end (ABĮ / UABĮ),
  // the approved set is submitted to RC within 30 days of approval.
  const approveBy = `${year + 1}-04-30`;
  return {year, period: {from, to}, size, category: cat, categoryName: def.name, suggested: size.category, forms: formKeys,
    options: [...new Set([...def.forms, ...Object.values(def.alt).flat()])].map((k) => ({key: k, name: FORMS[k].name, annex: FORMS[k].annex, required: def.forms.includes(k)})),
    docs: def.docs, statements, checks, deadlines: {approveBy, submitBy: '30 dienų nuo patvirtinimo', latest: `${year + 1}-05-30`}};
}

/** All statements of the set in one PDF (for approval, signing and attaching to the RC submission). */
export async function renderRcPackagePdf(pkg, header) {
  const out = await PDFDocument.create();
  out.setTitle(`Finansinių ataskaitų rinkinys ${pkg.year}`); out.setProducer('Apskaita');
  for (const st of pkg.statements) {
    const src = await PDFDocument.load(await renderStatementPdf(st, header));
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

/** Line data for typing into (or checking against) the RC e-form: one row per line. */
export function rcRows(pkg) {
  const rows = [];
  for (const st of pkg.statements) {
    if (st.matrix) {
      for (const r of st.matrix.rows) for (const c of st.matrix.cols) rows.push({form: `${st.form.name} (${st.form.annex})`, no: `${r.no}.`, label: `${r.label} – ${c.label}`, current: st.matrix.cells[r.no][c.key], previous: ''});
      continue;
    }
    for (const l of st.lines) if (!l.heading) rows.push({form: `${st.form.name} (${st.form.annex})`, no: l.no, label: l.label, current: l.current, previous: l.previous});
  }
  return rows;
}
