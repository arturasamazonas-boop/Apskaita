// Skolų suderinimo aktas: choose a counterparty and a date, review the balances and download the act as PDF.
import {h, clear, get, pageHeader, section, guard, input, field, select, table, money, eur, date, today, debounce, apiUrl} from '../core.mjs';

export async function render(main, rest, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = input({type: 'search', placeholder: 'Pavadinimas arba kodas'});
  const cpSel = select([['', '— pasirinkite —']], '');
  const asOf = input({type: 'date', value: params.get('asOf') || `${Number(today().slice(0, 4)) - 1}-12-31`});
  const number = input({value: '1', style: {maxWidth: '6rem'}});
  const out = h('div');
  const fill = async () => {
    const d = await get(`/api/counterparties?${new URLSearchParams({q: q.value, limit: 100})}`);
    const cur = cpSel.value || params.get('counterparty') || '';
    clear(cpSel, h('option', {value: ''}, '— pasirinkite —'), d.items.map((c) => h('option', {value: c.id, selected: String(c.id) === String(cur)}, `${c.name}${c.company_code ? ` (${c.company_code})` : ''}`)));
  };
  const load = async () => {
    if (!cpSel.value) { clear(out, h('p', {class: 'hint'}, 'Pasirinkite kontrahentą.')); return; }
    const a = await get(`/api/debt-act?${new URLSearchParams({counterparty: cpSel.value, asOf: asOf.value})}`);
    history.replaceState(null, '', `#/skolu-aktas?${new URLSearchParams({counterparty: cpSel.value, asOf: asOf.value})}`);
    clear(out, section(`${a.counterparty.name} – ${a.asOf}`,
      h('div', {class: 'cards'}, [['Jūsų skola mums (+)', a.receivable], ['Mūsų skola jums (–)', a.payable], ['Skolos likutis', a.balance]].map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, eur(v))))),
      a.open.length ? table([{label: 'Tipas', render: (r) => (r.register === 'sales' ? 'Pardavimas' : 'Pirkimas')}, {label: 'Data', render: (r) => date(r.issue_date)}, {label: 'Numeris', key: 'number'}, {label: 'Terminas', render: (r) => date(r.due_date)},
        {label: 'Suma', num: true, render: (r) => money(r.gross)}, {label: 'Likutis', num: true, render: (r) => money(r.outstanding)}], a.open) : h('p', {class: 'hint'}, 'Neapmokėtų sąskaitų nėra.'),
      h('p', {class: 'hint'}, 'Likučiai – iš didžiosios knygos pirkėjų / tiekėjų ir avansų sąskaitų su šiuo kontrahentu. Akte paliekama vieta kontrahento patvirtinimui ir parašams.')));
  };
  q.addEventListener('input', debounce(() => guard(fill)));
  [cpSel, asOf].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Skolų suderinimo aktas', h('button', {class: 'btn btn-primary', onclick: () => { if (!cpSel.value) return; location.href = apiUrl(`/api/debt-act?${new URLSearchParams({counterparty: cpSel.value, asOf: asOf.value, number: number.value, format: 'pdf'})}`); }}, '⇩ Atsisiųsti PDF')),
    section(null, h('div', {class: 'form-grid'}, field('Paieška', q), field('Kontrahentas', cpSel), field('Datai', asOf), field('Akto Nr.', number))), out);
  await fill();
  if (cpSel.value) await load(); else clear(out, h('p', {class: 'hint'}, 'Pasirinkite kontrahentą.'));
}
