// GPM313 mėnesinė pajamų mokesčio deklaracija shown as the VMI EDS form, from payroll sheets by payment month.
import {h, clear, get, api, pageHeader, section, guard, input, field, toast, today, table, money, date} from '../core.mjs';
import {edsFormView} from '../lib/eds-form.mjs';

export async function render(main) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  // GPM313 is filed for the previous month (payouts made in it), so that month is shown first.
  const prev = (() => { const [y, m] = today().slice(0, 7).split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const month = input({type: 'month', value: params.get('month') || prev});
  const layout = await get('/api/eds/gpm313/layout');
  const out = h('div'), notesBox = h('div'), runsBox = h('div');
  let values = {}, edits = {};
  const ym = () => ({year: month.value.slice(0, 4), month: String(Number(month.value.slice(5, 7)))});
  const draw = () => clear(out, edsFormView({layout, values, label: 'GPM313 mėnesinė pajamų mokesčio deklaracija',
    onInput: (f, raw, inp) => {
      let v = raw.replace(/\s/g, '');
      if (f.type === 'Decimal' && f.decimals) {
        if (v !== '' && !/^\d+([.,]\d{1,2})?$/.test(v)) { toast(`Laukelyje ${f.name.replace('G', '')} – suma eurais (pvz. 1234,56).`, 'error'); inp.value = values[f.name] || ''; return; }
        if (v !== '') v = Number(v.replace(',', '.')).toFixed(2).replace('.', ',');
      }
      values[f.name] = v; edits[f.name] = v; draw();
    }}));
  let seq = 0;
  const load = async () => {
    history.replaceState(null, '', `#/gpm313?month=${month.value}`);
    const my = ++seq;
    const d = await get(`/api/eds/gpm313?${new URLSearchParams(ym())}`);
    if (my !== seq) return; // a newer period was chosen meanwhile
    values = d.values; edits = {};
    clear(notesBox, d.notes.map((n) => h('p', {class: 'banner banner-warn'}, n)));
    clear(runsBox, d.runs.length ? table([{label: 'DU mėnuo', key: 'period'}, {label: 'Išmokėta', render: (r) => date(r.payment_date)}, {label: 'Būsena', render: (r) => (r.status === 'approved' ? 'Patvirtintas' : 'Juodraštis – neįtrauktas')},
      {label: 'Bruto', num: true, render: (r) => money(r.gross)}, {label: 'GPM', num: true, render: (r) => money(r.gpm)}], d.runs) : null);
    draw();
  };
  const download = (format) => guard(async () => {
    const res = await api('POST', '/api/eds/gpm313/file', {...ym(), format, values: edits}, {raw: true});
    if (!res.ok) throw new Error((await res.json()).error);
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `GPM313.${format}`;
    const a = h('a', {href: URL.createObjectURL(await res.blob()), download: name}); document.body.append(a); a.click(); a.remove();
    if (format === 'ffdata') toast('Failas paruoštas. EDS: „Pildyti formą“ → GPM313 → „Įkelti failą“ ir pateikite.', 'ok');
  });
  month.addEventListener('change', () => guard(load));
  clear(main, pageHeader('GPM313 mėnesinė pajamų mokesčio deklaracija',
    h('button', {class: 'btn btn-primary', onclick: () => download('ffdata')}, '⇩ EDS failas (.ffdata)'),
    h('button', {class: 'btn', onclick: () => download('pdf')}, '⇩ PDF')),
  section(null, h('div', {class: 'form-grid'}, field('Išmokėjimo mėnuo', month)),
    h('p', {class: 'hint'}, 'Forma GPM313 (01 versija) – tokia pati kaip VMI EDS. Teikiama už mėnesį, kurį išmokėtos pajamos, iki kito mėnesio 15 d. 5 laukelis – per mėnesį išmokėtas darbo užmokestis (bruto), 6 ir 7 – išskaičiuotas GPM nuo išmokų iki 15 d. ir po 15 d. pagal žiniaraščio išmokėjimo datą. Tuščius laukelius galite užpildyti spustelėję.'),
    notesBox, runsBox),
  out);
  await load();
}
