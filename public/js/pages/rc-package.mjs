// Finansinių ataskaitų rinkinys Registrų centrui: forms by company size, RC checks, the set as one PDF, line data for the RC e-form.
import {h, clear, get, pageHeader, section, guard, select, input, field, toast, today, apiUrl} from '../core.mjs';

const nf0 = new Intl.NumberFormat('lt-LT', {maximumFractionDigits: 0});
const plain = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v) === 0 ? 0 : v).replace(/\.00$/, '').replace('.', ','));
const ICON = {ok: '✓', warning: '!', error: '✗'};

export async function render(main) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const year = input({type: 'number', min: 2000, max: 2100, value: params.get('year') || String(Number(today().slice(0, 4)) - 1), style: {maxWidth: '8rem'}});
  const category = select([['', 'Pagal rodiklius (automatiškai)'], ['labai-maza', 'Labai maža įmonė'], ['maza', 'Maža įmonė'], ['vidutine', 'Vidutinė įmonė'], ['didele', 'Didelė įmonė']], params.get('category') || '');
  const number = input({value: '1', style: {maxWidth: '6rem'}});
  let chosen = params.get('forms') ? params.get('forms').split(',') : null;
  const out = h('div');
  const qs = (extra = {}) => new URLSearchParams({year: year.value, ...(category.value && {category: category.value}), ...(chosen && {forms: chosen.join(',')}), ...extra});
  const copy = (v) => { navigator.clipboard?.writeText(v).then(() => toast(`Nukopijuota: ${v}`, 'ok'), () => {}); };

  const draw = (p) => {
    const s = p.size;
    const lim = (k) => ({labai: [450000, 900000, 10], maza: [5000000, 10000000, 50]})[k];
    clear(out,
      section('Įmonės dydis ir rinkinio sudėtis',
        h('div', {class: 'cards'}, [['Turtas metų pabaigoje', `${nf0.format(s.assets)} €`], ['Pardavimo pajamos', `${nf0.format(s.revenue)} €`], ['Darbuotojai (metų pabaigoje)', String(s.staff)], ['Kategorija', p.categoryName]]
          .map(([t, v]) => h('div', {class: 'card stat'}, h('div', {class: 'stat-title'}, t), h('div', {class: 'stat-value'}, v)))),
        h('p', {class: 'hint'}, `Pagal rodiklius siūloma: ${{'labai-maza': 'labai maža', maza: 'maža', vidutine: 'vidutinė', didele: 'didelė'}[s.category]} įmonė. Ribos (FAĮ 5 str., neviršijami 2 iš 3 rodiklių): labai maža – turtas ${nf0.format(lim('labai')[0])} €, pajamos ${nf0.format(lim('labai')[1])} €, ${lim('labai')[2]} darbuotojų; maža – ${nf0.format(lim('maza')[0])} €, ${nf0.format(lim('maza')[1])} €, ${lim('maza')[2]} darbuotojų. Darbuotojų skaičius – metų pabaigoje (FAĮ – vidutinis sąrašinis), patikrinkite.`),
        h('div', {class: 'rc-forms'}, p.options.map((o) => h('label', {class: 'check'}, h('input', {type: 'checkbox', checked: p.forms.includes(o.key), 'data-form': o.key, onchange: () => {
          chosen = [...out.querySelectorAll('.rc-forms input:checked')].map((x) => x.dataset.form); guard(load);
        }}), ` ${o.name} (${o.annex})${o.required ? '' : ' – galima vietoj privalomos'}`))),
        h('p', null, h('strong', null, 'Kartu pateikiami dokumentai: '), p.docs.join('; '), '.')),
      section('Registrų centro patikros',
        p.checks.map((c) => h('p', {class: `issue issue-${c.level === 'ok' ? 'ok' : c.level}`}, `${ICON[c.level] || ''} ${c.form}: ${c.message}`)),
        p.checks.some((c) => c.level === 'error') ? null : h('p', {class: 'issue issue-ok'}, '✓ Balansai subalansuoti, formų tarpusavio sumos sutampa.')),
      section('Terminai ir pateikimas',
        h('ol', {class: 'rc-steps'},
          h('li', null, `Patvirtinkite rinkinį eiliniame visuotiniame dalyvių (akcininkų) susirinkime – ne vėliau kaip per 4 mėn. nuo metų pabaigos (iki ${p.deadlines.approveBy}).`),
          h('li', null, `Pateikite Registrų centrui per 30 dienų nuo patvirtinimo (vėliausiai apie ${p.deadlines.latest}): registrucentras.lt → Savitarna → Juridinių asmenų registras → Finansinių ataskaitų rinkinio pateikimas (prisijungimas per el. bankininkystę ar el. parašu).`),
          h('li', null, 'El. formoje pasirinkite tas pačias formas ir įrašykite sumas eurais iš lentelių žemiau (spustelėjus sumą – nukopijuojama). Praėjusių metų stulpelis RC formoje įkeliamas iš pernai pateikto rinkinio – palyginkite.'),
          h('li', null, 'Prisekite patvirtintą rinkinį (PDF su parašais arba ADOC/ASIC) ir kitus dokumentus, pasirašykite ir pateikite.'))),
      p.statements.map((st) => section(`${st.form.name} (${st.form.annex})`,
        st.matrix ? h('p', {class: 'hint'}, h('a', {href: `#/finansines/${st.key}?to=${p.period.to}`}, 'Atidaryti formą →'), ' Nuosavo kapitalo pokyčių lentelė – žr. formą ir XLSX failą.')
          : h('div', {class: 'table-wrap'}, h('table', {class: 'grid rc-table'},
            h('thead', null, h('tr', null, h('th', null, 'Eil. Nr.'), h('th', null, 'Straipsnis'), h('th', {class: 'num'}, 'Finansiniai metai'), h('th', {class: 'num'}, 'Praėję finansiniai metai'))),
            h('tbody', null, st.lines.filter((l) => !l.heading).map((l) => h('tr', {class: l.total ? 'fs-total' : ''}, h('td', {class: 'fs-no'}, l.no), h('td', null, l.label),
              [l.current, l.previous].map((v) => h('td', {class: 'num rc-copy', title: 'Spustelėkite – nukopijuoti', onclick: () => copy(plain(v))}, plain(v)))))))))));
  };
  let seq = 0;
  const load = async () => {
    history.replaceState(null, '', `#/rc-rinkinys?${qs()}`);
    const my = ++seq;
    const p = await get(`/api/rc-package?${qs()}`);
    if (my === seq) draw(p); // ignore an answer for an older choice
  };
  const dl = (format) => { location.href = apiUrl(`/api/rc-package/file?${qs({format, number: number.value, compiled: today()})}`); };
  year.addEventListener('change', () => { chosen = null; guard(load); });
  category.addEventListener('change', () => { chosen = null; guard(load); });
  clear(main, pageHeader('Rinkinys Registrų centrui',
    h('button', {class: 'btn btn-primary', onclick: () => dl('pdf')}, '⇩ Rinkinio PDF'),
    h('button', {class: 'btn', onclick: () => dl('xlsx')}, '⇩ XLSX (RC formai)'),
    h('button', {class: 'btn', onclick: () => dl('csv')}, '⇩ CSV')),
  h('p', {class: 'hint'}, 'Metinis finansinių ataskaitų rinkinys pagal VAS formas: kurias formas teikti pagal įmonės dydį, Registrų centro el. formos patikros, visas rinkinys vienu PDF tvirtinimui ir prisegimui, sumos eurais RC formos pildymui. Programa rinkinio RC nepateikia – tai daroma RC savitarnoje.'),
  section(null, h('div', {class: 'form-grid'}, field('Finansiniai metai', year), field('Įmonės kategorija', category), field('Rinkinio Nr. (PDF)', number))),
  out);
  await load();
}
