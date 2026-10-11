// PDF of a financial statement laid out like the VAS form: header captions, approval mark, title, table, signatures.
import path from 'node:path';
import PDFDocument from 'pdfkit';
import {ROOT} from '../config.mjs';

const nf0 = new Intl.NumberFormat('lt-LT', {maximumFractionDigits: 0, minimumFractionDigits: 0, useGrouping: true});
const nf2 = new Intl.NumberFormat('lt-LT', {maximumFractionDigits: 2, minimumFractionDigits: 2, useGrouping: true});
export function fmtAmount(v, cents) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  if (n === 0) return '–';
  const s = (cents ? nf2 : nf0).format(Math.abs(n)).replace(/ | /g, ' ');
  return n < 0 ? `(${s})` : s;
}

export function renderStatementPdf(st, header = {}) {
  const wide = !!st.matrix;
  const doc = new PDFDocument({size: 'A4', layout: wide ? 'landscape' : 'portrait', margins: {top: 36, bottom: 10, left: 42, right: 40}, info: {Title: `${st.form.name} ${st.period.to}`, Producer: 'Apskaita'}});
  doc.registerFont('r', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf'));
  doc.registerFont('b', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const PW = wide ? 842 : 595, PH = wide ? 595 : 842;
  const L = 42, W = PW - 42 - 40, cents = st.precision === 'cents';

  // Standard reference, top right.
  doc.font('r').fontSize(8).text(`${st.form.standard}\n${st.form.annex}`, L + W - 210, 36, {width: 210, align: 'left'});
  let y = 66;
  const line = (value, caption, {bold = false, size = 9.5} = {}) => {
    doc.font(bold ? 'b' : 'r').fontSize(size).text(value || ' ', L, y, {width: W, align: 'center'});
    y = doc.y + 1;
    doc.moveTo(L + 40, y).lineTo(L + W - 40, y).lineWidth(0.5).stroke();
    doc.font('r').fontSize(7).text(caption, L, y + 2, {width: W, align: 'center'});
    y = doc.y + 5;
  };
  const c = st.company;
  line([c.legal_form && !c.name.startsWith(c.legal_form) ? c.legal_form : '', c.name, c.code ? `įmonės kodas ${c.code}` : ''].filter(Boolean).join(', '), '(įmonės teisinė forma, pavadinimas, kodas)', {bold: true});
  line([c.address, 'Juridinių asmenų registras'].filter(Boolean).join(', '), '(buveinė (adresas), registras, kuriame kaupiami ir saugomi duomenys)');
  line(header.status || '', '(teisinis statusas, jei įmonė likviduojama, reorganizuojama ar yra bankrutavusi)');
  // Approval mark, right.
  doc.moveTo(L + W - 180, y + 14).lineTo(L + W, y + 14).stroke();
  doc.fontSize(7).text('(Tvirtinimo žyma)', L + W - 180, y + 17, {width: 180, align: 'center'});
  y += 30;
  doc.font('b').fontSize(12).text(`${st.period.to} ${st.form.title}`, L, y, {width: W, align: 'center'});
  y = doc.y + 8;
  doc.font('r').fontSize(9.5).text(`${header.compiled || ''}   Nr. ${header.number || '____'}`, L, y, {width: W, align: 'center'});
  y = doc.y + 1; doc.moveTo(L + 150, y).lineTo(L + W - 150, y).stroke();
  doc.fontSize(7).text('(ataskaitos sudarymo data)', L, y + 2, {width: W, align: 'center'});
  y = doc.y + 10;
  const half = W / 2 - 10;
  doc.fontSize(9.5).text(`${st.period.from} – ${st.period.to}`, L, y, {width: half, align: 'center'});
  doc.text(cents ? 'eurais ir centais' : 'eurais', L + half + 20, y, {width: half, align: 'center'});
  y = doc.y + 1;
  doc.moveTo(L + 20, y).lineTo(L + half - 20, y).stroke(); doc.moveTo(L + half + 40, y).lineTo(L + W - 20, y).stroke();
  doc.fontSize(7).text('(ataskaitinis laikotarpis)', L, y + 2, {width: half, align: 'center'});
  doc.text('(ataskaitos tikslumo lygis ir valiuta)', L + half + 20, y + 2, {width: half, align: 'center'});
  y = doc.y + 8;

  // Table.
  const ct = st.form.colTitles || ['Ataskaitinis laikotarpis', 'Praėjęs ataskaitinis laikotarpis'];
  const cols = wide ? [['Eil. Nr.', 30, 'center'], ['Straipsniai', 200, 'left'], ...st.matrix.cols.map((c) => [c.label, (W - 230) / st.matrix.cols.length, 'right'])]
    : [['Eil. Nr.', 44, 'center'], ['Straipsniai', W - 44 - 46 - 84 - 84, 'left'], ['Pastabos Nr.', 46, 'center'], [ct[0], 84, 'right'], [ct[1], 84, 'right']];
  const xs = []; let x = L; for (const col of cols) { xs.push(x); x += col[1]; }
  const cell = (i, text, yy, h, {bold = false, size = 8} = {}) => {
    doc.font(bold ? 'b' : 'r').fontSize(size).text(text, xs[i] + 3, yy + 2.5, {width: cols[i][1] - 6, align: cols[i][2], lineGap: 0});
  };
  const BOTTOM = PH - 42;
  const rowBox = (yy, h, fill) => {
    if (fill) doc.rect(L, yy, W, h).fill(fill).fillColor('black');
    for (let i = 0; i <= cols.length; i++) { const xx = i < cols.length ? xs[i] : L + W; doc.moveTo(xx, yy).lineTo(xx, yy + h).lineWidth(0.5).stroke(); }
    doc.moveTo(L, yy).lineTo(L + W, yy).stroke(); doc.moveTo(L, yy + h).lineTo(L + W, yy + h).stroke();
  };
  const headerRow = () => {
    const h = wide ? Math.max(30, ...cols.map((c) => { doc.font('b').fontSize(6.5); return doc.heightOfString(c[0], {width: c[1] - 6}) + 6; })) : 30;
    rowBox(y, h, '#eeeeee');
    cols.forEach((col, i) => cell(i, col[0].replace('Pastabos Nr.', 'Pasta-\nbos Nr.'), y, h, {bold: true, size: wide ? 6.5 : 7.5}));
    y += h;
  };
  headerRow();
  if (wide) {
    for (const r of st.matrix.rows) {
      doc.font(r.strong ? 'b' : 'r').fontSize(7.5);
      const h = Math.max(12.5, doc.heightOfString(r.label, {width: cols[1][1] - 6}) + 5);
      if (y + h > BOTTOM) { doc.addPage(); y = 40; headerRow(); }
      rowBox(y, h, r.strong ? '#f2f2f2' : null);
      cell(0, `${r.no}.`, y, h, {bold: r.strong, size: 7.5}); cell(1, r.label, y, h, {bold: r.strong, size: 7.5});
      st.matrix.cols.forEach((c, i) => cell(i + 2, fmtAmount(st.matrix.cells[r.no][c.key], cents), y, h, {bold: r.strong, size: 7.5}));
      y += h;
    }
  }
  for (const ln of wide ? [] : st.lines) {
    const bold = ln.heading || ln.total || /^[A-H]\.$/.test(ln.no) || (ln.label === ln.label.toUpperCase() && /[A-ZĄČĘĖĮŠŲŪŽ]/.test(ln.label));
    doc.font(bold ? 'b' : 'r').fontSize(8);
    const h = Math.max(12.5, doc.heightOfString(ln.label, {width: cols[1][1] - 6, lineGap: 0}) + 5);
    if (y + h > BOTTOM) { doc.addPage(); y = 40; headerRow(); }
    rowBox(y, h, ln.grand ? '#f2f2f2' : null);
    cell(0, ln.no, y, h, {bold});
    cell(1, ln.label, y, h, {bold});
    if (!ln.heading) { cell(3, fmtAmount(ln.current, cents), y, h, {bold}); cell(4, fmtAmount(ln.previous, cents), y, h, {bold}); }
    y += h;
  }
  // Signatures.
  if (y > BOTTOM - 80) { doc.addPage(); y = 50; } else y += 22;
  const sig = (title, name, caption) => {
    const w1 = 210, w2 = 110, w3 = W - w1 - w2 - 20;
    doc.font('r').fontSize(9).text(title || ' ', L, y, {width: w1, align: 'center'}); doc.text(' ', L + w1 + 10, y); doc.text(name || ' ', L + w1 + w2 + 20, y, {width: w3, align: 'center'});
    const yy = doc.y + 1;
    doc.moveTo(L, yy).lineTo(L + w1, yy).stroke(); doc.moveTo(L + w1 + 10, yy).lineTo(L + w1 + 10 + w2, yy).stroke(); doc.moveTo(L + w1 + w2 + 20, yy).lineTo(L + W, yy).stroke();
    doc.fontSize(6.8).text(caption, L, yy + 2, {width: w1, align: 'center'}); doc.text('(parašas)', L + w1 + 10, yy + 2, {width: w2, align: 'center'}); doc.text('(vardas ir pavardė)', L + w1 + w2 + 20, yy + 2, {width: w3, align: 'center'});
    y = doc.y + 16;
  };
  sig(header.managerTitle, header.managerName, '(įmonės vadovo pareigų pavadinimas)');
  sig(header.accountantTitle, header.accountantName, '(vyriausiojo buhalterio (buhalterio) arba galinčio tvarkyti apskaitą kito asmens pareigų pavadinimas)');
  doc.end();
  return done;
}
