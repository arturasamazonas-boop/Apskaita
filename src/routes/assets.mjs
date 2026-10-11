// Ilgalaikis turtas: asset cards, monthly depreciation runs posted to the ledger, disposal, register with ledger reconciliation.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {audit} from '../audit.mjs';
import {money} from '../lib/money.mjs';
import {postEntry, reverseEntry} from '../ledger/ledger.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {defaultAccounts, chargeFor, assetState, forecast, monthEnd, monthIndex, firstMonth} from '../assets/depreciation.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().replace(',', '.').replace(/\s/g, ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isPeriod = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const isAmount = (v) => /^\d+(\.\d{1,2})?$/.test(String(v));
const nextMonth = (d) => { const [y, m] = d.slice(0, 7).split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

async function postedMap(db) {
  const rows = (await db.query(`SELECT l.asset_id, r.period, l.amount FROM depreciation_lines l JOIN depreciation_runs r ON r.id=l.run_id WHERE r.status='posted'`)).rows;
  const m = new Map();
  for (const r of rows) { if (!m.has(String(r.asset_id))) m.set(String(r.asset_id), new Map()); m.get(String(r.asset_id)).set(r.period, money.norm(r.amount)); }
  return m;
}
const loadAssets = async (db, where = '', args = [], lock = false) => (await db.query(`SELECT a.*, ac.name AS cost_account_name FROM fixed_assets a JOIN accounts ac ON ac.code=a.cost_account ${where} ORDER BY a.inv_no${lock ? ' FOR UPDATE OF a' : ''}`, args)).rows
  .map((a) => ({...a, id: String(a.id), cost: money.norm(a.cost), residual_value: money.norm(a.residual_value), opening_accumulated: money.norm(a.opening_accumulated), disposed_on: a.disposed_on ? String(a.disposed_on).slice(0, 10) : null,
    acquisition_date: String(a.acquisition_date).slice(0, 10)}));

async function validateAsset(db, b, existing) {
  const v = {
    inv_no: s(b.inv_no ?? existing?.inv_no, 40), name: s(b.name ?? existing?.name, 200), cost_account: s(b.cost_account ?? existing?.cost_account, 8),
    acquisition_date: b.acquisition_date ?? existing?.acquisition_date, cost: num(b.cost ?? existing?.cost), residual_value: num(b.residual_value ?? existing?.residual_value) || '0',
    useful_life_months: Number(b.useful_life_months ?? existing?.useful_life_months), opening_accumulated: num(b.opening_accumulated ?? existing?.opening_accumulated) || '0',
    opening_period: s(b.opening_period ?? existing?.opening_period, 7) || null, location: s(b.location ?? existing?.location, 200), responsible: s(b.responsible ?? existing?.responsible, 200),
    notes: s(b.notes ?? existing?.notes, 2000), invoice_line_id: b.invoice_line_id ?? existing?.invoice_line_id ?? null,
  };
  if (!v.inv_no || !v.name) throw new AppError(400, 'name', 'Nurodykite inventorinį numerį ir pavadinimą.');
  if (!isDate(v.acquisition_date)) throw new AppError(400, 'date', 'Nurodykite įsigijimo (naudojimo pradžios) datą.');
  if (!isAmount(v.cost) || money.isZero(v.cost)) throw new AppError(400, 'cost', 'Įsigijimo savikaina – teigiama suma.');
  if (!isAmount(v.residual_value) || money.cmp(v.residual_value, v.cost) >= 0) throw new AppError(400, 'residual', 'Likvidacinė vertė turi būti mažesnė už savikainą.');
  if (!Number.isInteger(v.useful_life_months) || v.useful_life_months < 1 || v.useful_life_months > 1200) throw new AppError(400, 'life', 'Naudingo tarnavimo laikas – mėnesiais (1–1200).');
  if (!isAmount(v.opening_accumulated) || money.cmp(v.opening_accumulated, money.sub(v.cost, v.residual_value)) > 0) throw new AppError(400, 'opening', 'Sukauptas nusidėvėjimas negali viršyti nudėvimos vertės.');
  if (v.opening_period && !isPeriod(v.opening_period)) throw new AppError(400, 'opening_period', 'Laikotarpis – MMMM-mm.');
  if (!money.isZero(v.opening_accumulated) && !v.opening_period) throw new AppError(400, 'opening_period', 'Nurodykite, iki kurio mėnesio (imtinai) sukauptas perkeltas nusidėvėjimas.');
  v.depreciation_start = isPeriod(b.depreciation_start) ? b.depreciation_start : existing?.depreciation_start && !('acquisition_date' in b) ? existing.depreciation_start : nextMonth(v.acquisition_date);
  const def = defaultAccounts(v.cost_account);
  v.depreciation_account = s(b.depreciation_account ?? existing?.depreciation_account, 8) || def.depreciation;
  v.expense_account = s(b.expense_account ?? existing?.expense_account, 8) || def.expense;
  const codes = [v.cost_account, v.depreciation_account, v.expense_account];
  const found = (await db.query('SELECT code FROM accounts WHERE code = ANY($1) AND active AND postable', [codes])).rows.map((r) => r.code);
  for (const c of codes) if (!c || !found.includes(c)) throw new AppError(400, 'account', `Netinkama sąskaita ${c || '(tuščia)'} – pasirinkite detaliąją sąskaitų plano sąskaitą.`);
  if (!/^1[12]/.test(v.cost_account)) throw new AppError(400, 'account', 'Turto sąskaita turi būti iš 11 (nematerialusis) arba 12 (materialusis turtas) grupės.');
  return v;
}

export function register(r, {pool}) {
  // Register at a date with accumulated depreciation, net book value and reconciliation with the ledger.
  r.get('/api/fixed-assets', async ({user, query}) => {
    requireCap(user, 'read');
    const asOf = isDate(query.asOf) ? query.asOf : todayVilnius();
    const period = asOf.slice(0, 7);
    const [assets, posted] = [await loadAssets(pool), await postedMap(pool)];
    const items = [];
    const byAcc = new Map();
    for (const a of assets) {
      if (a.acquisition_date > asOf) continue;
      const gone = a.disposed_on && a.disposed_on <= asOf;
      const st = assetState(a, posted.get(a.id) || new Map(), period);
      items.push({...a, accumulated: st.accumulated, nbv: st.nbv, missing: st.missing, monthly: chargeFor(a, period, st.accumulated), disposedAtDate: !!gone});
      if (gone) continue;
      for (const [code, amt] of [[a.cost_account, a.cost], [a.depreciation_account, money.neg(st.accumulated)]]) byAcc.set(code, money.add(byAcc.get(code) || '0', amt));
    }
    const ledger = new Map((await pool.query(`SELECT l.account_code AS code, sum(l.debit-l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE e.entry_date <= $1 AND (l.account_code LIKE '11%' OR l.account_code LIKE '12%') GROUP BY 1`, [asOf])).rows.map((x) => [x.code, money.norm(x.bal)]));
    const recon = [...new Set([...byAcc.keys(), ...ledger.keys()])].sort().map((code) => ({code, register: byAcc.get(code) || '0.00', ledger: ledger.get(code) || '0.00',
      diff: money.sub(ledger.get(code) || '0', byAcc.get(code) || '0')}));
    const live = items.filter((i) => !i.disposedAtDate);
    return {asOf, items, totals: {cost: money.sum(live.map((i) => i.cost)), accumulated: money.sum(live.map((i) => i.accumulated)), nbv: money.sum(live.map((i) => i.nbv))}, reconciliation: recon};
  });
  r.get('/api/fixed-assets/candidates', async ({user}) => {
    requireCap(user, 'read');
    // Purchase invoice lines booked to 11/12 accounts that have no asset card yet.
    return (await pool.query(`SELECT l.id, l.description, l.net, l.account_code, i.issue_date, i.series, i.number, (i.counterparty_snapshot->>'name') AS supplier
      FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id LEFT JOIN fixed_assets a ON a.invoice_line_id=l.id
      WHERE i.register='purchase' AND (l.account_code LIKE '11%' OR l.account_code LIKE '12%') AND a.id IS NULL ORDER BY i.issue_date DESC LIMIT 200`)).rows;
  });
  r.get('/api/fixed-assets/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const [a] = await loadAssets(pool, 'WHERE a.id=$1', [params.id]);
    if (!a) throw new AppError(404, 'not_found', 'Turto kortelė nerasta.');
    const posted = (await postedMap(pool)).get(a.id) || new Map();
    const today = todayVilnius().slice(0, 7);
    const history = [...posted].sort(([x], [y]) => monthIndex(x) - monthIndex(y)).map(([period, amount]) => ({period, amount}));
    const st = assetState(a, posted, today);
    return {...a, monthly: chargeFor(a, firstMonth(a), a.opening_accumulated), history, accumulated: st.accumulated, nbv: st.nbv, missing: st.missing,
      forecast: forecast(a, posted, firstMonth(a)).slice(0, 120)};
  });
  r.post('/api/fixed-assets', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      const v = await validateAsset(db, b, null);
      if (v.invoice_line_id && !(await db.query('SELECT 1 FROM invoice_lines WHERE id=$1', [v.invoice_line_id])).rowCount) throw new AppError(400, 'invoice_line', 'Sąskaitos eilutė nerasta.');
      const dup = await db.query('SELECT 1 FROM fixed_assets WHERE inv_no=$1', [v.inv_no]);
      if (dup.rowCount) throw new AppError(409, 'inv_no', `Inventorinis Nr. ${v.inv_no} jau naudojamas.`);
      const row = (await db.query(`INSERT INTO fixed_assets(inv_no, name, cost_account, depreciation_account, expense_account, acquisition_date, cost, residual_value, useful_life_months, depreciation_start,
          opening_accumulated, opening_period, location, responsible, invoice_line_id, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [v.inv_no, v.name, v.cost_account, v.depreciation_account, v.expense_account, v.acquisition_date, v.cost, v.residual_value, v.useful_life_months, v.depreciation_start, v.opening_accumulated, v.opening_period, v.location, v.responsible, v.invoice_line_id, v.notes, user.id])).rows[0];
      await audit(db, {userId: user.id, action: 'asset.create', entityType: 'fixed_asset', entityId: row.id, details: {inv_no: v.inv_no, cost: v.cost}});
      return {id: String(row.id)};
    });
  });
  r.put('/api/fixed-assets/:id', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      const [a] = await loadAssets(db, 'WHERE a.id=$1', [params.id], true);
      if (!a) throw new AppError(404, 'not_found', 'Turto kortelė nerasta.');
      const v = await validateAsset(db, b, a);
      const hasPostings = (await db.query(`SELECT 1 FROM depreciation_lines l JOIN depreciation_runs r ON r.id=l.run_id WHERE l.asset_id=$1 AND r.status='posted' LIMIT 1`, [a.id])).rowCount > 0;
      const FIN = ['cost_account', 'depreciation_account', 'expense_account', 'acquisition_date', 'cost', 'residual_value', 'useful_life_months', 'depreciation_start', 'opening_accumulated', 'opening_period'];
      const changed = FIN.filter((k) => String(v[k] ?? '') !== String(a[k] ?? ''));
      if ((hasPostings || a.status === 'disposed') && changed.length) throw new AppError(409, 'posted', `Nusidėvėjimas jau skaičiuotas – finansinių duomenų (${changed.join(', ')}) keisti negalima. Atšaukite nusidėvėjimo žiniaraščius arba nurašykite ir sukurkite naują kortelę.`);
      await db.query(`UPDATE fixed_assets SET inv_no=$2, name=$3, cost_account=$4, depreciation_account=$5, expense_account=$6, acquisition_date=$7, cost=$8, residual_value=$9, useful_life_months=$10, depreciation_start=$11,
        opening_accumulated=$12, opening_period=$13, location=$14, responsible=$15, notes=$16 WHERE id=$1`,
      [a.id, v.inv_no, v.name, v.cost_account, v.depreciation_account, v.expense_account, v.acquisition_date, v.cost, v.residual_value, v.useful_life_months, v.depreciation_start, v.opening_accumulated, v.opening_period, v.location, v.responsible, v.notes]);
      await audit(db, {userId: user.id, action: 'asset.update', entityType: 'fixed_asset', entityId: a.id, details: {changed}});
      return {ok: true};
    });
  });
  r.delete('/api/fixed-assets/:id', async ({user, params}) => {
    requireCap(user, 'write');
    return tx(pool, async (db) => {
      const used = await db.query('SELECT 1 FROM depreciation_lines WHERE asset_id=$1 LIMIT 1', [params.id]);
      if (used.rowCount) throw new AppError(409, 'posted', 'Kortelės su nusidėvėjimo istorija ištrinti negalima – turtą nurašykite.');
      const d = await db.query(`DELETE FROM fixed_assets WHERE id=$1 AND status='active' RETURNING inv_no`, [params.id]);
      if (!d.rowCount) throw new AppError(404, 'not_found', 'Turto kortelė nerasta arba nurašyta.');
      await audit(db, {userId: user.id, action: 'asset.delete', entityType: 'fixed_asset', entityId: params.id, details: {inv_no: d.rows[0].inv_no}});
      return {ok: true};
    });
  });
  // Disposal: write-off or sale. Ledger: D accumulated depreciation, D 6400 net book value / K cost. Sale proceeds are a separate sales invoice (5400).
  r.post('/api/fixed-assets/:id/dispose', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (!isDate(b.date)) throw new AppError(400, 'date', 'Nurodykite nurašymo datą.');
    const kind = b.kind === 'sale' ? 'sale' : 'writeoff';
    return tx(pool, async (db) => {
      const [a] = await loadAssets(db, 'WHERE a.id=$1', [params.id], true);
      if (!a) throw new AppError(404, 'not_found', 'Turto kortelė nerasta.');
      if (a.status === 'disposed') throw new AppError(409, 'disposed', 'Turtas jau nurašytas.');
      if (b.date < a.acquisition_date) throw new AppError(400, 'date', 'Nurašymo data ankstesnė už įsigijimo datą.');
      const posted = (await postedMap(db)).get(a.id) || new Map();
      const month = b.date.slice(0, 7);
      const later = [...posted.keys()].filter((p) => monthIndex(p) > monthIndex(month));
      if (later.length) throw new AppError(409, 'later_runs', `Po nurašymo mėnesio jau paskaičiuotas nusidėvėjimas (${later.join(', ')}) – pirmiausia atšaukite tuos žiniaraščius.`);
      const st = assetState(a, posted, month);
      if (st.missing.length || (!posted.has(month) && !money.isZero(chargeFor(a, month, st.accumulated)))) {
        const need = [...st.missing, ...(!posted.has(month) && !money.isZero(chargeFor(a, month, st.accumulated)) ? [month] : [])];
        throw new AppError(409, 'missing_runs', `Pirmiausia paskaičiuokite nusidėvėjimą už ${need.join(', ')} (turtas nudėvimas ir nurašymo mėnesį).`);
      }
      const nbv = money.sub(a.cost, st.accumulated);
      const lines = [{account: a.depreciation_account, debit: st.accumulated, description: `${a.inv_no} sukauptas nusidėvėjimas`},
        {account: '6400', debit: nbv, description: `${a.inv_no} likutinė vertė`}, {account: a.cost_account, credit: a.cost, description: `${a.inv_no} ${a.name}`}];
      const e = await postEntry(db, {date: b.date, description: `${kind === 'sale' ? 'Ilgalaikio turto pardavimas' : 'Ilgalaikio turto nurašymas'}: ${a.inv_no} ${a.name}`, sourceType: 'asset_disposal', sourceId: a.id,
        idempotencyKey: `asset-dispose:${a.id}`, userId: user.id, lines});
      await db.query(`UPDATE fixed_assets SET status='disposed', disposed_on=$2, disposal_kind=$3, disposal_entry_id=$4, disposal_note=$5 WHERE id=$1`, [a.id, b.date, kind, e.id, s(b.note, 500)]);
      await audit(db, {userId: user.id, action: 'asset.dispose', entityType: 'fixed_asset', entityId: a.id, details: {date: b.date, kind, nbv, entryId: e.id}});
      return {ok: true, entryId: String(e.id), nbv};
    });
  });

  // ------------------------------------------------------------ monthly depreciation runs
  const preview = async (db, period) => {
    const [assets, posted] = [await loadAssets(db, `WHERE a.status='active' OR a.disposed_on >= $1`, [`${period}-01`]), await postedMap(db)];
    const lines = [], blocked = [];
    for (const a of assets) {
      const p = posted.get(a.id) || new Map();
      if (p.has(period)) continue;
      const st = assetState(a, p, period);
      const amount = chargeFor(a, period, st.accumulated);
      if (money.isZero(amount)) continue;
      if (st.missing.length) { blocked.push({id: a.id, inv_no: a.inv_no, name: a.name, missing: st.missing}); continue; }
      lines.push({id: a.id, inv_no: a.inv_no, name: a.name, expense_account: a.expense_account, depreciation_account: a.depreciation_account, amount, accumulatedAfter: money.add(st.accumulated, amount)});
    }
    return {period, lines, blocked, total: money.sum(lines.map((l) => l.amount)), alreadyPosted: !!(await db.query(`SELECT 1 FROM depreciation_runs WHERE period=$1 AND status='posted'`, [period])).rowCount};
  };
  r.get('/api/depreciation/preview', async ({user, query}) => {
    requireCap(user, 'read');
    if (!isPeriod(query.period)) throw new AppError(400, 'period', 'Nurodykite mėnesį (MMMM-mm).');
    return preview(pool, query.period);
  });
  r.get('/api/depreciation/runs', async ({user}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT r.*, (SELECT count(*) FROM depreciation_lines l WHERE l.run_id=r.id) AS assets FROM depreciation_runs r ORDER BY r.period DESC, r.id DESC LIMIT 240`)).rows;
  });
  r.post('/api/depreciation/runs', async ({req, user}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (!isPeriod(b.period)) throw new AppError(400, 'period', 'Nurodykite mėnesį (MMMM-mm).');
    return tx(pool, async (db) => {
      await db.query('LOCK TABLE depreciation_runs IN EXCLUSIVE MODE');
      const p = await preview(db, b.period);
      if (p.alreadyPosted) throw new AppError(409, 'posted', `Nusidėvėjimas už ${b.period} jau paskaičiuotas.`);
      if (p.blocked.length) throw new AppError(409, 'missing_runs', `Pirmiausia paskaičiuokite ankstesnius mėnesius: ${[...new Set(p.blocked.flatMap((x) => x.missing))].sort().join(', ')}.`);
      if (!p.lines.length) throw new AppError(422, 'empty', `Už ${b.period} nėra nudėvimo turto.`);
      const run = (await db.query(`INSERT INTO depreciation_runs(period, total, created_by) VALUES ($1,$2,$3) RETURNING id`, [b.period, p.total, user.id])).rows[0];
      const sum = (key) => { const m = new Map(); for (const l of p.lines) m.set(l[key], money.add(m.get(l[key]) || '0', l.amount)); return m; };
      const lines = [...[...sum('expense_account')].map(([account, debit]) => ({account, debit, description: `Nusidėvėjimas ${b.period}`})),
        ...[...sum('depreciation_account')].map(([account, credit]) => ({account, credit, description: `Sukauptas nusidėvėjimas ${b.period}`}))];
      const e = await postEntry(db, {date: monthEnd(b.period), description: `Ilgalaikio turto nusidėvėjimas ${b.period}`, sourceType: 'depreciation', sourceId: run.id, idempotencyKey: `depreciation:${run.id}`, userId: user.id, lines});
      await db.query('UPDATE depreciation_runs SET journal_entry_id=$2 WHERE id=$1', [run.id, e.id]);
      for (const l of p.lines) await db.query('INSERT INTO depreciation_lines(run_id, asset_id, amount) VALUES ($1,$2,$3)', [run.id, l.id, l.amount]);
      await audit(db, {userId: user.id, action: 'depreciation.post', entityType: 'depreciation_run', entityId: run.id, details: {period: b.period, total: p.total, entryId: e.id}});
      return {id: String(run.id), entryId: String(e.id), total: p.total, assets: p.lines.length};
    });
  });
  r.post('/api/depreciation/runs/:id/cancel', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (s(b.reason).length < 5) throw new AppError(400, 'reason', 'Nurodykite atšaukimo priežastį.');
    return tx(pool, async (db) => {
      const run = (await db.query(`SELECT * FROM depreciation_runs WHERE id=$1 FOR UPDATE`, [params.id])).rows[0];
      if (!run || run.status !== 'posted') throw new AppError(404, 'not_found', 'Galiojantis žiniaraštis nerastas.');
      const later = await db.query(`SELECT period FROM depreciation_runs WHERE status='posted' AND period > $1 ORDER BY period`, [run.period]);
      if (later.rowCount) throw new AppError(409, 'later_runs', `Pirmiausia atšaukite vėlesnius žiniaraščius: ${later.rows.map((x) => x.period).join(', ')}.`);
      const disposed = await db.query(`SELECT a.inv_no FROM fixed_assets a JOIN depreciation_lines l ON l.asset_id=a.id WHERE l.run_id=$1 AND a.status='disposed'`, [run.id]);
      if (disposed.rowCount) throw new AppError(409, 'disposed', `Žiniaraštyje yra jau nurašytas turtas (${disposed.rows.map((x) => x.inv_no).join(', ')}).`);
      const rev = await reverseEntry(db, {entryId: run.journal_entry_id, date: monthEnd(run.period), reason: `nusidėvėjimas ${run.period}: ${s(b.reason, 200)}`, userId: user.id});
      await db.query(`UPDATE depreciation_runs SET status='cancelled', cancelled_at=now(), cancel_reason=$2 WHERE id=$1`, [run.id, s(b.reason, 200)]);
      await audit(db, {userId: user.id, action: 'depreciation.cancel', entityType: 'depreciation_run', entityId: run.id, details: {period: run.period, reversalEntryId: rev.id}});
      return {ok: true};
    });
  });
}
