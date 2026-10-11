// Pinigų srautų ataskaita (5-asis VAS „Pinigų srautų ataskaita“, VAS-14): 1 priedas – tiesioginiu būdu, 2 priedas – netiesioginiu būdu.
// Both are derived from posted journal lines of the period. Opening-balance entries count as the opening balance, and year-end
// closing entries (only income/expense and 34x accounts) are ignored, so every line is a real movement. Every account is assigned
// to exactly one line, which makes the statement reconcile to the change in cash (27) by construction.
import {money} from '../lib/money.mjs';

const starts = (c, list) => list.some((p) => c.startsWith(p));
const isPL = (c) => c[0] === '5' || c[0] === '6';
const CASH = ['27'];
const FA = ['11', '12'];
const REVAL = ['1201', '1211', '1221', '1231', '1241', '32'];
const isContra = (c) => starts(c, FA) && c.length === 4 && /[789]$/.test(c);
const DEPRECIATION = ['6201', '6306', '6307'];
const IMPAIRMENT = ['6309', '67'];
const DISPOSAL = ['5400', '6400'];
const FIN_INCOME = ['5600', '5601', '5604', '5609', '5802', '5805', '5808', '5809', '5810', '55'];
const FIN_COST = ['6800', '6801', '6802', '6805', '6806', '6808', '6809', '6810', '65', '66'];

/** Movements of the period per account and per entry. */
export async function flowData(db, {from, to}) {
  const rows = (await db.query(`SELECT e.id AS entry_id, e.entry_date, e.source_type, l.account_code AS code, l.debit, l.credit
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.entry_date <= $1 ORDER BY e.id, l.id`, [to])).rows;
  const entries = new Map();
  for (const r of rows) { if (!entries.has(r.entry_id)) entries.set(r.entry_id, {date: r.entry_date, source: r.source_type, lines: []}); entries.get(r.entry_id).lines.push(r); }
  const isClosing = (e) => e.lines.every((l) => isPL(l.code) || l.code.startsWith('34') || l.code.startsWith('390')) && e.lines.some((l) => isPL(l.code)) && e.lines.some((l) => !isPL(l.code));
  const flows = new Map(), debitTurn = new Map(), creditTurn = new Map(), opening = new Map(), closing = new Map();
  const add = (m, k, v) => m.set(k, money.add(m.get(k) || '0', v));
  const periodEntries = [];
  for (const e of entries.values()) {
    const inPeriod = e.date >= from && e.date <= to;
    const asOpening = e.date < from || (inPeriod && e.source === 'opening');
    for (const l of e.lines) {
      const v = money.sub(l.debit, l.credit);
      add(closing, l.code, v);
      if (asOpening) add(opening, l.code, v);
    }
    if (!inPeriod || e.source === 'opening' || isClosing(e)) continue;
    periodEntries.push(e);
    for (const l of e.lines) { add(flows, l.code, money.sub(l.debit, l.credit)); add(debitTurn, l.code, l.debit); add(creditTurn, l.code, l.credit); }
  }
  const sumOf = (m, pred) => money.sum([...m].filter(([c]) => pred(c)).map(([, v]) => v));
  return {flows, debitTurn, creditTurn, periodEntries, cashOpening: sumOf(opening, (c) => starts(c, CASH)), cashClosing: sumOf(closing, (c) => starts(c, CASH))};
}

// Indirect method: [line id, predicate] for balance-sheet accounts; the line value is −(D−K) movement.
const INDIRECT_BS = [
  ['I.3', ['162', '165', '1670', '1672', '1674']],
  ['I.4', ['201', '202', '203', '204', '205', '209']],
  ['I.5', ['208', '29', '116', '126']],
  ['I.7', ['241']],
  ['I.8', ['242', '243']],
  ['I.9', ['2441', '2442', '2443', '2444', '2445', '2446', '2447', '2449', '263']],
  ['I.10', ['206', '207']],
  ['I.11', ['423', '424']],
  ['I.12', ['442', '443']],
  ['I.13', ['447']],
  ['I.14', ['448']],
  ['I.15', ['41']],
  ['I.16', ['425', '426', '427', '428', '444', '445', '446', '4492', '4493', '4494', '4496', '4497', '449', '49']],
  ['I.19', ['171', ...REVAL]],
  ['II.inv', ['160', '163', '166', '168', '261', '262', '172', '173']],
  ['II.loan', ['161', '164', '1671', '2440']],
  ['III.1.1', ['301', '302', '304', '309']],
  ['III.1.2', ['305', '308']],
  ['III.1.3', ['303']],
  ['III.1.4', ['33', '34', '390', '4490', '4491', '4495']],
  ['III.loan', ['422', '441', '4214', '4403', '4404']],
  ['III.bond', ['4210', '4400']],
  ['III.lease', ['4211', '4401']],
  ['III.other', ['40', '4213', '4402']],
];

export function computeIndirect(fd) {
  const v = new Map();
  const put = (id, x) => v.set(id, money.add(v.get(id) || '0', x));
  const f = (pred) => money.sum([...fd.flows].filter(([c]) => pred(c)).map(([, x]) => x));
  const unassigned = [];
  // Operating: net result, then non-cash and financing/investing items moved out of it.
  put('I.1', money.neg(f(isPL)));
  const dep = f((c) => starts(c, DEPRECIATION)), imp = f((c) => starts(c, IMPAIRMENT)), disp = f((c) => starts(c, DISPOSAL));
  const finInc = f((c) => starts(c, FIN_INCOME)), finCost = f((c) => starts(c, FIN_COST));
  put('I.2', dep);
  put('I.17', disp);
  put('I.18', money.add(finInc, finCost));
  put('I.19', imp);
  put('II.7', money.neg(finInc));
  put('III.2.2.3', money.neg(finCost));
  // Fixed assets: acquisitions = debit turnover of cost accounts; the rest of the movement is disposals.
  const faCost = (c) => starts(c, FA) && !isContra(c) && !starts(c, REVAL);
  const acq = money.sum([...fd.debitTurn].filter(([c]) => faCost(c)).map(([, x]) => x));
  const faAll = f((c) => starts(c, FA) && !starts(c, REVAL));
  put('II.1', money.neg(acq));
  put('II.2', money.sub(money.sub(money.sub(money.add(money.neg(faAll), acq), dep), disp), imp));
  for (const [c, x] of fd.flows) {
    if (isPL(c) || starts(c, CASH) || (starts(c, FA) && !starts(c, REVAL))) continue;
    const hit = INDIRECT_BS.find(([, pre]) => starts(c, pre));
    const val = money.neg(x);
    if (!hit) { if (!money.isZero(x)) unassigned.push({code: c, amount: money.norm(x)}); put(c[0] <= '2' ? 'I.10' : 'I.16', val); continue; }
    const [id] = hit;
    const inflow = money.cmp(val, '0') > 0;
    // Investments and borrowings are shown gross: credits are cash in, debits are cash out.
    const split = (inId, outId) => { put(inId, fd.creditTurn.get(c) || '0'); put(outId, money.neg(fd.debitTurn.get(c) || '0')); };
    if (id === 'II.inv') split('II.4', 'II.3');
    else if (id === 'II.loan') split('II.6', 'II.5');
    else if (id === 'III.loan') split('III.2.1.1', 'III.2.2.1');
    else if (id === 'III.bond') split('III.2.1.2', 'III.2.2.2');
    // A new lease liability is the non-cash counterpart of a leased asset: it offsets that acquisition.
    else if (id === 'III.lease') put(inflow ? 'II.1' : 'III.2.2.4', val);
    else if (id === 'III.other') put(inflow ? 'III.2.5' : 'III.2.6', val);
    else put(id, val);
  }
  return {v, unassigned};
}

// Direct method: each entry with cash lines is split over its other lines; the category comes from the counter-account.
function directCategory(c, val) {
  const inflow = money.cmp(val, '0') > 0;
  if (starts(c, ['241', '242', '243', '442', '50'])) return 'cust';
  if (starts(c, ['4481', '4482', '448', '6003', '6203', '6304'])) return 'I.2.2';
  if (starts(c, ['2441', '4492'])) return 'vat';
  if (starts(c, ['447', '4493', '2442', '2443', '2444', '6308', '69'])) return 'I.2.3';
  if (starts(c, ['443', '424', '423', '208', '20', '29', '60', '61', '62', '63', '64'])) return 'I.2.1';
  if (starts(c, [...FA, ...DISPOSAL])) return inflow ? 'II.2' : 'II.1';
  if (starts(c, ['160', '163', '166', '168', '261', '262', '172', '173'])) return inflow ? 'II.4' : 'II.3';
  if (starts(c, ['161', '164', '1671', '2440'])) return inflow ? 'II.6' : 'II.5';
  if (starts(c, FIN_INCOME)) return 'II.7';
  if (starts(c, ['301', '302', '304', '309'])) return 'III.1.1';
  if (starts(c, ['305', '308'])) return 'III.1.2';
  if (starts(c, ['303'])) return 'III.1.3';
  if (starts(c, ['33', '34', '390', '4490', '4491', '4495'])) return 'III.1.4';
  if (starts(c, ['4210', '4400'])) return inflow ? 'III.2.1.2' : 'III.2.2.2';
  if (starts(c, ['4211', '4401'])) return inflow ? 'III.2.1.1' : 'III.2.2.4';
  if (starts(c, ['422', '441', '4214', '4403', '4404'])) return inflow ? 'III.2.1.1' : 'III.2.2.1';
  if (starts(c, FIN_COST)) return 'III.2.2.3';
  if (starts(c, ['40', '4213', '4402'])) return inflow ? 'III.2.5' : 'III.2.6';
  return inflow ? 'I.1.2' : 'I.2.4';
}

export function computeDirect(fd) {
  const v = new Map();
  const put = (id, x) => v.set(id, money.add(v.get(id) || '0', x));
  for (const e of fd.periodEntries) {
    const cash = e.lines.filter((l) => starts(l.code, CASH));
    const other = e.lines.filter((l) => !starts(l.code, CASH));
    if (!cash.length || !other.length) continue; // no cash, or a transfer between own cash accounts
    const parts = other.map((l) => ({code: l.code, val: money.sub(l.credit, l.debit)})).map((p) => ({...p, cat: directCategory(p.code, p.val)}));
    // VAT follows the customer or supplier in the same entry (receipts and payments are shown with VAT).
    const main = parts.find((p) => p.cat === 'cust') ? 'cust' : parts.find((p) => p.cat === 'I.2.1') ? 'I.2.1' : 'I.2.3';
    for (const p of parts) {
      let cat = p.cat === 'vat' ? main : p.cat;
      if (cat === 'cust') cat = 'I.1.1';
      put(cat, p.val);
    }
  }
  return {v, unassigned: []};
}

const L = (id, no, label, spec) => [id, no, label, spec];
const INVESTING_FINANCING = [
  L('IIh', 'II.', 'Investicinės veiklos pinigų srautai', {h: true}),
  L('II.1', 'II.1.', 'Ilgalaikio turto (išskyrus investicijas) įsigijimas', {}),
  L('II.2', 'II.2.', 'Ilgalaikio turto (išskyrus investicijas) perleidimas', {}),
  L('II.3', 'II.3.', 'Ilgalaikių investicijų įsigijimas', {}),
  L('II.4', 'II.4.', 'Ilgalaikių investicijų perleidimas', {}),
  L('II.5', 'II.5.', 'Paskolų suteikimas', {}),
  L('II.6', 'II.6.', 'Paskolų susigrąžinimas', {}),
  L('II.7', 'II.7.', 'Gauti dividendai, palūkanos', {}),
  L('II.8', 'II.8.', 'Kiti investicinės veiklos pinigų srautų padidėjimai', {}),
  L('II.9', 'II.9.', 'Kiti investicinės veiklos pinigų srautų sumažėjimai', {}),
  L('II', '', 'Grynieji investicinės veiklos pinigų srautai', {sum: ['II.1', 'II.2', 'II.3', 'II.4', 'II.5', 'II.6', 'II.7', 'II.8', 'II.9'], total: true}),
  L('IIIh', 'III.', 'Finansinės veiklos pinigų srautai', {h: true}),
  L('III.1', 'III.1.', 'Pinigų srautai, susiję su įmonės savininkais', {sum: ['III.1.1', 'III.1.2', 'III.1.3', 'III.1.4']}),
  L('III.1.1', 'III.1.1.', 'Akcijų išleidimas', {}),
  L('III.1.2', 'III.1.2.', 'Savininkų įnašai nuostoliams padengti', {}),
  L('III.1.3', 'III.1.3.', 'Savų akcijų supirkimas', {}),
  L('III.1.4', 'III.1.4.', 'Dividendų išmokėjimas', {}),
  L('III.2', 'III.2.', 'Pinigų srautai, susiję su kitais finansavimo šaltiniais', {sum: ['III.2.1', 'III.2.2', 'III.2.3', 'III.2.4', 'III.2.5', 'III.2.6']}),
  L('III.2.1', 'III.2.1.', 'Finansinių skolų padidėjimas', {sum: ['III.2.1.1', 'III.2.1.2']}),
  L('III.2.1.1', 'III.2.1.1.', 'Paskolų gavimas', {}),
  L('III.2.1.2', 'III.2.1.2.', 'Obligacijų išleidimas', {}),
  L('III.2.2', 'III.2.2.', 'Finansinių skolų sumažėjimas', {sum: ['III.2.2.1', 'III.2.2.2', 'III.2.2.3', 'III.2.2.4']}),
  L('III.2.2.1', 'III.2.2.1.', 'Paskolų grąžinimas', {}),
  L('III.2.2.2', 'III.2.2.2.', 'Obligacijų supirkimas', {}),
  L('III.2.2.3', 'III.2.2.3.', 'Sumokėtos palūkanos', {}),
  L('III.2.2.4', 'III.2.2.4.', 'Lizingo (finansinės nuomos) mokėjimai', {}),
  L('III.2.3', 'III.2.3.', 'Kitų įmonės įsipareigojimų padidėjimas', {}),
  L('III.2.4', 'III.2.4.', 'Kitų įmonės įsipareigojimų sumažėjimas', {}),
  L('III.2.5', 'III.2.5.', 'Kiti finansinės veiklos pinigų srautų padidėjimai', {}),
  L('III.2.6', 'III.2.6.', 'Kiti finansinės veiklos pinigų srautų sumažėjimai', {}),
  L('III', '', 'Grynieji finansinės veiklos pinigų srautai', {sum: ['III.1', 'III.2'], total: true}),
  L('IV', 'IV.', 'Valiutų kursų pasikeitimo įtaka grynųjų pinigų ir pinigų ekvivalentų likučiui', {}),
  L('V', 'V.', 'Grynasis pinigų srautų padidėjimas (sumažėjimas)', {sum: ['I', 'II', 'III', 'IV'], total: true}),
  L('VI', 'VI.', 'Pinigai ir pinigų ekvivalentai laikotarpio pradžioje', {}),
  L('VII', 'VII.', 'Pinigai ir pinigų ekvivalentai laikotarpio pabaigoje', {sum: ['V', 'VI'], grand: true}),
];

export const CF_INDIRECT = [
  L('Ih', 'I.', 'Pagrindinės veiklos pinigų srautai', {h: true}),
  ...[['I.1', 'Grynasis pelnas (nuostoliai)'], ['I.2', 'Nusidėvėjimo ir amortizacijos sąnaudos'], ['I.3', 'Po vienerių metų gautinų sumų (padidėjimas) sumažėjimas'],
    ['I.4', 'Atsargų (padidėjimas) sumažėjimas'], ['I.5', 'Išankstinių apmokėjimų (padidėjimas) sumažėjimas'], ['I.6', 'Nebaigtų vykdyti sutarčių (padidėjimas) sumažėjimas'],
    ['I.7', 'Pirkėjų įsiskolinimo (padidėjimas) sumažėjimas'], ['I.8', 'Dukterinių ir asocijuotų įmonių skolų (padidėjimas) sumažėjimas'], ['I.9', 'Kitų gautinų sumų (padidėjimas) sumažėjimas'],
    ['I.10', 'Kito trumpalaikio turto (padidėjimas) sumažėjimas'], ['I.11', 'Ilgalaikių skolų tiekėjams ir gautų išankstinių apmokėjimų padidėjimas (sumažėjimas)'],
    ['I.12', 'Trumpalaikių skolų tiekėjams ir gautų išankstinių apmokėjimų padidėjimas (sumažėjimas)'], ['I.13', 'Pelno mokesčio įsipareigojimų padidėjimas (sumažėjimas)'],
    ['I.14', 'Su darbo santykiais susijusių įsipareigojimų padidėjimas (sumažėjimas)'], ['I.15', 'Atidėjinių padidėjimas (sumažėjimas)'], ['I.16', 'Kitų mokėtinų sumų ir įsipareigojimų padidėjimas (sumažėjimas)'],
    ['I.17', 'Ilgalaikio materialiojo ir nematerialiojo turto perleidimo rezultatų eliminavimas'], ['I.18', 'Finansinės ir investicinės veiklos rezultatų eliminavimas'], ['I.19', 'Kitų nepiniginių straipsnių eliminavimas']]
    .map(([id, label]) => L(id, `${id}.`, label, {})),
  L('I', '', 'Grynieji pagrindinės veiklos pinigų srautai', {sum: Array.from({length: 19}, (_, i) => `I.${i + 1}`), total: true}),
  ...INVESTING_FINANCING,
];

export const CF_DIRECT = [
  L('Ih', 'I.', 'Pagrindinės veiklos pinigų srautai', {h: true}),
  L('I.1', 'I.1.', 'Ataskaitinio laikotarpio pinigų įplaukos (su PVM)', {sum: ['I.1.1', 'I.1.2']}),
  L('I.1.1', 'I.1.1.', 'Pinigų įplaukos iš klientų', {}),
  L('I.1.2', 'I.1.2.', 'Kitos įplaukos', {}),
  L('I.2', 'I.2.', 'Ataskaitinio laikotarpio pinigų išmokos', {sum: ['I.2.1', 'I.2.2', 'I.2.3', 'I.2.4']}),
  L('I.2.1', 'I.2.1.', 'Pinigai, sumokėti žaliavų, prekių ir paslaugų tiekėjams (su PVM)', {}),
  L('I.2.2', 'I.2.2.', 'Pinigų išmokos, susijusios su darbo santykiais', {}),
  L('I.2.3', 'I.2.3.', 'Sumokėti į biudžetą mokesčiai', {}),
  L('I.2.4', 'I.2.4.', 'Kitos išmokos', {}),
  L('I', '', 'Grynieji pagrindinės veiklos pinigų srautai', {sum: ['I.1', 'I.2'], total: true}),
  ...INVESTING_FINANCING,
];

/** Leaf values for one period plus the reconciliation check. */
export async function cashFlowColumn(db, method, period) {
  const fd = await flowData(db, period);
  const {v, unassigned} = method === 'direct' ? computeDirect(fd) : computeIndirect(fd);
  v.set('VI', fd.cashOpening);
  const checks = [];
  const lines = method === 'direct' ? CF_DIRECT : CF_INDIRECT;
  const leafIds = lines.filter(([, , , s]) => !s.h && !s.sum).map(([id]) => id);
  const flowSum = money.sum(leafIds.filter((id) => id !== 'VI').map((id) => v.get(id) || '0'));
  const expected = money.sub(fd.cashClosing, fd.cashOpening);
  if (!money.eq(flowSum, expected)) checks.push({level: 'error', message: `Pinigų srautų suma ${flowSum} nesutampa su pinigų likučio pokyčiu ${expected} (${period.from}–${period.to}).`});
  if (unassigned.length) checks.push({level: 'warning', message: `Sąskaitos, priskirtos bendroms eilutėms (I.10 / I.16): ${unassigned.map((u) => `${u.code} (${u.amount})`).join(', ')}. Patikrinkite klasifikaciją.`});
  return {v, checks, cashClosing: fd.cashClosing};
}
