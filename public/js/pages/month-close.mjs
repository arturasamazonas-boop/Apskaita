// Mėnesio uždarymas: checklist of open items for a month, with links, and locking the month when done.
import {h, clear, get, post, pageHeader, section, input, field, guard, can, confirmDialog, toast} from '../core.mjs';

const ICON = {error: '✗', warn: '!', info: 'i', ok: '✓'};
const prevMonth = () => { const d = new Date(); const m = d.getMonth() === 0 ? 12 : d.getMonth(); return `${d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()}-${String(m).padStart(2, '0')}`; };

export async function render(main, rest, state) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = input({type: 'month', value: params.get('period') || prevMonth()});
  const out = h('div');
  const load = async () => {
    history.replaceState(null, '', `#/menesio-uzdarymas?period=${month.value}`);
    const d = await get(`/api/month-close?period=${month.value}`);
    const groups = [...new Set(d.items.map((i) => i.group))];
    const done = !d.summary.error && !d.summary.warn;
    clear(out,
      h('p', {class: done ? 'issue issue-ok' : 'issue issue-warning'}, done ? `${d.period}: viskas paruošta uždarymui.` : `${d.period}: liko ${d.summary.error} kliūčių ir ${d.summary.warn} įspėjimų.`),
      groups.map((g) => section(g, h('ul', {class: 'checklist'}, d.items.filter((i) => i.group === g).map((i) => h('li', {class: `cl-item check-${i.level}`},
        h('span', {class: 'check-icon', 'aria-hidden': 'true'}, ICON[i.level]),
        h('div', null, h('strong', null, i.title), h('div', {class: 'hint'}, i.message)),
        i.link && i.level !== 'ok' ? h('a', {class: 'btn btn-small', href: i.link}, 'Atidaryti') : null))))),
      can(state.user, 'lock') && (!d.lockedThrough || d.lockedThrough < d.to) ? h('div', {class: 'actions'}, h('button', {class: done ? 'btn btn-primary' : 'btn', onclick: () => guard(async () => {
        if (!await confirmDialog('Užrakinti laikotarpį', `Užrakinti įrašus iki ${d.to}? Užrakinus šio laikotarpio įrašų keisti nebus galima (atrakinti gali administratorius).${done ? '' : ' Dėmesio: sąraše dar yra neišspręstų punktų.'}`, 'Užrakinti')) return;
        await post('/api/settings/lock-period', {lockedThrough: d.to, note: `Mėnesio uždarymas ${d.period}`});
        toast(`Užrakinta iki ${d.to}.`, 'ok'); load();
      })}, `Užrakinti iki ${d.to}`)) : null);
  };
  month.addEventListener('change', () => guard(load));
  clear(main, pageHeader('Mėnesio uždarymas'),
    h('div', {class: 'filters'}, field('Mėnuo', month), h('p', {class: 'hint'}, 'Vienoje vietoje – kas dar neatlikta mėnesiui uždaryti. Paspaudus „Atidaryti“ pateksite ten, kur tai sutvarkoma.')), out);
  await load();
}
