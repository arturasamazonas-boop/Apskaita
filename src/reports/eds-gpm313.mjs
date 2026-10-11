// GPM313 – mėnesinė pajamų mokesčio deklaracija (version 01, VMI order VA-121), as in VMI EDS.
// Filed for the month in which payouts were made (by the 15th of the next month):
//   5 – A class employment payouts paid in the month, before NPD, GPM, VSD and PSD;
//   6 / 7 – GPM withheld from payouts made up to the 15th / after the 15th of the month;
//   8–12 – non-employment A class and B class payouts: not from payroll, typed in on the form.
import {AppError} from '../db.mjs';
import {money} from '../lib/money.mjs';
import {edsLayout} from './eds-forms.mjs';

export const GPM313 = edsLayout('GPM313');
const comma = (v) => (money.isZero(v) ? '' : money.norm(v).replace('.', ','));

export async function gpm313Values(db, {year, month}) {
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const runs = (await db.query(`SELECT r.id, r.period, r.payment_date, r.status, coalesce(sum(l.gross),0) AS gross, coalesce(sum(l.gpm),0) AS gpm
    FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id=r.id WHERE to_char(r.payment_date, 'YYYY-MM')=$1 GROUP BY r.id ORDER BY r.payment_date`, [ym])).rows
    .map((r) => ({...r, payment_date: String(r.payment_date instanceof Date ? r.payment_date.toISOString() : r.payment_date).slice(0, 10), gross: money.norm(r.gross), gpm: money.norm(r.gpm)}));
  const approved = runs.filter((r) => r.status === 'approved');
  const early = approved.filter((r) => Number(r.payment_date.slice(8, 10)) <= 15), late = approved.filter((r) => Number(r.payment_date.slice(8, 10)) > 15);
  const v = Object.fromEntries(GPM313.fields.map((f) => [f.name, '']));
  Object.assign(v, {
    B_FormNr: 'GPM313', B_FormVerNr: '01', B_MM_ID: String(company.company_code || '').replace(/\D/g, ''),
    B_MM_Pavadinimas: [company.legal_form && !company.name.startsWith(company.legal_form) ? company.legal_form : '', company.name].filter(Boolean).join(' ').slice(0, 58),
    B_ML_Metai: String(year), B_ML_Menuo: String(Number(month)),
    G5: comma(money.sum(approved.map((r) => r.gross))), G6: comma(money.sum(early.map((r) => r.gpm))), G7: comma(money.sum(late.map((r) => r.gpm))),
  });
  const notes = [];
  if (runs.some((r) => r.status !== 'approved')) notes.push(`Nepatvirtinti žiniaraščiai, kurių išmokėjimo data ${ym}, neįtraukti: ${runs.filter((r) => r.status !== 'approved').map((r) => r.period).join(', ')}.`);
  if (!approved.length) notes.push(`Žiniaraščių su išmokėjimo data ${ym} nėra – deklaracija pildoma pagal išmokėjimo mėnesį (pvz. rugsėjo DU, išmokėtas spalio 5 d., deklaruojamas spalio GPM313).`);
  notes.push('Avansai laikomi išmokėtais kartu su žiniaraščio išmokėjimu. Jei avansą mokėjote kitą mėnesį ar kitą mėnesio pusę, pataisykite 5–7 laukelius.');
  notes.push('8–12 laukelius (su darbo santykiais nesusijusios A klasės ir B klasės išmokos: autoriniai, nuoma ir kt.) įrašykite patys.');
  return {values: v, runs, notes, company: {name: company.name, code: company.company_code}};
}

/** Edits typed on the form: amounts with up to 2 decimals (comma), not negative. */
export function applyGpm313Edits(values, edits = {}) {
  const v = {...values};
  for (const [name, raw] of Object.entries(edits || {})) {
    const f = GPM313.fields.find((x) => x.name === name);
    if (!f) throw new AppError(400, 'field', `Nežinomas laukelis ${name}.`);
    if (f.readOnly || ['B_MM_ID', 'B_ML_Metai', 'B_ML_Menuo'].includes(name)) continue;
    const x = String(raw ?? '').trim().replace(/\s/g, '');
    if (f.type === 'Decimal') {
      if (x !== '' && !/^\d+([.,]\d{1,2})?$/.test(x)) throw new AppError(400, 'amount', `Laukelyje ${name.replace('G', '')} – suma eurais (pvz. 1234,56).`);
      if (x.replace(/[.,]\d*$/, '').length > f.cells.length - 2) throw new AppError(400, 'amount', `Laukelio ${name.replace('G', '')} suma per didelė.`);
      v[name] = x === '' ? '' : comma(x.replace(',', '.'));
      continue;
    }
    v[name] = String(raw ?? '').trim().slice(0, f.cells?.length || 255);
  }
  return v;
}
