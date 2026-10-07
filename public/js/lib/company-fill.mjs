// "Užpildyti iš rekvizitai.lt": fill company fields from a company page the user opened in their own browser
// (paste the page text, or use the bookmarklet), plus an EU VIES check of the VAT number.
import {h, get, modal, toast, guard} from '../core.mjs';
import {parseCompanyText} from './company-parse.mjs';

export const REKVIZITAI_URL = 'https://rekvizitai.vz.lt/';
const FIELDS = ['name', 'company_code', 'vat_code', 'legal_form', 'address', 'phone', 'email', 'website', 'manager', 'iban', 'bank_name'];

/** Put parsed values into form controls (only non-empty values; existing input is replaced). Returns the list of filled labels. */
export function applyCompany(controls, data) {
  const filled = [];
  for (const k of FIELDS) {
    const el = controls[k];
    if (!el || !data[k]) continue;
    el.value = data[k];
    el.dispatchEvent(new Event('input', {bubbles: true}));
    filled.push(k);
  }
  if (controls.vat_registered && data.vat_code) controls.vat_registered.checked = true;
  if (controls.country && data.company_code && !controls.country.value) controls.country.value = 'LT';
  return filled;
}

/** Button that opens the paste dialog and fills `controls`. */
export function rekvizitaiButton(controls, {onFilled} = {}) {
  return h('button', {type: 'button', class: 'btn', onclick: () => pasteDialog((data) => {
    const filled = applyCompany(controls, data);
    toast(filled.length ? `Užpildyta laukų: ${filled.length}. Patikrinkite prieš išsaugodami.` : 'Duomenų nerasta.', filled.length ? 'ok' : 'error');
    onFilled?.(data);
  })}, '⇩ Užpildyti iš rekvizitai.lt');
}

export function pasteDialog(onData) {
  const ta = h('textarea', {rows: 10, placeholder: 'Įklijuokite čia visą įmonės puslapio tekstą…', 'aria-label': 'Įmonės puslapio tekstas'});
  const m = modal('Įmonės duomenys iš rekvizitai.lt', h('form', {onsubmit: (e) => {
    e.preventDefault();
    const data = parseCompanyText(ta.value);
    if (!data.company_code && !data.vat_code && !data.name) { toast('Neatpažinau įmonės duomenų. Nukopijuokite visą įmonės puslapį (Ctrl+A, Ctrl+C).', 'error'); return; }
    m.close(); onData(data);
  }},
  h('ol', {class: 'howto'},
    h('li', null, 'Atsidarykite ', h('a', {href: REKVIZITAI_URL, target: '_blank', rel: 'noopener noreferrer'}, 'rekvizitai.lt'), ' ir susiraskite įmonę.'),
    h('li', null, 'Įmonės puslapyje paspauskite Ctrl+A, tada Ctrl+C (telefone – „Pažymėti viską“ ir „Kopijuoti“).'),
    h('li', null, 'Įklijuokite žemiau (Ctrl+V) ir spauskite „Užpildyti“.')),
  ta,
  h('p', {class: 'hint'}, 'Greičiau: įsidiekite mygtuką „→ Apskaita“ (Žinynai → Įmonė iš rekvizitai.lt) – tada užteks vieno paspaudimo rekvizitai.lt puslapyje. Tekstas apdorojamas jūsų naršyklėje.'),
  h('div', {class: 'actions'}, h('button', {class: 'btn btn-primary'}, 'Užpildyti'))));
  ta.focus();
}

/** VIES check button for a VAT input; shows the result next to it. */
export function vatCheckButton(vatInput) {
  const out = h('span', {class: 'vat-result', 'aria-live': 'polite'});
  const btn = h('button', {type: 'button', class: 'btn btn-small', onclick: () => guard(async () => {
    out.textContent = 'Tikrinama…'; out.className = 'vat-result';
    try {
      const r = await get(`/api/vat-check?code=${encodeURIComponent(vatInput.value)}`);
      out.textContent = r.valid ? `✓ Galioja (VIES)${r.name ? `: ${r.name}` : ''}` : '✗ VIES: PVM kodas negalioja';
      out.className = `vat-result ${r.valid ? 'pos' : 'neg'}`;
    } catch (e) { out.textContent = e.message; out.className = 'vat-result neg'; }
  })}, 'Tikrinti VIES');
  return h('span', {class: 'vat-check'}, btn, out);
}
