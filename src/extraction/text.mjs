// Text layer extraction with provenance. Produces a uniform TextDoc:
// {pages:[{page, width, height, method, image?:Buffer, rows:[Row]}]}
// Row = {text, bbox:[x0,y0,x1,y1] (0..1 page-relative), segments:[Seg], words:[Word], source}
// Seg = {text, bbox, words, col?}; Word = {text, bbox, conf?}
// Tools: poppler (pdftotext/pdftoppm/pdfinfo), ImageMagick (convert), Tesseract OCR.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {XMLParser} from 'fast-xml-parser';

const run = promisify(execFile);
// OCR_TIMEOUT_MS scales all tool timeouts for slow hosts (e.g. shared/free CPUs). Default 240 s per step.
const OCR_TIMEOUT = Math.max(30000, Number(process.env.OCR_TIMEOUT_MS || 240000));
const exec = (cmd, args, opts = {}) => run(cmd, args, {maxBuffer: 64 * 1024 * 1024, ...opts, timeout: Math.max(opts.timeout || 0, OCR_TIMEOUT)});

export const OCR_PROVIDER = {name: 'tesseract', scoreMeaning: 'Tesseract žodžio atpažinimo patikimumas 0–100 (ne tikimybė, kad reikšmė teisinga)'};

const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Group words into visual rows by vertical overlap, then split rows into segments by horizontal gaps. */
export function wordsToRows(words, {gapFactor = 1.4} = {}) {
  const ws = words.filter((w) => w.text.trim()).map((w) => ({...w, cy: (w.bbox[1] + w.bbox[3]) / 2, h: w.bbox[3] - w.bbox[1]}));
  ws.sort((a, b) => a.cy - b.cy || a.bbox[0] - b.bbox[0]);
  const rows = [];
  for (const w of ws) {
    const row = rows.find((r) => Math.abs(r.cy - w.cy) < Math.max(r.h, w.h) * 0.5);
    if (row) { row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + w.cy) / row.words.length; row.h = Math.max(row.h, w.h); } else rows.push({cy: w.cy, h: w.h, words: [w]});
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((r) => {
    r.words.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const segs = [];
    let cur = null;
    for (const w of r.words) {
      const charW = (w.bbox[2] - w.bbox[0]) / Math.max(w.text.length, 1);
      if (cur && w.bbox[0] - cur.bbox[2] < Math.max(charW, r.h * 0.45) * gapFactor) {
        cur.words.push(w); cur.text += ' ' + w.text; cur.bbox[2] = Math.max(cur.bbox[2], w.bbox[2]);
        cur.bbox[1] = Math.min(cur.bbox[1], w.bbox[1]); cur.bbox[3] = Math.max(cur.bbox[3], w.bbox[3]);
      } else { cur = {text: w.text, bbox: [...w.bbox], words: [w]}; segs.push(cur); }
    }
    const words = r.words.map(({cy, h, ...w}) => w);
    const bbox = [Math.min(...words.map((w) => w.bbox[0])), Math.min(...words.map((w) => w.bbox[1])), Math.max(...words.map((w) => w.bbox[2])), Math.max(...words.map((w) => w.bbox[3]))];
    return {text: segs.map((s) => s.text).join('  '), bbox, segments: segs.map((s) => ({...s, words: s.words.map(({cy, h, ...w}) => w)})), words};
  });
}

async function pdfPageCount(file) {
  const {stdout} = await exec('pdfinfo', [file]);
  const m = /Pages:\s+(\d+)/.exec(stdout);
  return m ? Number(m[1]) : 1;
}

/** Native PDF text with word boxes via pdftotext -bbox. */
async function pdfWords(file) {
  const {stdout} = await exec('pdftotext', ['-bbox', file, '-']);
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let m;
  while ((m = pageRe.exec(stdout))) {
    const W = Number(m[1]), H = Number(m[2]);
    const words = [];
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    let w;
    while ((w = wordRe.exec(m[3]))) words.push({text: decodeEntities(w[5]), bbox: [Number(w[1]) / W, Number(w[2]) / H, Number(w[3]) / W, Number(w[4]) / H]});
    pages.push({width: W, height: H, words});
  }
  return pages;
}

/** Correct orientation (Tesseract OSD) and skew (ImageMagick deskew), then OCR to TSV. */
export async function ocrImage(imgPath, workDir, {languages = 'lit+eng', label = 'p'} = {}) {
  const pre = path.join(workDir, `${label}-pre.png`);
  await exec('convert', [imgPath, '-auto-orient', '-colorspace', 'Gray', '-background', 'white', '-deskew', '40%', '+repage', '-strip', pre]);
  let rotate = 0, osdNote = '';
  try {
    const {stdout, stderr} = await exec('tesseract', [pre, '-', '--psm', '0'], {timeout: 60000});
    const out = stdout + stderr;
    const r = /Rotate:\s*(\d+)/.exec(out), c = /Orientation confidence:\s*([\d.]+)/.exec(out);
    if (r && Number(r[1]) && c && Number(c[1]) >= 1.5) rotate = Number(r[1]);
    osdNote = r ? `OSD rotate=${r[1]} confidence=${c ? c[1] : '?'}` : '';
  } catch (e) { osdNote = 'OSD nepavyko (per mažai teksto)'; }
  let finalImg = pre;
  if (rotate) {
    finalImg = path.join(workDir, `${label}-rot.png`);
    await exec('convert', [pre, '-rotate', String(rotate), '+repage', finalImg]);
  }
  const {stdout: dims} = await exec('identify', ['-format', '%w %h', finalImg]);
  const [W, H] = dims.trim().split(/\s+/).map(Number);
  const outBase = path.join(workDir, `${label}-ocr`);
  await exec('tesseract', [finalImg, outBase, '-l', languages, '--psm', '3', 'tsv'], {timeout: 240000});
  const tsv = await fs.readFile(outBase + '.tsv', 'utf8');
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5' || !c[11].trim()) continue;
    const [left, top, width, height, conf] = [c[6], c[7], c[8], c[9], c[10]].map(Number);
    words.push({text: c[11], bbox: [left / W, top / H, (left + width) / W, (top + height) / H], conf: Math.round(conf)});
  }
  return {words, width: W, height: H, image: await fs.readFile(finalImg), rotate, deskewed: true, osdNote};
}

export async function extractPdf(file, workDir, opts = {}) {
  const n = await pdfPageCount(file);
  if (n > (opts.maxPages || 60)) throw new Error(`PDF turi per daug puslapių (${n}). Padalinkite failą.`);
  const native = await pdfWords(file);
  const pages = [];
  for (let i = 0; i < n; i++) {
    const p = native[i] || {words: [], width: 595, height: 842};
    const textChars = p.words.reduce((s, w) => s + w.text.length, 0);
    const prefix = path.join(workDir, `page${i + 1}`);
    if (textChars >= 25) {
      await exec('pdftoppm', ['-r', '110', '-png', '-singlefile', '-f', String(i + 1), '-l', String(i + 1), file, prefix]);
      pages.push({page: i + 1, width: p.width, height: p.height, method: 'pdf-text', rows: wordsToRows(p.words), image: await fs.readFile(prefix + '.png')});
    } else {
      await exec('pdftoppm', ['-r', '300', '-png', '-singlefile', '-f', String(i + 1), '-l', String(i + 1), file, prefix + '-hi']);
      const o = await ocrImage(prefix + '-hi.png', workDir, {languages: opts.languages, label: `p${i + 1}`});
      pages.push({page: i + 1, width: o.width, height: o.height, method: 'ocr', rows: wordsToRows(o.words), image: await shrink(o.image, workDir, `p${i + 1}`), ocr: {rotate: o.rotate, deskewed: o.deskewed, note: o.osdNote}});
    }
  }
  return {pages};
}

async function shrink(buf, workDir, label) {
  const src = path.join(workDir, `${label}-full.png`), dst = path.join(workDir, `${label}-view.png`);
  await fs.writeFile(src, buf);
  await exec('convert', [src, '-resize', '1400x1400>', dst]);
  return fs.readFile(dst);
}

export async function extractImage(file, workDir, opts = {}) {
  const o = await ocrImage(file, workDir, {languages: opts.languages, label: 'img'});
  return {pages: [{page: 1, width: o.width, height: o.height, method: 'ocr', rows: wordsToRows(o.words), image: await shrink(o.image, workDir, 'img'), ocr: {rotate: o.rotate, deskewed: o.deskewed, note: o.osdNote}}]};
}

/** DOCX: paragraphs and tables in body order. Provenance = paragraph index or table/row/cell. */
export async function extractDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  const parser = new XMLParser({ignoreAttributes: false, preserveOrder: true, trimValues: false});
  const tree = parser.parse(xml);
  const find = (nodes, name) => (nodes || []).find((n) => n[name])?.[name];
  const doc = find(tree, 'w:document');
  const body = find(doc, 'w:body') || [];
  const textOf = (nodes) => {
    let s = '';
    for (const n of nodes || []) {
      const k = Object.keys(n).find((x) => x !== ':@');
      if (k === 'w:t') s += (n[k] || []).map((t) => t['#text'] ?? '').join('');
      else if (k === 'w:tab') s += '\t';
      else if (k === 'w:br' || k === 'w:cr') s += '\n';
      else if (k === 'w:p') s += (s && !s.endsWith('\n') ? '\n' : '') + textOf(n[k]);
      else if (k && Array.isArray(n[k]) && k !== 'w:instrText' && k !== 'w:delText') s += textOf(n[k]);
    }
    return s;
  };
  const rows = [];
  let pIdx = 0, tIdx = 0;
  for (const n of body) {
    const k = Object.keys(n).find((x) => x !== ':@');
    if (k === 'w:p') {
      pIdx++;
      for (const part of textOf(n[k]).split('\n')) {
        const text = part.replace(/\t+/g, '  ').trim();
        if (text) rows.push({text, segments: part.split(/\t+/).map((t) => t.trim()).filter(Boolean).map((t) => ({text: t})), source: {kind: 'docx-paragraph', paragraph: pIdx}});
      }
    } else if (k === 'w:tbl') {
      tIdx++;
      let rIdx = 0;
      for (const tr of n[k].filter((x) => x['w:tr'])) {
        rIdx++;
        const cells = tr['w:tr'].filter((x) => x['w:tc']).map((tc, cIdx) => ({text: textOf(tc['w:tc']).replace(/\s*\n\s*/g, ' ').trim(), col: cIdx, source: {kind: 'docx-table', table: tIdx, row: rIdx, cell: cIdx + 1}}));
        const nonEmpty = cells.filter((c) => c.text);
        if (!nonEmpty.length) continue;
        rows.push({text: nonEmpty.map((c) => c.text).join('  '), segments: cells, isTableRow: true, source: {kind: 'docx-table', table: tIdx, row: rIdx}});
      }
    }
  }
  return {pages: [{page: 1, method: 'docx', rows}]};
}

export function plainText(textDoc) {
  return textDoc.pages.map((p) => p.rows.map((r) => r.text).join('\n')).join('\n\f\n');
}
