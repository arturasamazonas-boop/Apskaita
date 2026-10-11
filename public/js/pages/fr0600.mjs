// PVM deklaracija FR0600 shown exactly as the VMI EDS form: the official form page as background, values in the form's cells.
// Fields the program does not fill can be typed in on the form; the EDS file (.ffdata) and the PDF are built from what is shown.
import {h, clear, get, api, pageHeader, section, guard, input, field, select, toast, today} from '../core.mjs';

const SUM36 = ['E27', 'E29', 'E29A', 'E30', 'E31', 'E32', 'E33', 'E34'];
const RADIO = {B_Pirmine: 'B_Patikslinta', B_Patikslinta: 'B_Pirmine', 'E9-1': 'E9-2', 'E9-2': 'E9-1'};
const PRINTED = ['B_FormNr', 'B_FormVerNr', 'LT'];

const prevMonth = () => {
  const [y, m] = today().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
};
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** Characters per cell, as on the paper/EDS form (same rules as src/reports/eds-fr0600.mjs placements()). */
function cellChars(f, v) {
  if (!f.cells || v === '' || v === undefined) return [];
  let s = String(v);
  if (f.type === 'Date') return [...s].map((ch, i) => [f.cells[i], ch]).filter(([c, ch]) => c && ch !== '-');
  if (f.type === 'Text') s = s.toUpperCase();
  s = s.slice(0, f.cells.length);
  const start = f.align === 'RightJustified' ? f.cells.length - s.length : 0;
  return [...s].map((ch, i) => [f.cells[start + i], ch]);
}

export async function render(main) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = input({type: 'month', value: params.get('month') || prevMonth()});
  const kind = select([['0', 'Pirminė'], ['1', 'Patikslinta']], params.get('correction') === '1' ? '1' : '0');
  const layout = await get('/api/eds/fr0600/layout');
  const {width: PW, height: PH} = layout.page;
  const pct = (x, total) => `${(x / total) * 100}%`;
  const box = ([l, t, r, b]) => ({left: pct(l, PW), top: pct(t, PH), width: pct(r - l, PW), height: pct(b - t, PH)});
  const out = h('div'), notesBox = h('div');
  let values = {}, edits = {};

  const period = () => ({from: `${month.value}-01`, to: monthEnd(month.value), correction: kind.value});
  const recompute36 = () => {
    if ([...SUM36, 'E35'].every((k) => (values[k] ?? '') === '')) { values.E36 = ''; return; }
    values.E36 = String(SUM36.reduce((a, k) => a + Number(values[k] || 0), 0) - Number(values.E35 || 0));
  };

  const draw = () => {
    const form = h('div', {class: 'eds-form', role: 'group', 'aria-label': 'FR0600 PVM deklaracija'}, h('img', {class: 'eds-bg', src: '/img/fr0600-v3.png', alt: '', draggable: 'false'}));
    for (const f of layout.fields) {
      if (f.type === 'Radiogroup' || PRINTED.includes(f.name)) continue;
      if (f.type === 'Checkmark') {
        form.append(h('button', {type: 'button', class: ['eds-check', values[f.name] === '1' && 'on'], style: box(f.rect), title: f.name, 'data-field': f.name, 'aria-pressed': String(values[f.name] === '1'),
          onclick: () => {
            const on = values[f.name] !== '1';
            values[f.name] = on ? '1' : ''; edits[f.name] = values[f.name];
            if (on && RADIO[f.name]) { values[RADIO[f.name]] = ''; edits[RADIO[f.name]] = ''; }
            if (on && f.name === 'B_Patikslinta') kind.value = '1';
            if (on && f.name === 'B_Pirmine') kind.value = '0';
            draw();
          }}, values[f.name] === '1' ? 'X' : ''));
        continue;
      }
      const wrap = h('div', {class: ['eds-field', f.readOnly && 'ro'], style: box(f.rect), 'data-field': f.name});
      for (const [[l, t, r, b], ch] of cellChars(f, values[f.name])) {
        const [fl, ft] = f.rect;
        wrap.append(h('span', {class: 'eds-ch', style: {left: pct(l - fl, f.rect[2] - fl), top: pct(t - ft, f.rect[3] - ft), width: pct(r - l, f.rect[2] - fl), height: pct(b - t, f.rect[3] - ft)}}, ch));
      }
      if (!f.readOnly) {
        const inp = h('input', {class: ['eds-input', f.align === 'RightJustified' && 'right'], value: values[f.name] || '', 'aria-label': `Laukelis ${f.name.replace(/^E/, '')}`, inputmode: f.type === 'Decimal' ? 'numeric' : undefined,
          maxlength: f.type === 'Date' ? 10 : f.cells.length + (f.type === 'Decimal' ? 1 : 0), placeholder: f.type === 'Date' ? 'MMMM-mm-dd' : ''});
        inp.addEventListener('change', () => {
          let v = inp.value.trim();
          if (f.type === 'Decimal') {
            v = v.replace(/\s/g, '');
            if (v !== '' && !/^-?\d+$/.test(v)) { toast(`Laukelyje ${f.name.replace(/^E/, '')} – tik sveikieji skaičiai (eurais be centų).`, 'error'); inp.value = values[f.name] || ''; return; }
            if (v !== '') v = String(Number(v));
          }
          values[f.name] = v; edits[f.name] = v;
          recompute36(); draw();
        });
        wrap.append(inp);
      }
      form.append(wrap);
    }
    clear(out, form);
  };

  const load = async () => {
    const p = period();
    history.replaceState(null, '', `#/fr0600?${new URLSearchParams({month: month.value, correction: p.correction})}`);
    const d = await get(`/api/eds/fr0600?${new URLSearchParams(p)}`);
    values = d.values; edits = {};
    clear(notesBox, d.notes.map((n) => h('p', {class: 'banner banner-warn'}, n)));
    draw();
  };
  const download = (format) => guard(async () => {
    const res = await api('POST', '/api/eds/fr0600/file', {...period(), format, values: edits}, {raw: true});
    if (!res.ok) throw new Error((await res.json()).error);
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `FR0600.${format}`;
    const a = h('a', {href: URL.createObjectURL(await res.blob()), download: name}); document.body.append(a); a.click(); a.remove();
    if (format === 'ffdata') toast('Failas paruoštas. EDS: „Pildyti formą“ → FR0600 → „Įkelti failą“ ir pateikite.', 'ok');
  });

  [month, kind].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('PVM deklaracija FR0600',
    h('button', {class: 'btn btn-primary', onclick: () => download('ffdata')}, '⇩ EDS failas (.ffdata)'),
    h('button', {class: 'btn', onclick: () => download('pdf')}, '⇩ PDF')),
  section(null, h('div', {class: 'form-grid'}, field('Mokestinis laikotarpis', month), field('Deklaracija', kind)),
    h('p', {class: 'hint'}, 'Forma FR0600 (03 versija) – tokia pati kaip VMI EDS. Sumos – sveikais eurais. Tuščius laukelius galite užpildyti spustelėję ant jų; 36 laukelis skaičiuojamas automatiškai (27+29+29A+30+31+32+33+34−35). 3–6 ir 10 laukelius užpildo EDS.'),
    h('p', {class: 'hint'}, 'Programa deklaracijos nepateikia: atsisiųstą .ffdata failą įkelkite EDS sistemoje (Pildyti formą → FR0600 → Įkelti failą), patikrinkite ir pateikite. ',
      h('a', {href: '#/ataskaitos/pvm-deklaracija'}, 'Skaičiavimo išklotinė pagal PVM kodus →')),
    notesBox),
  out);
  await load();
}
