// Valiutų kursai (Lietuvos bankas) ir valiutinių straipsnių perkainojimas.
import {h, clear, get, post, put, pageHeader, section, table, money, date, guard, select, input, field, can, today, toast, badge, promptDialog, confirmDialog} from '../core.mjs';

const STATUS = {posted: ['Užregistruota', 'done'], cancelled: ['Atšaukta', 'muted']};
const tabs = (cur) => h('div', {class: 'tabs'}, [['', 'Kursai'], ['perkainojimas', 'Perkainojimas']].map(([k, t]) => h('a', {class: ['tab', cur === k && 'active'], href: `#/valiutos${k ? '/' + k : ''}`}, t)));
const monthEndBefore = () => { const [y, m] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); };

export async function render(main, rest, state) {
  if (rest[0] === 'perkainojimas') return revaluation(main, state);
  return rates(main, state);
}

async function rates(main, state) {
  const from = input({type: 'date', value: `${today().slice(0, 7)}-01`}), to = input({type: 'date', value: today()});
  const ccy = input({placeholder: 'pvz. USD', maxlength: 3, style: {maxWidth: '6rem', textTransform: 'uppercase'}});
  const mDate = input({type: 'date', value: today()}), mCcy = input({placeholder: 'USD', maxlength: 3, style: {maxWidth: '6rem'}}), mRate = input({inputmode: 'decimal', placeholder: '1,1234'});
  const out = h('div'), info = h('div');
  const load = async () => {
    const d = await get(`/api/fx/rates?${new URLSearchParams({from: from.value, to: to.value, ...(ccy.value && {currency: ccy.value.toUpperCase()})})}`);
    clear(info, d.used.length ? h('p', {class: 'hint'}, `Naudojamos valiutos: ${d.used.join(', ')}.`) : null,
      d.online ? null : h('p', {class: 'issue issue-warning'}, 'Kursų gavimas iš Lietuvos banko išjungtas (FX_URL) – kursus įveskite ranka.'));
    clear(out, table([{label: 'Data', render: (r) => date(r.rate_date)}, {label: 'Valiuta', key: 'currency'}, {label: 'Už 1 EUR', num: true, render: (r) => r.rate}, {label: '1 vienetas, EUR', num: true, render: (r) => (1 / Number(r.rate)).toFixed(6)},
      {label: 'Šaltinis', render: (r) => (r.source === 'LB' ? 'Lietuvos bankas' : 'Įvesta ranka')}], d.rows, {empty: 'Šiuo laikotarpiu kursų nėra – paspauskite „Gauti iš Lietuvos banko“.'}));
  };
  const fetchDay = () => guard(async () => { const r = await post('/api/fx/fetch', {date: to.value}); toast(`Gauta kursų: ${r.fetched}.`, 'ok'); await load(); });
  const fetchHistory = () => guard(async () => {
    if (!/^[A-Za-z]{3}$/.test(ccy.value)) throw new Error('Nurodykite valiutą (pvz. USD), kurios istoriją gauti.');
    const r = await post('/api/fx/fetch', {currency: ccy.value.toUpperCase(), from: from.value, to: to.value}); toast(`Gauta kursų: ${r.fetched}.`, 'ok'); await load();
  });
  [from, to, ccy].forEach((x) => x.addEventListener('change', () => guard(load)));
  clear(main, pageHeader('Valiutų kursai', can(state.user, 'write') ? [h('button', {class: 'btn btn-primary', onclick: fetchDay}, '⟳ Gauti iš Lietuvos banko'), h('button', {class: 'btn', onclick: fetchHistory}, '⟳ Valiutos istorija')] : null), tabs(''),
    h('p', {class: 'hint'}, 'Euro ir užsienio valiutų santykiai, kuriuos skelbia Lietuvos bankas (EU tipas: ECB orientaciniai kursai ir Lietuvos banko skelbiami kitų valiutų kursai). Sąskaitos kita valiuta registruojamos pagal sandorio (PVM apskaičiavimo arba išrašymo) dienos kursą; savaitgalį ir švenčių dienomis – paskutinį paskelbtą. Kursai gaunami automatiškai kasdien po 17 val.'),
    section(null, h('div', {class: 'filters'}, field('Nuo', from), field('Iki', to), field('Valiuta', ccy)), info), out,
    can(state.user, 'approve') ? section('Įvesti kursą ranka', h('form', {onsubmit: (e) => guard(async () => {
      e.preventDefault();
      await put('/api/fx/rates', {currency: mCcy.value.toUpperCase(), date: mDate.value, rate: mRate.value}); toast('Kursas išsaugotas.', 'ok'); mRate.value = ''; await load();
    })}, h('div', {class: 'form-grid'}, field('Data', mDate), field('Valiuta', mCcy), field('Valiutos vienetų už 1 EUR', mRate)), h('button', {class: 'btn'}, 'Išsaugoti'),
    h('p', {class: 'hint'}, 'Ranka įvestas kursas nepakeičiamas automatiškai gautu.'))) : null);
  await load();
}

async function revaluation(main, state) {
  const asOf = input({type: 'date', value: monthEndBefore()});
  const out = h('div'), hist = h('div');
  let seq = 0;
  const loadHist = async () => {
    const rows = await get('/api/fx/revaluations');
    clear(hist, table([{label: 'Data', render: (r) => date(r.as_of)}, {label: 'Būsena', render: (r) => badge(STATUS, r.status)}, {label: 'Straipsnių', num: true, key: 'items'},
      {label: 'Teigiama įtaka (5803)', num: true, render: (r) => money(r.gain)}, {label: 'Neigiama įtaka (6803)', num: true, render: (r) => money(r.loss)}, {label: 'Įrašas', render: (r) => (r.journal_entry_id ? `#${r.journal_entry_id}` : '—')},
      {label: '', render: (r) => (r.status === 'posted' && can(state.user, 'approve') ? h('button', {class: 'btn btn-small', onclick: () => guard(async () => {
        const reason = await promptDialog('Atšaukti perkainojimą', 'Priežastis', {minLength: 5});
        if (!reason) return;
        await post(`/api/fx/revaluations/${r.id}/cancel`, {reason}); toast('Perkainojimas atšauktas.', 'ok'); loadHist(); preview();
      })}, 'Atšaukti') : '')}], rows, {empty: 'Perkainojimų dar nėra.'}));
  };
  const preview = async () => {
    const my = ++seq;
    const p = await get(`/api/fx/revaluation?asOf=${asOf.value}`);
    if (my !== seq) return;
    clear(out,
      p.posted ? h('p', {class: 'banner'}, `${p.asOf} datai perkainojimas jau užregistruotas.`) : null,
      p.missing.length ? h('p', {class: 'issue issue-error'}, `Nėra kursų ${p.asOf} datai: ${p.missing.join(', ')} – gaukite juos skiltyje „Kursai“.`) : null,
      table([{label: 'Straipsnis', render: (x) => (x.type === 'invoice' ? `${x.register === 'sales' ? 'Pirkėjo skola' : 'Skola tiekėjui'}: ${x.label} · ${x.counterparty || ''}` : `Banko sąskaita: ${x.label}`)},
        {label: 'Likutis valiuta', num: true, render: (x) => `${money(x.origBalance)} ${x.currency}`}, {label: 'Kursas', num: true, render: (x) => `${x.rate} (${x.rateDate})`},
        {label: 'Apskaitoje, EUR', num: true, render: (x) => money(x.bookBalance)}, {label: 'Pagal kursą, EUR', num: true, render: (x) => money(x.newBalance)},
        {label: 'Skirtumas', num: true, render: (x) => h('strong', {class: x.gain ? '' : 'text-error'}, `${x.gain ? '+' : '−'}${money(Math.abs(Number(x.diff)))}`)}, {label: 'Sąskaita', key: 'account'}],
      p.items, {empty: 'Perkainoti nėra ką: atvirų sąskaitų kita valiuta ir valiutinių banko sąskaitų likučių skirtumų nėra.'}),
      p.items.length ? h('p', null, h('strong', null, `Teigiama įtaka (${p.gainAccount}): ${money(p.gain)} €; neigiama įtaka (${p.lossAccount}): ${money(p.loss)} €; iš viso ${money(p.net)} €.`)) : null,
      p.items.length && !p.posted && !p.missing.length && can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', onclick: () => guard(async () => {
        if (!await confirmDialog('Perkainoti', `Užregistruoti valiutinių straipsnių perkainojimą ${p.asOf} datai?`, 'Registruoti')) return;
        const r = await post('/api/fx/revaluations', {asOf: asOf.value}); toast(`Perkainojimas užregistruotas (įrašas #${r.entryId}).`, 'ok'); preview(); loadHist();
      })}, `Perkainoti ${p.asOf} datai`) : null);
  };
  asOf.addEventListener('change', () => guard(preview));
  clear(main, pageHeader('Valiutinių straipsnių perkainojimas'), tabs('perkainojimas'),
    section(null, h('div', {class: 'filters'}, field('Ataskaitinė data', asOf)),
      h('p', {class: 'hint'}, 'Finansinių ataskaitų dieną piniginiai straipsniai užsienio valiuta (neapmokėtos pirkėjų ir tiekėjų sąskaitos, valiutinės banko sąskaitos) perskaičiuojami pagal tos dienos Lietuvos banko kursą. Skirtumai – į 5803 „Teigiama valiutų kursų pokyčio įtaka“ ir 6803 „Neigiama valiutų kursų pokyčio įtaka“. Kitas perkainojimas skaičiuojamas nuo perkainotų sumų; atšaukti galima tik paskutinį.'), out),
    section('Užregistruoti perkainojimai', hist));
  await Promise.all([preview(), loadHist()]);
}
