// Core API: auth, settings, users, chart of accounts, rules, journal, contacts, products, jobs, audit.
import {AppError, tx} from '../db.mjs';
import {requireCap, createUser, publicUser, hashPassword, ROLES} from '../auth/auth.mjs';
import {readJson, sameOrigin} from '../http.mjs';
import {audit} from '../audit.mjs';
import {postEntry, reverseEntry, validateLines, entryLines} from '../ledger/ledger.mjs';
import {money} from '../lib/money.mjs';
import {normalizeVat, normalizeIban} from '../extraction/ids.mjs';
import {todayVilnius} from '../invoices/context.mjs';

const s = (v, n = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, n));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const page = (q) => ({limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200), offset: Math.max(Number(q.offset) || 0, 0)});

export function register(r, {pool, auth, config}) {
  const setSessionCookie = (res, token) => res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionHours * 3600}${config.secureCookies ? '; Secure' : ''}`);
  // ---------------------------------------------------------------- auth
  r.post('/api/login', async ({req, res}) => {
    const b = await readJson(req);
    const ip = req.socket.remoteAddress || '';
    const {token, csrf, user} = await auth.login(s(b.email, 200), String(b.password || ''), ip);
    setSessionCookie(res, token);
    return {user, csrf};
  }, {public: true});
  r.post('/api/open-login', async ({req, res}) => {
    if (!config.openAccess) throw new AppError(404, 'not_found', 'Nerasta.');
    if (!sameOrigin(req)) throw new AppError(403, 'csrf', 'Užklausa iš kitos svetainės atmesta.');
    const {token, csrf, user} = await auth.openLogin();
    setSessionCookie(res, token);
    return {user, csrf};
  }, {public: true});
  r.post('/api/logout', async ({res, token}) => {
    await auth.logout(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return {ok: true};
  });
  r.get('/api/me', async ({user, session}) => {
    const company = (await pool.query('SELECT name, onboarding_done, vat_registered, locked_through FROM company_settings WHERE id=1')).rows[0];
    return {user, csrf: session.csrf, company};
  });
  r.get('/api/health', async ({res}) => {
    await pool.query('SELECT 1');
    return {ok: true};
  }, {public: true});
  // EU VIES check of a VAT number: validity and the registered name (Lithuania does not publish addresses there).
  r.get('/api/vat-check', async ({user, query}) => {
    requireCap(user, 'read');
    const code = normalizeVat(s(query.code, 20));
    const m = /^([A-Z]{2})([0-9A-Z]{2,13})$/.exec(code);
    if (!m) throw new AppError(400, 'bad_vat', 'Netinkamas PVM mokėtojo kodas.');
    let r;
    try {
      r = await fetch(`${config.viesUrl}/ms/${m[1] === 'GR' ? 'EL' : m[1]}/vat/${m[2]}`, {signal: AbortSignal.timeout(10000), headers: {accept: 'application/json'}});
    } catch (e) { throw new AppError(502, 'vies_unavailable', `VIES sistema nepasiekiama (${e.name === 'TimeoutError' ? 'laukimo laikas baigėsi' : 'ryšio klaida'}). Pabandykite vėliau.`); }
    if (!r.ok) throw new AppError(502, 'vies_unavailable', `VIES sistema grąžino klaidą (${r.status}). Pabandykite vėliau.`);
    const d = await r.json();
    if (d.userError && !['VALID', 'INVALID'].includes(d.userError)) throw new AppError(502, 'vies_unavailable', `VIES: ${d.userError}. Pabandykite vėliau.`);
    const clean = (v) => (v && v !== '---' && v !== 'N/A' ? String(v).trim() : '');
    return {code, valid: !!d.isValid, name: clean(d.name), address: clean(d.address), checkedAt: d.requestDate || new Date().toISOString()};
  });
  r.get('/api/bootstrap-status', async () => ({needsAdmin: !(await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount, openAccess: !!config.openAccess}), {public: true});

  // ---------------------------------------------------------------- company settings
  r.get('/api/settings/company', async ({user}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM company_settings WHERE id=1')).rows[0]; });
  r.put('/api/settings/company', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    const f = {name: s(b.name), legal_form: s(b.legal_form, 50), company_code: s(b.company_code, 20).replace(/\s/g, ''), vat_code: normalizeVat(s(b.vat_code, 20)),
      vat_registered: !!b.vat_registered, vat_registered_from: isDate(b.vat_registered_from) ? b.vat_registered_from : null, address: s(b.address), email: s(b.email, 200), phone: s(b.phone, 50),
      asset_threshold: money.norm(b.asset_threshold || '500'), retention_note: s(b.retention_note, 2000), onboarding_done: b.onboarding_done === undefined ? undefined : !!b.onboarding_done,
      website: b.website === undefined ? undefined : s(b.website, 200), manager: b.manager === undefined ? undefined : s(b.manager, 120),
      iban: b.iban === undefined ? undefined : normalizeIban(s(b.iban, 40)), bank_name: b.bank_name === undefined ? undefined : s(b.bank_name, 100)};
    if (f.company_code && !/^\d{7,9}$/.test(f.company_code)) throw new AppError(400, 'bad_code', 'Įmonės kodas turi būti 7–9 skaitmenys.');
    if (f.vat_registered && !/^LT(\d{9}|\d{12})$/.test(f.vat_code)) throw new AppError(400, 'bad_vat', 'PVM mokėtojo kodas turi būti LT ir 9 arba 12 skaitmenų.');
    const keys = Object.keys(f).filter((k) => f[k] !== undefined);
    return tx(pool, async (db) => {
      const before = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
      const row = (await db.query(`UPDATE company_settings SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=1 RETURNING *`, keys.map((k) => f[k]))).rows[0];
      await audit(db, {userId: user.id, action: 'settings.company', entityType: 'company', entityId: 1, details: {before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: f}});
      return row;
    });
  });
  r.post('/api/settings/lock-period', async ({req, user}) => {
    requireCap(user, 'lock');
    const b = await readJson(req);
    if (b.lockedThrough !== null && !isDate(b.lockedThrough)) throw new AppError(400, 'bad_date', 'Netinkama data.');
    return tx(pool, async (db) => {
      const before = (await db.query('SELECT locked_through FROM company_settings WHERE id=1 FOR UPDATE')).rows[0].locked_through;
      if (before && (!b.lockedThrough || b.lockedThrough < before)) requireCap(user, 'settings'); // unlocking needs admin
      await db.query('UPDATE company_settings SET locked_through=$1 WHERE id=1', [b.lockedThrough]);
      await audit(db, {userId: user.id, action: 'period.lock', entityType: 'company', entityId: 1, details: {before, after: b.lockedThrough, note: s(b.note, 500)}});
      return {lockedThrough: b.lockedThrough};
    });
  });

  // ---------------------------------------------------------------- users
  r.get('/api/users', async ({user}) => { requireCap(user, 'users'); return (await pool.query('SELECT * FROM users ORDER BY id')).rows.map(publicUser); });
  r.post('/api/users', async ({req, user}) => { requireCap(user, 'users'); const b = await readJson(req); return createUser(pool, {email: s(b.email, 200), name: s(b.name, 100), role: b.role, password: String(b.password || '')}, user.id); });
  r.put('/api/users/:id', async ({req, user, params}) => {
    requireCap(user, 'users');
    const b = await readJson(req);
    if (b.role && !ROLES.includes(b.role)) throw new AppError(400, 'bad_role', 'Netinkamas vaidmuo.');
    if (String(params.id) === String(user.id) && (b.active === false || (b.role && b.role !== 'admin'))) throw new AppError(400, 'self', 'Negalite atimti administratoriaus teisių sau.');
    return tx(pool, async (db) => {
      const u = (await db.query(`UPDATE users SET role=COALESCE($2, role), active=COALESCE($3, active), name=COALESCE($4, name)${b.password ? ', password_hash=$5' : ''} WHERE id=$1 RETURNING *`,
        [params.id, b.role || null, typeof b.active === 'boolean' ? b.active : null, b.name ? s(b.name, 100) : null, ...(b.password ? [hashPassword(String(b.password))] : [])])).rows[0];
      if (!u) throw new AppError(404, 'not_found', 'Naudotojas nerastas.');
      if (b.active === false || b.role || b.password) await db.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
      await audit(db, {userId: user.id, action: 'user.update', entityType: 'user', entityId: u.id, details: {role: b.role, active: b.active, passwordChanged: !!b.password}});
      return publicUser(u);
    });
  });

  // ---------------------------------------------------------------- chart of accounts, tax, series, posting roles
  // Default: accounts open for posting (for pickers). ?all=1: the whole tree with group headers, in chart order.
  r.get('/api/accounts', async ({user, query}) => {
    requireCap(user, 'read');
    if (query.all) return (await pool.query(`SELECT a.*, (SELECT count(*) FROM journal_lines l WHERE l.account_code=a.code)::int AS line_count FROM accounts a ORDER BY rpad(a.code, 8, ' ')`)).rows;
    return (await pool.query('SELECT * FROM accounts WHERE postable ORDER BY code')).rows;
  });
  r.post('/api/accounts', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    if (!/^\d{1,8}$/.test(s(b.code))) throw new AppError(400, 'bad_code', 'Sąskaitos kodas – iki 8 skaitmenų.');
    if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(b.type)) throw new AppError(400, 'bad_type', 'Netinkamas sąskaitos tipas.');
    // A sub-account turns its parent into a group, which is only possible while the parent has no postings.
    const row = await tx(pool, async (db) => {
      let level = 1, parent = null;
      if (b.parent_code) {
        parent = (await db.query('SELECT * FROM accounts WHERE code=$1 FOR UPDATE', [s(b.parent_code)])).rows[0];
        if (!parent) throw new AppError(400, 'bad_parent', 'Grupė nerasta.');
        if (!s(b.code).startsWith(parent.code)) throw new AppError(400, 'bad_code', `Subsąskaitos kodas turi prasidėti grupės kodu ${parent.code}.`);
        if (parent.postable) {
          if ((await db.query('SELECT 1 FROM journal_lines WHERE account_code=$1 LIMIT 1', [parent.code])).rowCount) throw new AppError(409, 'used', `Sąskaita ${parent.code} jau turi įrašų – subsąskaitų jai kurti negalima.`);
          if (parent.system_role) throw new AppError(409, 'role', `Sąskaita ${parent.code} naudojama automatiniams įrašams – pirmiausia pakeiskite kontavimo susiejimą.`);
          await db.query('UPDATE accounts SET postable=false WHERE code=$1', [parent.code]);
        }
        level = Math.min(parent.level + 1, 5);
        if (b.type !== parent.type) b.type = parent.type;
      }
      return (await db.query('INSERT INTO accounts(code, name, type, subtype, parent_code, level, postable) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (code) DO NOTHING RETURNING *',
        [s(b.code), s(b.name, 200), b.type, s(b.subtype, 30) || parent?.subtype || '', parent?.code || null, level])).rows[0];
    });
    if (!row) throw new AppError(409, 'exists', 'Tokia sąskaita jau yra.');
    await audit(pool, {userId: user.id, action: 'account.create', entityType: 'account', entityId: row.code, details: row});
    return row;
  });
  r.put('/api/accounts/:code', async ({req, user, params}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    const used = (await pool.query('SELECT 1 FROM journal_lines WHERE account_code=$1 LIMIT 1', [params.code])).rowCount;
    if (b.type && used) throw new AppError(409, 'used', 'Sąskaita jau naudojama įrašuose – jos tipo keisti negalima.');
    const row = (await pool.query('UPDATE accounts SET name=COALESCE($2,name), active=COALESCE($3,active), type=COALESCE($4,type) WHERE code=$1 RETURNING *', [params.code, b.name ? s(b.name, 200) : null, typeof b.active === 'boolean' ? b.active : null, b.type || null])).rows[0];
    await audit(pool, {userId: user.id, action: 'account.update', entityType: 'account', entityId: params.code, details: b});
    return row;
  });
  r.put('/api/posting-roles', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      for (const [role, code] of Object.entries(b || {})) {
        if (!/^[a-z_]{3,30}$/.test(role)) continue;
        const acc = (await db.query('SELECT code FROM accounts WHERE code=$1 AND active AND postable', [code])).rows[0];
        if (!acc) throw new AppError(400, 'bad_account', `Sąskaita ${code} nerasta.`);
        await db.query('UPDATE accounts SET system_role=NULL WHERE system_role=$1', [role]);
        await db.query('UPDATE accounts SET system_role=$1 WHERE code=$2', [role, code]);
      }
      await audit(db, {userId: user.id, action: 'posting_roles.update', entityType: 'settings', details: b});
      return (await db.query('SELECT system_role, code FROM accounts WHERE system_role IS NOT NULL')).rows;
    });
  });
  r.get('/api/tax-codes', async ({user}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM tax_codes ORDER BY code, effective_from')).rows; });
  r.post('/api/tax-codes', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    if (!/^PVM\d{1,3}$/.test(s(b.code))) throw new AppError(400, 'bad_code', 'Kodas turi atitikti VMI klasifikatorių (PVM + skaičius).');
    if (!isDate(b.effective_from)) throw new AppError(400, 'bad_date', 'Nurodykite galiojimo pradžią.');
    const row = (await pool.query(`INSERT INTO tax_codes(code, isaf_code, rate, description, applies_to, effective_from, effective_to) VALUES ($1,$1,$2,$3,$4,$5,$6) RETURNING *`,
      [s(b.code), b.rate === '' || b.rate === null ? null : money.norm(b.rate), s(b.description, 300), ['sales', 'purchase', 'both'].includes(b.applies_to) ? b.applies_to : 'both', b.effective_from, isDate(b.effective_to) ? b.effective_to : null])).rows[0];
    await audit(pool, {userId: user.id, action: 'tax_code.create', entityType: 'tax_code', entityId: row.id, details: row});
    return row;
  });
  r.put('/api/tax-codes/:id', async ({req, user, params}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    const row = (await pool.query('UPDATE tax_codes SET effective_to=$2, active=COALESCE($3, active) WHERE id=$1 RETURNING *', [params.id, isDate(b.effective_to) ? b.effective_to : null, typeof b.active === 'boolean' ? b.active : null])).rows[0];
    await audit(pool, {userId: user.id, action: 'tax_code.update', entityType: 'tax_code', entityId: params.id, details: b});
    return row;
  });
  r.get('/api/series', async ({user}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM document_series ORDER BY code')).rows; });
  r.post('/api/series', async ({req, user}) => {
    requireCap(user, 'settings');
    const b = await readJson(req);
    const code = s(b.code, 10).toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(code)) throw new AppError(400, 'bad_code', 'Serija – iki 10 lotyniškų raidžių/skaitmenų.');
    const row = (await pool.query(`INSERT INTO document_series(code, register, doc_type, next_number, padding, description) VALUES ($1,'sales',$2,$3,$4,$5)
      ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description, padding=EXCLUDED.padding, next_number=GREATEST(document_series.next_number, EXCLUDED.next_number) RETURNING *`,
    [code, b.doc_type === 'credit_note' ? 'credit_note' : 'invoice', Math.max(1, Number(b.next_number) || 1), Math.min(10, Math.max(1, Number(b.padding) || 6)), s(b.description, 200)])).rows[0];
    await audit(pool, {userId: user.id, action: 'series.upsert', entityType: 'series', entityId: code, details: row});
    return row;
  });

  // ---------------------------------------------------------------- classification rules (authorized sign-off only)
  r.get('/api/rules', async ({user, query}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT r.*, c.name AS counterparty_name, cu.name AS created_by_name, au.name AS approved_by_name,
        (SELECT count(*) FROM invoice_lines l WHERE l.rule_id = r.id) AS used_count
      FROM classification_rules r LEFT JOIN counterparties c ON c.id=r.counterparty_id
      LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users au ON au.id=r.approved_by
      ${query.all ? '' : "WHERE r.status='active'"} ORDER BY r.rule_key, r.version DESC`)).rows;
  });
  r.post('/api/rules', async ({req, user}) => {
    requireCap(user, 'rules');
    const b = await readJson(req);
    return tx(pool, async (db) => saveRule(db, user, b));
  });
  r.post('/api/rules/:key/retire', async ({user, params}) => {
    requireCap(user, 'rules');
    return tx(pool, async (db) => {
      const row = (await db.query(`UPDATE classification_rules SET status='retired', retired_at=now() WHERE rule_key=$1 AND status='active' RETURNING *`, [params.key])).rows[0];
      if (!row) throw new AppError(404, 'not_found', 'Aktyvi taisyklė nerasta.');
      await audit(db, {userId: user.id, action: 'rule.retire', entityType: 'rule', entityId: params.key, details: {version: row.version}});
      return row;
    });
  });

  // ---------------------------------------------------------------- journal
  r.get('/api/journal', async ({user, query}) => {
    requireCap(user, 'read');
    const {limit, offset} = page(query);
    const params = [];
    const where = [];
    if (isDate(query.from)) { params.push(query.from); where.push(`e.entry_date >= $${params.length}`); }
    if (isDate(query.to)) { params.push(query.to); where.push(`e.entry_date <= $${params.length}`); }
    if (query.account) { params.push(query.account); where.push(`EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.id AND l.account_code=$${params.length})`); }
    if (query.source) { params.push(query.source); where.push(`e.source_type=$${params.length}`); }
    const rows = (await pool.query(`SELECT e.*, u.name AS created_by_name,
        (SELECT sum(debit) FROM journal_lines l WHERE l.entry_id=e.id) AS amount,
        (SELECT json_agg(json_build_object('account', l.account_code, 'debit', l.debit, 'credit', l.credit, 'description', l.description) ORDER BY l.id) FROM journal_lines l WHERE l.entry_id=e.id) AS lines,
        (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id=e.id LIMIT 1) AS reversed_by
      FROM journal_entries e LEFT JOIN users u ON u.id=e.created_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.entry_date DESC, e.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, params)).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.get('/api/journal/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const e = (await pool.query('SELECT * FROM journal_entries WHERE id=$1', [params.id])).rows[0];
    if (!e) throw new AppError(404, 'not_found', 'Įrašas nerastas.');
    const source = await sourceLink(pool, e);
    return {...e, lines: await entryLines(pool, e.id), source};
  });
  r.post('/api/journal', async ({req, user}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (!isDate(b.date)) throw new AppError(400, 'bad_date', 'Nurodykite datą.');
    const lines = (b.lines || []).slice(0, 100).map((l) => ({account: s(l.account, 8), debit: l.debit ? money.norm(String(l.debit).replace(',', '.')) : '0', credit: l.credit ? money.norm(String(l.credit).replace(',', '.')) : '0', counterpartyId: l.counterpartyId || null, description: s(l.description, 200)}));
    const v = validateLines(lines);
    if (!v.ok) throw new AppError(422, 'unbalanced', v.errors.join(' '));
    const kind = ['manual', 'opening', 'cogs', 'adjustment'].includes(b.kind) ? b.kind : 'manual';
    if (!s(b.description)) throw new AppError(400, 'description', 'Nurodykite įrašo aprašymą.');
    const key = s(b.idempotencyKey, 100) || `${kind}:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    return tx(pool, async (db) => {
      const e = await postEntry(db, {date: b.date, description: s(b.description, 300), sourceType: kind, idempotencyKey: `manual:${key}`, userId: user.id, lines});
      if (kind === 'cogs' && /^\d{4}-\d{2}$/.test(s(b.cogsPeriod, 7))) {
        await db.query(`INSERT INTO cogs_periods(period, journal_entry_id, confirmed_by, note) VALUES ($1,$2,$3,$4) ON CONFLICT (period) DO UPDATE SET journal_entry_id=EXCLUDED.journal_entry_id, confirmed_by=EXCLUDED.confirmed_by, confirmed_at=now(), note=EXCLUDED.note`,
          [b.cogsPeriod, e.id, user.id, s(b.description, 300)]);
      }
      await audit(db, {userId: user.id, action: `journal.${kind}`, entityType: 'journal_entry', entityId: e.id, details: {date: b.date, amount: v.debit, duplicate: e.duplicate}});
      return e;
    });
  });
  r.post('/api/journal/:id/reverse', async ({req, user, params}) => {
    requireCap(user, 'approve');
    const b = await readJson(req);
    if (!isDate(b.date)) throw new AppError(400, 'bad_date', 'Nurodykite atšaukimo datą.');
    return tx(pool, async (db) => {
      const e = (await db.query('SELECT * FROM journal_entries WHERE id=$1', [params.id])).rows[0];
      if (!e) throw new AppError(404, 'not_found', 'Įrašas nerastas.');
      if (!['manual', 'opening', 'cogs', 'adjustment'].includes(e.source_type)) throw new AppError(409, 'linked', 'Dokumento ar mokėjimo įrašą atšaukite per kreditinę sąskaitą arba koregavimą.');
      const r2 = await reverseEntry(db, {entryId: e.id, date: b.date, reason: s(b.reason, 200) || e.description, userId: user.id});
      await audit(db, {userId: user.id, action: 'journal.reverse', entityType: 'journal_entry', entityId: e.id, details: {reversal: r2.id, reason: s(b.reason, 200)}});
      return r2;
    });
  });
  r.get('/api/cogs-periods', async ({user}) => { requireCap(user, 'read'); return (await pool.query('SELECT * FROM cogs_periods ORDER BY period DESC')).rows; });

  // ---------------------------------------------------------------- counterparties & products
  r.get('/api/counterparties', async ({user, query}) => {
    requireCap(user, 'read');
    const {limit, offset} = page(query);
    const q = s(query.q, 100);
    const rows = (await pool.query(`SELECT c.*,
        (SELECT coalesce(sum(i.gross_total),0) FROM invoices i WHERE i.counterparty_id=c.id AND i.register='sales') AS sales_total,
        (SELECT coalesce(sum(i.gross_total),0) FROM invoices i WHERE i.counterparty_id=c.id AND i.register='purchase') AS purchase_total
      FROM counterparties c WHERE ($1 = '' OR c.name ILIKE '%'||$1||'%' OR c.company_code LIKE $1||'%' OR c.vat_code ILIKE $1||'%')
      ORDER BY c.name LIMIT ${limit + 1} OFFSET ${offset}`, [q])).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.post('/api/counterparties', async ({req, user}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    if (!s(b.name)) throw new AppError(400, 'name', 'Nurodykite pavadinimą.');
    if (s(b.company_code) && (await pool.query('SELECT 1 FROM counterparties WHERE company_code=$1', [s(b.company_code, 20).replace(/\s/g, '')])).rowCount) throw new AppError(409, 'exists', `Kontrahentas su kodu ${s(b.company_code)} jau yra.`);
    const row = (await pool.query(`INSERT INTO counterparties(name, company_code, vat_code, address, country, email, iban, is_supplier, is_customer, is_individual, notes, legal_form, phone, website, manager)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [...cpValues(b)])).rows[0];
    await audit(pool, {userId: user.id, action: 'counterparty.create', entityType: 'counterparty', entityId: row.id});
    return row;
  });
  r.put('/api/counterparties/:id', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    if (!s(b.name)) throw new AppError(400, 'name', 'Nurodykite pavadinimą.');
    const row = (await pool.query(`UPDATE counterparties SET name=$2, company_code=$3, vat_code=$4, address=$5, country=$6, email=$7, iban=$8, is_supplier=$9, is_customer=$10, is_individual=$11, notes=$12,
      legal_form=$13, phone=$14, website=$15, manager=$16 WHERE id=$1 RETURNING *`, [params.id, ...cpValues(b)])).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Kontrahentas nerastas.');
    await audit(pool, {userId: user.id, action: 'counterparty.update', entityType: 'counterparty', entityId: row.id, details: {note: 'Užregistruotų dokumentų rekvizitai nekeičiami (išsaugota kopija).'}});
    return row;
  });
  // ---------------------------------------------------------------- jobs & audit
  r.get('/api/jobs', async ({user, query}) => {
    requireCap(user, 'read');
    return (await pool.query(`SELECT id, type, status, attempts, max_attempts, run_at, last_error, created_at, finished_at, payload FROM jobs
      WHERE ($1='' OR status=$1) ORDER BY id DESC LIMIT 100`, [s(query.status, 20)])).rows;
  });
  r.post('/api/jobs/:id/retry', async ({user, params}) => {
    requireCap(user, 'write');
    const row = (await pool.query(`UPDATE jobs SET status='queued', run_at=now(), attempts=0, last_error=NULL WHERE id=$1 AND status IN ('dead','failed') RETURNING id, type, payload`, [params.id])).rows[0];
    if (!row) throw new AppError(409, 'not_retryable', 'Užduotis nėra nesėkminga.');
    if (row.type === 'extract_invoice') await pool.query(`UPDATE documents SET processing_status='processing', processing_error=NULL WHERE id=$1 AND processing_status='failed'`, [row.payload.documentId]);
    await audit(pool, {userId: user.id, action: 'job.retry', entityType: 'job', entityId: row.id});
    return row;
  });
  r.get('/api/audit', async ({user, query}) => {
    requireCap(user, 'resolve');
    const {limit, offset} = page(query);
    const rows = (await pool.query(`SELECT a.*, u.name AS user_name, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE ($1='' OR a.entity_type=$1) AND ($2='' OR a.entity_id=$2) ORDER BY a.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, [s(query.entityType, 40), s(query.entityId, 40)])).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit};
  });
  r.get('/api/today', async () => ({today: todayVilnius()}));
}

export async function saveRule(db, user, b) {
  const required = ['name', 'register', 'account_code', 'line_type', 'vat_treatment', 'effective_from'];
  for (const k of required) if (!b[k]) throw new AppError(400, 'required', `Trūksta lauko: ${k}`);
  if (!isDate(b.effective_from) || (b.effective_to && !isDate(b.effective_to))) throw new AppError(400, 'bad_date', 'Netinkamos galiojimo datos.');
  if (!['purchase', 'sales'].includes(b.register)) throw new AppError(400, 'bad_register', 'Netinkamas registras.');
  const acc = (await db.query('SELECT code FROM accounts WHERE code=$1 AND active', [b.account_code])).rows[0];
  if (!acc) throw new AppError(400, 'bad_account', 'Sąskaita nerasta.');
  let key = s(b.rule_key, 60);
  let version = 1;
  if (key) {
    const cur = (await db.query(`SELECT * FROM classification_rules WHERE rule_key=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [key])).rows[0];
    if (!cur) throw new AppError(404, 'not_found', 'Taisyklė nerasta.');
    version = cur.version + 1;
    await db.query(`UPDATE classification_rules SET status='retired', retired_at=now() WHERE rule_key=$1 AND status='active'`, [key]);
  } else key = `R${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const row = (await db.query(`INSERT INTO classification_rules(rule_key, version, name, register, counterparty_id, match_text, priority, effective_from, effective_to, account_code, line_type, vat_treatment, created_by, approved_by, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14) RETURNING *`,
  [key, version, s(b.name, 200), b.register, b.counterparty_id || null, s(b.match_text, 200), Math.max(1, Math.min(10000, Number(b.priority) || 100)), b.effective_from, b.effective_to || null, b.account_code, b.line_type, b.vat_treatment, user.id, s(b.note, 500)])).rows[0];
  await audit(db, {userId: user.id, action: version > 1 ? 'rule.new_version' : 'rule.create', entityType: 'rule', entityId: key, details: {version, ruleId: row.id, signedOffBy: user.id, scope: {register: b.register, counterpartyId: b.counterparty_id || null, matchText: b.match_text || ''}, priority: row.priority, effectiveFrom: row.effective_from, effectiveTo: row.effective_to, account: row.account_code, vat: row.vat_treatment}});
  return row;
}

function cpValues(b) {
  return [s(b.name), s(b.company_code, 20).replace(/\s/g, ''), normalizeVat(s(b.vat_code, 20)), s(b.address), s(b.country || 'LT', 2).toUpperCase(), s(b.email, 200), normalizeIban(s(b.iban, 40)),
    !!b.is_supplier, !!b.is_customer, !!b.is_individual, s(b.notes, 2000), s(b.legal_form, 50), s(b.phone, 50), s(b.website, 200), s(b.manager, 120)];
}

export async function sourceLink(db, e) {
  if (e.source_type === 'invoice') {
    const i = (await db.query('SELECT id, register, series, number, document_id FROM invoices WHERE id=$1', [e.source_id])).rows[0];
    return i ? {type: 'invoice', id: i.id, label: `${i.register === 'sales' ? 'Pardavimas' : 'Pirkimas'} ${i.series} ${i.number}`.trim(), documentId: i.document_id} : null;
  }
  if (e.source_type === 'bank') {
    const t = (await db.query(`SELECT t.id, s.document_id FROM bank_transactions t JOIN bank_statements s ON s.id=t.first_statement_id WHERE t.id=$1`, [e.source_id])).rows[0];
    return t ? {type: 'bank_transaction', id: t.id, label: `Banko operacija #${t.id}`, documentId: t.document_id} : null;
  }
  if (e.source_type === 'payroll') {
    const r = (await db.query('SELECT id, period FROM payroll_runs WHERE id=$1', [e.source_id])).rows[0];
    return r ? {type: 'payroll', id: r.id, label: `DU žiniaraštis ${r.period}`, href: `#/atlyginimai/${r.id}`} : null;
  }
  return {type: e.source_type, id: e.source_id, label: e.source_type};
}
