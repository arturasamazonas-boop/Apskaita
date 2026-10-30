// Manual invoices, credit notes and generated PDFs.
import {requireCap} from '../auth/auth.mjs';
import {readJson} from '../http.mjs';
import {AppError} from '../db.mjs';
import {createManualInvoice, createCreditNote} from '../sales/service.mjs';
import {signDownload} from '../vault/documents.mjs';
import {salesInvoiceForUser} from '../sales/service.mjs';
import {listRecurring, saveRecurring, generateRecurring} from '../sales/recurring.mjs';
import {todayVilnius} from '../invoices/context.mjs';
import {emailDraft, sendInvoiceEmail, emailConfigured} from '../sales/email.mjs';
import {startCorrection, annulInvoice} from '../sales/edit.mjs';

export function register(r, {pool, config, storage}) {
  r.post('/api/manual-invoices', async ({req, user}) => createManualInvoice(pool, user, await readJson(req)));
  r.get('/api/recurring-invoices', async ({user}) => listRecurring(pool, user));
  r.post('/api/recurring-invoices', async ({req, user}) => saveRecurring(pool, user, null, await readJson(req)));
  r.put('/api/recurring-invoices/:id', async ({req, user, params}) => saveRecurring(pool, user, params.id, await readJson(req)));
  r.post('/api/recurring-invoices/generate', async ({req, user}) => { const b = await readJson(req); const today = todayVilnius(); const asOf = /^\d{4}-\d{2}-\d{2}$/.test(b.asOf || '') && b.asOf < today ? b.asOf : today; return generateRecurring(pool, user, {asOf, id: b.id || null}); }); // never ahead of today: an invoice cannot be dated in the future
  r.get('/api/invoices/:id/email', async ({user, params}) => {
    requireCap(user, 'read');
    await salesInvoiceForUser(pool, user, params.id);
    const d = await emailDraft(pool, params.id);
    return {to: d.to, subject: d.subject, text: d.text, history: d.history, configured: emailConfigured(config)};
  });
  r.post('/api/invoices/:id/email', async ({req, user, params}) => {
    await salesInvoiceForUser(pool, user, params.id);
    return sendInvoiceEmail({pool, storage, config}, user, params.id, await readJson(req));
  });
  r.post('/api/invoices/:id/correct', async ({user, params}) => { await salesInvoiceForUser(pool, user, params.id); return startCorrection(pool, user, params.id); });
  r.post('/api/invoices/:id/annul', async ({req, user, params}) => { await salesInvoiceForUser(pool, user, params.id); return annulInvoice(pool, user, params.id, await readJson(req)); });
  r.post('/api/invoices/:id/credit-note', async ({req, user, params}) => createCreditNote(pool, user, params.id, await readJson(req)));
  r.get('/api/invoices/:id/pdf-link', async ({user, params}) => {
    requireCap(user, 'read');
    const inv = await salesInvoiceForUser(pool, user, params.id);
    const f = (await pool.query(`SELECT id FROM stored_files WHERE document_id=$1 AND role IN ('generated','original') ORDER BY (role='generated') DESC, version DESC, id DESC LIMIT 1`, [inv.document_id])).rows[0];
    if (!f) throw new AppError(404, 'not_ready', 'PDF dar generuojamas – pabandykite po kelių sekundžių.');
    return {url: `/api/files/${f.id}/content?t=${signDownload(config.secretKey, f.id, user.id)}`};
  });
}
