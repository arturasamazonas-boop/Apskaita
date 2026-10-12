// PLN204 – metinė pelno mokesčio deklaracija (version 08, VMI order VA-2 as amended), as in VMI EDS:
// pages PLN204 and PLN204_2 and the PLN204S annex (non-deductible expenses). Values come from the ledger (classes 5 and 6
// of the tax year, closing entries left out) and the non-deductible expense rules; the rest is typed in on the form.
// The calculation chain follows the template's own script (37, 40/41, 43, 48, 52, 54A from the rate code, 55, 59, 62, 64).
import {AppError} from '../db.mjs';
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {edsLayout} from './eds-forms.mjs';
import {NOT_CLOSING} from '../ledger/closing.mjs';

export const PLN204_PAGES = ['PLN204', 'PLN204_2', 'PLN204S'];
export const PLN204_LAYOUTS = Object.fromEntries(PLN204_PAGES.map((p) => [p, edsLayout(p)]));
export const S_CODES = PLN204_LAYOUTS.PLN204S.fields.find((f) => f.name === 'S1-1').list;
const ROWS = 32;
const eur = (v) => divRound(toUnits(v, 2), 100n); // whole euros, half up
const n = (v) => (v === '' || v === undefined || v === null ? 0n : BigInt(v));
const has = (v) => v !== '' && v !== undefined && v !== null;
const str = (x) => String(x);

/** Rate (%) by rate code and year, as in the template (E54): 2026 – 17 / 7 / 0 …, 2025 – 16 / 6 …, earlier – 15 / 5 … */
export function rateFor(code, year) {
  const t = year >= 2026 ? {1: '17', 2: '7', 3: '0', 4: '7', 5: '0', 6: '8,5', 7: '3,5', 11: '7'}
    : year === 2025 ? {1: '16', 2: '6', 3: '0', 4: '6', 5: '0', 6: '8', 7: '3', 11: '6'}
      : {1: '15', 2: '5', 3: '0', 4: '5', 5: '0', 6: '7,5', 7: '2,5', 11: '5'};
  return t[Number(code)] ?? '';
}
// The form shows rates with one decimal: "17,0".
const rateField = (r) => (r === '' ? '' : r.includes(',') ? r : `${r},0`);
const pct = (base, rate) => divRound(base * BigInt(Math.round(Number(String(rate).replace(',', '.')) * 10)), 1000n);

/** Calculated fields from the entered ones (in place). `v` holds the E and S fields of all pages. */
export function recompute(v) {
  const rows = Array.from({length: ROWS}, (_, i) => i + 1);
  const sRows = rows.filter((i) => has(v[`S2-${i}`]));
  v.S3 = sRows.length ? str(sRows.reduce((a, i) => a + n(v[`S2-${i}`]), 0n)) : '';
  v.E20 = v.S3;
  const sum = (keys) => keys.reduce((a, k) => a + n(v[k]), 0n);
  const anyOf = (keys) => keys.some((k) => has(v[k]));
  // Totals with breakdowns (21 ≥ 22+…, 27 ≥ 28+…, 32 ≥ 33+…): the sum of the parts unless a larger total was typed in.
  for (const [total, parts] of [['E21', ['E22', 'E23', 'E24', 'E25', 'E25A', 'E25B']], ['E27', ['E28', 'E29', 'E30', 'E31', 'E31A']], ['E32', ['E33', 'E34', 'E35', 'E36', 'E36A']]]) {
    if (anyOf(parts) && (!has(v[total]) || n(v[total]) < sum(parts))) v[total] = str(sum(parts));
  }
  if (anyOf(['E19', 'E20', 'E21', 'E26', 'E27', 'E32'])) v.E37 = str(n(v.E19) + n(v.E20) + n(v.E21) - n(v.E26) - n(v.E27) - n(v.E32)); else v.E37 = '';
  const x = n(v.E37) + n(v.E38) - n(v.E39) - n(v.E39A);
  if (anyOf(['E37', 'E38', 'E39', 'E39A'])) { v.E40 = x >= 0n ? str(x) : ''; v.E41 = x < 0n ? str(-x) : ''; } else { v.E40 = ''; v.E41 = ''; }
  if (has(v.E40) && !has(v.E43)) v.E43 = str(n(v.E40) - n(v.E42));
  if (!has(v.E40)) v.E43 = '';
  let e48;
  if (has(v.E40)) e48 = n(v.E43) - n(v.E45) + n(v.E43A) - n(v.E43B) + n(v.E44) - n(v.E46) - n(v.E47) - n(v.E47A);
  else { const t = n(v.E43A) - n(v.E43B) + n(v.E44) - n(v.E46) - n(v.E47) - n(v.E47A) - n(v.E41); e48 = t >= 0n && anyOf(['E43A', 'E44']) ? t : null; }
  v.E48 = e48 === null ? '' : str(e48);
  v.E52 = has(v.E48) ? str(n(v.E48) - sum(['E49', 'E50', 'E51', 'E51A'])) : '';
  if (has(v.E52) && !has(v.E52A) && !has(v.E52B)) v.E52A = v.E52;
  const year = Number(String(v.B_ML_DataNuo || '').slice(0, 4)) || 2026;
  for (const s of ['A', 'B']) {
    const base = v[`E52${s}`];
    v[`E54${s}`] = has(base) && has(v[`E53${s}`]) ? rateField(rateFor(v[`E53${s}`], year)) : '';
    v[`E55${s}`] = has(base) && has(v[`E54${s}`]) ? str(pct(n(base), v[`E54${s}`])) : '';
  }
  v.E55 = anyOf(['E55A', 'E55B']) ? str(n(v.E55A) + n(v.E55B)) : '';
  v.E59 = anyOf(['E55', 'E56', 'E58']) ? str(n(v.E55) - n(v.E56) - n(v.E58)) : '';
  const e62 = n(v.E59) - n(v.E60) - n(v.E61);
  v.E62 = e62 !== 0n ? str(e62) : '';
  v.E64 = anyOf(['E62', 'E63']) ? str(n(v.E63) - n(v.E62)) : '';
  return v;
}

/** Values for a tax year from the ledger, the non-deductible rules and the employee list. */
export async function pln204Values(db, {year}) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const bal = (await db.query(`SELECT l.account_code AS code, a.name, sum(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code
    WHERE e.entry_date BETWEEN $1 AND $2 AND l.account_code ~ '^[56]' AND ${NOT_CLOSING} GROUP BY 1, 2`, [from, to])).rows.map((r) => ({...r, bal: money.norm(r.bal)}));
  const revenue = money.neg(money.sum(bal.filter((r) => r.code[0] === '5').map((r) => r.bal)));
  const tax = money.sum(bal.filter((r) => r.code.startsWith('69')).map((r) => r.bal)); // profit tax expense: not part of profit before tax
  const expenses = money.sum(bal.filter((r) => r.code[0] === '6' && !r.code.startsWith('69')).map((r) => r.bal));
  // Non-deductible amounts by PLN204S kind code.
  const rules = (await db.query('SELECT r.*, a.name FROM tax_nondeductible_rules r JOIN accounts a ON a.code=r.account_code ORDER BY r.code, r.account_code')).rows;
  const byCode = new Map(), detail = [];
  for (const r of rules) {
    const amt = bal.filter((b) => b.code === r.account_code || b.code.startsWith(r.account_code)).reduce((a, b) => money.add(a, b.bal), '0.00');
    if (money.cmp(amt, '0') <= 0) continue;
    const part = fromUnits(divRound(toUnits(amt, 2) * toUnits(r.percent, 2), 10000n), 2);
    detail.push({account: r.account_code, name: r.name, code: r.code, percent: money.norm(r.percent), expense: amt, nondeductible: part});
    byCode.set(r.code, money.add(byCode.get(r.code) || '0', part));
  }
  // Average number of employees: employed at each month end, averaged over 12 months.
  let staffMonths = 0;
  for (let m = 1; m <= 12; m++) {
    const d = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    staffMonths += Number((await db.query(`SELECT count(*) AS c FROM employees WHERE employment_start <= $1 AND (employment_end IS NULL OR employment_end >= $1)`, [d])).rows[0].c);
  }
  const staff = Math.round(staffMonths / 12);
  const v = Object.fromEntries(PLN204_PAGES.flatMap((p) => PLN204_LAYOUTS[p].fields.map((f) => [f.name, ''])));
  const E18 = eur(revenue), E19 = eur(money.sub(revenue, expenses));
  // Reduced rate (PMĮ 5 str. 2 d.): fewer than 10 employees and income up to 300 000 € (further conditions on owners apply).
  const small = staff < 10 && money.cmp(revenue, '300000') <= 0;
  Object.assign(v, {
    B_MM_ID: String(company.company_code || '').replace(/\D/g, ''), B_MM_Pavad: [company.legal_form && !company.name.startsWith(company.legal_form) ? company.legal_form : '', company.name].filter(Boolean).join(' ').slice(0, 47),
    B_ML_DataNuo: from, B_ML_DataIki: to, B_FormVerNr: '08', E4: String(staff),
    E9: 'N', E10: 'N', 'E17-FR0528': 'N', 'E17-FR0438': 'N', E17A: 'N', E17C: 'N',
    E18: E18 !== 0n ? str(E18) : '', E19: str(E19), E53A: '',
  });
  [...byCode].sort(([a], [b]) => a.localeCompare(b)).slice(0, ROWS).forEach(([code, amt], i) => { v[`S1-${i + 1}`] = code; v[`S2-${i + 1}`] = str(eur(amt)); });
  recompute(v);
  if (has(v.E52) || has(v.E48)) v.E53A = small ? '2' : '1';
  recompute(v);
  const notes = [];
  notes.push(`53A laukelyje parinktas tarifo kodas ${v.E53A || '—'} (${small ? 'lengvatinis 7 % – mažiau nei 10 darbuotojų ir pajamos ≤ 300 000 €; patikrinkite kitas PMĮ 5 str. 2 d. sąlygas (pvz. akcininkai – fiziniai asmenys, ne pirmieji veiklos metai – tada kodas 3)' : 'standartinis'}). Pakeiskite, jei reikia.`);
  if (money.cmp(tax, '0') !== 0) notes.push(`Pelno mokesčio sąnaudos (69 grupė, ${tax} €) į 19 laukelį (pelnas prieš apmokestinimą) neįtrauktos.`);
  notes.push('Mokestinis nusidėvėjimas apskaitomas kaip buhalterinis – jei taikote kitus normatyvus (PMĮ 1 priedas), skirtumą įrašykite 25 / 36 laukeliuose ir PLN204S priede.');
  notes.push('Ankstesnių metų mokestiniai nuostoliai (45 laukelis): įrašykite patys – ne daugiau kaip 70 % 43 laukelio sumos (lengvatinį tarifą taikantiems – be ribos).');
  if (!detail.length) notes.push('Neleidžiamų atskaitymų nerasta – patikrinkite taisykles (reprezentacija, baudos, parama, dovanos ir kt.).');
  return {values: v, detail, rules, staff, revenue, expenses, notes, period: {from, to}};
}

/** User edits: whole euros in amount fields, list fields from their lists, read-only fields ignored. */
export function applyPln204Edits(values, edits = {}) {
  const v = {...values};
  const byName = new Map(PLN204_PAGES.flatMap((p) => PLN204_LAYOUTS[p].fields.map((f) => [f.name, f])));
  for (const [name, raw] of Object.entries(edits || {})) {
    const f = byName.get(name);
    if (!f) throw new AppError(400, 'field', `Nežinomas laukelis ${name}.`);
    if (f.readOnly || ['B_MM_ID', 'B_ML_DataNuo', 'B_ML_DataIki'].includes(name)) continue;
    const x = String(raw ?? '').trim().replace(/\s/g, '');
    if (f.list) { if (x !== '' && !f.list.some((o) => o.value === x)) throw new AppError(400, 'list', `Laukelyje ${name.replace(/^[ES]/, '')} – netinkama reikšmė.`); v[name] = x; continue; }
    if (f.type === 'Decimal') {
      if (f.decimals) {
        if (x !== '' && !/^\d+([.,]\d)?$/.test(x)) throw new AppError(400, 'amount', `Laukelyje ${name.slice(1)} – skaičius su vienu skaitmeniu po kablelio.`);
        v[name] = x.replace('.', ','); continue;
      }
      if (x !== '' && !/^-?\d+$/.test(x)) throw new AppError(400, 'amount', `Laukelyje ${name.replace(/^[ES]/, '')} – sveikieji eurai.`);
      if (x.replace('-', '').length > (f.cells?.length || 12)) throw new AppError(400, 'amount', `Laukelio ${name.replace(/^[ES]/, '')} reikšmė per ilga.`);
      v[name] = x === '' ? '' : String(BigInt(x));
      continue;
    }
    v[name] = x.slice(0, f.cells?.length || 255);
  }
  if (has(v.E45) && has(v.E43) && !['2', '3'].includes(v.E53A) && n(v.E45) * 10n > n(v.E43) * 7n) throw new AppError(400, 'loss_limit', '45 laukelis negali viršyti 70 % 43 laukelio sumos (PMĮ 30 str. 4 d.).');
  // 43 is re-derived from 40 and 42 unless typed in.
  if (!('E43' in (edits || {}))) v.E43 = '';
  if (!('E52A' in (edits || {}))) v.E52A = '';
  for (const k of ['E21', 'E27', 'E32']) if (!(k in (edits || {}))) v[k] = '';
  return recompute(v);
}

/** Per-page values for the file and the PDF: the S annex only when it has rows. */
export function pln204Pages(v) {
  const pages = ['PLN204', 'PLN204_2', ...(has(v.S3) ? ['PLN204S'] : [])];
  return pages.map((p) => {
    const layout = PLN204_LAYOUTS[p];
    const values = Object.fromEntries(layout.fields.map((f) => [f.name, v[f.name] ?? '']));
    values.B_FormNr = p === 'PLN204S' ? 'PLN204S' : 'PLN204';
    if ('B_FormVerNr' in values) values.B_FormVerNr = '08';
    return {code: p, layout, values, group: p === 'PLN204S' ? 'Priedas_PLN204S' : undefined};
  });
}
