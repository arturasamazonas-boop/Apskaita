// Upload handling: size/type validation, safety scan, exact-duplicate detection, job enqueue.
import {AppError, tx} from '../db.mjs';
import {requireCap} from '../auth/auth.mjs';
import {detectType, scanFile, SUPPORTED, UNSUPPORTED_EXPLANATIONS, MIME} from './filetypes.mjs';
import {createDocument, addFile, refreshSearch, loadDocumentForUser} from './documents.mjs';
import {enqueue} from '../jobs.mjs';
import {audit} from '../audit.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function uploadFiles({pool, storage, config}, user, files, {workflow = 'invoice', meta = {}} = {}) {
  requireCap(user, 'write');
  if (!['invoice', 'vault', 'bank'].includes(workflow)) throw new AppError(400, 'bad_workflow', 'Netinkamas įkėlimo tipas.');
  const results = [];
  for (const f of files) {
    results.push(await uploadOne({pool, storage, config}, user, f, workflow, meta).catch((e) => ({name: f.name, status: 'error', message: e.message})));
  }
  return results;
}

async function validate({storage, config}, f, workflow) {
  if (f.truncated || f.buffer.length > config.maxUploadBytes) throw new AppError(413, 'too_large', `Failas per didelis (riba ${Math.round(config.maxUploadBytes / 1048576)} MB).`);
  if (!f.buffer.length) throw new AppError(400, 'empty', 'Failas tuščias.');
  const type = await detectType(f.buffer, f.name);
  const allowed = SUPPORTED[workflow];
  if (!allowed[type]) {
    const why = UNSUPPORTED_EXPLANATIONS[type] || `Formatas „${type}“ šiam veiksmui nepalaikomas. Palaikoma: ${Object.values(allowed).join(', ')}.`;
    throw new AppError(415, 'unsupported', why);
  }
  const scan = await scanFile(f.buffer, type, {clamscanPath: config.clamscanPath, tmpWrite: async (buf) => { const d = await storage.tempDir('scan'); const p = path.join(d, 'f'); await fs.writeFile(p, buf); return p; }});
  if (!scan.ok) throw new AppError(422, 'unsafe', scan.problems.join(' '));
  return {type, scan};
}

async function uploadOne({pool, storage, config}, user, f, workflow, meta) {
  const {type, scan} = await validate({storage, config}, f, workflow);
  const name = String(f.name || 'failas').replace(/[\\/\0]/g, '_').slice(0, 200);
  return tx(pool, async (db) => {
    const sha = (await storage.put(f.buffer)).sha256;
    if (workflow !== 'vault') {
      const dup = await db.query(`SELECT f.document_id FROM stored_files f JOIN documents d ON d.id=f.document_id
        WHERE f.sha256=$1 AND f.role='original' AND d.workflow=$2 AND d.processing_status <> 'rejected' LIMIT 1`, [sha, workflow]);
      if (dup.rows[0]) return {name, status: 'duplicate', documentId: dup.rows[0].document_id, message: `Identiškas failas jau įkeltas (dokumentas #${dup.rows[0].document_id}). Naujas įrašas nesukurtas.`};
    }
    const doc = await createDocument(db, {
      kind: workflow === 'bank' ? 'bank_statement' : (meta.kind || 'unknown'), title: meta.title || name.replace(/\.[a-z0-9]+$/i, ''),
      confidentiality: meta.confidentiality || 'normal', tags: meta.tags, notes: meta.notes, reference_number: meta.reference_number,
      counterparty_id: meta.counterparty_id, issue_date: meta.issue_date, start_date: meta.start_date, end_date: meta.end_date,
      contract_value: meta.contract_value, contract_currency: meta.contract_currency, contract_status: meta.contract_status,
      workflow, processing_status: workflow === 'invoice' ? 'uploaded' : 'stored',
    }, user.id);
    const file = await addFile(db, storage, {documentId: doc.id, buffer: f.buffer, mime: MIME[type], originalName: name, role: 'original', userId: user.id, note: scan.antivirus === 'clean' ? 'Antivirusinis patikrinimas: švarus' : ''});
    if (workflow === 'invoice') await enqueue(db, 'extract_invoice', {documentId: doc.id}, {idempotencyKey: `extract:${doc.id}:1`});
    if (workflow === 'vault' && ['pdf', 'docx', 'jpeg', 'png'].includes(type)) await enqueue(db, 'index_document', {documentId: doc.id, fileId: file.id}, {idempotencyKey: `index:${file.id}`, maxAttempts: 3});
    await refreshSearch(db, doc.id);
    return {name, status: 'uploaded', documentId: doc.id, fileId: file.id, format: type, antivirus: scan.antivirus};
  });
}

/** New immutable version of an existing vault document. */
export async function uploadVersion({pool, storage, config}, user, documentId, f, note = '') {
  requireCap(user, 'write');
  const doc = await loadDocumentForUser(pool, user, documentId);
  if (doc.workflow === 'invoice' && doc.processing_status === 'posted') throw new AppError(409, 'posted', 'Užregistruoto dokumento originalas nekeičiamas. Įkelkite naują dokumentą arba koregavimą.');
  const {type} = await validate({storage, config}, f, 'vault');
  return tx(pool, async (db) => {
    const file = await addFile(db, storage, {documentId, buffer: f.buffer, mime: MIME[type], originalName: String(f.name).slice(0, 200), role: 'original', userId: user.id, note: String(note).slice(0, 300)});
    if (['pdf', 'docx', 'jpeg', 'png'].includes(type)) await enqueue(db, 'index_document', {documentId, fileId: file.id}, {idempotencyKey: `index:${file.id}`, maxAttempts: 3});
    return {fileId: file.id, version: file.version};
  });
}

/** Background: extract searchable text (and previews) for vault documents. */
export async function indexVaultDocument({pool, storage, config}, {documentId, fileId}, extractText) {
  const file = (await pool.query('SELECT * FROM stored_files WHERE id=$1 AND document_id=$2', [fileId, documentId])).rows[0];
  if (!file) return {skipped: true};
  const textDoc = await extractText(storage, file, config);
  await tx(pool, async (db) => {
    for (const page of textDoc.pages) {
      await db.query(`INSERT INTO document_pages(document_id, file_id, page, method, text) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (file_id, page) DO UPDATE SET text=EXCLUDED.text`,
        [documentId, file.id, page.page, page.method, page.rows.map((r) => r.text).join('\n')]);
      const have = await db.query(`SELECT 1 FROM stored_files WHERE derived_from_file_id=$1 AND role='preview' AND page=$2`, [file.id, page.page]);
      if (page.image && !have.rowCount) await addFile(db, storage, {documentId, buffer: page.image, mime: 'image/png', originalName: `preview-p${page.page}.png`, role: 'preview', page: page.page, derivedFrom: file.id});
    }
    // Index only the latest version's text for search.
    await db.query(`DELETE FROM document_pages WHERE document_id=$1 AND file_id<>$2`, [documentId, file.id]);
    await refreshSearch(db, documentId);
    await audit(db, {actor: 'system', action: 'document.indexed', entityType: 'document', entityId: documentId, details: {fileId: file.id, pages: textDoc.pages.length}});
  });
  return {pages: textDoc.pages.length};
}
