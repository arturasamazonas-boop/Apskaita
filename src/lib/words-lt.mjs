// Amount in words in Lithuanian for invoices ("Suma žodžiais"): "penki šimtai trisdešimt vienas euras 19 ct".
const ONES = ['', 'vienas', 'du', 'trys', 'keturi', 'penki', 'šeši', 'septyni', 'aštuoni', 'devyni'];
const TEENS = ['dešimt', 'vienuolika', 'dvylika', 'trylika', 'keturiolika', 'penkiolika', 'šešiolika', 'septyniolika', 'aštuoniolika', 'devyniolika'];
const TENS = ['', '', 'dvidešimt', 'trisdešimt', 'keturiasdešimt', 'penkiasdešimt', 'šešiasdešimt', 'septyniasdešimt', 'aštuoniasdešimt', 'devyniasdešimt'];

/** Noun form for a count: 1, 21, 31… → singular; 2–9, 22–29… → plural; 0, 10–20, 30… → genitive plural. */
export function ltForm(n, [one, few, many]) {
  const last2 = n % 100, last = n % 10;
  if (last2 >= 10 && last2 <= 20) return many;
  if (last === 1) return one;
  if (last === 0) return many;
  return few;
}

function below1000(n) {
  const out = [];
  const h = Math.floor(n / 100), rest = n % 100;
  if (h) out.push(h === 1 ? 'šimtas' : `${ONES[h]} šimtai`);
  if (rest >= 10 && rest < 20) out.push(TEENS[rest - 10]);
  else { if (Math.floor(rest / 10)) out.push(TENS[Math.floor(rest / 10)]); if (rest % 10) out.push(ONES[rest % 10]); }
  return out.join(' ');
}

/** Whole number in words (0 – 999 999 999 999). */
export function numberWords(n) {
  n = Math.trunc(Math.abs(Number(n)));
  if (n === 0) return 'nulis';
  const parts = [];
  for (const [size, forms] of [[1e9, ['milijardas', 'milijardai', 'milijardų']], [1e6, ['milijonas', 'milijonai', 'milijonų']], [1e3, ['tūkstantis', 'tūkstančiai', 'tūkstančių']]]) {
    const k = Math.floor(n / size);
    if (k) { parts.push(`${k === 1 ? '' : below1000(k) + ' '}${ltForm(k, forms)}`.trim()); n %= size; }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/** "1234.50" EUR → "vienas tūkstantis du šimtai trisdešimt keturi eurai 50 ct". */
export function amountWords(amount, currency = 'EUR') {
  const s = String(amount ?? '0').trim().replace(/\s/g, '').replace(',', '.');
  const neg = s.startsWith('-');
  const [w, f = '0'] = s.replace('-', '').split('.');
  const whole = Number(w || 0), cents = Number((f + '00').slice(0, 2));
  const unit = currency === 'EUR' ? ltForm(whole, ['euras', 'eurai', 'eurų']) : currency;
  const text = `${neg ? 'minus ' : ''}${numberWords(whole)} ${unit} ${String(cents).padStart(2, '0')} ${currency === 'EUR' ? 'ct' : 'cnt.'}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
