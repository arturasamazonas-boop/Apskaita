// Metų uždarymas: close income and expense accounts into 341, then move the result to 342.
import {h, clear, get, post, pageHeader, section, table, money, guard, input, field, can, today, confirmDialog, toast} from '../core.mjs';

export async function render(main, rest, state) {
  const year = input({type: 'number', min: 2000, max: 2100, value: String(Number(today().slice(0, 4)) - 1), style: {maxWidth: '8rem'}});
  const out = h('div');
  const load = async () => {
    const s = await get(`/api/year-end?year=${year.value}`);
    const profit = Number(s.result) >= 0;
    clear(out,
      h('div', {class: 'cards'}, h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, `${s.year} m. ${profit ? 'pelnas' : 'nuostoliai'}`), h('div', {class: 'stat-value'}, `${money(Math.abs(Number(s.result)))} €`)),
        h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, '341 likutis metų pabaigoje'), h('div', {class: 'stat-value'}, `${money(s.balance341)} €`))),
      section('1. Pajamų ir sąnaudų sąskaitų uždarymas (gruodžio 31 d.)',
        s.closing && !s.open ? h('p', {class: 'issue issue-ok'}, `✓ Uždaryta įrašu #${s.closing.id}.`) : null,
        s.open ? [table([{label: 'Sąskaita', key: 'code'}, {label: 'Pavadinimas', key: 'name'}, {label: 'Likutis (D+ / K−)', num: true, render: (a) => money(a.bal)}], s.accounts),
          h('p', {class: 'hint'}, `Įrašas: pajamų sąskaitos debetuojamos, sąnaudų – kredituojamos, rezultatas – į 341 „Ataskaitinių metų nepaskirstytasis pelnas (nuostoliai)“. Finansinėse ataskaitose uždarymo įrašas neiškraipo pelno (nuostolių) ataskaitos.`),
          can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
            if (!await confirmDialog('Uždaryti metus', `Uždaryti ${s.year} m. pajamų ir sąnaudų sąskaitas į 341? Prieš tai užregistruokite visus metų įrašus (nusidėvėjimą, savikainą, pelno mokestį).`, 'Uždaryti')) return;
            const r = await post('/api/year-end/close', {year: s.year}); toast(`Metai uždaryti (įrašas #${r.entryId}).`, 'ok'); load();
          })}, `Uždaryti ${s.year} m.`) : null] : (!s.closing ? h('p', {class: 'hint'}, 'Pajamų ir sąnaudų likučių nėra.') : null)),
      section(`2. Rezultato perkėlimas į 342 (${Number(s.year) + 1}-01-01)`,
        s.transfer ? h('p', {class: 'issue issue-ok'}, `✓ Perkelta įrašu #${s.transfer.id}.`)
          : [h('p', {class: 'hint'}, 'Patvirtinus finansinių ataskaitų rinkinį, ataskaitinių metų rezultatas (341) perkeliamas į ankstesnių metų nepaskirstytąjį pelną (342). Pelno paskirstymą (rezervai, dividendai) įregistruokite rankiniu įrašu pagal dalyvių sprendimą.'),
            can(state.user, 'approve') && !s.open && Number(s.balance341) ? h('button', {class: 'btn', onclick: () => guard(async () => {
              const r = await post('/api/year-end/transfer', {year: s.year}); toast(`Perkelta (įrašas #${r.entryId}).`, 'ok'); load();
            })}, 'Perkelti į 342') : null]),
      h('p', {class: 'hint'}, 'Klaidingą uždarymo ar perkėlimo įrašą galima atšaukti: Finansai → Žurnalas → Atšaukti.'));
  };
  year.addEventListener('change', () => guard(load));
  clear(main, pageHeader('Metų uždarymas'), section(null, h('div', {class: 'filters'}, field('Finansiniai metai', year))), out);
  await load();
}
