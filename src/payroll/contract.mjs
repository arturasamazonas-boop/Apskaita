// Darbo sutartis (employment contract) printed from the employee card, following the content the Labour Code requires:
// the parties, the essential terms (DK 34 str.: job function, pay, workplace), the type and term of the contract,
// working time, annual leave, pay dates and probation (DK 36, 44 str.). Data come from the employee card and the
// company settings; the few terms not stored there are given in the print dialog.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import {ROOT} from '../config.mjs';
import {money} from '../lib/money.mjs';
import {amountWords} from '../lib/words-lt.mjs';

const fmt = (v) => money.norm(v).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const ltDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return '____ m. ______________ d.';
  const M = ['sausio', 'vasario', 'kovo', 'balandžio', 'gegužės', 'birželio', 'liepos', 'rugpjūčio', 'rugsėjo', 'spalio', 'lapkričio', 'gruodžio'];
  return `${d.slice(0, 4)} m. ${M[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))} d.`;
};

export function contractDefaults(emp, company) {
  const city = (/,\s*(?:LT-?\d{5}\s+)?([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+)\s*$/.exec(company.address || '') || [])[1] || '';
  const hours = Number(emp.hours_per_week || 40);
  return {
    number: '', date: String(emp.employment_start || '').slice(0, 10), place: city,
    workplace: company.address || '', duties: '', probationMonths: '0',
    workTime: hours >= 40 ? 'Penkių darbo dienų savaitė, 40 valandų per savaitę (8 valandos per dieną), poilsio dienos – šeštadienis ir sekmadienis.'
      : `Darbo laiko norma – ${String(hours).replace('.', ',')} val. per savaitę (darbo dienos ir valandos – pagal darbo grafiką).`,
    payDays: 'Darbo užmokestis mokamas du kartus per mėnesį; darbuotojo prašymu – kartą per mėnesį, ne vėliau kaip iki kito mėnesio 10 d.',
    leaveDays: hours >= 40 ? '20' : '20', employerRep: company.manager || '', employerRepTitle: company.manager_title || 'Direktorius',
  };
}

export function renderContractPdf(emp, company, opts) {
  const o = {...contractDefaults(emp, company), ...Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined && v !== null))};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({size: 'A4', margins: {top: 50, bottom: 50, left: 60, right: 60}, info: {Title: `Darbo sutartis ${emp.first_name} ${emp.last_name}`, Producer: 'Apskaita'}});
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('r', path.join(ROOT, 'assets/fonts/DejaVuSans.ttf')); doc.registerFont('b', path.join(ROOT, 'assets/fonts/DejaVuSans-Bold.ttf'));
    const W = doc.page.width - 120;
    const employer = [company.legal_form && !String(company.name).startsWith(company.legal_form) ? company.legal_form : '', company.name].filter(Boolean).join(' ');
    doc.font('b').fontSize(14).text('DARBO SUTARTIS', {align: 'center'});
    doc.font('r').fontSize(10).text(`${ltDate(o.date)} Nr. ${o.number || '______'}`, {align: 'center'});
    if (o.place) doc.text(o.place, {align: 'center'});
    doc.moveDown(1);
    const p = (text) => { doc.font('r').fontSize(10).text(text, {width: W, align: 'justify'}); doc.moveDown(0.4); };
    const h = (text) => { doc.moveDown(0.3); doc.font('b').fontSize(10.5).text(text, {width: W}); doc.moveDown(0.3); };
    p(`Darbdavys ${employer}, juridinio asmens kodas ${company.company_code || '__________'}, buveinė ${company.address || '__________'}, kuriam atstovauja ${o.employerRepTitle ? o.employerRepTitle.toLowerCase() : 'vadovas'} ${o.employerRep || '__________________'}, ir darbuotojas (-a) ${emp.first_name} ${emp.last_name}, asmens kodas ${emp.personal_code || '___________'}, gyvenamoji vieta ${emp.address || '______________________________'}, sudarė šią darbo sutartį.`);
    const salary = emp.pay_type === 'hourly'
      ? `${String(Number(emp.hourly_rate)).replace('.', ',')} Eur (${amountWords(money.norm(emp.hourly_rate)).replace(/^./, (c) => c.toLowerCase())}) už valandą neatskaičius mokesčių`
      : `${fmt(emp.base_salary)} Eur (${amountWords(money.norm(emp.base_salary)).replace(/^./, (c) => c.toLowerCase())}) per mėnesį neatskaičius mokesčių`;
    const fixed = emp.contract_type === 'fixed_term';
    const items = [
      ['Darbo sutarties rūšis ir terminas', `${fixed ? 'Terminuota' : 'Neterminuota'} darbo sutartis. Darbo pradžia – ${ltDate(String(emp.employment_start).slice(0, 10))}${fixed ? `, darbo sutarties pabaiga – ${ltDate(String(emp.employment_end || '').slice(0, 10))}` : ''}.`],
      ['Darbo funkcija (pareigos)', `${emp.position || '__________________'}${emp.department ? `, padalinys – ${emp.department}` : ''}.${o.duties ? ` ${o.duties}` : ' Konkrečios pareigos nustatomos pareigybės aprašyme, su kuriuo darbuotojas supažindinamas pasirašytinai.'}`],
      ['Darbovietė', `${o.workplace || company.address || '__________'}.`],
      ['Darbo apmokėjimo sąlygos', `Darbuotojui nustatomas ${emp.pay_type === 'hourly' ? 'valandinis įkainis' : 'mėnesinis darbo užmokestis (pastovioji dalis)'} – ${salary}. ${o.payDays} Darbo užmokestis pervedamas į darbuotojo nurodytą sąskaitą${emp.iban ? ` ${emp.iban}` : ''}.`],
      ['Darbo laiko režimas', o.workTime],
      ['Kasmetinės atostogos', `Darbuotojui suteikiamos ${o.leaveDays} darbo dienų (dirbant penkias dienas per savaitę) trukmės kasmetinės atostogos, kurių trukmė apskaičiuojama ir jos suteikiamos Darbo kodekso nustatyta tvarka.`],
      ['Išbandymas', Number(o.probationMonths) > 0 ? `Nustatomas ${Number(o.probationMonths)} mėn. išbandymo laikotarpis (ne ilgesnis kaip trys mėnesiai, DK 36 str.).` : 'Išbandymas nenustatomas.'],
      ['Informacija darbuotojui (DK 44 str.)', 'Viršvalandinis darbas ir darbas poilsio ar švenčių dienomis apmokamas Darbo kodekso 144 straipsnyje nustatyta tvarka (ne mažiau kaip pusantro ar dvigubo dydžio darbo užmokesčiu). Darbuotojo kvalifikacijos tobulinimas ir mokymas – pagal darbdavio nustatytą tvarką ir Darbo kodekso 37 straipsnį. Socialinio draudimo įmokas darbdavys moka Valstybinio socialinio draudimo fondo valdybai (Sodrai).'],
      ['Kitos sąlygos', 'Kitos darbo sąlygos, kurios nenurodytos šioje sutartyje, nustatomos pagal Lietuvos Respublikos darbo kodeksą, kitus darbo teisės aktus ir darbdavio darbo tvarkos taisykles. Įspėjimo apie darbo sutarties nutraukimą terminai – pagal Darbo kodekso 55–57 straipsnius.'],
      ['Baigiamosios nuostatos', 'Darbo sutartis įsigalioja nuo jos pasirašymo ir galioja nuo darbo pradžios dienos. Sutartis sudaryta dviem vienodą teisinę galią turinčiais egzemplioriais – po vieną kiekvienai šaliai. Darbuotojas patvirtina, kad iki darbo pradžios jis supažindintas su darbo tvarkos taisyklėmis, darbuotojų saugos ir sveikatos reikalavimais bei pareigybės aprašymu.'],
    ];
    items.forEach(([title, text], i) => { h(`${i + 1}. ${title}`); p(text.replace(/\.\./g, '.')); });
    doc.moveDown(1.5);
    if (doc.y > doc.page.height - 170) doc.addPage();
    const y = doc.y, col = W / 2;
    const sign = (x, who, lines) => {
      doc.font('b').fontSize(10).text(who, x, y, {width: col - 20});
      doc.font('r').fontSize(9).text(lines.filter(Boolean).join('\n'), x, y + 16, {width: col - 20});
      const ly = y + 90;
      doc.moveTo(x, ly).lineTo(x + col - 30, ly).lineWidth(0.5).stroke();
      doc.fontSize(7.5).fillColor('#555').text('(parašas)', x, ly + 3); doc.fillColor('#000');
    };
    sign(60, 'Darbdavys', [employer, `${o.employerRepTitle || ''} ${o.employerRep || ''}`.trim()]);
    sign(60 + col, 'Darbuotojas', [`${emp.first_name} ${emp.last_name}`, emp.position || '']);
    doc.end();
  });
}
