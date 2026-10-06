// Dokumentų dėžutė: drag & drop upload with progress, status queues, filters, bulk approval of selected ready documents.
import {h, clear, get, post, upload, pageHeader, table, badge, STATUS, eur, date, toast, showError, guard, select, input, field, pager, debounce, can, confirmDialog} from '../core.mjs';

export async function render(main, rest, state) {
  if (rest[0]) return (await import('./review.mjs')).render(main, rest, state);
  const formats = await get('/api/supported-formats');
  const st = {status: '', q: '', register: '', offset: 0, limit: 50, count: 0, hasMore: false};
  const selected = new Map();
  const listBox = h('div');
  const tabs = h('div', {class: 'tabs', role: 'tablist'});
  const progress = h('div', {class: 'upload-progress', 'aria-live': 'polite'});
  let timer;

  const fileInput = h('input', {type: 'file', multiple: true, accept: '.pdf,.docx,.jpg,.jpeg,.png', class: 'visually-hidden', id: 'inbox-files', onchange: () => send([...fileInput.files])});
  const drop = h('div', {class: 'dropzone', tabindex: '0', role: 'button', 'aria-describedby': 'formats',
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } }, onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); send([...e.dataTransfer.files]); }},
  h('strong', null, 'Nutempkite sąskaitas čia arba spauskite, kad pasirinktumėte'),
  h('span', {id: 'formats', class: 'hint'}, `Palaikoma: ${Object.values(formats.invoice).join(', ')}. Galima keli failai vienu metu.`), fileInput);

  async function send(files) {
    if (!can(state.user, 'write')) return toast('Neturite teisės įkelti.', 'error');
    if (!files.length) return;
    const fd = new FormData();
    fd.append('workflow', 'invoice');
    files.forEach((f) => fd.append('files', f, f.name));
    const bar = h('progress', {max: 100, value: 0, 'aria-label': 'Įkėlimo eiga'});
    clear(progress, h('span', null, `Įkeliama ${files.length} failų… `), bar);
    try {
      const r = await upload('/api/uploads', fd, (p) => { bar.value = p; });
      clear(progress, h('ul', {class: 'upload-results'}, r.results.map((x) => h('li', {class: `res-${x.status}`},
        `${x.name}: `, x.status === 'uploaded' ? 'įkelta, atpažįstama…' : x.status === 'duplicate' ? h('span', null, x.message, ' ', h('a', {href: `#/deze/${x.documentId}`}, 'Atidaryti')) : x.message))));
      fileInput.value = '';
      load();
    } catch (e) { showError(e); clear(progress); }
  }

  async function load() {
    const q = new URLSearchParams({limit: st.limit, offset: st.offset, ...(st.status && {status: st.status}), ...(st.q && {q: st.q}), ...(st.register && {register: st.register})});
    const d = await get(`/api/inbox?${q}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(tabs, [['', 'Visi'], ['needs_review', 'Reikia peržiūros'], ['ready', 'Paruošta tvirtinti'], ['processing', 'Apdorojama'], ['failed', 'Nepavyko'], ['posted', 'Užregistruota'], ['rejected', 'Atmesta']].map(([k, t]) =>
      h('button', {class: ['tab', st.status === k && 'active'], role: 'tab', 'aria-selected': String(st.status === k), onclick: () => { st.status = k; st.offset = 0; load(); }}, t, k && d.counts[k] ? h('span', {class: 'count'}, d.counts[k]) : null)));
    const cols = [
      {label: '', render: (r) => r.processing_status === 'ready' && r.proposal_id ? h('input', {type: 'checkbox', 'aria-label': `Pažymėti ${r.title}`, checked: selected.has(r.proposal_id), onchange: (e) => { e.target.checked ? selected.set(r.proposal_id, r.content_hash) : selected.delete(r.proposal_id); bulkBtn.disabled = !selected.size; bulkBtn.textContent = `Patvirtinti pažymėtus (${selected.size})`; }}) : ''},
      {label: 'Dokumentas', render: (r) => h('a', {href: `#/deze/${r.id}`}, r.title || r.file_name || `#${r.id}`)},
      {label: 'Būsena', render: (r) => h('span', null, badge(STATUS, r.processing_status), r.processing_status === 'processing' && r.job_status === 'queued' ? h('small', {class: 'hint'}, ' eilėje') : null)},
      {label: 'Registras', render: (r) => ({purchase: 'Pirkimai', sales: 'Pardavimai'}[r.register] || '—')},
      {label: 'Kontrahentas', key: 'counterparty'},
      {label: 'Data', render: (r) => date(r.issue_date)},
      {label: 'Suma', num: true, render: (r) => eur(r.gross)},
      {label: 'Pastaba', render: (r) => r.processing_error || (Number(r.errors) ? `${r.errors} klaid.: ${r.first_error || ''}` : r.proposal_kind === 'correction' ? 'Koregavimo pasiūlymas' : '')},
    ];
    clear(listBox, table(cols, d.items, {onRow: (r) => { location.hash = `#/deze/${r.id}`; }, empty: 'Dokumentų nėra. Įkelkite sąskaitas aukščiau.'}), pager(st, load));
    clearTimeout(timer);
    if (d.items.some((x) => ['uploaded', 'processing'].includes(x.processing_status)) && location.hash.startsWith('#/deze')) timer = setTimeout(load, 2500);
  }

  const bulkBtn = h('button', {class: 'btn btn-primary', disabled: true, onclick: async () => {
    if (!await confirmDialog('Patvirtinti pažymėtus', `Bus patvirtinta ${selected.size} pilnai patikrintų dokumentų. Kiekvienas patikrinamas iš naujo serveryje; turintys klaidų nebus užregistruoti.`)) return;
    const r = await guard(() => post('/api/proposals/bulk-approve', {items: [...selected].map(([proposalId, contentHash]) => ({proposalId, contentHash}))}));
    if (r) { const ok = r.results.filter((x) => x.ok).length; toast(`Patvirtinta: ${ok}. Nepavyko: ${r.results.length - ok}.`, ok === r.results.length ? 'ok' : 'error'); selected.clear(); load(); }
  }}, 'Patvirtinti pažymėtus (0)');
  const search = input({type: 'search', placeholder: 'Ieškoti pagal pavadinimą…', 'aria-label': 'Paieška', oninput: debounce(() => { st.q = search.value; st.offset = 0; load(); })});
  const reg = select([['', 'Visi registrai'], ['purchase', 'Pirkimai'], ['sales', 'Pardavimai']], '', {'aria-label': 'Registras', onchange: () => { st.register = reg.value; load(); }});
  clear(main, pageHeader('Dokumentų dėžutė', can(state.user, 'approve') ? bulkBtn : null),
    can(state.user, 'write') ? drop : null, progress, tabs, h('div', {class: 'filters'}, search, reg), listBox);
  await load();
}
