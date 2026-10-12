// VMI EDS forms: layouts extracted from the official .mxfd templates (scripts/mxfd-layout.py), FFData files for upload
// to EDS, characters placed in the form cells, and a PDF on the official form page.
import fs from 'node:fs';
import path from 'node:path';
import {PDFDocument, rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {ROOT} from '../config.mjs';

// box: the form page inside the converted background PDF (points, origin bottom-left), measured from a 600 dpi render;
// LibreOffice puts the EMF page on A4 with margins, so the PDF output crops it back to the form page.
export const EDS_FORMS = {
  FR0600: {json: 'assets/forms/fr0600-v3.json', pdf: 'assets/forms/fr0600-v3.pdf', png: '/img/fr0600-v3.png', box: {left: 28.32, right: 567.0, bottom: 841.89 - 801.84, top: 841.89 - 40.08}},
  GPM313: {json: 'assets/forms/gpm313-v1.json', pdf: 'assets/forms/gpm313-v1.pdf', png: '/img/gpm313-v1.png', box: {left: 28.32, right: 567.0, bottom: 841.89 - 612.6, top: 841.89 - 229.32}},
  // Multi-page forms: one entry per page (PageDefName), the main group's pages first, annexes in their own groups.
  PLN204: {json: 'assets/forms/pln204-v8.json', pdf: 'assets/forms/pln204-v8.pdf', png: '/img/pln204-v8.png', box: {left: 28.32, right: 567.0, bottom: 841.89 - 611.4, top: 841.89 - 230.52}},
  PLN204_2: {json: 'assets/forms/pln204-2-v8.json', pdf: 'assets/forms/pln204-2-v8.pdf', png: '/img/pln204-2-v8.png', box: {left: 28.32, right: 567.0, bottom: 841.89 - 611.4, top: 841.89 - 230.52}},
  PLN204S: {json: 'assets/forms/pln204s-v8.json', pdf: 'assets/forms/pln204s-v8.pdf', png: '/img/pln204s-v8.png', box: {left: 28.32, right: 567.0, bottom: 841.89 - 611.4, top: 841.89 - 230.52}},
};
const cache = new Map();
export function edsLayout(code) {
  if (!cache.has(code)) cache.set(code, {...JSON.parse(fs.readFileSync(path.join(ROOT, EDS_FORMS[code].json), 'utf8')), png: EDS_FORMS[code].png});
  return cache.get(code);
}
const PRINTED = new Set(['B_FormNr', 'B_FormVerNr', 'LT']);
const fieldsXml = (layout, values) => `<Fields Count="${layout.fields.length}">\n${layout.fields.map((x) => `<Field Name="${xmlEsc(x.name)}">${xmlEsc(values[x.name] ?? '')}</Field>`).join('\n')}\n</Fields>`;
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** FFData XML for upload to EDS („Pildyti formą“ → „Įkelti failą“). */
export function toFFData(layout, values, {login = 'apskaita', today}) {
  const f = layout.fields;
  return `<?xml version="1.0" encoding="UTF-8"?>
<FFData Version="1" CreatedByApp="Apskaita" CreatedByLogin="${xmlEsc(login)}" CreatedOn="${today}">
<Form FormDefId="${layout.formDefId}">
<DocumentPages>
<Group Name="${xmlEsc(layout.group)}">
<ListPages>
<ListPage>${layout.formCode}</ListPage>
</ListPages>
</Group>
</DocumentPages>
<Pages Count="1">
<Page PageDefName="${layout.formCode}" PageNumber="1">
<Fields Count="${f.length}">
${f.map((x) => `<Field Name="${xmlEsc(x.name)}">${xmlEsc(values[x.name] ?? '')}</Field>`).join('\n')}
</Fields>
</Page>
</Pages>
</Form>
</FFData>
`;
}

/**
 * FFData of a multi-page form: `pages` = [{layout, values, group?}] in page order; pages without `group` belong to the
 * main group, the others are annexes nested in it (one <Group> per annex page), as in the VMI/Sodra FFData description.
 */
export function toFFDataPages({formDefId, mainGroup}, pages, {login = 'apskaita', today}) {
  const main = pages.filter((p) => !p.group), annex = pages.filter((p) => p.group);
  const list = (names) => `<ListPages>\n${names.map((n) => `<ListPage>${n}</ListPage>`).join('\n')}\n</ListPages>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<FFData Version="1" CreatedByApp="Apskaita" CreatedByLogin="${xmlEsc(login)}" CreatedOn="${today}">
<Form FormDefId="${formDefId}">
<DocumentPages>
<Group Name="${xmlEsc(mainGroup)}">
${list(main.map((p) => p.layout.pageName || p.layout.formCode))}
${annex.map((p) => `<Group Name="${xmlEsc(p.group)}">\n${list([p.layout.pageName])}\n</Group>`).join('\n')}
</Group>
</DocumentPages>
<Pages Count="${pages.length}">
${[...main, ...annex].map((p, i) => `<Page PageDefName="${p.layout.pageName || p.layout.formCode}" PageNumber="${i + 1}">\n${fieldsXml(p.layout, p.values)}\n</Page>`).join('\n')}
</Pages>
</Form>
</FFData>
`;
}

/** Cell text of a decimal value: digits only, the decimal separator is printed on the form between the cells. */
function decimalChars(f, v) {
  const d = f.decimals || 0;
  if (!d) return String(v);
  const [i, frac = ''] = String(v).replace('.', ',').split(',');
  return i + (frac + '0'.repeat(d)).slice(0, d);
}

/** Characters to draw per field: [{name, chars: [[cellRect, char]], mark: rect}] in template units (300 dpi). */
export function placements(layout, values) {
  const out = [];
  for (const f of layout.fields) {
    const v = values[f.name] ?? '';
    if (f.type === 'Checkmark') { if (v === '1') out.push({name: f.name, mark: f.rect}); continue; }
    if (!f.cells || v === '' || PRINTED.has(f.name)) continue;
    let s = f.type === 'Decimal' ? decimalChars(f, v) : String(v);
    if (f.type === 'Date') { out.push({name: f.name, chars: [...s].map((ch, i) => [f.cells[i], ch]).filter(([c, ch]) => c && ch !== '-')}); continue; }
    if (f.type === 'Text') s = s.toUpperCase();
    s = s.slice(0, f.cells.length);
    const start = f.align === 'RightJustified' ? f.cells.length - s.length : 0;
    out.push({name: f.name, chars: [...s].map((ch, i) => [f.cells[start + i], ch])});
  }
  return out;
}

/** The form page(s) with the values in their cells. `pages` = [{code, values}] (code: key of EDS_FORMS). */
export async function renderEdsPages(pages, {title} = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title || pages[0].code); doc.setProducer('Apskaita');
  const font = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'assets/fonts/DejaVuSans.ttf')), {subset: true});
  const blue = rgb(0, 0, 0.55);
  for (const {code, values} of pages) {
    const def = EDS_FORMS[code], layout = edsLayout(code);
    const bg = await PDFDocument.load(fs.readFileSync(path.join(ROOT, def.pdf)));
    const landscape = layout.page.width > layout.page.height;
    const W = landscape ? 841.89 : 595.28, H = landscape ? 595.28 : 841.89;
    const page = doc.addPage([W, H]);
    const [embedded] = await doc.embedPages([bg.getPage(0)], [def.box]);
    page.drawPage(embedded, {x: 0, y: 0, width: W, height: H});
    const k = W / layout.page.width, ky = H / layout.page.height;
    for (const p of placements(layout, values)) {
      if (p.mark) {
        const [l, t, r, b] = p.mark, size = (b - t) * ky * 0.95;
        page.drawText('X', {x: (l + r) / 2 * k - font.widthOfTextAtSize('X', size) / 2, y: H - b * ky + (b - t) * ky * 0.15, size, font, color: blue});
        continue;
      }
      for (const [[l, t, r, b], ch] of p.chars) {
        const size = Math.min((b - t) * ky * 0.72, (r - l) * k * 1.1);
        page.drawText(ch, {x: (l + r) / 2 * k - font.widthOfTextAtSize(ch, size) / 2, y: H - b * ky + (b - t) * ky * 0.2, size, font, color: blue});
      }
    }
  }
  return Buffer.from(await doc.save());
}
export const renderEdsPdf = (code, values, opts) => renderEdsPages([{code, values}], opts);
