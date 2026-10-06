// Documents, files, uploads, invoice inbox and proposals.
import {AppError, tx} from '../db.mjs';
import {requireCap, can} from '../auth/auth.mjs';
import {readJson, readMultipart, SECURITY_HEADERS} from '../http.mjs';
import {audit} from '../audit.mjs';
import {uploadFiles, uploadVersion} from '../vault/upload.mjs';
import {SUPPORTED} from '../vault/filetypes.mjs';
import {searchDocuments, loadDocumentForUser, updateMetadata, signDownload, checkDownload, contractStatusFor, deletionBlockers, visibilitySql} from '../vault/documents.mjs';
import {liveValidation, editProposal, approveProposal, rejectProposal, bulkApprove, splitDocument, requestReextract} from '../invoices/service.mjs';
import {computeProposal, applyClassification} from '../invoices/engine.mjs';
import {loadContext, todayVilnius} from '../invoices/context.mjs';
import {saveRule} from './core.mjs';

export function register(r, deps) {
  const {pool, storage, config} = deps;

  r.get('/api/supported-formats', async () => SUPPORTED);

  r.post('/api/uploads', async ({req, user}) => {
    requireCap(user, 'write');
    const {files, fields} = await readMultipart(req, {maxFileBytes: config.maxUploadBytes});
    if (!files.length) throw new AppError(400, 'no_files', 'Nepasirinktas nė vienas failas.');
    let meta = {};
    try { meta = fields.meta ? JSON.parse(fields.meta) : {}; } catch { throw new AppError(400, 'bad_meta', 'Netinkami metaduomenys.'); }
    if (meta.confidentiality === 'admin_only' && !can(user, 'admin_only')) throw new AppError(403, 'forbidden', 'Tik administratorius gali nustatyti šį lygį.');
    if (meta.confidentiality === 'restricted' && !can(user, 'restricted')) throw new AppError(403, 'forbidden', 'Neturite teisės nustatyti šio lygio.');
    return {results: await uploadFiles(deps, user, files, {workflow: fields.workflow || 'invoice', meta})};
  });

  // ------------------------------------------------------------ vault
  r.get('/api/documents', async ({user, query}) => {
    requireCap(user, 'read');
    const res = await searchDocuments(pool, user, query);
    const today = todayVilnius();
    res.items = res.items.map((d) => ({...d, contract_status_effective: contractStatusFor(d, today)}));
    if (query.q) await audit(pool, {userId: user.id, action: 'document.search', entityType: 'document', details: {q: String(query.q).slice(0, 100), results: res.items.length}});
    return res;
  });
  r.get('/api/documents/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const d = await loadDocumentForUser(pool, user, params.id);
    const files = (await pool.query(`SELECT f.id, f.version, f.role, f.page, f.sha256, f.size_bytes, f.mime, f.original_name, f.derived_from_file_id, f.uploaded_at, f.note, u.name AS uploaded_by_name
      FROM stored_files f LEFT JOIN users u ON u.id=f.uploaded_by WHERE f.document_id=$1 ORDER BY f.role, f.version DESC, f.page`, [d.id])).rows;
    const links = (await pool.query(`SELECT l.relation, l.to_document_id AS id, d.title, 'out' AS dir FROM document_links l JOIN documents d ON d.id=l.to_document_id WHERE l.from_document_id=$1 AND ${visibilitySql(user)}
      UNION ALL SELECT l.relation, l.from_document_id, d.title, 'in' FROM document_links l JOIN documents d ON d.id=l.from_document_id WHERE l.to_document_id=$1 AND ${visibilitySql(user)}`, [d.id])).rows;
    const invoices = (await pool.query(`SELECT id, register, doc_type, series, number, issue_date, gross_total, journal_entry_id FROM invoices WHERE document_id=$1 ORDER BY id`, [d.id])).rows;
    const proposals = (await pool.query(`SELECT id, kind, version, status, blocking, created_at, decided_at FROM proposals WHERE document_id=$1 ORDER BY version DESC LIMIT 50`, [d.id])).rows;
    const extraction = (await pool.query(`SELECT id, provider, provider_version, is_demo, created_at, file_id, result->'layout' AS layout, result->'notes' AS notes, result->'pages' AS pages FROM extractions WHERE document_id=$1 ORDER BY id DESC LIMIT 1`, [d.id])).rows[0] || null;
    const history = can(user, 'resolve') ? (await pool.query(`SELECT a.at, a.action, a.details, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type='document' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 100`, [String(d.id)])).rows : [];
    const statement = (await pool.query('SELECT id FROM bank_statements WHERE document_id=$1', [d.id])).rows[0] || null;
    await audit(pool, {userId: user.id, action: 'document.view', entityType: 'document', entityId: d.id});
    return {...d, search_text: undefined, contract_status_effective: contractStatusFor(d, todayVilnius()), files, links, invoices, proposals, extraction, history, statementId: statement?.id || null, deletionBlockers: await deletionBlockers(pool, d.id)};
  });
  r.put('/api/documents/:id', async ({req, user, params}) => { requireCap(user, 'write'); return updateMetadata(pool, user, params.id, await readJson(req)); });
  r.post('/api/documents/:id/versions', async ({req, user, params}) => {
    requireCap(user, 'write');
    const {files, fields} = await readMultipart(req, {maxFileBytes: config.maxUploadBytes, maxFiles: 1});
    if (!files[0]) throw new AppError(400, 'no_file', 'Pasirinkite failą.');
    return uploadVersion(deps, user, params.id, files[0], fields.note || '');
  });
  r.post('/api/documents/:id/links', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    await loadDocumentForUser(pool, user, params.id);
    await loadDocumentForUser(pool, user, b.toDocumentId);
    const rel = ['related', 'contract_invoice', 'replaces', 'attachment'].includes(b.relation) ? b.relation : 'related';
    await pool.query(`INSERT INTO document_links(from_document_id, to_document_id, relation, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [params.id, b.toDocumentId, rel, user.id]);
    await audit(pool, {userId: user.id, action: 'document.link', entityType: 'document', entityId: params.id, details: {to: b.toDocumentId, relation: rel}});
    return {ok: true};
  });
  r.delete('/api/documents/:id', async ({user, params}) => {
    requireCap(user, 'write');
    return tx(pool, async (db) => {
      const d = await loadDocumentForUser(db, user, params.id, {forUpdate: true});
      const blockers = await deletionBlockers(db, d.id);
      if (blockers.length) throw new AppError(409, 'protected', `Dokumento ištrinti negalima: ${blockers.join(' ')} Galite jį archyvuoti.`);
      // Originals are immutable evidence: "deletion" archives and hides; files and audit history remain.
      await db.query(`UPDATE documents SET archived=true, processing_status=CASE WHEN workflow='invoice' THEN 'rejected' ELSE processing_status END, notes=trim(notes || ' [Pašalinta iš sąrašų]'), updated_at=now() WHERE id=$1`, [d.id]);
      await db.query(`UPDATE proposals SET status='rejected', decided_by=$2, decided_at=now(), decision_note='Dokumentas pašalintas' WHERE document_id=$1 AND status='open'`, [d.id, user.id]);
      await audit(db, {userId: user.id, action: 'document.remove', entityType: 'document', entityId: d.id});
      return {ok: true};
    });
  });
  r.post('/api/documents/:id/split', async ({req, user, params}) => splitDocument(pool, storage, user, params.id, (await readJson(req)).ranges));
  r.post('/api/documents/:id/reextract', async ({user, params}) => requestReextract(pool, user, params.id));
  r.post('/api/documents/:id/move-to-vault', async ({req, user, params}) => {
    requireCap(user, 'write');
    const b = await readJson(req);
    return tx(pool, async (db) => {
      const d = await loadDocumentForUser(db, user, params.id, {forUpdate: true});
      if (d.processing_status === 'posted') throw new AppError(409, 'posted', 'Užregistruotas dokumentas lieka registre.');
      const kind = ['proforma', 'contract', 'receipt', 'other'].includes(b.kind) ? b.kind : 'other';
      await db.query(`UPDATE documents SET workflow='vault', kind=$2, processing_status='stored', updated_at=now() WHERE id=$1`, [d.id, kind]);
      await db.query(`UPDATE proposals SET status='rejected', decided_by=$2, decided_at=now(), decision_note='Perkelta į saugyklą' WHERE document_id=$1 AND status='open'`, [d.id, user.id]);
      await audit(db, {userId: user.id, action: 'document.move_to_vault', entityType: 'document', entityId: d.id, details: {kind}});
      return {ok: true};
    });
  });

  // ------------------------------------------------------------ files (controlled downloads)
  r.post('/api/files/:id/link', async ({user, params}) => {
    requireCap(user, 'read');
    const f = (await pool.query('SELECT * FROM stored_files WHERE id=$1', [params.id])).rows[0];
    if (!f) throw new AppError(404, 'not_found', 'Failas nerastas.');
    await loadDocumentForUser(pool, user, f.document_id);
    return {url: `/api/files/${f.id}/content?t=${signDownload(config.secretKey, f.id, user.id)}`};
  });
  r.get('/api/files/:id/content', async ({user, params, query, res}) => {
    requireCap(user, 'read');
    const f = (await pool.query('SELECT * FROM stored_files WHERE id=$1', [params.id])).rows[0];
    if (!f) throw new AppError(404, 'not_found', 'Failas nerastas.');
    await loadDocumentForUser(pool, user, f.document_id);
    if (!checkDownload(config.secretKey, f.id, user.id, query.t)) throw new AppError(403, 'link_expired', 'Atsisiuntimo nuoroda nebegalioja. Atnaujinkite puslapį.');
    const buf = await storage.read(f.storage_key);
    if (f.role === 'original' || f.role === 'generated') await audit(pool, {userId: user.id, action: query.download ? 'file.download' : 'file.view', entityType: 'document', entityId: f.document_id, details: {fileId: f.id, version: f.version}});
    const inline = !query.download && (f.mime.startsWith('image/') || f.mime === 'application/pdf');
    res.writeHead(200, {...SECURITY_HEADERS, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Content-Type': f.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name || `failas-${f.id}`)}`, 'X-Frame-Options': 'SAMEORIGIN'});
    res.end(buf);
  });

  // ------------------------------------------------------------ inbox
  r.get('/api/inbox', async ({user, query}) => {
    requireCap(user, 'read');
    const limit = Math.min(Number(query.limit) || 50, 200), offset = Math.max(Number(query.offset) || 0, 0);
    const where = [`d.workflow='invoice'`, visibilitySql(user)];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.status) add('d.processing_status = ?', query.status); else where.push(`d.processing_status <> 'rejected'`);
    if (query.q) add(`(d.title ILIKE '%' || ? || '%')`, String(query.q).slice(0, 100));
    if (query.from) add('d.created_at >= ?::date', query.from);
    if (query.to) add('d.created_at < ?::date + 1', query.to);
    if (query.register) add(`p.data->>'register' = ?`, query.register);
    const rows = (await pool.query(`SELECT d.id, d.title, d.kind, (SELECT original_name FROM stored_files f WHERE f.document_id=d.id AND f.role='original' ORDER BY version LIMIT 1) AS file_name, d.processing_status, d.processing_error, d.created_at, d.reference_number,
        p.id AS proposal_id, p.version, p.kind AS proposal_kind, p.blocking, p.content_hash, p.data->>'register' AS register, p.data->'counterparty'->>'name' AS counterparty,
        p.data->>'issueDate' AS issue_date, p.validation->'computed'->>'gross' AS gross,
        (SELECT count(*) FROM jsonb_array_elements(p.validation->'issues') x WHERE x->>'level'='error') AS errors,
        (SELECT x->>'message' FROM jsonb_array_elements(p.validation->'issues') x WHERE x->>'level'='error' LIMIT 1) AS first_error,
        (SELECT status FROM jobs j WHERE j.payload->>'documentId' = d.id::text AND j.type='extract_invoice' ORDER BY j.id DESC LIMIT 1) AS job_status
      FROM documents d LEFT JOIN proposals p ON p.document_id=d.id AND p.status='open'
      WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit + 1} OFFSET ${offset}`, params)).rows;
    const counts = (await pool.query(`SELECT processing_status, count(*) AS n FROM documents d WHERE d.workflow='invoice' AND ${visibilitySql(user)} GROUP BY 1`)).rows;
    return {items: rows.slice(0, limit), hasMore: rows.length > limit, counts: Object.fromEntries(counts.map((c) => [c.processing_status, Number(c.n)]))};
  });

  r.get('/api/proposals/:id', async ({user, params}) => {
    requireCap(user, 'read');
    const p = (await pool.query('SELECT * FROM proposals WHERE id=$1', [params.id])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    if (p.document_id) await loadDocumentForUser(pool, user, p.document_id);
    const versions = (await pool.query(`SELECT p.id, p.version, p.status, p.created_at, u.name AS created_by_name FROM proposals p LEFT JOIN users u ON u.id=p.created_by
      WHERE ${p.document_id ? 'p.document_id' : 'p.external_order_id'}=$1 ORDER BY version DESC`, [p.document_id || p.external_order_id])).rows;
    const live = await liveValidation(pool, p);
    return {...p, storedValidation: p.validation, validation: live, blocking: live.blocking ?? p.blocking, versions};
  });
  // Server-side recalculation while editing (no state change).
  r.post('/api/proposals/:id/compute', async ({req, user, params}) => {
    requireCap(user, 'read');
    const p = (await pool.query('SELECT * FROM proposals WHERE id=$1', [params.id])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    if (p.document_id) await loadDocumentForUser(pool, user, p.document_id);
    const b = await readJson(req);
    const ctx = await loadContext(pool);
    const data = {...p.data, ...b.data, provenance: p.data.provenance, splitHint: p.data.splitHint};
    const {computed, issues, blocking} = computeProposal(applyClassification(data, ctx), {...ctx, duplicates: {}});
    return {computed, issues, blocking, note: 'Peržiūra be dublikatų patikros; išsaugojus bus patikrinta visa apimtimi.'};
  });
  r.put('/api/proposals/:id', async ({req, user, params}) => {
    const b = await readJson(req);
    const p = await editProposal(pool, user, params.id, {contentHash: b.contentHash, data: b.data});
    return p;
  });
  r.post('/api/proposals/:id/approve', async ({req, user, params}) => approveProposal(pool, user, params.id, await readJson(req)));
  r.post('/api/proposals/:id/reject', async ({req, user, params}) => rejectProposal(pool, user, params.id, await readJson(req)));
  r.post('/api/proposals/bulk-approve', async ({req, user}) => ({results: await bulkApprove(pool, user, (await readJson(req)).items)}));
  // Explicit, user-initiated rule creation from a reviewed line (never automatic).
  r.post('/api/proposals/:id/rule-from-line', async ({req, user, params}) => {
    requireCap(user, 'rules');
    const b = await readJson(req);
    const p = (await pool.query('SELECT * FROM proposals WHERE id=$1', [params.id])).rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Pasiūlymas nerastas.');
    const line = p.data.lines?.[Number(b.lineIndex)];
    if (!line) throw new AppError(400, 'bad_line', 'Eilutė nerasta.');
    if (!p.data.counterparty?.id && b.scope === 'counterparty') throw new AppError(400, 'no_cp', 'Kontrahentas dar neužregistruotas – taisyklę kurkite po patvirtinimo.');
    return tx(pool, async (db) => saveRule(db, user, {
      name: b.name || `${p.data.counterparty?.name || ''}: ${line.description}`.slice(0, 200), register: p.data.register,
      counterparty_id: b.scope === 'counterparty' ? p.data.counterparty.id : null, match_text: b.matchText ?? '', priority: b.priority || 100,
      effective_from: b.effectiveFrom || p.data.issueDate, effective_to: b.effectiveTo || null,
      account_code: b.accountCode || line.accountCode, line_type: b.lineType || line.lineType, vat_treatment: b.vatTreatment || line.vatTreatment, note: `Sukurta iš pasiūlymo #${p.id} eilutės ${Number(b.lineIndex) + 1}`,
    }));
  });
}
