// Palūkanų priskaičiavimo ataskaita (Excel), laid out as accountants keep it: company, title with the years, the
// annual rate, the loan and its contract, then one row per money movement and per interest period – balance, days,
// the amount interest is charged on, rate, interest and the same interest again in the column of its year – and the
// totals. Interest periods are split at 31 December, so every year's interest can be read off its own column.
// Balances, interest and totals are Excel formulas (with their values filled in), so the sheet can be checked and
// extended by hand like the accountant's own.
import {calcInterest, BASES} from './interest.mjs';

const DAY = 86400000;
const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
const iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
const asDate = (s) => new Date(`${s}T00:00:00Z`);
const TEXT = {
  received: {disbursement: 'Gavimas', repayment: 'Grąžinimas'},
  granted: {disbursement: 'Išmokėjimas', repayment: 'Grąžinimas'},
};

/** Rows of the report for a loan between `from` and `to` (both inclusive). */
export function interestReportRows(loan, {from, to}) {
  const events = loan.events.map((e) => ({date: String(e.event_date).slice(0, 10), kind: e.kind, amount: e.amount, rate: e.rate, note: e.note || ''}));
  const calc = calcInterest({events, rate: loan.annual_rate, basis: loan.basis, asOf: to, includeLastDay: loan.include_last_day, includeEndDay: true});
  // Interest pieces (already split at 1 January for actual/actual; split here for the other bases too), cut to [from, to].
  const pieces = [];
  for (const p of calc.periods) {
    for (const part of p.parts) {
      let a = dayNo(part.from);
      const e = dayNo(part.to);
      while (a <= e) {
        const y = new Date(a * DAY).getUTCFullYear(), yEnd = Math.min(e, Date.UTC(y, 11, 31) / DAY);
        const s = Math.max(a, dayNo(from));
        if (yEnd >= s) pieces.push({from: iso(s), to: iso(yEnd), balance: Number(p.balance), rate: Number(p.rate)});
        a = yEnd + 1;
      }
    }
  }
  const denomOf = (pc) => (loan.basis === 'act360' || loan.basis === '30e360' ? 360 : loan.basis === 'act365' ? 365 : ((y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365))(+pc.from.slice(0, 4)));
  const daysOf = (pc) => {
    if (loan.basis !== '30e360') return dayNo(pc.to) - dayNo(pc.from) + 1;
    const x = asDate(pc.from), y = new Date((dayNo(pc.to) + 1) * DAY);
    return 360 * (y.getUTCFullYear() - x.getUTCFullYear()) + 30 * (y.getUTCMonth() - x.getUTCMonth()) + (Math.min(y.getUTCDate(), 30) - Math.min(x.getUTCDate(), 30));
  };
  // Principal before the report starts.
  let opening = 0;
  for (const e of events) if (e.date < from) opening += e.kind === 'disbursement' ? Number(e.amount) : e.kind === 'repayment' ? -Number(e.amount) : 0;
  const rows = [];
  const inRange = events.filter((e) => e.date >= from && e.date <= to);
  // Chronological: on a day, the money arriving first, then the interest period ending that day (which, with the
  // repayment day included, also covers the money repaid that day), then repayments and other events.
  const items = [
    ...inRange.map((e) => ({date: e.date, order: e.kind === 'disbursement' || e.kind === 'rate_change' ? 0 : 2, event: e})),
    ...pieces.map((pc) => ({date: pc.to, order: 1, piece: pc})),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (it.event) {
      const e = it.event;
      const text = e.kind === 'rate_change' ? `Palūkanų norma pakeista į ${String(Number(e.rate)).replace('.', ',')} %` : e.kind === 'interest_payment' ? 'Palūkanų mokėjimas' : TEXT[loan.direction][e.kind];
      // A repayment on the day an interest period ends shares its row (as in the accountant's sheet).
      if (e.kind === 'repayment' && last && last.date === e.date && last.piece && !last.event) { last.event = e; last.text = text + (e.note ? ` – ${e.note}` : ''); continue; }
      rows.push({date: e.date, text: text + (e.note ? ` – ${e.note}` : ''), event: e});
    } else {
      const pc = it.piece, endOfYear = pc.to.slice(5) === '12-31';
      rows.push({date: pc.to, text: endOfYear && pc.to !== to ? 'Metų pabaiga' : pc.to === to ? 'Palūkanos iki ataskaitos pabaigos' : 'Palūkanos', piece: {...pc, days: daysOf(pc), denom: denomOf(pc)}});
    }
  }
  const years = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) years.push(y);
  return {rows, opening, years, calc, paid: calc.paid};
}

export async function interestReportXlsx(loan, company, {from, to}) {
  const ExcelJS = (await import('exceljs')).default;
  const {rows, opening, years} = interestReportRows(loan, {from, to});
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apskaita';
  const ws = wb.addWorksheet('Palūkanos', {pageSetup: {orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9}});
  const y1 = years[0], y2 = years[years.length - 1];
  const name = loan.cp_name || loan.counterparty_name || '';
  ws.getCell('A1').value = company.name || ''; ws.getCell('A1').font = {bold: true, size: 12};
  ws.getCell('A3').value = `PALŪKANŲ PRISKAIČIAVIMO ATASKAITA UŽ ${y1 === y2 ? y1 : `${y1} - ${y2}`} METUS`; ws.getCell('A3').font = {bold: true, size: 13};
  ws.getCell('A4').value = `Laikotarpis ${from} – ${to}. Dienų skaičiavimas: ${BASES[loan.basis]}${loan.include_last_day ? ', grąžinimo diena įskaičiuojama' : ', grąžinimo diena neįskaičiuojama'}.`;
  ws.getCell('A4').font = {italic: true, size: 9, color: {argb: 'FF555555'}};
  ws.getCell('F6').value = 'Metinės palūkanos'; ws.getCell('F6').font = {bold: true};
  ws.getCell('H6').value = Number(loan.annual_rate) / 100; ws.getCell('H6').numFmt = '0.00%'; ws.getCell('H6').font = {bold: true};
  ws.getCell('A6').value = `Paskola ${loan.direction === 'granted' ? 'suteikta ' : ''}${name}`.trim(); ws.getCell('A6').font = {bold: true};
  ws.getCell('A7').value = `Sutartis Nr.: ${loan.contract_no || '—'}${loan.contract_date ? ` (${String(loan.contract_date).slice(0, 10)})` : ''}`;
  const head = ['Oper.nr.', 'Oper.data', 'Tekstas', 'Debetas', 'Kreditas', 'Likučiai', 'Dienos', 'Suma už kurias skaičiuojamos palūk.', 'Palūkanos %', 'Palūkanų suma', ...years];
  const hr = ws.getRow(8);
  head.forEach((t, i) => { const c = hr.getCell(i + 1); c.value = t; c.font = {bold: true}; c.alignment = {wrapText: true, vertical: 'middle', horizontal: 'center'}; c.border = {bottom: {style: 'thin'}}; c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEFEFEF'}}; });
  hr.height = 46;
  ws.getCell('E9').value = 'Pradiniai likučiai'; ws.getCell('F9').value = Math.round(opening * 100) / 100;
  const col = (i) => (i > 26 ? String.fromCharCode(64 + Math.floor((i - 1) / 26)) : '') + String.fromCharCode(65 + ((i - 1) % 26)); // 1 → A, 27 → AA
  const yearCol = (y) => col(11 + years.indexOf(y));
  let r = 10, n = 0, balance = opening;
  const first = r;
  for (const row of rows) {
    const x = ws.getRow(r);
    const e = row.event, pc = row.piece;
    x.getCell(1).value = ++n;
    x.getCell(2).value = asDate(row.date); x.getCell(2).numFmt = 'yyyy-mm-dd';
    x.getCell(3).value = row.text;
    const debit = e?.kind === 'disbursement' ? Number(e.amount) : null, credit = e?.kind === 'repayment' ? Number(e.amount) : null;
    if (debit !== null) x.getCell(4).value = debit;
    if (credit !== null) x.getCell(5).value = credit;
    balance += (debit || 0) - (credit || 0);
    x.getCell(6).value = {formula: `F${r - 1}+D${r}-E${r}`, result: Math.round(balance * 100) / 100};
    if (pc) {
      const interest = pc.balance * pc.rate / 100 / pc.denom * pc.days;
      x.getCell(7).value = pc.days;
      x.getCell(8).value = pc.balance;
      x.getCell(9).value = pc.rate / 100; x.getCell(9).numFmt = '0.00%';
      x.getCell(10).value = {formula: `H${r}*I${r}/${pc.denom}*G${r}`, result: interest};
      const yc = yearCol(+pc.from.slice(0, 4));
      ws.getCell(`${yc}${r}`).value = {formula: `J${r}`, result: interest};
    }
    if (e?.kind === 'interest_payment') { x.getCell(3).value = `${row.text}: ${String(Number(e.amount).toFixed(2)).replace('.', ',')}`; }
    r++;
  }
  const last = r - 1;
  // Totals.
  const tr = ws.getRow(r + 1);
  tr.getCell(3).value = 'VISO:';
  const sum = (c) => ({formula: last >= first ? `SUM(${c}${first}:${c}${last})` : '0', result: rows.reduce((a, row, i) => a + (Number(ws.getCell(`${c}${first + i}`).value?.result ?? ws.getCell(`${c}${first + i}`).value) || 0), 0)});
  for (const c of ['D', 'E', 'G', 'J', ...years.map(yearCol)]) tr.getCell(c).value = sum(c);
  tr.getCell('F').value = {formula: `F${last >= first ? last : 9}`, result: Math.round(balance * 100) / 100};
  tr.font = {bold: true};
  tr.eachCell((c) => { c.border = {top: {style: 'thin'}, bottom: {style: 'double'}}; });
  // Interest paid and still due.
  const paid = rows.filter((x) => x.event?.kind === 'interest_payment').reduce((a, x) => a + Number(x.event.amount), 0);
  ws.getCell(`C${r + 3}`).value = 'Sumokėta palūkanų'; ws.getCell(`J${r + 3}`).value = paid;
  ws.getCell(`C${r + 4}`).value = 'Liko mokėti palūkanų'; ws.getCell(`J${r + 4}`).value = {formula: `J${r + 1}-J${r + 3}`, result: Number(tr.getCell('J').value.result) - paid};
  ws.getCell(`C${r + 4}`).font = {bold: true}; ws.getCell(`J${r + 4}`).font = {bold: true};
  // Formats and widths.
  for (const c of ['D', 'E', 'F', 'H', 'J', ...years.map(yearCol)]) ws.getColumn(c).numFmt = '#,##0.00';
  ws.getCell('H6').numFmt = '0.00%';
  years.forEach((y) => { ws.getCell(`${yearCol(y)}8`).numFmt = '0'; });
  [8, 11, 34, 13, 13, 14, 8, 16, 11, 14, ...years.map(() => 12)].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{state: 'frozen', ySplit: 8}];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
