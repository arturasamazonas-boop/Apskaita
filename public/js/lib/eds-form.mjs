// An EDS form as VMI shows it: the official form page as background, each value character in its own cell
// (same placement rules as src/reports/eds-forms.mjs), editable fields typed in by clicking them.
import {h} from '../core.mjs';

const PRINTED = new Set(['B_FormNr', 'B_FormVerNr', 'LT']);

/** Cell text: decimals without the separator (it is printed on the form), dates without dashes, text in capitals. */
export function cellChars(f, v) {
  if (!f.cells || v === '' || v === undefined || v === null) return [];
  let s = String(v);
  if (f.type === 'Date') return [...s].map((ch, i) => [f.cells[i], ch]).filter(([c, ch]) => c && ch !== '-');
  if (f.type === 'Decimal' && f.decimals) { const [i, frac = ''] = s.replace('.', ',').split(','); s = i + (frac + '0'.repeat(f.decimals)).slice(0, f.decimals); }
  if (f.type === 'Text') s = s.toUpperCase();
  s = s.slice(0, f.cells.length);
  const start = f.align === 'RightJustified' ? f.cells.length - s.length : 0;
  return [...s].map((ch, i) => [f.cells[start + i], ch]);
}

/**
 * @param layout  layout JSON (fields, page, png)
 * @param values  field values (FFData)
 * @param onCheck (field, on) → called when a checkmark is clicked
 * @param onInput (field, raw) → returns the value to store, or throws Error with a message
 */
export function edsFormView({layout, values, label, onCheck, onInput}) {
  const {width: PW, height: PH} = layout.page;
  const pct = (x, total) => `${(x / total) * 100}%`;
  const box = ([l, t, r, b]) => ({left: pct(l, PW), top: pct(t, PH), width: pct(r - l, PW), height: pct(b - t, PH)});
  const cq = (units, k) => `${(units / PW) * 100 * k}cqw`; // size relative to the form width
  const form = h('div', {class: 'eds-form', role: 'group', 'aria-label': label}, h('img', {class: 'eds-bg', src: layout.png, alt: '', draggable: 'false'}));
  for (const f of layout.fields) {
    if (f.type === 'Radiogroup' || PRINTED.has(f.name)) continue;
    if (f.type === 'Checkmark') {
      const on = values[f.name] === '1';
      form.append(h('button', {type: 'button', class: ['eds-check', on && 'on'], style: {...box(f.rect), fontSize: cq(f.rect[3] - f.rect[1], 0.8)}, title: f.name, 'data-field': f.name, 'aria-pressed': String(on),
        onclick: () => onCheck?.(f, !on)}, on ? 'X' : ''));
      continue;
    }
    const wrap = h('div', {class: ['eds-field', f.readOnly && 'ro'], style: box(f.rect), 'data-field': f.name});
    const [fl, ft, fr, fb] = f.rect;
    for (const [[l, t, r, b], ch] of cellChars(f, values[f.name])) {
      wrap.append(h('span', {class: 'eds-ch', style: {left: pct(l - fl, fr - fl), top: pct(t - ft, fb - ft), width: pct(r - l, fr - fl), height: pct(b - t, fb - ft), fontSize: cq(Math.min(b - t, (r - l) * 1.5), 0.72)}}, ch));
    }
    if (!f.readOnly && onInput) {
      const cellH = f.cells?.[0] ? f.cells[0][3] - f.cells[0][1] : fb - ft;
      const inp = h('input', {class: ['eds-input', f.align === 'RightJustified' && 'right'], value: values[f.name] || '', 'aria-label': `Laukelis ${f.name.replace(/^[EG]/, '')}`,
        inputmode: f.type === 'Decimal' ? 'decimal' : undefined, style: {fontSize: cq(cellH, 0.7)},
        maxlength: f.type === 'Date' ? 10 : (f.cells?.length || 255) + (f.type === 'Decimal' ? 2 : 0), placeholder: f.type === 'Date' ? 'MMMM-mm-dd' : ''});
      inp.addEventListener('change', () => onInput(f, inp.value.trim(), inp));
      wrap.append(inp);
    }
    form.append(wrap);
  }
  return form;
}
