// Review screen: original beside editable fields; selecting a field highlights its source (page box, DOCX
// paragraph or table cell). Edits are saved as new versions; approval quotes the exact saved version hash.
import {h, clear, get, post, put, pageHeader, section, badge, STATUS, DOC_TYPE, LINE_TYPE, VAT_T, eur, money, date, dateTime, toast, showError, guard,
  select, input, field, table, modal, confirmDialog, promptDialog, fileUrl, openFile, can} from '../core.mjs';

const PROV = {uncertain: ['Neaišku', 'warn'], conflict: ['Prieštaravimas', 'error'], missing: ['Nerasta', 'muted'], defaulted: ['Numatyta reikšmė', 'info'], ok: ['Atpažinta', 'ok']};

export async function render(main, [docId], state) {
  let doc;
  if (String(docId).startsWith('p')) {
    // Proposal without a document (store order): review the same way, without an original viewer.
    const pr = await get(`/api/proposals/${docId.slice(1)}`);
    doc = {id: null, title: `Parduotuvės užsakymo sąskaitos pasiūlymas #${pr.id}`, files: [], proposals: [pr], invoices: [], extraction: null, workflow: 'store',
      processing_status: pr.status === 'approved' ? 'posted' : pr.blocking ? 'needs_review' : 'ready'};
  } else doc = await get(`/api/documents/${docId}`);
  const openP = doc.proposals.find((p) => p.status === 'open') || doc.proposals[0];
  const [accounts, taxCodes] = await Promise.all([get('/api/accounts'), get('/api/tax-codes')]);
  if (!openP) {
    clear(main, pageHeader(doc.title || `Dokumentas #${doc.id}`), badge(STATUS, doc.processing_status),
      h('p', null, doc.processing_error || (['uploaded', 'processing'].includes(doc.processing_status) ? 'Dokumentas atpažįstamas – puslapis atsinaujins.' : 'Pasiūlymo nėra.')),
      doc.processing_status === 'failed' ? h('button', {class: 'btn', onclick: () => guard(() => post(`/api/documents/${doc.id}/reextract`), 'Paleista iš naujo.').then(() => render(main, [docId], state))}, 'Bandyti iš naujo') : null);
    if (['uploaded', 'processing'].includes(doc.processing_status)) setTimeout(() => { if (location.hash === `#/deze/${docId}`) render(main, [docId], state); }, 2500);
    return;
  }
  let p = await get(`/api/proposals/${openP.id}`);
  const editable = p.status === 'open' && can(state.user, 'write');
  let model = structuredClone(p.data);
  let dirty = false;
  const viewer = h('div', {class: 'viewer', 'aria-label': 'Originalus dokumentas'});
  const form = h('div', {class: 'review-form'});
  const bar = h('div', {class: 'review-bar'});
  const accOptions = [['', '— pasirinkite —'], ...accounts.filter((a) => a.active).map((a) => [a.code, `${a.code} ${a.name}`])];
  const taxOptions = [['', '—'], ['BE_PVM', 'Be PVM'], ...[...new Set(taxCodes.filter((t) => t.active).map((t) => t.code))].map((c) => { const t = taxCodes.find((x) => x.code === c); return [c, `${c} ${t.rate === null ? '' : Number(t.rate) + ' %'}`]; })];

  // ------------------------------------------------------------ viewer
  let highlightLayer = [];
  const pagesEl = h('div', {class: 'pages'});
  async function drawViewer() {
    const previews = doc.files.filter((f) => f.role === 'preview').sort((a, b) => b.version - a.version || a.page - b.page);
    const latestVersion = previews[0]?.version;
    const original = doc.files.find((f) => f.role === 'original' || f.role === 'generated');
    const tools = h('div', {class: 'viewer-tools'}, original ? h('button', {class: 'btn btn-small', onclick: () => openFile(original.id)}, 'Atidaryti originalą') : h('span', {class: 'hint'}, 'Įvesta rankiniu būdu – originalo failo nėra.'),
      doc.extraction ? h('span', {class: 'hint'}, `Atpažinimas: ${doc.extraction.provider} (${dateTime(doc.extraction.created_at)})${doc.extraction.pages?.some((x) => x.method === 'ocr') ? ', OCR' : ''}`) : null);
    clear(viewer, tools, pagesEl);
    const layout = doc.extraction?.layout || [];
    if (previews.length) {
      for (const pv of previews.filter((x) => x.version === latestVersion)) {
        const wrap = h('div', {class: 'page', 'data-page': pv.page}, h('img', {alt: `Puslapis ${pv.page}`, loading: 'lazy'}));
        pagesEl.append(wrap);
        fileUrl(pv.id).then((u) => { wrap.querySelector('img').src = u; });
        const pl = layout.find((l) => l.page === pv.page);
        if (pl?.method === 'ocr') wrap.append(h('span', {class: 'page-tag'}, 'OCR'));
      }
    } else if (layout.length) {
      // DOCX: structured rendering of paragraphs and table cells.
      for (const pg of layout) {
        const box = h('div', {class: 'docx-view'});
        let tbl = null, tno = null;
        for (const r of pg.rows) {
          if (r.source?.kind === 'docx-table') {
            if (tno !== r.source.table) { tbl = h('table', {class: 'docx-table'}); box.append(tbl); tno = r.source.table; }
            tbl.append(h('tr', null, r.segments.map((s) => h('td', {'data-src': `t${s.source?.table}r${s.source?.row}c${s.source?.cell}`}, s.text))));
          } else { tno = null; box.append(h('p', {'data-src': `p${r.source?.paragraph}`}, r.text)); }
        }
        pagesEl.append(box);
      }
    }
  }
  function highlight(path) {
    highlightLayer.forEach((x) => x.remove ? x.remove() : x.classList.remove('hl'));
    highlightLayer = [];
    const prov = model.provenance?.[path] || (path.startsWith('lines.') ? {source: model.lines[Number(path.split('.')[1])]?.sourceRef} : null);
    const s = prov?.source;
    if (!s) return;
    if (s.kind === 'docx-table' || s.kind === 'docx-paragraph') {
      const sel = s.kind === 'docx-table' ? (s.cell ? `[data-src="t${s.table}r${s.row}c${s.cell}"]` : `[data-src^="t${s.table}r${s.row}c"]`) : `[data-src="p${s.paragraph}"]`;
      viewer.querySelectorAll(sel).forEach((el) => { el.classList.add('hl'); highlightLayer.push(el); });
      highlightLayer[0]?.scrollIntoView({block: 'center', behavior: 'smooth'});
      return;
    }
    const pageEl = viewer.querySelector(`.page[data-page="${s.page}"]`);
    if (!pageEl || !s.bbox) return;
    const [x0, y0, x1, y1] = s.bbox;
    const box = h('div', {class: 'hl-box', title: s.text || '', style: {left: `${x0 * 100 - 0.5}%`, top: `${y0 * 100 - 0.4}%`, width: `${(x1 - x0) * 100 + 1}%`, height: `${(y1 - y0) * 100 + 0.8}%`}});
    pageEl.append(box);
    highlightLayer.push(box);
    box.scrollIntoView({block: 'center', behavior: 'smooth'});
  }

  // ------------------------------------------------------------ form helpers
  const markDirty = () => { dirty = true; drawBar(); };
  const get_ = (path) => path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), model);
  const set_ = (path, v) => { const ks = path.split('.'); let o = model; for (const k of ks.slice(0, -1)) o = o[k]; o[ks.at(-1)] = v; };
  function provBadge(path) {
    const pr = model.provenance?.[path];
    if (!pr) return null;
    const status = pr.corrected ? null : pr.status;
    const items = [];
    if (pr.corrected) items.push(h('span', {class: 'badge badge-info', title: `Atpažinta: ${pr.extractedValue ?? '—'}; pataisė ${pr.corrected.byName || ''} ${dateTime(pr.corrected.at)}`}, 'Pataisyta'));
    else if (status && status !== 'ok') items.push(badge(PROV, status));
    if (pr.providerScore) items.push(h('span', {class: 'hint', title: pr.providerScore.meaning}, ` ${pr.providerScore.provider}: ${pr.providerScore.score}/100`));
    if (pr.derived) items.push(h('span', {class: 'hint'}, ` ${pr.derived}`));
    return items.length ? h('span', {class: 'prov'}, items) : null;
  }
  function needsConfirm(path) { const pr = model.provenance?.[path]; return pr && !pr.corrected && ['uncertain', 'conflict'].includes(pr.status); }
  function fieldOf(label, path, {type = 'text', options = null, width} = {}) {
    const val = get_(path) ?? '';
    const el = options ? select(options, val, {disabled: !editable}) : input({type, value: val, disabled: !editable, class: width});
    el.addEventListener('focus', () => highlight(path));
    el.addEventListener(options ? 'change' : 'input', () => { set_(path, el.value); markDirty(); });
    const pr = model.provenance?.[path];
    const conf = needsConfirm(path) ? h('label', {class: 'check small'}, h('input', {type: 'checkbox', disabled: !editable, checked: !!model.confirmations?.[path], onchange: (e) => { model.confirmations = {...model.confirmations, [path]: e.target.checked}; markDirty(); }}), ' Patvirtinu reikšmę') : null;
    const wrap = field(label, el, pr?.reason && !pr.corrected ? pr.reason : null);
    wrap.dataset.path = path;
    wrap.querySelector('label').append(' ', provBadge(path) || '');
    if (conf) wrap.append(conf);
    if (pr?.source) wrap.append(h('button', {type: 'button', class: 'link small', onclick: () => highlight(path)}, 'Rodyti šaltinyje'));
    return wrap;
  }

  // ------------------------------------------------------------ issues & computed
  function issuesBox(v) {
    const groups = [['error', 'Klaidos (blokuoja tvirtinimą)'], ['warning', 'Įspėjimai'], ['info', 'Informacija']];
    return h('div', {class: 'issues', 'aria-live': 'polite'}, groups.map(([lvl, title]) => {
      const list = (v.issues || []).filter((i) => i.level === lvl);
      if (!list.length) return null;
      return h('div', {class: `issue-group issue-${lvl}`}, h('strong', null, title), h('ul', null, list.map((i) => h('li', null,
        h('button', {type: 'button', class: 'link', onclick: () => { const el = form.querySelector(`[data-path="${i.field}"] input, [data-path="${i.field}"] select`); el?.focus(); highlight(i.field); }}, i.message),
        ackFor(i)))));
    }));
  }
  function ackFor(i) {
    if (!editable) return null;
    let key = null;
    if (i.code === 'duplicate_open') key = `dup:${(/#(\d+)/.exec(i.message) || [])[1]}`;
    if (i.code === 'duplicate_near') return null;
    if (i.code === 'split') return h('button', {type: 'button', class: 'btn btn-small', onclick: splitDoc}, 'Padalinti failą');
    if (!key) return null;
    return h('label', {class: 'check small'}, h('input', {type: 'checkbox', checked: !!model.acknowledgements?.[key], onchange: (e) => { model.acknowledgements = {...model.acknowledgements, [key]: e.target.checked}; markDirty(); }}), ' Patvirtinu, kad tai skirtingi dokumentai');
  }
  function computedBox(v) {
    const c = v.computed || {};
    return h('div', null,
      h('div', {class: 'totals'}, h('div', null, h('span', null, 'Suma be PVM'), h('strong', null, eur(c.net))), h('div', null, h('span', null, 'PVM'), h('strong', null, eur(c.vat))), h('div', null, h('span', null, 'Iš viso'), h('strong', null, eur(c.gross))),
        model.register === 'purchase' ? h('div', null, h('span', null, 'Atskaitomas PVM'), h('strong', null, eur(c.deductibleVat))) : null),
      table([{label: 'PVM kodas', key: 'taxCode'}, {label: 'Tarifas', render: (g) => `${g.rate ?? '—'} %`}, {label: 'Apmokestinama', num: true, render: (g) => money(g.taxable)}, {label: 'Apskaičiuota', num: true, render: (g) => money(g.vatComputed)}, {label: 'Dokumente', num: true, render: (g) => money(g.vatSource)}, {label: 'Naudojama', num: true, render: (g) => money(g.vat)}, {label: 'Paaiškinimas', key: 'note'}], c.vatGroups || []),
      h('h3', null, 'Siūlomi didžiosios knygos įrašai'),
      table([{label: 'Sąskaita', render: (e) => `${e.account} ${e.accountName}`}, {label: 'Kontrahentas', key: 'counterparty'}, {label: 'Debetas', num: true, render: (e) => (Number(e.debit) ? money(e.debit) : '')}, {label: 'Kreditas', num: true, render: (e) => (Number(e.credit) ? money(e.credit) : '')}], c.entries || [], {empty: 'Įrašai bus parodyti, kai bus pasirinktas registras ir sąskaitos.'}));
  }

  // ------------------------------------------------------------ lines
  function linesBox() {
    const rows = model.lines.map((l, i) => {
      const cell = (k, opts = {}) => {
        const path = `lines.${i}.${k}`;
        const el = opts.options ? select(opts.options, l[k] ?? '', {disabled: !editable, 'aria-label': `${opts.label} (${i + 1} eil.)`}) : input({value: l[k] ?? '', disabled: !editable, class: opts.cls, 'aria-label': `${opts.label} (${i + 1} eil.)`, inputmode: opts.num ? 'decimal' : null});
        el.addEventListener('focus', () => highlight(path));
        el.addEventListener(opts.options ? 'change' : 'input', () => { l[k] = el.value; if (['accountCode', 'lineType', 'vatTreatment'].includes(k)) l.userClassified = true; if (k === 'vatRate') l.taxCode = ''; markDirty(); });
        const pr = model.provenance?.[path];
        return h('td', {'data-path': path, class: pr && !pr.corrected && ['uncertain', 'conflict'].includes(pr.status) ? 'cell-warn' : null}, el);
      };
      const s = l.suggestion || {};
      return [h('tr', null,
        h('td', null, String(i + 1)), cell('description', {label: 'Aprašymas', cls: 'w-desc'}), cell('quantity', {label: 'Kiekis', cls: 'w-num', num: true}), cell('unit', {label: 'Mato vnt.', cls: 'w-unit'}),
        cell('unitPrice', {label: 'Kaina', cls: 'w-num', num: true}), cell('discount', {label: 'Nuolaida', cls: 'w-num', num: true}), cell('sourceNet', {label: 'Suma dokumente', cls: 'w-num', num: true}),
        cell('vatRate', {label: 'PVM %', cls: 'w-unit', num: true}), cell('taxCode', {label: 'PVM kodas', options: taxOptions}),
        cell('accountCode', {label: 'Sąskaita', options: accOptions}), cell('lineType', {label: 'Tipas', options: [['', '—'], ...Object.entries(LINE_TYPE)]}),
        cell('vatTreatment', {label: 'PVM atskaita', options: [['', '—'], ...Object.entries(VAT_T)]}),
        h('td', null, editable ? h('button', {class: 'btn-icon', 'aria-label': `Pašalinti ${i + 1} eilutę`, onclick: () => { model.lines.splice(i, 1); markDirty(); drawForm(p.validation); }}, '×') : null)),
      h('tr', {class: 'line-note'}, h('td'), h('td', {colspan: 12}, h('small', null, `Pasiūlymo šaltinis: ${{rule: 'patvirtinta taisyklė', product: 'prekės kortelė', keyword: 'raktažodžiai', llm: 'kalbos modelis', manual: 'naudotojas', default: 'numatyta', store: 'parduotuvė', original: 'originali sąskaita', none: 'nėra'}[s.source] || '—'}. ${s.explanation || ''} ${s.vatExplanation ? `PVM: ${s.vatExplanation}` : ''}`),
        can(state.user, 'rules') && model.register && l.accountCode ? h('button', {class: 'link small', onclick: () => ruleDialog(i)}, ' Sukurti taisyklę iš šios eilutės') : null))];
    });
    return h('div', null, h('div', {class: 'table-wrap'}, h('table', {class: 'grid lines'},
      h('thead', null, h('tr', null, ['#', 'Aprašymas', 'Kiekis', 'Vnt.', 'Kaina be PVM', 'Nuolaida', 'Suma dok.', 'PVM %', 'PVM kodas', 'Sąskaita', 'Tipas', 'PVM atskaita', ''].map((t) => h('th', {scope: 'col'}, t)))),
      h('tbody', null, rows.flat()))),
    editable ? h('button', {class: 'btn btn-small', onclick: () => { model.lines.push({description: '', quantity: '1', unit: 'vnt.', unitPrice: '', discount: '0', sourceNet: '', vatRate: '21', taxCode: '', accountCode: '', lineType: '', vatTreatment: '', userClassified: false}); markDirty(); drawForm(p.validation); }}, '+ Pridėti eilutę') : null);
  }

  async function ruleDialog(i) {
    const l = model.lines[i];
    const scope = select([['counterparty', `Tik šiam kontrahentui (${model.counterparty?.name || ''})`], ['all', 'Visiems kontrahentams']], model.counterparty?.id ? 'counterparty' : 'all');
    const match = input({value: (l.description || '').split(/\s+/).slice(0, 2).join(' ')});
    const prio = input({value: '100', inputmode: 'numeric'});
    const from = input({type: 'date', value: model.issueDate});
    const to = input({type: 'date'});
    const m = modal('Nauja klasifikavimo taisyklė', h('form', {onsubmit: async (e) => {
      e.preventDefault();
      const r = await guard(() => post(`/api/proposals/${p.id}/rule-from-line`, {lineIndex: i, scope: scope.value, matchText: match.value, priority: prio.value, effectiveFrom: from.value, effectiveTo: to.value || null}), 'Taisyklė sukurta ir patvirtinta jūsų vardu.');
      if (r) m.close();
    }}, h('p', null, `Sąskaita ${l.accountCode}, tipas ${LINE_TYPE[l.lineType] || l.lineType}, PVM: ${VAT_T[l.vatTreatment] || l.vatTreatment}. Taisyklė bus taikoma naujiems dokumentams ir užfiksuota audito žurnale.`),
    field('Taikymo sritis', scope), field('Aprašyme turi būti tekstas (tuščia – bet kokia eilutė)', match), field('Prioritetas (mažesnis – svarbesnis)', prio), field('Galioja nuo', from), field('Galioja iki', to),
    h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Patvirtinti taisyklę'))));
  }

  async function splitDoc() {
    const hint = model.splitHint;
    const text = await promptDialog('Padalinti failą', 'Puslapių grupės, pvz. „1-1, 2-3“', {placeholder: hint?.ranges?.map((r) => `${r.from}-${r.to}`).join(', ')});
    if (text === null) return;
    const ranges = (text || hint.ranges.map((r) => `${r.from}-${r.to}`).join(',')).split(',').map((s) => { const [a, b] = s.trim().split('-'); return {from: Number(a), to: Number(b || a)}; });
    const r = await guard(() => post(`/api/documents/${doc.id}/split`, {ranges}), 'Failas padalintas – dalys atpažįstamos.');
    if (r) location.hash = '#/deze';
  }

  // ------------------------------------------------------------ form
  function drawForm(v) {
    const docTypes = Object.entries(DOC_TYPE).filter(([k]) => k !== 'correction');
    clear(form,
      p.kind === 'correction' ? h('div', {class: 'banner banner-warn'}, 'Koregavimo pasiūlymas: dokumentas jau užregistruotas. Patvirtinus bus užregistruotas tik skirtumas, originalūs įrašai lieka nepakeisti.') : null,
      p.status !== 'open' ? h('div', {class: 'banner'}, `Ši versija: ${{approved: 'patvirtinta', rejected: 'atmesta', superseded: 'pakeista naujesne'}[p.status]}.`, doc.invoices[0] ? h('a', {href: `#/${doc.invoices[0].register === 'sales' ? 'pardavimai' : 'pirkimai'}/s/${doc.invoices[0].id}`}, ' Atidaryti užregistruotą sąskaitą') : null) : null,
      issuesBox(v),
      section('Dokumentas', h('div', {class: 'form-grid'},
        fieldOf('Tipas', 'docType', {options: docTypes}), fieldOf('Registras', 'register', {options: [['', '— pasirinkite —'], ['purchase', 'Pirkimai'], ['sales', 'Pardavimai']]}),
        model.issueHere ? h('p', {class: 'hint'}, `Numeris bus suteiktas patvirtinant (serija ${model.seriesCode}).`) : [fieldOf('Serija', 'series'), fieldOf('Numeris', 'number')],
        fieldOf('Išrašymo data', 'issueDate', {type: 'date'}), fieldOf('Apmokėti iki', 'dueDate', {type: 'date'}), fieldOf('PVM apskaičiavimo data (jei kita)', 'vatPointDate', {type: 'date'}),
        fieldOf('Valiuta', 'currency'), fieldOf('Mokėjimo paskirtis', 'paymentReference'), fieldOf('Užsakymo nr.', 'orderReference'), fieldOf('Koreguojamas dokumentas', 'relatedDocument')),
      model.registerReason ? h('p', {class: 'hint'}, model.registerReason) : null),
      section(model.register === 'sales' ? 'Pirkėjas' : 'Tiekėjas', h('div', {class: 'form-grid'},
        fieldOf('Pavadinimas', 'counterparty.name'), fieldOf('Įmonės kodas', 'counterparty.companyCode'), fieldOf('PVM mokėtojo kodas', 'counterparty.vatCode'),
        fieldOf('Adresas', 'counterparty.address'), fieldOf('Šalis', 'counterparty.country'), fieldOf('IBAN', 'counterparty.iban')),
      h('p', {class: 'hint'}, model.counterparty?.id ? `Susieta su esamu kontrahentu #${model.counterparty.id}.` : 'Naujas kontrahentas bus sukurtas patvirtinus.')),
      section('Eilutės', linesBox()),
      section('Dokumento sumos (kaip atspausdinta)', h('div', {class: 'form-grid'}, fieldOf('Suma be PVM', 'sourceTotals.net'), fieldOf('PVM', 'sourceTotals.vat'), fieldOf('Iš viso', 'sourceTotals.gross'),
        (model.sourceTotals.vatByRate || []).map((r, i) => fieldOf(`PVM ${r.rate} %`, `sourceTotals.vatByRate.${i}.amount`))),
      h('p', {class: 'hint'}, 'Serveris perskaičiuoja sumas ir PVM pagal eilutes; neatitikimai su dokumento sumomis paaiškinami aukščiau.')),
      section('Apskaičiuota serveryje', computedBox(v)),
      model.extractionNotes?.length ? section('Atpažinimo pastabos', h('ul', null, model.extractionNotes.map((n) => h('li', null, n)))) : null,
      section('Versijos', table([{label: 'Versija', key: 'version'}, {label: 'Būsena', key: 'status'}, {label: 'Sukurta', render: (x) => dateTime(x.created_at)}, {label: 'Kas', render: (x) => x.created_by_name || 'Sistema'}], p.versions || [])));
  }

  function drawBar() {
    const blocking = p.validation?.blocking ?? p.blocking;
    clear(bar,
      dirty ? h('span', {class: 'badge badge-warn'}, 'Yra neišsaugotų pakeitimų') : h('span', {class: 'hint'}, `Versija ${p.version}`),
      editable ? h('button', {class: 'btn', onclick: recompute}, 'Perskaičiuoti') : null,
      editable ? h('button', {class: 'btn', disabled: !dirty, onclick: save}, 'Išsaugoti pakeitimus') : null,
      p.status === 'open' && can(state.user, 'approve') ? h('button', {class: 'btn btn-primary', disabled: dirty || blocking, title: dirty ? 'Pirmiausia išsaugokite pakeitimus' : blocking ? 'Išspręskite klaidas' : 'Ctrl+Enter', onclick: approve}, 'Patvirtinti') : null,
      p.status === 'open' && can(state.user, 'approve') ? h('button', {class: 'btn btn-danger', onclick: reject}, 'Atmesti') : null,
      p.status === 'open' && ['proforma', 'contract', 'receipt'].includes(model.docType) && editable ? h('button', {class: 'btn', onclick: toVault}, 'Perkelti į dokumentų saugyklą') : null,
      doc.workflow === 'invoice' && can(state.user, 'write') && doc.files.some((f) => f.role === 'original') ? h('button', {class: 'btn btn-small', onclick: () => guard(() => post(`/api/documents/${doc.id}/reextract`), 'Atpažinimas paleistas iš naujo. Užregistruoti įrašai nebus keičiami.')}, 'Atpažinti iš naujo') : null);
  }

  async function recompute() {
    const r = await guard(() => post(`/api/proposals/${p.id}/compute`, {data: model}));
    if (r) { drawForm(r); toast(r.blocking ? 'Perskaičiuota: liko klaidų.' : 'Perskaičiuota: klaidų nėra. Išsaugokite pakeitimus.', r.blocking ? 'error' : 'ok'); }
  }
  async function save() {
    const r = await guard(() => put(`/api/proposals/${p.id}`, {contentHash: p.content_hash, data: model}), 'Išsaugota nauja versija; ankstesnis tvirtinimo prašymas nebegalioja.');
    if (r) { p = await get(`/api/proposals/${r.id}`); model = structuredClone(p.data); dirty = false; drawForm(p.validation); drawBar(); }
  }
  async function approve() {
    if (dirty) return toast('Pirmiausia išsaugokite pakeitimus.', 'error');
    const btn = bar.querySelector('.btn-primary'); if (btn) btn.disabled = true;
    const r = await guard(() => post(`/api/proposals/${p.id}/approve`, {contentHash: p.content_hash}));
    if (r) { toast(r.alreadyApproved ? 'Jau buvo patvirtinta.' : `Patvirtinta ir užregistruota${r.number ? ` (${r.number})` : ''}.`, 'ok'); location.hash = '#/deze'; } else drawBar();
  }
  async function reject() {
    const reason = await promptDialog('Atmesti dokumentą', 'Priežastis', {minLength: 3, multiline: true});
    if (reason === null) return;
    if (await guard(() => post(`/api/proposals/${p.id}/reject`, {contentHash: p.content_hash, reason}), 'Atmesta.')) location.hash = '#/deze';
  }
  async function toVault() {
    if (!await confirmDialog('Perkelti į saugyklą', 'Dokumentas nebus registruojamas apskaitoje ir bus saugomas „Dokumentai“ skiltyje.')) return;
    if (await guard(() => post(`/api/documents/${doc.id}/move-to-vault`, {kind: model.docType}), 'Perkelta.')) location.hash = `#/dokumentai/${doc.id}`;
  }

  clear(main, pageHeader(doc.title || `Dokumentas #${doc.id}`, badge(STATUS, doc.processing_status), h('a', {class: 'btn btn-small', href: '#/deze'}, '‹ Atgal į dėžutę')),
    h('div', {class: 'review'}, viewer, h('div', null, form)), bar);
  main.onkeydown = (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); approve(); } };
  drawViewer();
  drawForm(p.validation);
  drawBar();
}
