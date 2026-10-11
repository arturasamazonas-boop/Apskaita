// PVM deklaracija FR0600 (versija 03, nuo 2026-01-01) exactly as in VMI EDS: the official form layout
// (assets/forms/fr0600-v3.*, extracted from the VMI .mxfd template by scripts/mxfd-layout.py),
// field values per the VMI filling rules (VA-129, 2025-12-22), an FFData file for upload to EDS and a PDF on the form background.
import fs from 'node:fs';
import path from 'node:path';
import {PDFDocument, rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {ROOT} from '../config.mjs';
import {money, toUnits, divRound} from '../lib/money.mjs';
import {AppError} from '../db.mjs';

export const LAYOUT = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/forms/fr0600-v3.json'), 'utf8'));
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Aprašo 11.4 p.: sums in whole euros, 49 cents and less dropped, 50 and more rounded up (half away from zero for negatives).
const eur = (v) => divRound(toUnits(v, 2), 100n);

/** Field values (FFData names) for a period. Empty fields stay empty (Aprašo 11.3 p.). */
export async function fr0600Values(db, {from, to, correction = false}) {
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const rows = (await db.query(`SELECT i.register, v.tax_code, coalesce(sum(v.taxable),0) AS taxable, coalesce(sum(v.vat),0) AS vat, coalesce(sum(v.deductible_vat),0) AS deductible
    FROM invoices i JOIN invoice_vat_rows v ON v.invoice_id=i.id WHERE coalesce(i.vat_point_date, i.issue_date) BETWEEN $1 AND $2 GROUP BY 1, 2`, [from, to])).rows;
  const sum = (pred, k) => money.sum(rows.filter(pred).map((r) => r[k]));
  const S = (codes) => (r) => r.register === 'sales' && codes.includes(r.tax_code);
  const KNOWN = ['PVM1', 'PVM2', 'PVM3', 'PVM58', 'PVM5', 'PVM12', 'PVM13'];
  const n = {
    E11: eur(sum(S(['PVM1', 'PVM2', 'PVM3', 'PVM58']), 'taxable')),
    E13: eur(sum(S(['PVM5']), 'taxable')),
    E17: eur(sum(S(['PVM12']), 'taxable')),
    E18: eur(sum(S(['PVM13']), 'taxable')),
    E19: eur(sum((r) => r.register === 'sales' && !KNOWN.includes(r.tax_code), 'taxable')),
    E25: eur(sum((r) => r.register === 'purchase', 'vat')),
    E29: eur(sum(S(['PVM1']), 'vat')),
    E29A: eur(sum(S(['PVM58']), 'vat')),
    E30: eur(sum(S(['PVM2']), 'vat')),
    E31: eur(sum(S(['PVM3']), 'vat')),
    E35: eur(sum((r) => r.register === 'purchase', 'deductible')),
  };
  // 36 = 27 + 29 + 29A + 30 + 31 + 32 + 33 + 34 − 35, from the rounded fields as EDS calculates it.
  const v = Object.fromEntries(LAYOUT.fields.map((f) => [f.name, '']));
  for (const [k, x] of Object.entries(n)) v[k] = x === 0n ? '' : String(x);
  recompute36(v);
  Object.assign(v, {
    B_FormNr: 'FR0600', B_FormVerNr: '03', LT: 'LT',
    B_MM_Pavad: [company.legal_form && !company.name.startsWith(company.legal_form) ? company.legal_form : '', company.name].filter(Boolean).join(' ').slice(0, 30),
    B_MM_ID: String(company.company_code || '').replace(/\D/g, ''),
    // 3–6 and 10 are not filled in by the taxpayer (Aprašo 16–19, 23 p.); EDS fills them.
    B_ML_DataNuo: from, B_ML_DataIki: to,
    B_Pirmine: correction ? '' : '1', B_Patikslinta: correction ? '1' : '', E8: correction ? 'B_Patikslinta' : 'B_Pirmine',
    'E9-1': '1', 'E9-2': '', E9: 'E9-1',
  });
  const notes = [];
  if (rows.some((r) => r.register === 'purchase' && !money.eq(r.vat, r.deductible))) notes.push('25 laukelyje – visas pirkimo PVM, 35 laukelyje – tik atskaitomas (neatskaitomas PVM, pvz. reprezentacijos, į 35 neįtraukiamas).');
  if (rows.some((r) => r.register === 'sales' && !KNOWN.includes(r.tax_code))) notes.push('19 laukelyje – pardavimai su kitais PVM kodais; patikrinkite, ar jie turi būti deklaruojami 19 laukelyje.');
  notes.push('Atvirkštinio apmokestinimo, importo ir ES įsigijimų laukelių (12, 14–16, 20–24, 26–28, 32–34) programa nepildo – įrašykite juos EDS, jei turite tokių sandorių.');
  return {values: v, period: {from, to}, correction, notes, company: {name: company.name, code: company.company_code, vatCode: company.vat_code}};
}

const SUM36 = ['E27', 'E29', 'E29A', 'E30', 'E31', 'E32', 'E33', 'E34'];
/** Fills field 36 from the other fields: 36 = 27 + 29 + 29A + 30 + 31 + 32 + 33 + 34 − 35 (empty when all are empty). */
export function recompute36(v) {
  const keys = [...SUM36, 'E35'];
  if (keys.every((k) => (v[k] ?? '') === '')) { v.E36 = ''; return v; }
  v.E36 = String(SUM36.reduce((a, k) => a + BigInt(v[k] || 0), 0n) - BigInt(v.E35 || 0));
  return v;
}

/** Applies the user's edits from the on-screen form to the calculated values, the way EDS validates the fields. */
export function applyEdits(values, edits = {}) {
  const v = {...values};
  const byName = Object.fromEntries(LAYOUT.fields.map((f) => [f.name, f]));
  for (const [name, raw] of Object.entries(edits || {})) {
    const f = byName[name];
    if (!f) throw new AppError(400, 'field', `Nežinomas laukelis ${name}.`);
    if (f.readOnly || ['E8', 'E9'].includes(name)) continue; // calculated or printed on the form
    const x = String(raw ?? '').trim();
    if (f.type === 'Checkmark') { v[name] = x === '1' ? '1' : ''; continue; }
    if (f.type === 'Decimal') {
      const n = x.replace(/\s/g, '');
      if (n !== '' && !/^-?\d+$/.test(n)) throw new AppError(400, 'amount', `Laukelyje ${name.replace(/^E/, '')} – tik sveikieji skaičiai (eurais be centų).`);
      if (n.replace('-', '').length > f.cells.length) throw new AppError(400, 'amount', `Laukelio ${name.replace(/^E/, '')} reikšmė per ilga.`);
      if (name === 'E28' && n !== '' && (Number(n) < 0 || Number(n) > 100)) throw new AppError(400, 'amount', '28 laukelyje – procentas nuo 0 iki 100.');
      v[name] = n === '' ? '' : String(BigInt(n));
      continue;
    }
    if (f.type === 'Date') {
      if (x !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(x)) throw new AppError(400, 'date', `Netinkama data laukelyje ${name}.`);
      v[name] = x; continue;
    }
    v[name] = x.slice(0, f.cells?.length || 255);
  }
  // Radio groups hold the name of the chosen checkmark.
  if (v.B_Patikslinta === '1' && edits.B_Patikslinta === '1') v.B_Pirmine = '';
  if (v.B_Pirmine === '1' && edits.B_Pirmine === '1') v.B_Patikslinta = '';
  v.E8 = v.B_Patikslinta === '1' ? 'B_Patikslinta' : v.B_Pirmine === '1' ? 'B_Pirmine' : '';
  if (v['E9-2'] === '1' && edits['E9-2'] === '1') v['E9-1'] = '';
  if (v['E9-1'] === '1' && edits['E9-1'] === '1') v['E9-2'] = '';
  v.E9 = v['E9-1'] === '1' ? 'E9-1' : v['E9-2'] === '1' ? 'E9-2' : '';
  return recompute36(v);
}

/** FFData XML for upload to EDS („Pildyti formą“ → „Įkelti failą“). */
export function toFFData(values, {login = 'apskaita', today}) {
  const f = LAYOUT.fields;
  return `<?xml version="1.0" encoding="UTF-8"?>
<FFData Version="1" CreatedByApp="Apskaita" CreatedByLogin="${xmlEsc(login)}" CreatedOn="${today}">
<Form FormDefId="${LAYOUT.formDefId}">
<DocumentPages>
<Group Name="${xmlEsc(LAYOUT.group)}">
<ListPages>
<ListPage>${LAYOUT.formCode}</ListPage>
</ListPages>
</Group>
</DocumentPages>
<Pages Count="1">
<Page PageDefName="${LAYOUT.formCode}" PageNumber="1">
<Fields Count="${f.length}">
${f.map((x) => `<Field Name="${xmlEsc(x.name)}">${xmlEsc(values[x.name] ?? '')}</Field>`).join('\n')}
</Fields>
</Page>
</Pages>
</Form>
</FFData>
`;
}

/** Characters to draw per field: [{name, chars: [[cellRect, char]], mark: rect}] in template units (300 dpi). */
export function placements(values) {
  const out = [];
  for (const f of LAYOUT.fields) {
    const v = values[f.name] ?? '';
    if (f.type === 'Checkmark') { if (v === '1') out.push({name: f.name, mark: f.rect}); continue; }
    if (!f.cells || v === '' || ['B_FormNr', 'B_FormVerNr', 'LT'].includes(f.name)) continue; // printed on the form
    let s = String(v);
    if (f.type === 'Date') { out.push({name: f.name, chars: [...s].map((ch, i) => [f.cells[i], ch]).filter(([c, ch]) => c && ch !== '-')}); continue; }
    if (f.type === 'Text') s = s.toUpperCase();
    s = s.slice(0, f.cells.length);
    const start = f.align === 'RightJustified' ? f.cells.length - s.length : 0;
    out.push({name: f.name, chars: [...s].map((ch, i) => [f.cells[start + i], ch])});
  }
  return out;
}

// Form page within assets/forms/fr0600-v3.pdf (points, PDF origin bottom-left), measured from a 300 dpi render.
const BG_BOX = {left: 28.32, right: 567.12, bottom: 841.89 - 801.84, top: 841.89 - 40.08};

export async function renderFr0600Pdf(values) {
  const bg = await PDFDocument.load(fs.readFileSync(path.join(ROOT, 'assets/forms/fr0600-v3.pdf')));
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('FR0600 PVM deklaracija'); doc.setProducer('Apskaita');
  const font = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'assets/fonts/DejaVuSans.ttf')), {subset: true});
  // The converted background has the form page (grey area) shrunk inside white margins; crop it to the form page and stretch it to A4.
  const W = 595.28, H = 841.89;
  const page = doc.addPage([W, H]);
  const [embedded] = await doc.embedPages([bg.getPage(0)], [BG_BOX]);
  page.drawPage(embedded, {x: 0, y: 0, width: W, height: H});
  const k = W / LAYOUT.page.width;
  for (const p of placements(values)) {
    if (p.mark) {
      const [l, t, r, b] = p.mark, size = (b - t) * k * 0.95;
      page.drawText('X', {x: (l + r) / 2 * k - font.widthOfTextAtSize('X', size) / 2, y: H - b * k + (b - t) * k * 0.15, size, font, color: rgb(0, 0, 0.55)});
      continue;
    }
    for (const [[l, t, r, b], ch] of p.chars) {
      const size = (b - t) * k * 0.72;
      page.drawText(ch, {x: (l + r) / 2 * k - font.widthOfTextAtSize(ch, size) / 2, y: H - b * k + (b - t) * k * 0.2, size, font, color: rgb(0, 0, 0.55)});
    }
  }
  return Buffer.from(await doc.save());
}
