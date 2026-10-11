// Nuosavo kapitalo pokyčių ataskaita (4-asis VAS, VAS-6, 1 priedas): two years of equity movements per component.
// Movements are classified from posted journal lines; the year result comes from income and expense accounts.
import {money} from '../lib/money.mjs';

const starts = (c, list) => list.some((p) => c.startsWith(p));
const isPL = (c) => c[0] === '5' || c[0] === '6';
export const EQ_COLS = [
  ['c1', 'Apmokėtas įstatinis arba pagrindinis kapitalas', ['301', '302', '305', '308', '309']],
  ['c2', 'Akcijų priedai', ['304']],
  ['c3', 'Savos akcijos (–)', ['303']],
  ['c4', 'Perkainojimo rezervas: ilgalaikio materialiojo turto', ['321']],
  ['c5', 'Perkainojimo rezervas: finansinio turto', ['322']],
  ['c6', 'Įstatymo numatyti rezervai: privalomasis arba atsargos (rezervinis) kapitalas', ['331']],
  ['c7', 'Įstatymo numatyti rezervai: savoms akcijoms įsigyti', ['332']],
  ['c8', 'Kiti rezervai', ['333']],
  ['c9', 'Nepaskirstytasis pelnas (nuostoliai)', ['34', '390']],
];
const MOVES = [
  ['5', 'Ilgalaikio materialiojo turto vertės padidėjimas (sumažėjimas)'],
  ['6', 'Veiksmingos apsidraudimo priemonės vertės padidėjimas (sumažėjimas)'],
  ['7', 'Savų akcijų įsigijimas (pardavimas)'],
  ['8', 'Pelno (nuostolių) ataskaitoje nepripažintas pelnas (nuostoliai)'],
  ['9', 'Ataskaitinio laikotarpio grynasis pelnas (nuostoliai)'],
  ['10', 'Dividendai'],
  ['11', 'Kitos išmokos'],
  ['12', 'Sudaryti rezervai'],
  ['13', 'Panaudoti rezervai'],
  ['14', 'Įstatinio kapitalo didinimas (mažinimas) arba pajininkų įnašai (pajų grąžinimas)'],
  ['15', 'Kitas įstatinio arba pagrindinio kapitalo padidėjimas (sumažėjimas)'],
  ['16', 'Įnašai nuostoliams padengti'],
];
export const EQ_ROWS = [
  ['1', 'Likutis užpraėjusio ataskaitinio (metinio) laikotarpio pabaigoje', 'bal'],
  ['2', 'Apskaitos politikos pakeitimo rezultatas', 'zero'],
  ['3', 'Esminių klaidų taisymo rezultatas', 'zero'],
  ['4', 'Perskaičiuotas likutis užpraėjusio ataskaitinio (metinio) laikotarpio pabaigoje', 'sum4'],
  ...MOVES.map(([n, l]) => [n, l, 'p']),
  ['17', 'Likutis praėjusio ataskaitinio (metinio) laikotarpio pabaigoje', 'bal'],
  ...MOVES.map(([n, l]) => [String(Number(n) + 13), l, 'c']),
  ['30', 'Likutis ataskaitinio laikotarpio pabaigoje', 'bal'],
];

const colOf = (c) => EQ_COLS.find(([, , pre]) => starts(c, pre))?.[0];

async function yearMovements(db, from, to) {
  const rows = (await db.query(`SELECT e.id, e.source_type, l.account_code AS code, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.entry_date BETWEEN $1 AND $2 ORDER BY e.id`, [from, to])).rows;
  const entries = new Map();
  for (const r of rows) { if (!entries.has(r.id)) entries.set(r.id, {source: r.source_type, lines: []}); entries.get(r.id).lines.push(r); }
  const m = {}; // m[row][col]
  const add = (row, col, v) => { m[row] ??= {}; m[row][col] = money.add(m[row][col] || '0', v); };
  let profit = '0', opening = {};
  for (const e of entries.values()) {
    const closing = e.lines.every((l) => isPL(l.code) || colOf(l.code) === 'c9') && e.lines.some((l) => isPL(l.code)) && e.lines.some((l) => !isPL(l.code));
    if (closing) continue; // year-end transfer of the result: the result row is computed from income and expenses
    for (const l of e.lines) {
      const v = money.sub(l.credit, l.debit); // equity increases with credits
      if (isPL(l.code)) { if (e.source !== 'opening') profit = money.add(profit, v); continue; }
      const col = colOf(l.code);
      if (!col) continue;
      if (e.source === 'opening') { opening[col] = money.add(opening[col] || '0', v); continue; }
      const partners = e.lines.filter((x) => x !== l).map((x) => x.code);
      const has = (pre) => partners.some((c) => starts(c, pre));
      let row;
      if (col === 'c1' || col === 'c2') row = has(['34', '390']) ? '14' : has(['308']) || starts(l.code, ['308']) ? '16' : '14';
      else if (col === 'c3') row = '7';
      else if (col === 'c4') row = '5';
      else if (col === 'c5') row = '8';
      else if (col >= 'c6' && col <= 'c8') row = money.cmp(v, '0') >= 0 ? '12' : '13';
      else if (has(['33'])) row = money.cmp(v, '0') <= 0 ? '12' : '13';
      else if (has(['4490'])) row = '10';
      else if (has(['301', '302', '304', '305', '308', '309'])) row = has(['308', '309']) ? '16' : '14';
      else row = '11';
      add(row, col, v);
    }
  }
  add('9', 'c9', profit);
  return {m, opening};
}

async function balances(db, asOf) {
  const r = (await db.query(`SELECT l.account_code AS code, coalesce(sum(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.entry_date <= $1 GROUP BY 1`, [asOf])).rows;
  const b = {};
  for (const x of r) { const col = isPL(x.code) ? 'c9' : colOf(x.code); if (col) b[col] = money.add(b[col] || '0', x.v); }
  return b;
}

/** Matrix: rows × columns (+ c10 total) for the year ending `to` and the year before. */
export async function buildEquity(db, {to}) {
  const y = Number(to.slice(0, 4));
  const pFrom = `${y - 1}-01-01`, pTo = `${y - 1}-12-31`, cFrom = `${y}-01-01`;
  const [b1, b17, b30, mp, mc] = await Promise.all([balances(db, `${y - 2}-12-31`), balances(db, pTo), balances(db, to), yearMovements(db, pFrom, pTo), yearMovements(db, cFrom, to)]);
  const cells = {};
  const cols = EQ_COLS.map(([c]) => c);
  const set = (row, col, v) => { cells[row] ??= {}; cells[row][col] = money.norm(v || '0'); };
  for (const c of cols) {
    // Opening-balance entries dated inside a year belong to that year's opening line.
    set('1', c, money.add(b1[c] || '0', mp.opening[c] || '0'));
    set('2', c, '0'); set('3', c, '0'); set('4', c, cells['1'][c]);
    for (const [n] of MOVES) set(n, c, mp.m[n]?.[c]);
    set('17', c, money.add(b17[c] || '0', mc.opening[c] || '0'));
    for (const [n] of MOVES) set(String(Number(n) + 13), c, mc.m[n]?.[c]);
    set('30', c, b30[c]);
  }
  for (const [row] of EQ_ROWS) set(row, 'c10', money.sum(cols.map((c) => cells[row][c])));
  const checks = [];
  for (const [start, first, end] of [['4', 5, '17'], ['17', 18, '30']]) {
    for (const c of [...cols, 'c10']) {
      const calc = money.add(cells[start][c], money.sum(Array.from({length: 12}, (_, i) => cells[String(first + i)][c])));
      if (!money.eq(calc, cells[end][c])) checks.push({level: 'warning', message: `Stulpelis „${(EQ_COLS.find(([k]) => k === c) || [, 'Iš viso'])[1]}“: ${start} eil. + pokyčiai = ${calc}, o ${end} eil. likutis ${cells[end][c]} (pradinių likučių įrašai metų viduryje arba nepriskirtas pokytis).`});
    }
  }
  return {period: {from: cFrom, to}, previousPeriod: {from: pFrom, to: pTo}, cells, checks};
}
