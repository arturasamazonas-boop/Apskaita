// Parse company details from text copied from a company page (rekvizitai.lt, Registrų centras, an invoice…).
// Pure function, no DOM: used by the browser (bookmarklet landing page, paste dialogs) and by tests.

const FORMS = ['UAB', 'AB', 'MB', 'VšĮ', 'IĮ', 'ŽŪB', 'KB', 'TŪB', 'KŪB', 'ŽŪK', 'VĮ', 'BĮ', 'SB', 'TB', 'Asociacija'];
const FORM_NAMES = {UAB: 'Uždaroji akcinė bendrovė', AB: 'Akcinė bendrovė', MB: 'Mažoji bendrija', 'VšĮ': 'Viešoji įstaiga', 'IĮ': 'Individuali įmonė', 'ŽŪB': 'Žemės ūkio bendrovė',
  KB: 'Kooperatinė bendrovė', 'TŪB': 'Tikroji ūkinė bendrija', 'KŪB': 'Komanditinė ūkinė bendrija', 'VĮ': 'Valstybės įmonė', 'BĮ': 'Biudžetinė įstaiga'};
const FORM_FROM_NAME = Object.fromEntries(Object.entries(FORM_NAMES).map(([k, v]) => [v.toLowerCase(), k]));

// Label → field, most specific first. A label matches at the start of a line, case-insensitively.
const LABELS = [
  ['vat_code', ['pvm mokėtojo kodas', 'pvm kodas', 'pvm mok. kodas', 'vat code', 'vat number']],
  ['company_code', ['juridinio asmens kodas', 'įmonės kodas', 'imones kodas', 'įm. kodas', 'company code', 'kodas']],
  ['name', ['įmonės pavadinimas', 'pavadinimas', 'company name']],
  ['legal_form', ['teisinė forma', 'teisine forma']],
  ['address', ['buveinės adresas', 'registracijos adresas', 'adresas', 'address']],
  ['phone', ['mobilus telefonas', 'telefonas', 'tel. nr.', 'tel.', 'phone']],
  ['email', ['elektroninis paštas', 'el. paštas', 'el.paštas', 'e. paštas', 'e-mail', 'email']],
  ['website', ['tinklalapis', 'interneto svetainė', 'svetainė', 'website']],
  ['manager', ['generalinis direktorius', 'direktorius', 'vadovas', 'manager']],
  ['iban', ['atsiskaitomoji sąskaita', 'banko sąskaita', 'a. s.', 'a.s.', 'sąskaitos nr.', 'iban']],
  ['bank_name', ['bankas']],
];
const ALL_LABELS = LABELS.flatMap(([, ls]) => ls);

const clean = (v) => String(v || '').replace(/[ \t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const isLabelLine = (line) => { const l = line.toLowerCase(); return ALL_LABELS.some((x) => l === x || l.startsWith(x + ':') || l.startsWith(x + ' ')); };

function valueAfter(lines, i, label) {
  const rest = clean(lines[i].slice(label.length).replace(/^[\s:–-]+/, ''));
  if (rest) return rest;
  const next = lines[i + 1];
  return next && !isLabelLine(next) ? clean(next) : '';
}

export function normalizeName(name) {
  const n = clean(name).replace(/["“”„]/g, '"');
  // "Energitech, UAB" → UAB „Energitech“
  const m = /^(.+?),\s*([A-ZŽŪĮŠČĘĖ][A-Za-zŽŪĮŠČĘĖžūįščęė]{0,9})$/.exec(n);
  if (m && FORMS.includes(m[2])) return `${m[2]} „${m[1].replace(/^"|"$/g, '')}“`;
  const m2 = /^(UAB|AB|MB|VšĮ|IĮ|ŽŪB|KB|TŪB|KŪB|VĮ|BĮ)\s+"?([^"]+?)"?$/.exec(n);
  if (m2) return `${m2[1]} „${m2[2]}“`;
  return n;
}

export function formOf(name, legalForm = '') {
  const lf = clean(legalForm).toLowerCase();
  if (FORM_FROM_NAME[lf]) return FORM_FROM_NAME[lf];
  const n = clean(name);
  for (const f of FORMS) if (n.startsWith(`${f} `) || n.endsWith(`, ${f}`) || n.endsWith(` ${f}`)) return f;
  return clean(legalForm);
}

const ibanRe = /\bLT\d{2}(?:\s?\d{4}){4}\b/;
const vatRe = /\bLT\s?(\d{9}|\d{12})\b/;
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const phoneRe = /(?:\+370|8)[\s-]?\(?\d{1,3}\)?(?:[\s-]?\d){5,8}/;

/** @returns {{name, company_code, vat_code, legal_form, address, phone, email, website, manager, iban, bank_name, source}} */
export function parseCompanyText(text, {title = '', url = ''} = {}) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const out = {name: '', company_code: '', vat_code: '', legal_form: '', address: '', phone: '', email: '', website: '', manager: '', iban: '', bank_name: '', source: url || ''};
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    for (const [key, labels] of LABELS) {
      if (out[key]) continue;
      const label = labels.find((x) => low === x || low.startsWith(x + ':') || low.startsWith(x + ' ') || low.startsWith(x + ' '));
      if (!label) continue;
      const v = valueAfter(lines, i, label);
      if (v) out[key] = v;
      break;
    }
  }
  const all = lines.join('\n');
  // Validate and normalise by format; fall back to patterns anywhere in the text.
  const code = /\b(\d{9})\b/.exec(out.company_code)?.[1] || (/(?:įmonės|juridinio asmens)\s+kodas[:\s]+(\d{9})\b/i.exec(all)?.[1]) || '';
  out.company_code = code;
  const vat = vatRe.exec(out.vat_code.toUpperCase()) || (/pvm/i.test(all) ? vatRe.exec(all) : null);
  out.vat_code = vat ? `LT${vat[1]}` : (/^ne\b|nėra|nera/i.test(out.vat_code) ? '' : '');
  const iban = ibanRe.exec(out.iban.toUpperCase()) || ibanRe.exec(all);
  out.iban = iban ? iban[0].replace(/\s/g, '') : '';
  out.email = (emailRe.exec(out.email) || emailRe.exec(all) || [''])[0];
  out.phone = clean((phoneRe.exec(out.phone) || phoneRe.exec(all) || [''])[0]);
  out.website = /^(https?:\/\/|www\.)\S+$/i.test(out.website) ? out.website : (/(?:^|\s)((?:https?:\/\/|www\.)[^\s]+\.[a-z]{2,}[^\s]*)/i.exec(out.website)?.[1] || '');
  if (out.manager.length > 80) out.manager = '';
  if (out.address.length > 200) out.address = out.address.slice(0, 200);
  // Name: label, then the page heading/title (rekvizitai.lt titles look like "Energitech, UAB – …").
  if (!out.name || out.name.length > 150) out.name = '';
  if (!out.name && title) out.name = clean(String(title).split(/\s[|–—-]\s/)[0]);
  if (!out.name) out.name = lines.find((l) => FORMS.some((f) => l.startsWith(`${f} `) || l.endsWith(`, ${f}`)) && l.length < 120) || '';
  out.legal_form = formOf(out.name, out.legal_form);
  out.name = normalizeName(out.name);
  return out;
}

/** The bookmarklet: run on a company page, it opens this application with the page text (never sent anywhere else). */
export function bookmarklet(appOrigin) {
  const code = `(()=>{const h=document.querySelector('h1');const d={u:location.href,t:(h&&h.innerText)||document.title,x:document.body.innerText.slice(0,40000)};`
    + `const url=${JSON.stringify(appOrigin + '/#/rekvizitai?d=')}+encodeURIComponent(JSON.stringify(d));const w=window.open(url,'_blank');if(!w)location.href=url;})()`;
  return `javascript:${code}`;
}
