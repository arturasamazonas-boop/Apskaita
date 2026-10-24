// Vadovo suvestinė: key figures, management P&L by month, 8-week cash forecast, top customers and debtors.
import {h, clear, get, api, guard, pageHeader, section, table, eur, money, date, input, field} from '../core.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs, ...kids) => { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); el.append(...kids.filter(Boolean)); return el; };

// Monthly revenue (bars) and net result (dots) with a zero line.
function monthChart(pl) {
  const rev = pl.rows.find((r) => r.key === 'revenue'), net = pl.rows.find((r) => r.key === 'net');
  const months = pl.columns.filter((c) => /^m\d+$/.test(c[0]));
  if (!months.length) return null;
  const vals = months.flatMap((c) => [Number(rev[c[0]]), Number(net[c[0]])]);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const W = 640, H = 200, pad = 24, bw = (W - pad * 2) / months.length;
  const y = (v) => pad + (H - pad * 2) * (max - v) / (max - min);
  return h('figure', {class: 'chart'}, s('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Pajamos ir grynasis rezultatas pagal mėnesius'},
    s('line', {x1: pad, x2: W - pad, y1: y(0), y2: y(0), class: 'chart-axis'}),
    ...months.flatMap((c, i) => {
      const r = Number(rev[c[0]]), n = Number(net[c[0]]), x = pad + i * bw;
      return [
        s('rect', {x: x + bw * 0.15, width: bw * 0.7, y: Math.min(y(r), y(0)), height: Math.max(1, Math.abs(y(r) - y(0))), class: 'chart-bar', rx: 3}, s('title', {}, `${c[1]}: pajamos ${money(r)} €`)),
        s('circle', {cx: x + bw / 2, cy: y(n), r: 4, class: n < 0 ? 'chart-dot neg' : 'chart-dot'}, s('title', {}, `${c[1]}: grynasis rezultatas ${money(n)} €`)),
        s('text', {x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-label'}, c[1]),
      ];
    })),
  h('figcaption', {class: 'hint'}, h('span', {class: 'legend-bar'}), ' pajamos  ', h('span', {class: 'legend-dot'}), ' grynasis rezultatas'));
}

export async function render(main) {
  const year = input({type: 'number', min: 2000, max: 2100, value: new Date().getFullYear(), class: 'w-num'});
  const plBox = h('div');
  const loadPl = async () => {
    const pl = await get(`/api/reports/management-pl?year=${year.value}`);
    const months = pl.columns.filter((c) => /^m\d+$/.test(c[0]));
    clear(plBox, monthChart(pl),
      table([{label: 'Rodiklis', render: (r) => (r.strong ? h('strong', null, r.label) : r.label)},
        ...[...months, ['total', 'Iš viso']].map(([k, label]) => ({label, num: true, render: (r) => (r[k] === null || r[k] === undefined ? '—' : r.key === 'margin' ? `${String(r[k]).replace('.', ',')} %` : h('span', {class: Number(r[k]) < 0 ? 'neg' : null}, money(r[k])))}))],
      pl.rows, {rowClass: (r) => (r.strong ? 'row-strong' : null)}),
      h('p', {class: 'hint'}, pl.definition),
      h('div', {class: 'actions'}, exportBtn('xlsx'), exportBtn('csv')));
  };
  const exportBtn = (fmt) => h('button', {class: 'btn btn-small', onclick: () => guard(async () => {
    const res = await api('GET', `/api/reports/management-pl?year=${year.value}&format=${fmt}`, undefined, {raw: true});
    if (!res.ok) throw new Error('Eksportas nepavyko.');
    const a = h('a', {href: URL.createObjectURL(await res.blob()), download: `valdymo-pn-${year.value}.${fmt}`}); document.body.append(a); a.click(); a.remove();
  })}, `Atsisiųsti ${fmt.toUpperCase()}`);
  year.addEventListener('change', () => guard(loadPl));
  const d = await get('/api/director');
  const f = d.forecast;
  clear(main, pageHeader('Vadovo suvestinė', h('span', {class: 'hint'}, `Būklė ${date(d.today)}`)),
    h('div', {class: 'cards'}, d.kpis.map((k) => h('a', {class: 'stat', href: k.link},
      h('span', {class: 'stat-title'}, k.title),
      h('strong', {class: 'stat-value'}, k.unit === 'EUR' ? eur(k.value) : k.value),
      k.change !== undefined && k.change !== null ? h('span', {class: k.change < 0 ? 'neg' : 'pos'}, `${k.change > 0 ? '+' : ''}${String(k.change).replace('.', ',')} % nei pernai`) : null,
      h('span', {class: 'stat-def'}, k.definition)))),
    section('Pelnas (nuostoliai) pagal mėnesius', h('div', {class: 'filters'}, field('Metai', year)), plBox),
    section('Pinigų srautų prognozė (8 savaitės)',
      table([{label: 'Savaitė', render: (w) => `${date(w.from)} – ${date(w.to)}`},
        {label: 'Įplaukos', num: true, render: (w) => h('span', null, money(w.inflow), Number(w.overdueIn) ? h('small', {class: 'hint'}, ` (pradelsta ${money(w.overdueIn)})`) : null)},
        {label: 'Išmokos', num: true, render: (w) => h('span', null, money(w.outflow), Number(w.overdueOut) ? h('small', {class: 'hint'}, ` (pradelsta ${money(w.overdueOut)})`) : null)},
        {label: 'Grynasis srautas', num: true, render: (w) => h('span', {class: Number(w.net) < 0 ? 'neg' : 'pos'}, money(w.net))},
        {label: 'Pinigų likutis', num: true, render: (w) => h('strong', {class: Number(w.closing) < 0 ? 'neg' : null}, money(w.closing))}], f.weeks),
      h('p', {class: 'hint'}, `Pradinis likutis ${eur(f.opening)}. Vėliau nei po 8 savaičių laukiama įplaukų ${eur(f.laterIn)}, išmokų ${eur(f.laterOut)}. ${f.note}`),
      f.weeks.some((w) => Number(w.closing) < 0) ? h('p', {class: 'issue issue-warning'}, 'Dėmesio: prognozuojamas neigiamas pinigų likutis – peržiūrėkite mokėjimų terminus arba skolų išieškojimą.') : null),
    h('div', {class: 'cols'},
      section(`Didžiausi pirkėjai ${d.year} m.`, table([{label: 'Pirkėjas', key: 'name'}, {label: 'Sąsk.', num: true, key: 'n'}, {label: 'Pardavimai be PVM', num: true, render: (r) => money(r.net)}, {label: 'Dalis', num: true, render: (r) => (r.share === null ? '—' : `${String(r.share).replace('.', ',')} %`)}], d.topCustomers, {empty: 'Pardavimų nėra.'})),
      section('Didžiausi skolininkai', table([{label: 'Pirkėjas', key: 'name'}, {label: 'Skola', num: true, render: (r) => money(r.outstanding)}, {label: 'Pradelsta', num: true, render: (r) => h('span', {class: Number(r.overdue) > 0 ? 'neg' : null}, money(r.overdue))}, {label: 'Vėluoja', num: true, render: (r) => (r.daysLate ? `${r.daysLate} d.` : '—')}],
        d.debtors, {empty: 'Skolų nėra.', onRow: (r) => { if (r.counterparty_id) location.hash = `#/skolu-aktas?counterparty=${r.counterparty_id}`; }}))));
  await loadPl();
}
