// i.SAF 1.2 XML export (VMI). Structure follows vendor/isaf/isaf_1.2.xsd (see docs/ISAF.md for provenance).
// Exporting is NOT submitting: the file must be uploaded to VMI i.SAF by the user.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../config.mjs';
import {money} from '../lib/money.mjs';
import {normalizeVat} from '../extraction/ids.mjs';

const run = promisify(execFile);
export const XSD_PATH = path.join(ROOT, 'vendor/isaf/isaf_1.2.xsd');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const TYPE = {vat_invoice: 'SF', credit_note: 'KS', debit_note: 'DS'};
const rate = (r) => (r === null || r === undefined ? null : String(Number(r)));

function partyXml(tag, p) {
  const vat = normalizeVat(p.vatCode) || 'ND';
  const nd = vat === 'ND';
  return `<${tag}>` +
    `<VATRegistrationNumber>${esc(vat)}</VATRegistrationNumber>` +
    (nd || p.companyCode ? `<RegistrationNumber>${esc(p.companyCode || 'ND')}</RegistrationNumber>` : '') +
    (p.country ? `<Country>${esc(p.country)}</Country>` : '<Country xsi:nil="true"/>') +
    `<Name>${esc(String(p.name || 'ND').slice(0, 256))}</Name>` +
    `</${tag}>`;
}

/** Collect register data; corrections are merged into the corrected invoice's totals. */
async function loadInvoices(db, register, from, to) {
  const rows = (await db.query(`SELECT i.*, (i.approved_at AT TIME ZONE 'Europe/Vilnius')::date AS registered_on FROM invoices i
    WHERE i.register=$1 AND i.issue_date BETWEEN $2 AND $3 AND i.doc_type <> 'correction' ORDER BY i.issue_date, i.id`, [register, from, to])).rows;
  const ids = rows.map((r) => r.id);
  const vat = ids.length ? (await db.query(`SELECT CASE WHEN c.doc_type='correction' THEN c.related_invoice_id ELSE v.invoice_id END AS root, v.tax_code, v.isaf_code, v.rate, sum(v.taxable) AS taxable, sum(v.vat) AS vat
    FROM invoice_vat_rows v JOIN invoices c ON c.id=v.invoice_id
    WHERE v.invoice_id = ANY($1) OR (c.doc_type='correction' AND c.related_invoice_id = ANY($1)) GROUP BY 1,2,3,4`, [ids])).rows : [];
  const related = ids.length ? (await db.query(`SELECT r.id, r.series, r.number, r.issue_date FROM invoices r WHERE r.id IN (SELECT related_invoice_id FROM invoices WHERE id = ANY($1))`, [ids])).rows : [];
  return rows.map((r) => ({...r, vat: vat.filter((v) => String(v.root) === String(r.id)), relatedInvoice: related.find((x) => String(x.id) === String(r.related_invoice_id)) || null}));
}

export async function buildIsaf(db, {from, to, dataType = 'F', now = new Date(), softwareVersion = '0.1.0'}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw Object.assign(new Error('Netinkamas laikotarpis.'), {status: 400});
  if (!['F', 'S', 'P'].includes(dataType)) throw Object.assign(new Error('Netinkamas duomenų tipas.'), {status: 400});
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const errors = [], warnings = [], excluded = [];
  if (!/^\d{1,11}$/.test(company.company_code || '')) errors.push({scope: 'company', message: 'Įmonės kodas (RegistrationNumber) privalomas ir turi būti iki 11 skaitmenų (Nustatymai → Įmonė).'});
  if (!company.vat_registered) warnings.push({scope: 'company', message: 'Įmonė pažymėta kaip ne PVM mokėtoja – i.SAF teikia PVM mokėtojai.'});
  const sections = [];
  const summary = {};
  for (const register of ['purchase', 'sales']) { // XSD order: PurchaseInvoices, SalesInvoices
    if ((register === 'sales' && dataType === 'P') || (register === 'purchase' && dataType === 'S')) continue;
    const invoices = await loadInvoices(db, register, from, to);
    const xmlInvoices = [];
    let taxable = '0.00', vatSum = '0.00';
    for (const inv of invoices) {
      const label = `${inv.series} ${inv.number}`.trim();
      const docErr = (m) => errors.push({scope: 'invoice', invoiceId: inv.id, label, register, message: m});
      if (!TYPE[inv.doc_type]) { excluded.push({invoiceId: inv.id, label, register, reason: inv.doc_type === 'invoice' ? 'Ne PVM sąskaita faktūra (be PVM) – į i.SAF neįtraukiama.' : `Tipas ${inv.doc_type} neįtraukiamas.`}); continue; }
      const cp = inv.counterparty_snapshot || {};
      const no = `${inv.series || ''}${inv.number}`.replace(/\s+/g, '');
      if (!no) docErr('Nėra sąskaitos numerio.');
      if (no.length > 70) docErr('Sąskaitos numeris ilgesnis nei 70 simbolių.');
      if (!cp.name) warnings.push({scope: 'invoice', invoiceId: inv.id, label, register, message: 'Nenurodytas kontrahento pavadinimas – bus įrašyta ND.'});
      if (!normalizeVat(cp.vatCode) && !cp.companyCode && register === 'purchase') warnings.push({scope: 'invoice', invoiceId: inv.id, label, register, message: 'Tiekėjas be PVM ir įmonės kodo – bus įrašyta ND.'});
      if (inv.doc_type === 'credit_note' && !inv.relatedInvoice) docErr('Kreditinė sąskaita nesusieta su koreguojama sąskaita (reikalinga nuoroda References).');
      if (!inv.vat.length) docErr('Nėra PVM eilučių.');
      const totals = [];
      for (const v of inv.vat) {
        if (v.tax_code === 'BE_PVM') { docErr('Eilutė „be PVM“ PVM sąskaitoje – nurodykite PVM klasifikatoriaus kodą.'); continue; }
        if (!/^PVM\d{1,3}$/.test(v.isaf_code || v.tax_code)) docErr(`Netinkamas PVM kodas ${v.tax_code}.`);
        totals.push(`<DocumentTotal><TaxableValue>${money.norm(v.taxable)}</TaxableValue><TaxCode>${esc(v.isaf_code || v.tax_code)}</TaxCode>` +
          (rate(v.rate) === null ? '<TaxPercentage xsi:nil="true"/>' : `<TaxPercentage>${rate(v.rate)}</TaxPercentage>`) +
          `<Amount>${money.norm(v.vat)}</Amount>${register === 'sales' ? '<VATPointDate2 xsi:nil="true"/>' : ''}</DocumentTotal>`);
        taxable = money.add(taxable, v.taxable); vatSum = money.add(vatSum, v.vat);
      }
      // Cross-check: register totals equal invoice totals (incl. corrections).
      const groupNet = money.sum(inv.vat.map((v) => v.taxable));
      const corr = (await db.query(`SELECT coalesce(sum(net_total),0) AS n FROM invoices WHERE (id=$1) OR (related_invoice_id=$1 AND doc_type='correction')`, [inv.id])).rows[0].n;
      if (!money.eq(groupNet, corr)) docErr(`PVM eilučių apmokestinamoji vertė ${groupNet} nesutampa su sąskaitos suma ${corr}.`);
      const refs = inv.relatedInvoice ? `<References><Reference><ReferenceNo>${esc(`${inv.relatedInvoice.series}${inv.relatedInvoice.number}`.replace(/\s+/g, ''))}</ReferenceNo><ReferenceDate>${inv.relatedInvoice.issue_date}</ReferenceDate></Reference></References>` : '<References/>';
      const vpd = inv.vat_point_date && inv.vat_point_date !== inv.issue_date && inv.vat_point_date >= '2016-07-01' ? `<VATPointDate>${inv.vat_point_date}</VATPointDate>` : '<VATPointDate xsi:nil="true"/>';
      if (register === 'sales') {
        xmlInvoices.push(`<Invoice><InvoiceNo>${esc(no)}</InvoiceNo>${partyXml('CustomerInfo', cp)}<InvoiceDate>${inv.issue_date}</InvoiceDate><InvoiceType>${TYPE[inv.doc_type]}</InvoiceType><SpecialTaxation/>${refs}${vpd}<DocumentTotals>${totals.join('')}</DocumentTotals></Invoice>`);
      } else {
        xmlInvoices.push(`<Invoice><InvoiceNo>${esc(no)}</InvoiceNo>${partyXml('SupplierInfo', cp)}<InvoiceDate>${inv.issue_date}</InvoiceDate><InvoiceType>${TYPE[inv.doc_type]}</InvoiceType><SpecialTaxation/>${refs}${vpd}<RegistrationAccountDate>${inv.registered_on}</RegistrationAccountDate><DocumentTotals>${totals.join('')}</DocumentTotals></Invoice>`);
      }
    }
    summary[register] = {invoices: xmlInvoices.length, taxable, vat: vatSum};
    if (xmlInvoices.length) sections.push(register === 'sales' ? `<SalesInvoices>${xmlInvoices.join('')}</SalesInvoices>` : `<PurchaseInvoices>${xmlInvoices.join('')}</PurchaseInvoices>`);
  }
  const created = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vilnius', dateStyle: 'short', timeStyle: 'medium'}).format(now).replace(' ', 'T');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<iSAFFile xmlns="http://www.vmi.lt/cms/imas/isaf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<Header><FileDescription><FileVersion>iSAF1.2</FileVersion><FileDateCreated>${created}</FileDateCreated><DataType>${dataType}</DataType>` +
    `<SoftwareCompanyName>Apskaita</SoftwareCompanyName><SoftwareName>Apskaita</SoftwareName><SoftwareVersion>${esc(softwareVersion)}</SoftwareVersion>` +
    `<RegistrationNumber>${esc(company.company_code || '0')}</RegistrationNumber><NumberOfParts>1</NumberOfParts><PartNumber>1</PartNumber>` +
    `<SelectionCriteria><SelectionStartDate>${from}</SelectionStartDate><SelectionEndDate>${to}</SelectionEndDate></SelectionCriteria></FileDescription></Header>` +
    (sections.length ? `<SourceDocuments>${sections.join('')}</SourceDocuments>` : '') + `</iSAFFile>\n`;
  return {xml, errors, warnings, excluded, summary};
}

/** Validate against the XSD with xmllint (libxml2). */
export async function validateXsd(xml, tmpDir) {
  await fs.mkdir(tmpDir, {recursive: true});
  const f = path.join(tmpDir, `isaf-${process.pid}-${Date.now()}.xml`);
  await fs.writeFile(f, xml);
  try {
    await run('xmllint', ['--noout', '--schema', XSD_PATH, f], {timeout: 60000});
    return {valid: true, messages: []};
  } catch (e) {
    if (e.code === 'ENOENT') return {valid: null, messages: ['xmllint neįdiegtas – XSD patikra neatlikta.']};
    return {valid: false, messages: String(e.stderr || e.message).split('\n').filter(Boolean).map((l) => l.replace(f, 'isaf.xml')).slice(0, 50)};
  } finally {
    await fs.rm(f, {force: true});
  }
}
