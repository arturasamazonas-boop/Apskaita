// Dokumentai: secure vault – search (metadata + extracted text), contracts lifecycle, versions, metadata, history.
import {h, clear, get, post, put, del, upload, pageHeader, section, table, badge, KIND, CONTRACT, STATUS, date, dateTime, toast, showError, guard, select, input, field, pager, debounce, can, openFile, confirmDialog, eur} from '../core.mjs';

export async function render(main, rest, state) {
  if (rest[0] === 'naujas') return uploadForm(main, state);
  if (rest[0]) return detail(main, rest[0], state);
  const st = {q: '', kind: '', tag: '', archived: 'false', offset: 0, limit: 50};
  const box = h('div');
  const load = async () => {
    const d = await get(`/api/documents?${new URLSearchParams({q: st.q, kind: st.kind, tag: st.tag, archived: st.archived, limit: st.limit, offset: st.offset})}`);
    st.count = d.items.length; st.hasMore = d.hasMore;
    clear(box, table([{label: 'Pavadinimas', render: (d2) => h('a', {href: `#/dokumentai/${d2.id}`}, d2.title || `#${d2.id}`)}, {label: 'Tipas', render: (d2) => KIND[d2.kind] || d2.kind}, {label: 'Kontrahentas', key: 'counterparty_name'},
      {label: 'Nr.', key: 'reference_number'}, {label: 'Būsena', render: (d2) => (d2.kind === 'contract' ? badge(Object.fromEntries(Object.entries(CONTRACT).map(([k, v]) => [k, [v, k === 'active' ? 'ok' : 'neutral']])), d2.contract_status_effective) : badge(STATUS, d2.processing_status))},
      {label: 'Žymos', render: (d2) => d2.tags.join(', ')}, {label: 'Versijos', key: 'versions'}, {label: 'Įkelta', render: (d2) => date(d2.created_at)}, {label: 'Prieiga', render: (d2) => ({normal: '', restricted: 'Ribota', admin_only: 'Tik admin.'}[d2.confidentiality])}],
    d.items, {onRow: (d2) => { location.hash = `#/dokumentai/${d2.id}`; }, empty: 'Dokumentų nerasta.'}), pager(st, load));
  };
  const q = input({type: 'search', placeholder: 'Ieškoti pavadinime, numeryje, kontrahente ar dokumento tekste…', 'aria-label': 'Paieška', oninput: debounce(() => { st.q = q.value; st.offset = 0; load(); })});
  const kind = select([['', 'Visi tipai'], ...Object.entries(KIND)], '', {'aria-label': 'Tipas', onchange: () => { st.kind = kind.value; st.offset = 0; load(); }});
  const tag = input({placeholder: 'Žyma', 'aria-label': 'Žyma', onchange: () => { st.tag = tag.value; load(); }});
  const arch = select([['false', 'Aktyvūs'], ['true', 'Archyvuoti'], ['all', 'Visi']], 'false', {'aria-label': 'Archyvas', onchange: () => { st.archived = arch.value; load(); }});
  clear(main, pageHeader('Dokumentai', can(state.user, 'write') ? h('a', {class: 'btn btn-primary', href: '#/dokumentai/naujas'}, '+ Įkelti dokumentą') : null),
    h('div', {class: 'filters'}, h('div', {class: 'grow'}, q), kind, tag, arch),
    h('p', {class: 'hint'}, 'Paieškos rezultatai rodomi tik pagal jūsų prieigos teises. Sutarčių vertės neregistruojamos apskaitoje.'), box);
  await load();
}

function metaInputs(d = {}) {
  return {
    kind: select(Object.entries(KIND).filter(([k]) => !['generated_invoice', 'bank_statement'].includes(k)), d.kind || 'contract'), title: input({value: d.title || ''}), reference_number: input({value: d.reference_number || ''}),
    counterparty_id: input({value: d.counterparty_id || '', inputmode: 'numeric', placeholder: 'Kontrahento ID'}), issue_date: input({type: 'date', value: d.issue_date || ''}),
    start_date: input({type: 'date', value: d.start_date || ''}), end_date: input({type: 'date', value: d.end_date || ''}), contract_value: input({value: d.contract_value || '', inputmode: 'decimal'}),
    contract_currency: input({value: d.contract_currency || 'EUR'}), contract_status: select([['', 'Pagal datas (automatiškai)'], ...Object.entries(CONTRACT)], d.contract_status_manual ? d.contract_status : ''),
    tags: input({value: (d.tags || []).join(', ')}), notes: h('textarea', {rows: 3}, d.notes || ''), confidentiality: select([['normal', 'Visi naudotojai'], ['restricted', 'Ribota (admin. ir buhalteriai)'], ['admin_only', 'Tik administratoriai']], d.confidentiality || 'normal'),
    retain_until: input({type: 'date', value: d.retain_until || ''}), legal_hold: h('input', {type: 'checkbox', checked: !!d.legal_hold}),
  };
}
const metaValues = (m) => ({kind: m.kind.value, title: m.title.value, reference_number: m.reference_number.value, counterparty_id: m.counterparty_id.value || null, issue_date: m.issue_date.value || null, start_date: m.start_date.value || null, end_date: m.end_date.value || null,
  contract_value: m.contract_value.value.replace(',', '.') || null, contract_currency: m.contract_currency.value, contract_status: m.contract_status.value, tags: m.tags.value, notes: m.notes.value, confidentiality: m.confidentiality.value,
  retain_until: m.retain_until.value || null, legal_hold: m.legal_hold.checked});
const metaForm = (m) => h('div', {class: 'form-grid'}, field('Tipas', m.kind), field('Pavadinimas', m.title), field('Numeris', m.reference_number), field('Kontrahento ID', m.counterparty_id, 'Žr. „Kontaktai ir prekės“'),
  field('Data', m.issue_date), field('Galioja nuo', m.start_date), field('Galioja iki', m.end_date), field('Sutarties vertė', m.contract_value, 'Informacinė – neregistruojama apskaitoje'), field('Valiuta', m.contract_currency),
  field('Sutarties būsena', m.contract_status), field('Žymos (kableliais)', m.tags), field('Prieiga', m.confidentiality), field('Saugoti iki', m.retain_until, 'Nurodykite pagal savo saugojimo politiką; teisės aktų terminų programa nenustato.'),
  h('label', {class: 'check'}, m.legal_hold, ' Draudimas naikinti (legal hold)'), field('Pastabos', m.notes));

async function uploadForm(main, state) {
  const m = metaInputs();
  const fileIn = h('input', {type: 'file', multiple: true});
  clear(main, pageHeader('Įkelti dokumentą', h('a', {class: 'btn btn-small', href: '#/dokumentai'}, '‹ Atgal')),
    h('form', {onsubmit: async (e) => {
      e.preventDefault();
      if (!fileIn.files.length) return toast('Pasirinkite failą.', 'error');
      const fd = new FormData(); fd.append('workflow', 'vault'); fd.append('meta', JSON.stringify(metaValues(m)));
      [...fileIn.files].forEach((f) => fd.append('files', f, f.name));
      try { const r = await upload('/api/uploads', fd); const ok = r.results.filter((x) => x.status === 'uploaded'); r.results.filter((x) => x.status === 'error').forEach((x) => toast(`${x.name}: ${x.message}`, 'error')); if (ok.length) location.hash = `#/dokumentai/${ok[0].documentId}`; } catch (x) { showError(x); }
    }}, section('Failai', fileIn, h('p', {class: 'hint'}, 'PDF, DOCX, XLSX, JPG, PNG, TXT, CSV, XML. Originalas saugomas nekeičiamas; tekstas indeksuojamas paieškai.')), section('Metaduomenys', metaForm(m)), h('button', {class: 'btn btn-primary'}, 'Įkelti')));
}

async function detail(main, id, state) {
  const d = await get(`/api/documents/${id}`);
  const m = metaInputs(d);
  const originals = d.files.filter((f) => ['original', 'generated'].includes(f.role));
  const derived = d.files.filter((f) => !['original', 'generated'].includes(f.role));
  const versionIn = h('input', {type: 'file', 'aria-label': 'Nauja versija'});
  clear(main, pageHeader(d.title || `Dokumentas #${d.id}`, h('a', {class: 'btn btn-small', href: '#/dokumentai'}, '‹ Dokumentai'),
    d.workflow === 'invoice' ? h('a', {class: 'btn btn-small', href: `#/deze/${d.id}`}, 'Peržiūra dėžutėje') : null),
    d.kind === 'contract' ? h('div', {class: 'banner'}, `Sutarties būsena: ${CONTRACT[d.contract_status_effective] || '—'}${d.contract_status_manual ? ' (nustatyta rankiniu būdu)' : ' (pagal datas)'}. Sutarties vertė ${d.contract_value ? eur(d.contract_value) : '—'} yra informacinė ir nesukuria pajamų, sąnaudų ar įsipareigojimų įrašų.`) : null,
    section('Failų versijos (originalai nekeičiami)', table([{label: 'Versija', key: 'version'}, {label: 'Failas', key: 'original_name'}, {label: 'Dydis', render: (f) => `${Math.round(f.size_bytes / 1024)} KB`}, {label: 'SHA-256', render: (f) => h('code', {title: f.sha256}, f.sha256.slice(0, 16) + '…')},
      {label: 'Įkėlė', render: (f) => `${f.uploaded_by_name || 'Sistema'} ${dateTime(f.uploaded_at)}`}, {label: 'Pastaba', key: 'note'}, {label: '', render: (f) => h('span', null, h('button', {class: 'btn btn-small', onclick: () => guard(() => openFile(f.id))}, 'Peržiūrėti'), ' ', h('button', {class: 'btn btn-small', onclick: () => guard(() => openFile(f.id, {download: true}))}, 'Atsisiųsti'))}], originals),
    can(state.user, 'write') && d.processing_status !== 'posted' ? h('div', {class: 'actions'}, versionIn, h('button', {class: 'btn btn-small', onclick: async () => {
      if (!versionIn.files[0]) return toast('Pasirinkite failą.', 'error');
      const fd = new FormData(); fd.append('file', versionIn.files[0], versionIn.files[0].name); fd.append('note', 'Nauja versija');
      try { await upload(`/api/documents/${d.id}/versions`, fd); toast('Įkelta nauja versija.', 'ok'); detail(main, id, state); } catch (e) { showError(e); }
    }}, 'Įkelti naują versiją')) : null,
    derived.length ? h('details', null, h('summary', null, `Išvestiniai failai (peržiūros, OCR): ${derived.length}`), table([{label: 'Rolė', key: 'role'}, {label: 'Psl.', key: 'page'}, {label: 'Iš failo', key: 'derived_from_file_id'}, {label: 'Pastaba', key: 'note'}], derived)) : null),
    section('Metaduomenys', metaForm(m), can(state.user, 'write') ? h('div', {class: 'actions'},
      h('button', {class: 'btn btn-primary', onclick: () => guard(() => put(`/api/documents/${d.id}`, metaValues(m)), 'Išsaugota.').then((r) => r && detail(main, id, state))}, 'Išsaugoti'),
      h('button', {class: 'btn', onclick: () => guard(() => put(`/api/documents/${d.id}`, {archived: !d.archived}), d.archived ? 'Grąžinta iš archyvo.' : 'Archyvuota.').then(() => detail(main, id, state))}, d.archived ? 'Grąžinti iš archyvo' : 'Archyvuoti'),
      h('button', {class: 'btn btn-danger', disabled: d.deletionBlockers.length > 0, title: d.deletionBlockers.join(' '), onclick: async () => { if (await confirmDialog('Pašalinti dokumentą', 'Dokumentas bus paslėptas iš sąrašų. Originalūs failai ir audito istorija išliks.')) { if (await guard(() => del(`/api/documents/${d.id}`), 'Pašalinta.')) location.hash = '#/dokumentai'; } }}, 'Pašalinti')) : null,
    d.deletionBlockers.length ? h('p', {class: 'hint'}, `Negalima pašalinti: ${d.deletionBlockers.join(' ')}`) : null),
    d.invoices.length ? section('Apskaitos įrašai', table([{label: 'Sąskaita', render: (i) => h('a', {href: `#/${i.register === 'sales' ? 'pardavimai' : 'pirkimai'}/s/${i.id}`}, `${i.series} ${i.number}`)}, {label: 'Tipas', key: 'doc_type'}, {label: 'Suma', num: true, render: (i) => eur(i.gross_total)}], d.invoices)) : null,
    d.links.length ? section('Susiję dokumentai', table([{label: 'Ryšys', key: 'relation'}, {label: 'Dokumentas', render: (l) => h('a', {href: `#/dokumentai/${l.id}`}, l.title || `#${l.id}`)}], d.links)) : null,
    can(state.user, 'write') ? section('Susieti su dokumentu', (() => { const to = input({inputmode: 'numeric', placeholder: 'Dokumento ID'}); const rel = select([['related', 'Susijęs'], ['contract_invoice', 'Sutarties sąskaita'], ['replaces', 'Pakeičia'], ['attachment', 'Priedas']], 'related');
      return h('div', {class: 'filters'}, to, rel, h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/documents/${d.id}/links`, {toDocumentId: to.value, relation: rel.value}), 'Susieta.').then(() => detail(main, id, state))}, 'Susieti')); })()) : null,
    d.history.length ? section('Istorija', table([{label: 'Laikas', render: (x) => dateTime(x.at)}, {label: 'Veiksmas', key: 'action'}, {label: 'Naudotojas', render: (x) => x.user_name || 'Sistema'}], d.history)) : null);
}
