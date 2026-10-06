// Sąskaitų planas: the chart as a tree (class → group → account), search, sub-accounts, activation.
import {h, clear, get, post, put, pageHeader, section, guard, select, input, field, can, debounce} from '../core.mjs';

const TYPE = {asset: 'Turtas', liability: 'Įsipareigojimai', equity: 'Nuosavybė', revenue: 'Pajamos', expense: 'Sąnaudos'};

export async function render(main, rest, state) {
  const rows = await get('/api/accounts?all=1');
  const byParent = new Map();
  for (const a of rows) { const k = a.parent_code || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(a); }
  const collapsed = new Set(rows.filter((a) => a.level === 2).map((a) => a.code));
  const st = {q: '', inactive: false};
  const editable = can(state.user, 'settings');
  const box = h('div', {class: 'chart'});

  const matches = (a) => { const q = st.q.trim().toLowerCase(); return !q || a.code.startsWith(q) || a.name.toLowerCase().includes(q); };
  const visible = (a) => (st.inactive || a.active) && (matches(a) || (byParent.get(a.code) || []).some(visible));

  const row = (a) => {
    const kids = (byParent.get(a.code) || []).filter(visible);
    const open = st.q || !collapsed.has(a.code);
    const toggle = kids.length ? h('button', {class: 'tree-toggle', 'aria-expanded': String(!!open), 'aria-label': `${open ? 'Suskleisti' : 'Išskleisti'} ${a.code}`, onclick: () => { collapsed.has(a.code) ? collapsed.delete(a.code) : collapsed.add(a.code); draw(); }}, open ? '▾' : '▸') : h('span', {class: 'tree-toggle'});
    const tr = h('tr', {class: ['acc-row', `lvl-${a.level}`, !a.postable && 'acc-group', !a.active && 'muted']},
      h('td', {'data-label': 'Kodas'}, h('span', {class: 'tree-indent', style: {paddingLeft: `${(a.level - 1) * 1.1}rem`}}, toggle, h('strong', null, a.code))),
      h('td', {'data-label': 'Pavadinimas'}, a.name),
      h('td', {'data-label': 'Tipas'}, TYPE[a.type]),
      h('td', {'data-label': 'Kontuojama'}, a.postable ? 'taip' : 'grupė'),
      h('td', {'data-label': 'Vaidmuo'}, a.system_role || ''),
      h('td', {'data-label': 'Įrašų', class: 'num'}, a.line_count || ''),
      h('td', {'data-label': 'Veiksmai', class: 'acc-actions'}, editable ? [
        a.level < 5 && (a.postable ? !a.line_count && !a.system_role : true) ? h('button', {class: 'btn btn-small', title: `Nauja subsąskaita ${a.code}`, onclick: () => addForm(a)}, '+ sub.') : null,
        a.postable ? h('label', {class: 'check'}, h('input', {type: 'checkbox', checked: a.active, onchange: (e) => guard(async () => { await put(`/api/accounts/${a.code}`, {active: e.target.checked}); a.active = e.target.checked; draw(); }, 'Išsaugota.')}), ' aktyvi') : null,
      ] : null));
    return [tr, open ? kids.map(row) : []];
  };

  const formBox = h('div');
  const addForm = (parent) => {
    const code = input({inputmode: 'numeric', value: parent ? parent.code : ''}), name = input();
    const type = select(Object.entries(TYPE), parent?.type || 'expense', {disabled: !!parent});
    clear(formBox, section(parent ? `Nauja subsąskaita grupėje ${parent.code} ${parent.name}` : 'Nauja sąskaita',
      h('form', {onsubmit: async (e) => { e.preventDefault(); if (await guard(() => post('/api/accounts', {code: code.value, name: name.value, type: type.value, parent_code: parent?.code || null}), 'Sąskaita pridėta.')) render(main, rest, state); }},
        h('div', {class: 'form-grid'}, field('Kodas', code, parent ? `Turi prasidėti ${parent.code}` : null), field('Pavadinimas', name), field('Tipas', type)),
        h('button', {class: 'btn btn-primary'}, 'Pridėti'), ' ', h('button', {type: 'button', class: 'btn', onclick: () => clear(formBox)}, 'Atšaukti'))));
    code.focus();
  };

  const draw = () => clear(box, h('table', {class: 'grid chart-table'},
    h('thead', null, h('tr', null, ['Kodas', 'Pavadinimas', 'Tipas', 'Kontuojama', 'Vaidmuo', 'Įrašų', ''].map((t) => h('th', null, t)))),
    h('tbody', null, (byParent.get('') || []).filter(visible).map(row))));

  const q = input({type: 'search', placeholder: 'Kodas arba pavadinimas', oninput: debounce(() => { st.q = q.value; draw(); }, 200)});
  const inactive = h('input', {type: 'checkbox', onchange: () => { st.inactive = inactive.checked; draw(); }});
  clear(main, pageHeader('Sąskaitų planas',
    h('button', {class: 'btn', onclick: () => { collapsed.clear(); draw(); }}, 'Išskleisti viską'),
    h('button', {class: 'btn', onclick: () => { rows.filter((a) => !a.postable).forEach((a) => collapsed.add(a.code)); draw(); }}, 'Suskleisti')),
    h('p', {class: 'hint'}, 'Planas pagal jūsų buhalterijos failą (UAB). Kontuoti galima tik į žemiausio lygio sąskaitas; grupės sumuoja jų likučius. Subsąskaitą galima kurti, kol grupei dar nėra įrašų. Automatinių įrašų sąskaitos – „Servisas → Kontavimo susiejimai“.'),
    h('div', {class: 'filters'}, field('Paieška', q), h('label', {class: 'check'}, inactive, ' rodyti neaktyvias')), formBox, box);
  draw();
}
