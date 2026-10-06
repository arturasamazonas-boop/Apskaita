// File type detection by content (magic bytes), not by name, plus safety checks.
import JSZip from 'jszip';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);

export const SUPPORTED = {
  invoice: {
    pdf: 'PDF (skaitmeninis arba skenuotas)',
    docx: 'Word DOCX',
    jpeg: 'JPG nuotrauka / skenas',
    png: 'PNG nuotrauka / skenas',
  },
  bank: {
    csv: 'CSV (su stulpelių susiejimu)',
    xlsx: 'Excel XLSX (su stulpelių susiejimu)',
    camt053: 'ISO 20022 CAMT.053 XML (camt.053.001.02–.08)',
    mt940: 'SWIFT MT940',
    pdf: 'PDF išrašas (atsarginis būdas, reikia peržiūros)',
    jpeg: 'JPG išrašo nuotrauka (OCR, reikia peržiūros)',
    png: 'PNG išrašo nuotrauka (OCR, reikia peržiūros)',
  },
  vault: {
    pdf: 'PDF', docx: 'Word DOCX', xlsx: 'Excel XLSX', jpeg: 'JPG', png: 'PNG', txt: 'Tekstas', csv: 'CSV', xml: 'XML',
  },
};

export const UNSUPPORTED_EXPLANATIONS = {
  doc: 'Senas Word .doc formatas nepalaikomas (saugus konvertavimas neįdiegtas). Išsaugokite dokumentą kaip DOCX arba PDF ir įkelkite dar kartą.',
  xls: 'Senas Excel .xls formatas nepalaikomas. Išsaugokite kaip XLSX arba CSV.',
  heic: 'HEIC nuotraukos nepalaikomos. Nustatykite telefoną fotografuoti JPG formatu arba konvertuokite į JPG.',
  zip: 'ZIP archyvai nepriimami. Išskleiskite ir įkelkite failus atskirai.',
  rtf: 'RTF nepalaikomas. Išsaugokite kaip DOCX arba PDF.',
  odt: 'ODT nepalaikomas. Išsaugokite kaip DOCX arba PDF.',
  unknown: 'Failo tipas neatpažintas. Palaikomi formatai nurodyti sąraše.',
};

export const MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpeg: 'image/jpeg', png: 'image/png',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml', camt053: 'application/xml', mt940: 'text/plain; charset=utf-8',
};

export async function detectType(buf, name = '') {
  const head = buf.subarray(0, 8);
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return ext === 'xls' ? 'xls' : 'doc';
  if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (head.subarray(4, 12).toString('latin1').startsWith('ftyphei') || head.subarray(4, 12).toString('latin1').startsWith('ftypmif')) return 'heic';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    try {
      const zip = await JSZip.loadAsync(buf, {checkCRC32: false});
      if (zip.file('word/document.xml')) return 'docx';
      if (zip.file('xl/workbook.xml')) return 'xlsx';
      if (zip.file('content.xml')) return 'odt';
    } catch { /* not a valid zip */ }
    return 'zip';
  }
  // Text formats.
  if (buf.subarray(0, 4096).includes(0)) return 'unknown';
  const sample = buf.subarray(0, 4096).toString('utf8');
  const t = sample.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<?xml') || t.startsWith('<Document')) return /camt\.053/.test(sample) ? 'camt053' : 'xml';
  if (/^:20:/m.test(t) && /^:60[FM]:/m.test(t)) return 'mt940';
  if (/^\{1:/.test(t) && /:60[FM]:/.test(sample)) return 'mt940';
  if (ext === 'csv' || /[;,\t]/.test(t.split(/\r?\n/)[0] || '')) return ext === 'txt' ? 'txt' : 'csv';
  if (ext === 'txt') return 'txt';
  return 'unknown';
}

/** Structural safety checks. Optional ClamAV scan when CLAMSCAN_PATH is configured. */
export async function scanFile(buf, type, {clamscanPath = '', tmpWrite} = {}) {
  const problems = [];
  if (type === 'pdf') {
    const s = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch)\b/.test(s)) problems.push('PDF turi vykdomo turinio (JavaScript/Launch) – failas atmestas saugumo sumetimais.');
    if (/\/EmbeddedFile\b/.test(s)) problems.push('PDF turi įterptų failų – failas atmestas saugumo sumetimais.');
    if (/\/Encrypt\b/.test(s)) problems.push('PDF užšifruotas slaptažodžiu – pašalinkite apsaugą ir įkelkite iš naujo.');
  }
  if (type === 'docx' || type === 'xlsx') {
    const zip = await JSZip.loadAsync(buf);
    let total = 0, n = 0;
    for (const f of Object.values(zip.files)) {
      n++;
      total += f._data?.uncompressedSize || 0;
      if (/vbaProject\.bin$/i.test(f.name) || /\.(exe|dll|js|vbs|bat|cmd)$/i.test(f.name)) problems.push(`Archyve rastas vykdomas turinys (${f.name}).`);
    }
    if (n > 3000) problems.push('Per daug failų dokumento archyve.');
    if (total > 150 * 1024 * 1024 || (buf.length > 0 && total / buf.length > 200)) problems.push('Įtartinai didelis išskleistas dydis (galima „zip bomba“).');
  }
  if (type === 'png' && buf.length > 24) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w * h > 120e6) problems.push('Paveikslėlis per didelis apdorojimui.');
  }
  let antivirus = 'not_configured';
  if (clamscanPath && tmpWrite) {
    const file = await tmpWrite(buf);
    try {
      await run(clamscanPath, ['--no-summary', file], {timeout: 120000});
      antivirus = 'clean';
    } catch (e) {
      if (e.code === 1) { antivirus = 'infected'; problems.push('Antivirusinė programa aptiko kenkėjišką turinį.'); } else antivirus = 'error';
    }
  }
  return {ok: problems.length === 0, problems, antivirus};
}
