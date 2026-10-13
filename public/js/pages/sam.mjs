// SAM – pranešimas Sodrai apie apdraustuosius (v07), shown on the official Sodra form pages, from the month's payroll sheet;
// FFData file for upload to Sodra EDAS and a PDF.
import {h, clear, get, pageHeader, section, guard, input, field, today, table, money, apiUrl} from '../core.mjs';
import {edsFormView} from '../lib/eds-form.mjs';

const prevMonth = () => { const [y, m] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export async function render(main, rest, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = input({type: 'month', value: params.get('month') || prevMonth()});
  const revised = h('input', {type: 'checkbox'});
  const preparator = input({value: state.user?.name || '', placeholder: 'Vardas, pavardė, tel., el. paštas'});
  const out = h('div'), info = h('div');
  let seq = 0;
  const q = () => new URLSearchParams({year: month.value.slice(0, 4), month: String(Number(month.value.slice(5, 7))), revised: revised.checked ? '1' : '0', preparator: preparator.value});
  const load = async () => {
    history.replaceState(null, '', `#/sam?month=${month.value}`);
    const my = ++seq;
    const d = await get(`/api/sodra/sam?${q()}`);
    if (my !== seq) return;
    clear(info, d.errors.map((e) => h('p', {class: 'issue issue-error'}, e)), d.notes.map((n) => h('p', {class: 'banner banner-warn'}, n)),
      h('div', {class: 'cards'}, [['Apdraustųjų', String(d.totals.persons)], ['Pajamos, nuo kurių skaičiuojamos įmokos', `${money(d.totals.income)} €`], ['Įmokų suma', `${money(d.totals.payment)} €`]]
        .map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, v)))),
      d.rows.length ? table([{label: 'Vardas, pavardė', render: (r) => `${r.firstName} ${r.lastName}`}, {label: 'Asmens kodas', key: 'personalCode'}, {label: 'Soc. draudimo Nr.', render: (r) => `${r.series}${r.number}`},
        {label: 'Pajamos (A11)', num: true, render: (r) => money(r.income)}, {label: 'Tarifas % (P3)', num: true, render: (r) => money(r.rate)}, {label: 'Įmokos (A12)', num: true, render: (r) => money(r.payment)}], d.rows) : null);
    clear(out, d.pages.map((p, i) => [h('h3', {class: 'eds-page-title'}, i ? `Priedas SAM3SD, ${p.values.PageNumber} lapas` : 'SAM pranešimas'),
      edsFormView({layout: d.layouts[p.code], values: p.values, label: p.code})]));
  };
  const dl = (format) => guard(async () => {
    const res = await fetch(apiUrl(`/api/sodra/sam/file?${q()}&format=${format}`), {credentials: 'same-origin'});
    if (!res.ok) throw new Error((await res.json()).error);
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `SAM.${format}`;
    const a = h('a', {href: URL.createObjectURL(await res.blob()), download: name}); document.body.append(a); a.click(); a.remove();
  });
  [month, revised].forEach((x) => x.addEventListener('change', () => guard(load)));
  preparator.addEventListener('change', () => guard(load));
  clear(main, pageHeader('SAM pranešimas Sodrai',
    h('button', {class: 'btn btn-primary', onclick: () => dl('ffdata')}, '⇩ EDAS failas (.ffdata)'),
    h('button', {class: 'btn', onclick: () => dl('pdf')}, '⇩ PDF')),
  section(null, h('div', {class: 'form-grid'}, field('Mėnuo', month), field('Užpildė (14 laukelis)', preparator), h('label', {class: 'check'}, revised, ' Patikslintas pranešimas (P35)')),
    h('p', {class: 'hint'}, 'Pranešimas apie apdraustuosius už ataskaitinį laikotarpį (SAM, 07 versija) – teikiamas Sodrai per EDAS iki kito mėnesio 15 d. Duomenys – iš patvirtinto mėnesio darbo užmokesčio žiniaraščio; forma rodoma ant oficialaus Sodros blanko. EDAS: Pranešimai → Įkelti failą.'),
    info),
  out);
  await load();
}
