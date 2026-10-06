import {h, clear, get, pageHeader, input, field, eur, monthStart, today} from '../core.mjs';

export async function render(main) {
  const from = input({type: 'date', value: monthStart()}), to = input({type: 'date', value: today()});
  const grid = h('div', {class: 'cards'});
  const load = async () => {
    const d = await get(`/api/dashboard?from=${from.value}&to=${to.value}`);
    clear(grid, d.cards.map((c) => h('a', {class: 'stat', href: c.link},
      h('span', {class: 'stat-title'}, c.title),
      h('strong', {class: 'stat-value'}, c.unit === 'EUR' ? eur(c.value) : c.value),
      h('span', {class: 'stat-def'}, c.definition))));
  };
  from.onchange = load; to.onchange = load;
  clear(main, pageHeader('Apžvalga'), h('div', {class: 'filters'}, field('Laikotarpis nuo', from), field('iki', to),
    h('p', {class: 'hint'}, 'Pardavimų ir mokėjimų kortelės rodo pasirinktą laikotarpį; skolos ir eilės – šiandienos būklę.')), grid);
  await load();
}
