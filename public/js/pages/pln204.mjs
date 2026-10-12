// PLN204 metinė pelno mokesčio deklaracija as in VMI EDS: pages PLN204, PLN204_2 and the PLN204S annex,
// values from the ledger and the non-deductible expense rules, editable on the form, EDS file (.ffdata) and PDF.
import {h, clear, get, put, api, pageHeader, section, guard, input, field, toast, today, table, money, can, select} from '../core.mjs';
import {edsFormView} from '../lib/eds-form.mjs';

const TITLES = {PLN204: 'PLN204 – 1 lapas', PLN204_2: 'PLN204 – 2 lapas', PLN204S: 'PLN204S priedas – neleidžiami atskaitymai'};

export async function render(main, rest, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const year = input({type: 'number', min: 2020, max: 2100, value: params.get('year') || String(Number(today().slice(0, 4)) - 1), style: {maxWidth: '8rem'}});
  const {pages, codes} = await get('/api/eds/pln204/layout');
  const out = h('div'), info = h('div'), rulesBox = h('div');
  let data = null, values = {}, edits = {}, seq = 0;
  const show = (p) => p !== 'PLN204S' || values.S3 || Object.keys(edits).some((k) => k.startsWith('S'));
  const draw = () => clear(out, Object.keys(pages).filter(show).map((p) => [h('h3', {class: 'eds-page-title'}, TITLES[p]), edsFormView({layout: {...pages[p], png: pages[p].png}, values: pageValues(p), label: TITLES[p],
    onInput: (f, raw, inp) => {
      let v = raw.replace(/\s/g, '');
      if (f.type === 'Decimal' && !f.list && !f.decimals && v !== '' && !/^-?\d+$/.test(v)) { toast(`Laukelyje ${f.name.replace(/^[ES]/, '')} – sveikieji eurai.`, 'error'); inp.value = values[f.name] || ''; return; }
      edits[f.name] = v;
      guard(recalc);
    }})]));
  const pageValues = (p) => ({...values, B_FormNr: p === 'PLN204S' ? 'PLN204S' : 'PLN204'});
  // Recalculation is done by the server (same rules as the file), so the screen always matches what is downloaded.
  const recalc = async () => {
    const my = ++seq;
    const res = await api('POST', '/api/eds/pln204/file', {year: year.value, format: 'json', values: edits});
    if (my !== seq) return;
    if (!res.ok) { const e = await res.json(); toast(e.error, 'error'); return; }
    values = (await res.json()).values; draw();
  };
  const drawInfo = () => {
    clear(info, data.notes.map((n) => h('p', {class: 'banner banner-warn'}, n)),
      h('div', {class: 'cards'}, [['Pajamos (5 klasė)', data.revenue], ['Sąnaudos be pelno mokesčio', data.expenses], ['Vid. darbuotojų sk.', String(data.staff)]].map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, t.startsWith('Vid') ? v : `${money(v)} €`)))),
      data.detail.length ? table([{label: 'Sąskaita', render: (d) => `${d.account} ${d.name}`}, {label: 'Kodas', key: 'code'}, {label: 'Sąnaudos', num: true, render: (d) => money(d.expense)}, {label: 'Neleidžiama, %', num: true, render: (d) => money(d.percent)}, {label: 'Neleidžiami atskaitymai', num: true, render: (d) => money(d.nondeductible)}], data.detail) : null);
  };
  const drawRules = (rules) => {
    const rows = rules.map((r) => ({acc: input({value: r.account_code, style: {maxWidth: '7rem'}}), code: select(codes.map((c) => [c.value, `${c.value} – ${c.label.slice(0, 70)}`]), r.code), pct: input({value: String(Number(r.percent)), inputmode: 'decimal', style: {maxWidth: '5rem'}}), note: input({value: r.note || ''})}));
    const body = h('tbody');
    const addRow = (r) => { rows.push(r); body.append(h('tr', null, h('td', null, r.acc), h('td', null, r.code), h('td', null, r.pct), h('td', null, r.note))); };
    const all = [...rows]; rows.length = 0; all.forEach(addRow);
    clear(rulesBox, h('details', null, h('summary', null, `Neleidžiamų atskaitymų taisyklės (${rules.length})`),
      h('p', {class: 'hint'}, 'Kokia sąnaudų sąskaitos dalis laikoma neleidžiamais atskaitymais (PMĮ 31 str.) ir kokiu PLN204S rūšies kodu. Pvz. reprezentacija – 50 % (kodas 06), baudos – 100 % (01), parama – 100 % (12), dovanos – 100 % (13).'),
      h('table', {class: 'grid'}, h('thead', null, h('tr', null, ['Sąskaita', 'PLN204S kodas', '%', 'Pastaba'].map((t) => h('th', null, t)))), body),
      can(state.user, 'approve') ? h('div', {class: 'actions-left'}, h('button', {class: 'btn btn-small', onclick: () => addRow({acc: input({style: {maxWidth: '7rem'}}), code: select(codes.map((c) => [c.value, `${c.value} – ${c.label.slice(0, 70)}`]), '31'), pct: input({value: '100', style: {maxWidth: '5rem'}}), note: input()})}, '+ Taisyklė'),
        h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
          await put('/api/tax/nondeductible-rules', {rules: rows.filter((r) => r.acc.value.trim()).map((r) => ({account_code: r.acc.value.trim(), code: r.code.value, percent: r.pct.value, note: r.note.value}))});
          toast('Taisyklės išsaugotos.', 'ok'); load();
        })}, 'Išsaugoti taisykles')) : null));
  };
  const load = async () => {
    history.replaceState(null, '', `#/pln204?year=${year.value}`);
    const my = ++seq;
    const [d, rules] = await Promise.all([get(`/api/eds/pln204?year=${year.value}`), get('/api/tax/nondeductible-rules')]);
    if (my !== seq) return;
    data = d; values = d.values; edits = {};
    drawInfo(); drawRules(rules); draw();
  };
  const download = (format) => guard(async () => {
    const res = await api('POST', '/api/eds/pln204/file', {year: year.value, format, values: edits}, {raw: true});
    if (!res.ok) throw new Error((await res.json()).error);
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `PLN204.${format}`;
    const a = h('a', {href: URL.createObjectURL(await res.blob()), download: name}); document.body.append(a); a.click(); a.remove();
    if (format === 'ffdata') toast('Failas paruoštas. EDS: „Pildyti formą“ → PLN204 → „Įkelti failą“, patikrinkite ir pateikite.', 'ok');
  });
  year.addEventListener('change', () => guard(load));
  clear(main, pageHeader('PLN204 metinė pelno mokesčio deklaracija',
    h('button', {class: 'btn btn-primary', onclick: () => download('ffdata')}, '⇩ EDS failas (.ffdata)'),
    h('button', {class: 'btn', onclick: () => download('pdf')}, '⇩ PDF')),
  section(null, h('div', {class: 'form-grid'}, field('Mokestiniai metai', year)),
    h('p', {class: 'hint'}, 'Forma PLN204 (08 versija) su PLN204S priedu – tokia pati kaip VMI EDS. Teikiama iki kitų metų birželio 15 d. Sumos – sveikais eurais. 18–19 laukeliai – iš didžiosios knygos (uždarymo įrašai neįskaičiuojami), 20 – iš PLN204S priedo pagal taisykles, toliau skaičiuojama kaip EDS. Tuščius laukelius galite užpildyti spustelėję.'),
    rulesBox, info),
  out);
  await load();
}
