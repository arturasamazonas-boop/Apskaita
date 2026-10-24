// Mokesčių kalendorius: returns and payments with deadlines; mark a return as filed (with the EDS number).
import {h, clear, get, post, pageHeader, section, table, input, field, guard, can, date, modal, toast, confirmDialog} from '../core.mjs';

const STATUS = {filed: ['Pateikta', 'done'], overdue: ['Vėluoja', 'error'], soon: ['Artėja', 'warn'], upcoming: ['Laukia', 'info']};
const iso = (d) => d.toISOString().slice(0, 10);

export async function render(main, rest, state) {
  const now = new Date();
  const from = input({type: 'date', value: iso(new Date(now.getTime() - 62 * 86400000))});
  const to = input({type: 'date', value: iso(new Date(now.getTime() + 120 * 86400000))});
  const out = h('div');
  const mark = (it) => {
    const on = input({type: 'date', value: iso(new Date())}), ref = input({placeholder: 'pvz., EDS registracijos Nr.'}), note = input();
    const m = modal(`Pateikta: ${it.title} (${it.period})`, h('form', {onsubmit: (e) => { e.preventDefault(); guard(async () => {
      await post('/api/tax-filings', {form: it.form, period: it.period, filedOn: on.value, reference: ref.value, note: note.value});
      m.close(); toast('Pažymėta kaip pateikta.', 'ok'); load();
    }); }}, field(it.payment ? 'Sumokėta' : 'Pateikta', on), field('Registracijos Nr. / nuoroda', ref), field('Pastaba', note), h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Išsaugoti'))));
  };
  const load = async () => {
    const d = await get(`/api/tax-calendar?from=${from.value}&to=${to.value}`);
    const canMark = can(state.user, 'approve');
    clear(out,
      d.summary.overdue ? h('div', {class: 'issue issue-error'}, `Vėluoja: ${d.summary.overdue}. Pateikite ir pažymėkite kaip pateiktas.`,
        canMark ? h('button', {class: 'btn btn-small', style: 'margin-left:.75rem', onclick: () => guard(async () => {
          if (!await confirmDialog('Pažymėti pateiktomis', `Pažymėti visas ${d.summary.overdue} vėluojančias prievoles kaip pateiktas (pvz., jos pateiktos dar prieš pradedant naudotis programa)?`, 'Pažymėti')) return;
          for (const i of d.items.filter((x) => x.status === 'overdue')) await post('/api/tax-filings', {form: i.form, period: i.period, filedOn: i.due, note: 'Pažymėta kartu su kitomis vėluojančiomis'});
          toast('Pažymėta.', 'ok'); load();
        })}, 'Pažymėti visas vėluojančias pateiktomis') : null) : d.summary.soon ? h('p', {class: 'issue issue-warning'}, `Per 7 dienas: ${d.summary.soon}.`) : h('p', {class: 'issue issue-ok'}, 'Vėluojančių nėra.'),
      table([
        {label: 'Terminas', render: (i) => h('span', null, date(i.due), i.due !== i.statutory ? h('small', {class: 'hint', title: 'Perkelta į kitą darbo dieną'}, ` (${date(i.statutory)} – ne darbo diena)`) : null)},
        {label: 'Prievolė', render: (i) => h('span', null, h('a', {href: i.link}, i.title), i.note ? h('div', {class: 'hint'}, i.note) : null)},
        {label: 'Laikotarpis', key: 'period'},
        {label: 'Būsena', render: (i) => h('span', {class: `badge badge-${STATUS[i.status][1]}`}, i.status === 'soon' || i.status === 'upcoming' ? `${STATUS[i.status][0]} (${i.daysLeft} d.)` : i.status === 'overdue' ? `${STATUS[i.status][0]} ${-i.daysLeft} d.` : STATUS[i.status][0])},
        {label: 'Pateikta', render: (i) => (i.filed ? `${date(i.filed.on)}${i.filed.reference ? `, ${i.filed.reference}` : ''}${i.filed.by ? ` (${i.filed.by})` : ''}` : '')},
        {label: '', render: (i) => (!canMark ? '' : i.filed
          ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => { await post('/api/tax-filings', {form: i.form, period: i.period, filed: false}); load(); })}, 'Atšaukti žymą')
          : h('button', {class: 'btn btn-small', onclick: () => mark(i)}, i.payment ? 'Sumokėta' : 'Pateikta'))},
      ], d.items, {empty: 'Šiuo laikotarpiu prievolių nėra.', rowClass: (i) => (i.status === 'overdue' ? 'row-error' : null)}),
      h('p', {class: 'hint'}, 'Terminai pagal bendrąsias taisykles: GPM313, SAM ir įmokos – iki kito mėnesio 15 d., i.SAF – iki 20 d., PVM deklaracija ir FR0564 – iki 25 d., PLN204 – iki birželio 15 d. Jei terminas – ne darbo diena, jis perkeliamas į kitą darbo dieną. Programa deklaracijų nepateikia – pateikę EDS ar EDAS sistemoje, pažymėkite čia.'));
  };
  from.addEventListener('change', () => guard(load)); to.addEventListener('change', () => guard(load));
  clear(main, pageHeader('Mokesčių kalendorius'), h('div', {class: 'filters'}, field('Terminai nuo', from), field('iki', to)), section(null, out));
  await load();
}
