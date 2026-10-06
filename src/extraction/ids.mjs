// Identifier validation used to detect OCR/typing errors (warnings, never auto-corrections).

/** Lithuanian VAT code check digit (LT + 9 or 12 digits). Algorithm as in python-stdnum lt.pvm. */
export function ltVatValid(code) {
  const m = /^LT(\d{9}|\d{12})$/.exec(String(code || '').replace(/\s/g, '').toUpperCase());
  if (!m) return false;
  const n = m[1];
  if (n.length === 9 && n[7] !== '1') return false;
  if (n.length === 12 && n[10] !== '1') return false;
  return ltVatCheckDigit(n.slice(0, -1)) === n.at(-1);
}

export function ltVatCheckDigit(body) {
  let c = [...body].reduce((s, d, i) => s + (1 + (i % 9)) * Number(d), 0) % 11;
  if (c === 10) c = [...body].reduce((s, d, i) => s + (1 + ((i + 2) % 9)) * Number(d), 0) % 11;
  return String(c % 10);
}

/** IBAN mod-97 check. */
export function ibanValid(iban) {
  const s = String(iban || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  if (s.startsWith('LT') && s.length !== 20) return false;
  const re = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let r = 0;
  for (const ch of re) r = (r * 10 + Number(ch)) % 97;
  return r === 1;
}

export function ibanCheckDigits(countryAndBban) {
  // countryAndBban: e.g. 'LT' + bban; returns full IBAN with valid check digits.
  const cc = countryAndBban.slice(0, 2), bban = countryAndBban.slice(2);
  const re = (bban + cc + '00').replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let r = 0;
  for (const ch of re) r = (r * 10 + Number(ch)) % 97;
  return cc + String(98 - r).padStart(2, '0') + bban;
}

export function normalizeVat(v) { return String(v || '').replace(/[\s.\-]/g, '').toUpperCase(); }
export function normalizeIban(v) { return String(v || '').replace(/\s/g, '').toUpperCase(); }

/** Normalize a document number for duplicate detection: alphanumerics only, leading zeros stripped from numeric runs. */
export function numberKey(series, number) {
  const s = `${series || ''}${number || ''}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.replace(/(^|[A-Z])0+(\d)/g, '$1$2');
}

export function normalizeName(name) {
  return fold(String(name || '')).replace(/["'„“”«»]/g, '').replace(/\b(uab|ab|mb|vsi|iį|ii|ltd|sia|ou|gmbh|oy)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const FOLD = {ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z', Ą: 'a', Č: 'c', Ę: 'e', Ė: 'e', Į: 'i', Š: 's', Ų: 'u', Ū: 'u', Ž: 'z'};
/** Lowercase + strip Lithuanian diacritics, 1:1 per character (indices preserved). */
export function fold(s) { return String(s).replace(/[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/g, (c) => FOLD[c]).toLowerCase(); }
