// Mėnesio uždarymas: one checklist of what is still open for a month, each item with a link to where it is fixed.
import {money} from '../lib/money.mjs';
import {roleAccounts} from '../ledger/ledger.mjs';
import {cogsGaps} from './reports.mjs';
import {taxCalendar} from '../tax/calendar.mjs';

const OPEN_TX = `('unmatched','proposed','needs_review')`;
const addMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const lt = (v) => money.norm(v).replace('.', ',');

export async function monthClose(db, {period, today}) {
  period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')) ? period : today.slice(0, 7);
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const roles = await roleAccounts(db);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const bal = async (code, asOf) => (await one(`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date <= $2`, [code, asOf])).v;
  const items = [];
  const add = (group, level, title, message, link = null) => items.push({group, level, title, message, link});

  // 1. Documents.
  const docs = await one(`SELECT count(*) FILTER (WHERE processing_status IN ('needs_review','ready')) AS review, count(*) FILTER (WHERE processing_status IN ('uploaded','processing')) AS processing,
      count(*) FILTER (WHERE processing_status='failed') AS failed
    FROM documents WHERE workflow='invoice' AND NOT archived AND (issue_date IS NULL OR issue_date <= $1)`, [to]);
  const pending = Number(docs.review) + Number(docs.processing) + Number(docs.failed);
  if (pending) add('Dokumentai', 'error', 'Neužregistruoti dokumentai', `Dokumentų dėžutėje ${docs.review} laukia peržiūros, ${docs.processing} apdorojama, ${docs.failed} nepavyko (data iki ${to} arba nenustatyta).`, '#/deze');
  else add('Dokumentai', 'ok', 'Visi dokumentai užregistruoti', 'Dokumentų dėžutėje nėra laukiančių dokumentų šiam mėnesiui.', '#/deze');

  // 2. Bank.
  const tx = await one(`SELECT count(*) AS n, coalesce(sum(abs(amount)),0) AS amount FROM bank_transactions WHERE status IN ${OPEN_TX} AND booking_date BETWEEN $1 AND $2`, [from, to]);
  if (Number(tx.n)) add('Bankas', 'error', 'Nesuderintos banko operacijos', `${tx.n} operacijų už ${lt(tx.amount)} EUR nesuderinta. Paruoštas galima patvirtinti kartu.`, '#/bankas');
  else add('Bankas', 'ok', 'Banko operacijos suderintos', 'Visos mėnesio banko operacijos patvirtintos.', '#/bankas');
  const st = await one(`SELECT count(*) AS n FROM bank_statements WHERE balance_status <> 'ok' AND resolved_at IS NULL AND period_from <= $2 AND period_to >= $1`, [from, to]);
  if (Number(st.n)) add('Bankas', 'error', 'Išrašų likučiai nesutampa', `${st.n} išrašų su likučių neatitikimu ar be likučių.`, '#/bankas/israsai');
  const accounts = await q(`SELECT b.id, b.name, b.ledger_account, b.currency, (SELECT count(*) FROM bank_accounts x WHERE x.ledger_account=b.ledger_account) AS shared,
      s.period_to, s.closing_balance FROM bank_accounts b
    LEFT JOIN LATERAL (SELECT period_to, closing_balance FROM bank_statements WHERE bank_account_id=b.id AND closing_balance IS NOT NULL AND period_to <= $1 ORDER BY period_to DESC, id DESC LIMIT 1) s ON true`, [to]);
  for (const a of accounts) {
    if (!a.period_to) { add('Bankas', 'warn', `${a.name}: nėra išrašo`, `Nėra išrašo su galutiniu likučiu iki ${to} – likučio su DK palyginti negalima.`, '#/bankas/importas'); continue; }
    const pto = String(a.period_to instanceof Date ? a.period_to.toISOString() : a.period_to).slice(0, 10);
    if (pto < to) add('Bankas', 'warn', `${a.name}: išrašas iki ${pto}`, `Paskutinis išrašas baigiasi ${pto}, o mėnuo – ${to}. Importuokite likusių dienų išrašą.`, '#/bankas/importas');
    if (a.currency !== 'EUR' || Number(a.shared) > 1) continue;
    const ledger = await bal(a.ledger_account, pto);
    const unposted = (await one(`SELECT coalesce(sum(amount),0) AS v FROM bank_transactions WHERE bank_account_id=$1 AND status IN ${OPEN_TX} AND booking_date <= $2`, [a.id, pto])).v;
    if (!money.eq(ledger, a.closing_balance) && money.eq(money.add(ledger, unposted), a.closing_balance)) add('Bankas', 'warn', `${a.name}: DK atsilieka nuo išrašo`, `Skirtumą ${lt(unposted)} EUR sudaro dar nepatvirtintos banko operacijos – patvirtinus likučiai sutaps.`, '#/bankas');
    else if (!money.eq(ledger, a.closing_balance)) add('Bankas', 'error', `${a.name}: DK nesutampa su išrašu`, `${pto} išrašo likutis ${lt(a.closing_balance)} EUR, DK sąskaitos ${a.ledger_account} likutis ${lt(ledger)} EUR (skirtumas ${lt(money.sub(a.closing_balance, ledger))}).`, `#/ataskaitos/knyga?account=${a.ledger_account}&from=${from}&to=${pto}`);
  }
  if (roles.unidentified) {
    const u = await bal(roles.unidentified, to);
    if (!money.isZero(u)) add('Bankas', 'warn', 'Neaiškios įmokos', `Sąskaitoje ${roles.unidentified} lieka ${lt(u)} EUR – išsiaiškinkite mokėtojus.`, `#/ataskaitos/knyga?account=${roles.unidentified}&from=${period.slice(0, 4)}-01-01&to=${to}`);
  }
  const cash = await bal('272', to);
  if (money.sign(cash) < 0) add('Kasa', 'error', 'Neigiamas kasos likutis', `Kasos (272) likutis ${to}: ${lt(cash)} EUR.`, '#/kasa/knyga');

  // 3. Month-end entries.
  const assets = await one(`SELECT count(*) AS n FROM fixed_assets WHERE status='active' AND depreciation_start <= $1`, [period]);
  if (Number(assets.n)) {
    const run = await one(`SELECT id FROM depreciation_runs WHERE period=$1 AND status='posted' LIMIT 1`, [period]);
    if (run) add('Mėnesio įrašai', 'ok', 'Nusidėvėjimas užregistruotas', `Ilgalaikio turto nusidėvėjimas už ${period} užregistruotas.`, '#/turtas/nusidevejimas');
    else add('Mėnesio įrašai', 'error', 'Neužregistruotas nusidėvėjimas', `${assets.n} turto vienetų nusidėvi, bet ${period} nusidėvėjimas neužregistruotas.`, '#/turtas/nusidevejimas');
  }
  if ((await cogsGaps(db, from, to)).length) add('Mėnesio įrašai', 'error', 'Neužregistruota savikaina', `Mėnesį parduota prekių, bet parduotų prekių savikaina (COGS) už ${period} neužregistruota – pelnas būtų per didelis.`, '#/ataskaitos/savikaina');
  const emp = await one(`SELECT count(*) AS n FROM employees WHERE active`);
  if (Number(emp.n)) {
    const pr = await one(`SELECT status FROM payroll_runs WHERE period=$1`, [period]);
    if (pr?.status === 'approved') add('Mėnesio įrašai', 'ok', 'Darbo užmokestis užregistruotas', `${period} žiniaraštis patvirtintas.`, '#/atlyginimai');
    else add('Mėnesio įrašai', 'error', 'Darbo užmokestis', pr ? `${period} žiniaraštis dar juodraštis – patvirtinkite.` : `${period} žiniaraščio nėra (${emp.n} aktyvūs darbuotojai).`, pr ? '#/atlyginimai' : '#/atlyginimai/naujas');
  }
  const loans = await q(`SELECT l.id, l.counterparty_name, (SELECT max(as_of) FROM loan_accruals a WHERE a.loan_id=l.id AND a.status='posted') AS last FROM loans l WHERE l.status='active'`);
  const behind = loans.filter((l) => !l.last || String(l.last instanceof Date ? l.last.toISOString() : l.last).slice(0, 10) < to);
  if (loans.length) {
    if (behind.length) add('Mėnesio įrašai', 'warn', 'Palūkanos nesukauptos', `${behind.length} iš ${loans.length} paskolų palūkanos nesukauptos iki ${to} (${behind.slice(0, 3).map((l) => l.counterparty_name).join(', ')}${behind.length > 3 ? '…' : ''}).`, '#/palukanos');
    else add('Mėnesio įrašai', 'ok', 'Palūkanos sukauptos', `Visų paskolų palūkanos sukauptos iki ${to}.`, '#/palukanos');
  }
  const foreign = await one(`SELECT (SELECT count(*) FROM bank_accounts WHERE currency <> 'EUR') + (SELECT count(*) FROM invoices WHERE currency <> 'EUR' AND issue_date <= $1) AS n`, [to]);
  if (Number(foreign.n)) {
    const rv = await one(`SELECT id FROM fx_revaluations WHERE as_of=$1 AND status='posted' LIMIT 1`, [to]);
    add('Mėnesio įrašai', rv ? 'ok' : 'info', 'Valiutinių straipsnių perkainojimas', rv ? `Perkainota ${to} kursu.` : `Yra užsienio valiutos sąskaitų ar skolų – jei rengiate ataskaitas, perkainokite ${to} kursu.`, '#/valiutos/perkainojimas');
  }

  // 4. VAT.
  const vatTurn = async (code) => (code ? (await one(`SELECT coalesce(sum(l.credit - l.debit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_code=$1 AND e.entry_date BETWEEN $2 AND $3`, [code, from, to])).v : '0');
  const out = await vatTurn(roles.vat_output), inp = money.neg(await vatTurn(roles.vat_input));
  const net = money.sub(out, inp);
  add('PVM', 'info', `PVM už ${period}: ${money.sign(net) >= 0 ? 'mokėti' : 'grąžintinas'} ${lt(money.abs(net))} EUR`, `Pardavimo PVM ${lt(out)} EUR, pirkimo PVM ${lt(inp)} EUR (DK apyvartos). Deklaraciją FR0600 pateikite iki kito mėnesio 25 d.`, `#/fr0600?period=${period}`);

  // 5. Returns for the month (deadlines in the next month).
  const cal = await taxCalendar(db, {from: `${period}-01`, to: `${addMonth(addMonth(period))}-15`, today});
  for (const i of cal.items.filter((x) => x.period === period)) {
    add('Deklaracijos ir mokėjimai', i.status === 'filed' ? 'ok' : i.status === 'overdue' ? 'error' : 'info', i.title,
      i.filed ? `Pateikta ${i.filed.on}${i.filed.reference ? ` (${i.filed.reference})` : ''}.` : `Terminas ${i.due}${i.status === 'overdue' ? ' – praleistas' : ''}. Pateikę pažymėkite mokesčių kalendoriuje.`, i.status === 'filed' ? null : '#/mokesciu-kalendorius');
  }

  // 6. Lock.
  const company = await one('SELECT locked_through FROM company_settings WHERE id=1');
  const locked = company.locked_through && String(company.locked_through instanceof Date ? company.locked_through.toISOString() : company.locked_through).slice(0, 10);
  add('Užrakinimas', locked && locked >= to ? 'ok' : 'info', locked && locked >= to ? 'Laikotarpis užrakintas' : 'Laikotarpis neužrakintas', locked ? `Užrakinta iki ${locked}.` : 'Laikotarpiai neužrakinti.', '#/nustatymai/laikotarpiai');

  const count = (l) => items.filter((i) => i.level === l).length;
  return {period, from, to, lockedThrough: locked || null, items, summary: {error: count('error'), warn: count('warn'), ok: count('ok')}};
}
