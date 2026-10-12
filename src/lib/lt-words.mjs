// Amounts in Lithuanian words for cash documents: "1234.56" → "Vienas tūkstantis du šimtai trisdešimt keturi Eur 56 ct".
const ONES = ['', 'vienas', 'du', 'trys', 'keturi', 'penki', 'šeši', 'septyni', 'aštuoni', 'devyni'];
const TEENS = ['dešimt', 'vienuolika', 'dvylika', 'trylika', 'keturiolika', 'penkiolika', 'šešiolika', 'septyniolika', 'aštuoniolika', 'devyniolika'];
const TENS = ['', '', 'dvidešimt', 'trisdešimt', 'keturiasdešimt', 'penkiasdešimt', 'šešiasdešimt', 'septyniasdešimt', 'aštuoniasdešimt', 'devyniasdešimt'];

function below1000(n) {
  const w = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) w.push(h === 1 ? 'šimtas' : `${ONES[h]} šimtai`);
  if (r >= 10 && r < 20) w.push(TEENS[r - 10]);
  else { if (r >= 20) w.push(TENS[Math.floor(r / 10)]); if (r % 10) w.push(ONES[r % 10]); }
  return w.join(' ');
}
/** Noun form by number: 1, 21, 31 … → singular; 2–9 endings → plural; 0, 10–20 endings → genitive plural. */
function form(n, [one, few, many]) {
  const r100 = n % 100, r10 = n % 10;
  if (r10 === 0 || (r100 >= 10 && r100 < 20)) return many;
  return r10 === 1 ? one : few;
}

export function intWords(n) {
  if (n === 0) return 'nulis';
  const parts = [];
  const groups = [[1e9, ['milijardas', 'milijardai', 'milijardų']], [1e6, ['milijonas', 'milijonai', 'milijonų']], [1e3, ['tūkstantis', 'tūkstančiai', 'tūkstančių']]];
  let rest = n;
  for (const [size, names] of groups) {
    const g = Math.floor(rest / size);
    if (g) { parts.push(`${below1000(g)} ${form(g, names)}`); rest %= size; }
  }
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

export function amountInWords(amount) {
  const [i, f = '0'] = String(amount).replace('-', '').split('.');
  const words = intWords(Number(i));
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} Eur ${(f + '00').slice(0, 2)} ct`;
}
