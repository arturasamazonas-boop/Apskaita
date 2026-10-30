// Drop area for supplier invoices outside the inbox (Pirkimai): the file goes to the inbox, is read automatically,
// and a single file opens straight in the review screen (which refreshes until reading is finished).
import {h, clear, upload, toast, showError, can} from '../core.mjs';

export function invoiceDrop(state, {title = 'Įkelkite pirkimo sąskaitą – tiekėjas, prekės ir sumos bus nuskaityti automatiškai'} = {}) {
  if (!can(state.user, 'write')) return null;
  const status = h('div', {class: 'upload-progress', 'aria-live': 'polite'});
  const fileInput = h('input', {type: 'file', multiple: true, accept: '.pdf,.docx,.jpg,.jpeg,.png', class: 'visually-hidden', onchange: () => send([...fileInput.files])});
  const drop = h('div', {class: 'dropzone dropzone-compact', tabindex: '0', role: 'button',
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } }, onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); send([...e.dataTransfer.files]); }},
  h('strong', null, title), h('span', {class: 'hint'}, 'PDF, DOCX, nuotrauka (JPG, PNG) – galima nutempti kelis failus.'), fileInput);
  async function send(files) {
    if (!files.length) return;
    const fd = new FormData();
    fd.append('workflow', 'invoice');
    files.forEach((f) => fd.append('files', f, f.name));
    clear(status, `Įkeliama ${files.length} failų…`);
    try {
      const r = await upload('/api/uploads', fd);
      const ok = r.results.filter((x) => x.status === 'uploaded' || x.status === 'duplicate');
      if (files.length === 1 && ok[0]) { toast(ok[0].status === 'duplicate' ? ok[0].message : 'Įkelta – nuskaitoma…', 'info'); location.hash = `#/deze/${ok[0].documentId}`; return; }
      clear(status, h('ul', {class: 'upload-results'}, r.results.map((x) => h('li', {class: `res-${x.status}`}, `${x.name}: `,
        x.documentId ? h('a', {href: `#/deze/${x.documentId}`}, x.status === 'uploaded' ? 'įkelta, nuskaitoma – atidaryti' : x.message) : x.message))));
    } catch (e) { showError(e); clear(status); }
  }
  return h('div', {class: 'invoice-drop'}, drop, status);
}
