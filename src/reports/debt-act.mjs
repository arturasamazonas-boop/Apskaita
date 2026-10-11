// Skolų suderinimo aktas: receivables and payables with one counterparty on a date, from the ledger and open invoices.
import path from 'node:path';
import PDFDocument from 'pdfkit';
import {ROOT} from '../config.mjs';
import {money} from '../lib/money.mjs';
import {invoiceBalances} from '../ledger/balances.mjs';
import {fmtAmount} from './statement-pdf.mjs';

export async function debtAct(db, {counterparty, asOf}) {
  const cp = (await db.query('SELECT * FROM counterparties WHERE id=$1', [counterparty])).rows[0];
  if (!cp) return null;
  const roles = Object.fromEntries((await db.query(`SELECT system_role, code FROM accounts WHERE system_role IN ('receivable','payable','advances_received','advances_paid')`)).rows.map((r) => [r.system_role, r.code]));
  const bal = async (code) => (code ? (await db.query(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND l.counterparty_id=$2 AND e.entry_date <= $3`, [code, cp.id, asOf])).rows[0].v : '0');
  const receivable = money.add(await bal(roles.receivable), await bal(roles.advances_paid));
  const payable = money.neg(money.add(await bal(roles.payable), await bal(roles.advances_received)));
  const open = [];
  for (const register of ['sales', 'purchase']) {
    for (const r of await invoiceBalances(db, {register, asOf, openOnly: true, counterpartyId: cp.id, limit: 5000})) open.push({register, issue_date: r.issue_date, number: `${r.series || ''} ${r.number}`.trim(), due_date: r.due_date, gross: r.gross, outstanding: r.outstanding});
  }
  return {asOf, counterparty: {id: cp.id, name: cp.name, code: cp.company_code, vat: cp.vat_code, address: cp.address}, receivable, payable, balance: money.sub(receivable, payable), open};
}

export function renderDebtActPdf(act, company, header = {}) {
  const doc = new PDFDocument({size: 'A4', margins: {top: 40, bottom: 20, left: 50, right: 45}, info: {Title: `Skolų suderinimo aktas ${act.counterparty.name}`, Producer: 'Apskaita'}});
  doc.registerFont('r', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf')); doc.registerFont('b', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
  const chunks = []; doc.on('data', (c) => chunks.push(c)); const done = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 50, W = 595 - 95;
  const pair = (y, a, b, ca, cb) => {
    doc.font('b').fontSize(9.5).text(a || ' ', L, y, {width: W / 2 - 10}); doc.text(b || ' ', L + W / 2 + 10, y, {width: W / 2 - 10});
    const yy = Math.max(doc.y, y + 12) + 1; doc.moveTo(L, yy).lineTo(L + W / 2 - 10, yy).stroke(); doc.moveTo(L + W / 2 + 10, yy).lineTo(L + W, yy).stroke();
    doc.font('r').fontSize(7).text(ca, L, yy + 2, {width: W / 2 - 10}); doc.text(cb, L + W / 2 + 10, yy + 2, {width: W / 2 - 10});
    return doc.y + 6;
  };
  let y = 40;
  doc.font('r').fontSize(8).text('Siuntėjas', L, y); doc.text('Gavėjas', L + W / 2 + 10, y); y += 12;
  y = pair(y, company.name, act.counterparty.name, '(įmonės pavadinimas)', '(įmonės pavadinimas)');
  y = pair(y, company.company_code, act.counterparty.code, '(įmonės kodas)', '(įmonės kodas)');
  y = pair(y, company.address, act.counterparty.address, '(adresas)', '(adresas)');
  y += 20;
  doc.font('b').fontSize(13).text('SKOLŲ SUDERINIMO AKTAS', L, y, {width: W, align: 'center'});
  doc.font('r').fontSize(9.5).text(`${header.compiled || act.asOf} Nr. ${header.number || '____'}`, L, doc.y + 4, {width: W, align: 'center'});
  y = doc.y + 16;
  doc.fontSize(10).text(`Prašome patvirtinti, kad sutinkate su žemiau nurodytu tarpusavio skolų likučiu ${act.asOf} mūsų apskaitos duomenimis.`, L, y, {width: W});
  y = doc.y + 12;
  const cw = W / 3;
  const head = ['JŪSŲ SKOLA MUMS (+)', 'MŪSŲ SKOLA JUMS (–)', 'SKOLOS LIKUTIS'], vals = [act.receivable, act.payable, act.balance];
  doc.rect(L, y, W, 18).fill('#eeeeee').fillColor('black');
  head.forEach((t, i) => doc.font('b').fontSize(8.5).text(t, L + i * cw, y + 5, {width: cw, align: 'center'}));
  vals.forEach((v, i) => doc.font('r').fontSize(11).text(`${fmtAmount(v, true)} EUR`, L + i * cw, y + 24, {width: cw, align: 'center'}));
  for (let i = 0; i <= 3; i++) doc.moveTo(L + i * cw, y).lineTo(L + i * cw, y + 42).stroke();
  doc.moveTo(L, y).lineTo(L + W, y).stroke(); doc.moveTo(L, y + 18).lineTo(L + W, y + 18).stroke(); doc.moveTo(L, y + 42).lineTo(L + W, y + 42).stroke();
  y += 56;
  if (act.open.length) {
    doc.font('b').fontSize(9).text('Neapmokėtos sąskaitos', L, y); y = doc.y + 4;
    const cols = [['Tipas', 70], ['Data', 70], ['Numeris', 120], ['Terminas', 70], ['Suma', 85], ['Likutis', 85]];
    let x = L; cols.forEach(([t, w]) => { doc.font('b').fontSize(8).text(t, x, y, {width: w - 4, align: ['Suma', 'Likutis'].includes(t) ? 'right' : 'left'}); x += w; });
    y += 13;
    for (const r of act.open) {
      if (y > 760) { doc.addPage(); y = 40; }
      const vals2 = [r.register === 'sales' ? 'Pardavimas' : 'Pirkimas', r.issue_date, r.number, r.due_date || '', fmtAmount(r.gross, true), fmtAmount(r.outstanding, true)];
      x = L; cols.forEach(([t, w], i) => { doc.font('r').fontSize(8).text(String(vals2[i]), x, y, {width: w - 4, align: i >= 4 ? 'right' : 'left'}); x += w; });
      y += 12;
    }
    y += 8;
  }
  const sign = (title, name) => {
    if (y > 740) { doc.addPage(); y = 40; }
    doc.font('r').fontSize(9).text(title, L, y, {width: 160}); doc.text(name || '', L + 330, y, {width: W - 330});
    doc.moveTo(L + 170, y + 11).lineTo(L + 320, y + 11).stroke();
    doc.fontSize(7).text('(parašas)', L + 170, y + 13, {width: 150, align: 'center'});
    y += 30;
  };
  y += 10; sign(company.manager_title || 'Įmonės vadovas', company.manager); sign(company.accountant_title || 'Buhalteris', company.accountant_name);
  y += 10;
  doc.font('b').fontSize(10).text('PATVIRTINIMAS', L, y); y = doc.y + 6;
  doc.font('r').fontSize(9.5).text('Jūsų nurodyta skolos suma yra teisinga / teisinga su tokiomis išimtimis:', L, y, {width: W}); y = doc.y + 6;
  for (let i = 0; i < 3; i++) { doc.moveTo(L, y + 14).lineTo(L + W, y + 14).stroke(); y += 18; }
  y += 14; sign('Įmonės vadovas', ''); sign('Vyr. buhalteris (buhalteris)', '');
  doc.end();
  return done;
}
