// Sending an issued sales invoice to the buyer by e-mail, with the invoice PDF attached.
// Uses an HTTPS e-mail API (Resend or Brevo), so it also works on hosts that block outgoing SMTP.
// Without a configured service the page offers to download the PDF and open the user's own e-mail program.
import {AppError} from '../db.mjs';
import {audit} from '../audit.mjs';
import {requireCap} from '../auth/auth.mjs';
import {money} from '../lib/money.mjs';

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/;

export function emailConfigured(config) { return !!(config.emailProvider && config.emailApiKey && config.emailFrom); }

/** Recipient, subject and text proposed for an invoice. */
export async function emailDraft(db, invoiceId) {
  const inv = (await db.query(`SELECT i.*, c.email AS cp_email FROM invoices i LEFT JOIN counterparties c ON c.id=i.counterparty_id WHERE i.id=$1 AND i.register='sales'`, [invoiceId])).rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Pardavimo sąskaita nerasta.');
  const company = (await db.query('SELECT name, email, phone FROM company_settings WHERE id=1')).rows[0];
  const no = `${inv.series} ${inv.number}`.trim();
  const sent = (await db.query(`SELECT recipients, status, sent_at, error FROM invoice_emails WHERE invoice_id=$1 ORDER BY id DESC LIMIT 10`, [inv.id])).rows;
  return {
    invoice: inv, to: inv.cp_email || '', subject: `${inv.doc_type === 'credit_note' ? 'Kreditinė sąskaita' : 'Sąskaita faktūra'} ${no}`,
    text: `Laba diena,\n\nsiunčiame ${inv.doc_type === 'credit_note' ? 'kreditinę sąskaitą' : 'sąskaitą faktūrą'} ${no} (${money.norm(inv.gross_total).replace('.', ',')} ${inv.currency})${inv.due_date && inv.doc_type !== 'credit_note' ? `, apmokėti iki ${inv.due_date}` : ''}.\nSąskaita pridėta PDF formatu.\n\nPagarbiai\n${company.name}${company.phone ? `\n${company.phone}` : ''}${company.email ? `\n${company.email}` : ''}`,
    history: sent,
  };
}

async function invoicePdf(db, storage, inv) {
  const f = (await db.query(`SELECT * FROM stored_files WHERE document_id=$1 AND role IN ('generated','original') ORDER BY (role='generated') DESC, version DESC, id DESC LIMIT 1`, [inv.document_id])).rows[0];
  if (!f) throw new AppError(409, 'not_ready', 'Sąskaitos PDF dar generuojamas – pabandykite po kelių sekundžių.');
  return {name: `${inv.series}${inv.number}.pdf`.replace(/[^\w.-]/g, '_'), content: (await storage.read(f.storage_key)).toString('base64')};
}

async function deliver(config, {to, cc, subject, text, attachment, replyTo}) {
  const fetchJson = async (url, headers, body) => {
    const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json', ...headers}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(`${config.emailProvider} ${r.status}: ${j.message || j.error || t.slice(0, 200)}`);
    return j;
  };
  if (config.emailProvider === 'resend') {
    const j = await fetchJson(`${config.emailApiUrl || 'https://api.resend.com'}/emails`, {authorization: `Bearer ${config.emailApiKey}`},
      {from: config.emailFrom, to, ...(cc.length && {cc}), ...(replyTo && {reply_to: replyTo}), subject, text, attachments: [{filename: attachment.name, content: attachment.content}]});
    return j.id || '';
  }
  const m = /^(.*)<([^>]+)>\s*$/.exec(config.emailFrom);
  const j = await fetchJson(`${config.emailApiUrl || 'https://api.brevo.com'}/v3/smtp/email`, {'api-key': config.emailApiKey},
    {sender: m ? {name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim()} : {email: config.emailFrom}, to: to.map((email) => ({email})), ...(cc.length && {cc: cc.map((email) => ({email}))}),
      ...(replyTo && {replyTo: {email: replyTo}}), subject, textContent: text, attachment: [{name: attachment.name, content: attachment.content}]});
  return j.messageId || '';
}

export async function sendInvoiceEmail({pool, storage, config}, user, invoiceId, b) {
  requireCap(user, 'write');
  if (!emailConfigured(config)) throw new AppError(422, 'email_not_configured', 'Laiškų siuntimas nenustatytas (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM). Atsisiųskite PDF ir išsiųskite savo pašto programa.');
  const list = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const to = list(b.to), cc = list(b.cc);
  if (!to.length || to.length > 5 || cc.length > 5 || [...to, ...cc].some((x) => !EMAIL_RE.test(x))) throw new AppError(400, 'email', 'Nurodykite teisingą gavėjo el. pašto adresą (iki 5).');
  const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const text = String(b.text || '').slice(0, 5000);
  if (!subject) throw new AppError(400, 'subject', 'Įrašykite laiško temą.');
  const draft = await emailDraft(pool, invoiceId);
  const inv = draft.invoice;
  const attachment = await invoicePdf(pool, storage, inv);
  const company = (await pool.query('SELECT email FROM company_settings WHERE id=1')).rows[0];
  let providerId = '', error = '';
  try { providerId = await deliver(config, {to, cc, subject, text, attachment, replyTo: EMAIL_RE.test(company.email || '') ? company.email : ''}); } catch (e) { error = e.message.slice(0, 500); }
  await pool.query(`INSERT INTO invoice_emails(invoice_id, recipients, subject, provider, status, provider_id, error, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [inv.id, [...to, ...cc.map((x) => `cc:${x}`)].join(', '), subject, config.emailProvider, error ? 'failed' : 'sent', String(providerId).slice(0, 200), error, user.id]);
  await audit(pool, {userId: user.id, action: error ? 'invoice.email_failed' : 'invoice.email', entityType: 'invoice', entityId: inv.id, details: {to, cc, subject, error: error || undefined}});
  // Remember the buyer's address for the next invoice.
  if (!error && inv.counterparty_id) await pool.query(`UPDATE counterparties SET email=$2 WHERE id=$1 AND coalesce(email,'')=''`, [inv.counterparty_id, to[0]]);
  if (error) throw new AppError(502, 'email_failed', `Laiško išsiųsti nepavyko: ${error}`);
  return {ok: true, to, providerId};
}
