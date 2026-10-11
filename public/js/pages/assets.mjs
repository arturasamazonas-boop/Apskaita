// Ilgalaikis turtas: register with net book values, asset cards, monthly depreciation runs, disposal.
import {h, clear, get, post, put, del, pageHeader, section, table, money, date, guard, select, input, field, can, today, confirmDialog, promptDialog, badge, toast} from '../core.mjs';

const STATUS = {active: ['Naudojamas', 'done'], disposed: ['Nurašytas', 'muted']};
const RUN = {posted: ['Kontuota', 'done'], cancelled: ['Atšaukta', 'muted']};
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Turto sąrašas'], ['nusidevejimas', 'Nusidėvėjimo skaičiavimas']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/turtas${k ? '/' + k : ''}`}, t)));
const months = (list) => { const m = [...new Set(list)].sort(); return m.length > 3 ? `${m[0]} – ${m.at(-1)} (${m.length} mėn.)` : m.join(', '); };
const prevMonth = () => { const [y, m] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export async function render(main, rest, state) {
  if (rest[0] === 'nusidevejimas') return runs(main, state);
  if (rest[0] === 'naujas') return card(main, null, state);
  if (rest[0]) return card(main, rest[0], state);
  return list(main, state);
}

async function list(main, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const asOf = input({type: 'date', value: params.get('asOf') || today()});
  const showDisposed = h('input', {type: 'checkbox', checked: params.get('disposed') === '1'});
  const out = h('div');
  const load = async () => {
    const d = await get(`/api/fixed-assets?asOf=${asOf.value}`);
    history.replaceState(null, '', `#/turtas?${new URLSearchParams({asOf: asOf.value, ...(showDisposed.checked && {disposed: '1'})})}`);
    const items = d.items.filter((i) => showDisposed.checked || !i.disposedAtDate);
    const bad = d.reconciliation.filter((r) => Number(r.diff) !== 0);
    clear(out,
      h('div', {class: 'cards'}, [['Įsigijimo savikaina', d.totals.cost], ['Sukauptas nusidėvėjimas', d.totals.accumulated], ['Likutinė vertė', d.totals.nbv]].map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, `${money(v)} €`)))),
      items.some((i) => i.missing.length) ? h('p', {class: 'issue issue-warning'}, `Nepaskaičiuotas nusidėvėjimas už ${months(items.flatMap((i) => i.missing))} – žr. „Nusidėvėjimo skaičiavimas“.`) : null,
      table([{label: 'Inv. Nr.', key: 'inv_no'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Sąskaita', render: (i) => i.cost_account}, {label: 'Įsigyta', render: (i) => date(i.acquisition_date)},
        {label: 'Tarnavimo laikas, mėn.', num: true, key: 'useful_life_months'}, {label: 'Savikaina', num: true, render: (i) => money(i.cost)}, {label: 'Sukauptas nusidėvėjimas', num: true, render: (i) => money(i.accumulated)},
        {label: 'Likutinė vertė', num: true, render: (i) => money(i.nbv)}, {label: 'Mėn. nusidėvėjimas', num: true, render: (i) => (Number(i.monthly) ? money(i.monthly) : '—')}, {label: 'Būsena', render: (i) => badge(STATUS, i.disposedAtDate ? 'disposed' : 'active')}],
      items, {onRow: (i) => { location.hash = `#/turtas/${i.id}`; }, empty: 'Ilgalaikio turto kortelių dar nėra.'}),
      section('Sutikrinimas su didžiąja knyga', h('p', {class: 'hint'}, 'Turto sąrašo savikaina ir sukauptas nusidėvėjimas pagal sąskaitas lyginami su didžiosios knygos likučiais tai pačiai datai.'),
        table([{label: 'Sąskaita', key: 'code'}, {label: 'Pagal korteles', num: true, render: (r) => money(r.register)}, {label: 'Didžiojoje knygoje', num: true, render: (r) => money(r.ledger)},
          {label: 'Skirtumas', num: true, render: (r) => (Number(r.diff) ? h('strong', {class: 'text-error'}, money(r.diff)) : '✓')}], d.reconciliation, {empty: 'Nėra 11 / 12 grupės likučių.'}),
        bad.length ? h('p', {class: 'issue issue-warning'}, 'Skirtumas reiškia, kad dalis turto apskaitoje neturi kortelės (ar atvirkščiai) arba nusidėvėjimas buvo įrašytas ranka. Kortelę galite sukurti iš pirkimo sąskaitos eilutės.') : null));
  };
  [asOf, showDisposed].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Ilgalaikis turtas', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: '#/turtas/naujas'}, '+ Nauja turto kortelė') : null), tabs(''),
    section(null, h('div', {class: 'filters'}, field('Datai', asOf), h('label', {class: 'check'}, showDisposed, ' Rodyti nurašytą turtą'))), out);
  await load();
}

async function card(main, id, state) {
  const [a, accounts, candidates] = await Promise.all([id ? get(`/api/fixed-assets/${id}`) : null, get('/api/accounts'), id ? [] : get('/api/fixed-assets/candidates')]);
  const edit = can(state.user, 'write') && (!a || a.status === 'active');
  const acc = (prefixes, value) => select([['', '— pagal turto sąskaitą —'], ...accounts.filter((x) => x.active && x.postable !== false && prefixes.some((p) => x.code.startsWith(p))).map((x) => [x.code, `${x.code} ${x.name}`])], value || '');
  const f = {
    inv_no: input({value: a?.inv_no || ''}), name: input({value: a?.name || ''}),
    cost_account: select(accounts.filter((x) => x.active && /^1[12]\d0$/.test(x.code)).map((x) => [x.code, `${x.code} ${x.name}`]), a?.cost_account || '1220'),
    acquisition_date: input({type: 'date', value: a?.acquisition_date || today()}), cost: input({value: a?.cost || '', inputmode: 'decimal'}), residual_value: input({value: a ? a.residual_value : '0', inputmode: 'decimal'}),
    useful_life_months: input({value: a?.useful_life_months || '', inputmode: 'numeric'}), depreciation_start: input({type: 'month', value: a?.depreciation_start || ''}),
    depreciation_account: acc(['11', '12'], a?.depreciation_account), expense_account: acc(['6'], a?.expense_account),
    opening_accumulated: input({value: a ? a.opening_accumulated : '0', inputmode: 'decimal'}), opening_period: input({type: 'month', value: a?.opening_period || ''}),
    location: input({value: a?.location || ''}), responsible: input({value: a?.responsible || ''}), notes: h('textarea', {rows: 2}, a?.notes || ''),
  };
  let invoiceLine = null;
  const years = input({inputmode: 'numeric', placeholder: 'metais', style: {maxWidth: '6rem'}});
  years.addEventListener('input', () => { const y = Number(years.value.replace(',', '.')); if (y > 0) f.useful_life_months.value = String(Math.round(y * 12)); });
  if (!edit) Object.values(f).forEach((x) => { x.disabled = true; });
  const body = () => ({...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value])), ...(invoiceLine && {invoice_line_id: invoiceLine})});
  const save = (e) => guard(async () => {
    e.preventDefault();
    if (a) { await put(`/api/fixed-assets/${a.id}`, body()); toast('Kortelė išsaugota.', 'ok'); card(main, a.id, state); }
    else { const r = await post('/api/fixed-assets', body()); toast('Kortelė sukurta.', 'ok'); location.hash = `#/turtas/${r.id}`; }
  });
  const fromInvoice = candidates.length && edit ? section('Kurti iš pirkimo sąskaitos', h('p', {class: 'hint'}, 'Pirkimų eilutės, kontuotos į 11 / 12 grupės sąskaitas, kurioms dar nėra kortelės.'),
    table([{label: 'Data', render: (c) => date(c.issue_date)}, {label: 'Sąskaita', render: (c) => `${c.series || ''} ${c.number}`}, {label: 'Tiekėjas', key: 'supplier'}, {label: 'Eilutė', key: 'description'}, {label: 'Sąsk.', key: 'account_code'}, {label: 'Suma', num: true, render: (c) => money(c.net)}],
      candidates, {onRow: (c) => {
        invoiceLine = c.id; f.name.value = c.description; f.cost.value = c.net; f.acquisition_date.value = String(c.issue_date).slice(0, 10);
        if ([...f.cost_account.options].some((o) => o.value === c.account_code)) f.cost_account.value = c.account_code;
        toast('Duomenys perkelti iš sąskaitos – patikrinkite ir nurodykite tarnavimo laiką.', 'ok');
      }})) : null;
  const actions = [];
  if (a && a.status === 'active' && can(state.user, 'approve')) actions.push(h('button', {class: 'btn', onclick: () => guard(async () => {
    const d = await promptDialog('Nurašyti / parduoti turtą', 'Nurašymo data (MMMM-mm-dd)', {placeholder: today(), minLength: 10});
    if (!d) return;
    const sale = await confirmDialog('Turto perleidimas', 'Ar turtas parduodamas? (Gerai – pardavimas, Atšaukti – nurašymas). Pardavimo pajamas (5400) įregistruokite pardavimo sąskaita.', 'Parduodamas');
    const r = await post(`/api/fixed-assets/${a.id}/dispose`, {date: d.trim(), kind: sale ? 'sale' : 'writeoff'});
    toast(`Turtas nurašytas, likutinė vertė ${money(r.nbv)} € – į 6400.`, 'ok'); card(main, a.id, state);
  })}, 'Nurašyti / parduoti'));
  if (a && !a.history.length && a.status === 'active' && can(state.user, 'write')) actions.push(h('button', {class: 'btn btn-danger', onclick: () => guard(async () => {
    if (!await confirmDialog('Ištrinti kortelę', `Ištrinti ${a.inv_no}?`, 'Ištrinti')) return;
    await del(`/api/fixed-assets/${a.id}`); location.hash = '#/turtas';
  })}, 'Ištrinti'));
  clear(main, pageHeader(a ? `${a.inv_no} ${a.name}` : 'Nauja ilgalaikio turto kortelė', ...actions), tabs(''),
    a ? h('div', {class: 'cards'}, [['Savikaina', a.cost], ['Sukauptas nusidėvėjimas', a.accumulated], ['Likutinė vertė', a.nbv], ['Mėnesio nusidėvėjimas', a.monthly]].map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, `${money(v)} €`)))) : null,
    a?.status === 'disposed' ? h('p', {class: 'banner'}, `Turtas ${a.disposal_kind === 'sale' ? 'parduotas' : 'nurašytas'} ${a.disposed_on}. ${a.disposal_note || ''}`) : null,
    a?.missing?.length ? h('p', {class: 'issue issue-warning'}, `Nepaskaičiuotas nusidėvėjimas už ${months(a.missing)}.`) : null,
    fromInvoice,
    section('Kortelė', h('form', {onsubmit: save},
      h('div', {class: 'form-grid'}, field('Inventorinis Nr.', f.inv_no), field('Pavadinimas', f.name), field('Turto sąskaita', f.cost_account), field('Įsigijimo (naudojimo pradžios) data', f.acquisition_date),
        field('Įsigijimo savikaina, €', f.cost), field('Likvidacinė vertė, €', f.residual_value), field('Naudingo tarnavimo laikas, mėn.', f.useful_life_months, h('span', null, 'arba įveskite metais: ', years)),
        field('Nusidėvėjimas skaičiuojamas nuo', f.depreciation_start, 'Tuščia – nuo kito mėnesio po naudojimo pradžios'), field('Sukaupto nusidėvėjimo sąskaita', f.depreciation_account), field('Sąnaudų sąskaita', f.expense_account),
        field('Perkeltas sukauptas nusidėvėjimas, €', f.opening_accumulated, 'Turtui, įsigytam prieš pradedant naudoti programą'), field('Sukauptas iki mėnesio (imtinai)', f.opening_period),
        field('Buvimo vieta', f.location), field('Atsakingas asmuo', f.responsible), field('Pastabos', f.notes)),
      h('p', {class: 'hint'}, 'Tiesiogiai proporcingas (tiesinis) metodas: (savikaina − likvidacinė vertė) / tarnavimo laikas mėnesiais; paskutinį mėnesį – likutis. Mokesčiams taikomi normatyviniai laikai (Pelno mokesčio įstatymo 1 priedas), pvz. kompiuteriai – 3 m., baldai – 6 m., lengvieji automobiliai – 6 m.'),
      edit ? h('button', {class: 'btn btn-primary'}, a ? 'Išsaugoti' : 'Sukurti kortelę') : null)),
    a ? section('Nusidėvėjimo istorija ir grafikas', h('div', {class: 'two-col'},
      table([{label: 'Mėnuo', key: 'period'}, {label: 'Paskaičiuota', num: true, render: (x) => money(x.amount)}], a.history, {empty: 'Nusidėvėjimas dar neskaičiuotas.'}),
      table([{label: 'Mėnuo', key: 'period'}, {label: 'Nusidėvėjimas', num: true, render: (x) => money(x.amount)}, {label: 'Sukauptas', num: true, render: (x) => money(x.accumulated)}, {label: 'Likutinė vertė', num: true, render: (x) => money(x.nbv)}],
        a.forecast.slice(0, 24), {empty: 'Turtas visiškai nudėvėtas.'}))) : null);
}

async function runs(main, state) {
  const period = input({type: 'month', value: prevMonth()});
  const out = h('div'), hist = h('div');
  const loadHist = async () => {
    const rows = await get('/api/depreciation/runs');
    clear(hist, table([{label: 'Mėnuo', key: 'period'}, {label: 'Būsena', render: (r) => badge(RUN, r.status)}, {label: 'Turto vnt.', num: true, key: 'assets'}, {label: 'Suma', num: true, render: (r) => money(r.total)}, {label: 'Įrašas', render: (r) => r.journal_entry_id || '—'},
      {label: '', render: (r) => (r.status === 'posted' && can(state.user, 'approve') ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => {
        const reason = await promptDialog('Atšaukti nusidėvėjimą', 'Priežastis', {minLength: 5});
        if (!reason) return;
        await post(`/api/depreciation/runs/${r.id}/cancel`, {reason}); toast('Atšaukta atvirkštiniu įrašu.', 'ok'); loadHist(); preview();
      })}, 'Atšaukti') : r.cancel_reason || '')}], rows, {empty: 'Nusidėvėjimas dar neskaičiuotas.'}));
  };
  let seq = 0;
  const preview = async () => {
    const my = ++seq;
    const p = await get(`/api/depreciation/preview?period=${period.value}`);
    if (my !== seq) return; // a newer month was chosen meanwhile
    clear(out,
      p.alreadyPosted ? h('p', {class: 'banner'}, `Už ${p.period} nusidėvėjimas jau paskaičiuotas.`) : null,
      p.blocked.length ? h('p', {class: 'issue issue-error'}, `Pirmiausia paskaičiuokite ankstesnius mėnesius: ${months(p.blocked.flatMap((b) => b.missing))}.`) : null,
      table([{label: 'Inv. Nr.', key: 'inv_no'}, {label: 'Pavadinimas', key: 'name'}, {label: 'D', key: 'expense_account'}, {label: 'K', key: 'depreciation_account'}, {label: 'Nusidėvėjimas', num: true, render: (l) => money(l.amount)},
        {label: 'Sukauptas po', num: true, render: (l) => money(l.accumulatedAfter)}], p.lines, {empty: p.alreadyPosted ? '—' : 'Šį mėnesį nudėvimo turto nėra.'}),
      p.lines.length ? h('p', null, h('strong', null, `Iš viso: ${money(p.total)} €`)) : null,
      p.lines.length && !p.blocked.length && !p.alreadyPosted && can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
        const r = await post('/api/depreciation/runs', {period: period.value});
        toast(`Nusidėvėjimas ${money(r.total)} € užregistruotas (įrašas #${r.entryId}).`, 'ok'); preview(); loadHist();
      })}, `Skaičiuoti ir kontuoti ${period.value}`) : null);
  };
  period.addEventListener('change', () => guard(preview));
  clear(main, pageHeader('Nusidėvėjimo skaičiavimas'), tabs('nusidevejimas'),
    section(null, h('div', {class: 'filters'}, field('Mėnuo', period)), h('p', {class: 'hint'}, 'Mėnesio nusidėvėjimas kontuojamas vienu įrašu mėnesio paskutinę dieną: D sąnaudų sąskaita / K sukaupto nusidėvėjimo sąskaita. Mėnesiai skaičiuojami iš eilės; atšaukti galima tik paskutinį.'), out),
    section('Paskaičiuoti mėnesiai', hist));
  await Promise.all([preview(), loadHist()]);
}
