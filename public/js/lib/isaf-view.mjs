// i.SAF registers as VMI i.SAF shows the uploaded data: header and the issued / received invoice registers,
// one row per DocumentTotal (VAT code), columns in the order of the i.SAF 1.2 specification. Built from the generated XML itself.
import {h, money} from '../core.mjs';

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const one = (el, path) => path.split('/').reduce((e, n) => kids(e, n)[0], el);
const txt = (el, path) => { const e = one(el, path); return e && e.getAttribute('xsi:nil') !== 'true' && !e.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') ? e.textContent : ''; };
const TYPES = {SF: 'SF – PVM sąskaita faktūra', DS: 'DS – debetinė', KS: 'KS – kreditinė', VS: 'VS – supaprastinta', VD: 'VD – supaprastinta debetinė', VK: 'VK – supaprastinta kreditinė', AN: 'AN – anuliuota'};
const DATA = {F: 'F – pilnas (išrašytos ir gautos)', S: 'S – išrašytos sąskaitos faktūros', P: 'P – gautos sąskaitos faktūros'};

function register(inv, sales) {
  const who = sales ? 'Pirkėjo' : 'Tiekėjo';
  const party = sales ? 'CustomerInfo' : 'SupplierInfo';
  const cols = ['Eil. Nr.', 'SF numeris', 'SF data', 'SF tipas', `${who} PVM mokėtojo kodas`, `${who} registracijos Nr.`, 'Šalis', `${who} pavadinimas`, 'Specialus apmokestinimas',
    'Koreguojamos SF Nr.', 'Koreguojamos SF data', 'PVM apskaičiavimo data', ...(sales ? [] : ['Įregistravimo apskaitoje data']), 'Apmokestinamoji vertė', 'PVM kodas', 'Tarifas, %', 'PVM suma'];
  const rows = [];
  let net = 0, vat = 0;
  inv.forEach((x, i) => {
    const totals = kids(one(x, 'DocumentTotals'), 'DocumentTotal');
    const ref = one(x, 'References/Reference');
    totals.forEach((t, j) => {
      const first = j === 0;
      net += Number(txt(t, 'TaxableValue') || 0); vat += Number(txt(t, 'Amount') || 0);
      const lead = first ? [String(i + 1), txt(x, 'InvoiceNo'), txt(x, 'InvoiceDate'), TYPES[txt(x, 'InvoiceType')] || txt(x, 'InvoiceType'), txt(x, `${party}/VATRegistrationNumber`), txt(x, `${party}/RegistrationNumber`),
        txt(x, `${party}/Country`), txt(x, `${party}/Name`), txt(x, 'SpecialTaxation'), ref ? txt(ref, 'ReferenceNo') : '', ref ? txt(ref, 'ReferenceDate') : '', txt(x, 'VATPointDate'), ...(sales ? [] : [txt(x, 'RegistrationAccountDate')])]
        : Array(sales ? 12 : 13).fill('');
      rows.push(h('tr', {class: first ? '' : 'isaf-cont'}, lead.map((v) => h('td', null, v)),
        h('td', {class: 'num'}, money(txt(t, 'TaxableValue'))), h('td', null, txt(t, 'TaxCode')), h('td', {class: 'num'}, txt(t, 'TaxPercentage')), h('td', {class: 'num'}, money(txt(t, 'Amount')))));
    });
  });
  return h('div', {class: 'table-wrap'}, h('table', {class: 'grid isaf-grid'},
    h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', {colspan: cols.length}, 'Įrašų nėra.'))),
    h('tfoot', null, h('tr', null, h('td', {colspan: sales ? 12 : 13}, `Iš viso: ${inv.length} SF`), h('td', {class: 'num'}, money(net.toFixed(2))), h('td'), h('td'), h('td', {class: 'num'}, money(vat.toFixed(2)))))));
}

/** Header and registers of an i.SAF file. */
export function isafView(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const d = one(root, 'Header/FileDescription');
  const head = [['Failo versija (FileVersion)', txt(d, 'FileVersion')], ['Sukūrimo data (FileDateCreated)', txt(d, 'FileDateCreated')], ['Duomenų tipas (DataType)', DATA[txt(d, 'DataType')] || txt(d, 'DataType')],
    ['Programinė įranga', `${txt(d, 'SoftwareCompanyName')} ${txt(d, 'SoftwareName')} ${txt(d, 'SoftwareVersion')}`], ['Mokesčių mokėtojo kodas (RegistrationNumber)', txt(d, 'RegistrationNumber')],
    ['Dalis', `${txt(d, 'PartNumber')} iš ${txt(d, 'NumberOfParts')}`], ['Laikotarpis', `${txt(d, 'SelectionCriteria/SelectionStartDate')} – ${txt(d, 'SelectionCriteria/SelectionEndDate')}`]];
  const src = one(root, 'SourceDocuments');
  const sales = kids(one(src, 'SalesInvoices'), 'Invoice'), purchase = kids(one(src, 'PurchaseInvoices'), 'Invoice');
  const type = txt(d, 'DataType');
  return h('div', {class: 'isaf-view'},
    h('section', {class: 'card'}, h('h2', null, 'i.SAF rinkmena – antraštė'), h('table', {class: 'grid isaf-head'}, h('tbody', null, head.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))))),
    type !== 'P' ? h('section', {class: 'card'}, h('h2', null, 'Išrašytų sąskaitų faktūrų registras'), register(sales, true)) : null,
    type !== 'S' ? h('section', {class: 'card'}, h('h2', null, 'Gautų sąskaitų faktūrų registras'), register(purchase, false)) : null);
}
