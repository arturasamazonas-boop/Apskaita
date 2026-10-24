// Pasikartojančios sąskaitos: templates (rent, subscriptions) that create draft sales invoices on their dates.
import {h, clear, get, post, put, pageHeader, section, table, input, select, field, guard, can, date, money, toast, debounce} from '../core.mjs';

const INTERVALS = [[1, 'Kas mėnesį'], [2, 'Kas 2 mėn.'], [3, 'Kas ketvirtį'], [6, 'Kas pusmetį'], [12, 'Kas metus']];

export async function render(main, tabs, state) {
  const [d, series, taxCodes] = await Promise.all([get('/api/recurring-invoices'), get('/api/series'), get('/api/tax-codes')]);
  const noVat = !state.company?.vat_registered;
  const taxOpts = noVat ? [['BE_PVM', 'BE_PVM']] : [...new Set(taxCodes.filter((t) => t.active && (!t.applies_to || t.applies_to === 'both' || t.applies_to === 'sales')).map((t) => t.code))].map((c) => [c, c]);
  const formBox = h('div');
  const edit = (tpl = null) => {
    const name = input({value: tpl?.name || '', required: true});
    const cpSel = select([[tpl?.counterparty_id || '', tpl?.counterparty_name || '— pasirinkite —']], tpl?.counterparty_id || '');
    const cpQ = input({type: 'search', placeholder: 'Ieškoti pirkėjo'});
    cpQ.oninput = debounce(async () => {
      const r = await get(`/api/counterparties?${new URLSearchParams({q: cpQ.value, limit: 30})}`);
      clear(cpSel, h('option', {value: ''}, '— pasirinkite —'), r.items.map((c) => h('option', {value: c.id}, `${c.name}${c.company_code ? ` (${c.company_code})` : ''}`)));
    });
    const next = input({type: 'date', value: tpl?.next_date || '', required: true});
    const interval = select(INTERVALS, tpl?.interval_months || 1);
    const due = input({type: 'number', min: 0, max: 365, value: tpl?.due_days ?? 14, class: 'w-num'});
    const end = input({type: 'date', value: tpl?.end_date || ''});
    const ser = select(series.filter((x) => x.doc_type !== 'credit_note').map((x) => [x.code, x.code]), tpl?.series_code || 'PP');
    const notes = input({value: tpl?.notes || ''});
    const active = h('input', {type: 'checkbox', checked: tpl ? tpl.active : true});
    const lines = (tpl?.lines || [{description: '', quantity: '1', unitPrice: '', taxCode: noVat ? 'BE_PVM' : 'PVM1'}]).map((l) => ({...l}));
    const linesBox = h('div');
    const drawLines = () => clear(linesBox, table([
      {label: 'Aprašymas', render: (l) => input({value: l.description, 'aria-label': 'Aprašymas', oninput: (e) => { l.description = e.target.value; }})},
      {label: 'Kiekis', render: (l) => input({value: l.quantity, inputmode: 'decimal', class: 'w-num', 'aria-label': 'Kiekis', oninput: (e) => { l.quantity = e.target.value; }})},
      {label: 'Kaina be PVM', render: (l) => input({value: l.unitPrice, inputmode: 'decimal', class: 'w-num', 'aria-label': 'Kaina', oninput: (e) => { l.unitPrice = e.target.value; }})},
      {label: 'PVM', render: (l) => select(taxOpts, l.taxCode, {onchange: (e) => { l.taxCode = e.target.value; }})},
      {label: '', render: (l) => (lines.length > 1 ? h('button', {type: 'button', class: 'btn-icon', 'aria-label': 'Pašalinti', onclick: () => { lines.splice(lines.indexOf(l), 1); drawLines(); }}, '×') : '')},
    ], lines));
    drawLines();
    clear(formBox, section(tpl ? `Keisti: ${tpl.name}` : 'Naujas šablonas', h('form', {onsubmit: (e) => { e.preventDefault(); guard(async () => {
      const body = {name: name.value, counterpartyId: cpSel.value, nextDate: next.value, intervalMonths: Number(interval.value), dueDays: Number(due.value), endDate: end.value || null, seriesCode: ser.value, notes: notes.value, active: active.checked,
        lines: lines.map((l) => ({...l, unitPrice: String(l.unitPrice).replace(',', '.'), quantity: String(l.quantity).replace(',', '.')}))};
      if (tpl) await put(`/api/recurring-invoices/${tpl.id}`, body); else await post('/api/recurring-invoices', body);
      toast('Šablonas išsaugotas.', 'ok'); render(main, tabs, state);
    }); }},
    h('div', {class: 'form-grid'}, field('Pavadinimas', name), field('Pirkėjas', h('div', null, cpQ, cpSel)), field('Pirmos (kitos) sąskaitos data', next), field('Periodiškumas', interval),
      field('Apmokėti per, d.', due), field('Kartoti iki (neprivaloma)', end), field('Serija', ser), field('Pastaba sąskaitoje', notes), h('label', {class: 'check'}, active, ' aktyvus')),
    linesBox, h('div', {class: 'actions'}, h('button', {type: 'button', class: 'btn btn-small', onclick: () => { lines.push({description: '', quantity: '1', unitPrice: '', taxCode: lines[0]?.taxCode || 'PVM1'}); drawLines(); }}, '+ Eilutė'),
      h('button', {class: 'btn btn-primary'}, 'Išsaugoti'), h('button', {type: 'button', class: 'btn', onclick: () => clear(formBox)}, 'Atšaukti')))));
    name.focus();
  };
  const total = (t) => t.lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0);
  clear(main, pageHeader('Pardavimai'), tabs,
    h('p', {class: 'hint'}, 'Šablonas kas periodą sukuria pardavimo sąskaitos juodraštį (kasdien automatiškai arba paspaudus mygtuką). Numeris suteikiamas ir sąskaita registruojama tik patvirtinus juodraštį.'),
    can(state.user, 'write') ? h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary', onclick: () => edit()}, '+ Naujas šablonas'),
      h('button', {class: 'btn', onclick: () => guard(async () => { const r = await post('/api/recurring-invoices/generate', {}); toast(r.created.length ? `Sukurta juodraščių: ${r.created.length}.` : 'Šiandien kurti nėra ką.', 'ok'); render(main, tabs, state); })}, 'Sukurti suėjusius juodraščius dabar')) : null,
    formBox,
    section('Šablonai', table([{label: 'Pavadinimas', key: 'name'}, {label: 'Pirkėjas', key: 'counterparty_name'}, {label: 'Periodiškumas', render: (t) => INTERVALS.find((x) => x[0] === t.interval_months)?.[1] || `${t.interval_months} mėn.`},
      {label: 'Kita sąskaita', render: (t) => (t.active ? date(t.next_date) : 'sustabdytas')}, {label: 'Iki', render: (t) => (t.end_date ? date(t.end_date) : '—')}, {label: 'Suma be PVM', num: true, render: (t) => money(total(t))}],
    d.templates, {onRow: can(state.user, 'write') ? (t) => edit(t) : null, empty: 'Šablonų nėra.', rowClass: (t) => (t.active ? null : 'muted')})),
    section(`Laukia patvirtinimo (${d.drafts.length})`, table([{label: 'Data', render: (x) => date(x.issue_date)}, {label: 'Juodraštis', render: (x) => h('a', {href: `#/deze/${x.document_id}`}, x.title)},
      {label: 'Suma su PVM', num: true, render: (x) => money(x.gross)}, {label: 'Būsena', render: (x) => (x.blocking ? h('span', {class: 'badge badge-error'}, 'yra klaidų') : h('span', {class: 'badge badge-ok'}, 'paruošta'))}],
    d.drafts, {onRow: (x) => { location.hash = `#/deze/${x.document_id}`; }, empty: 'Laukiančių juodraščių nėra.'})));
}
