// Finansinės ataskaitos pagal verslo apskaitos standartų formas:
//   2-asis VAS „Balansas“ (VAS-41): 1 priedas – balansas, 2 priedas – sutrumpintas balansas, 3 priedas – labai mažų įmonių trumpas balansas;
//   3-iasis VAS „Pelno (nuostolių) ataskaita“ (VAS-40): 1 priedas – pelno (nuostolių) ataskaita, 2 priedas – labai mažų įmonių trumpa.
// Lines are mapped to the chart of accounts (migration 009) by account-code prefix. Amounts come only from posted journal lines.
import {NOT_CLOSING} from '../ledger/closing.mjs';
import {money, toUnits, fromUnits, divRound} from '../lib/money.mjs';
import {CF_INDIRECT, CF_DIRECT, cashFlowColumn} from './cashflow.mjs';
import {buildEquity, EQ_COLS, EQ_ROWS} from './equity.mjs';

// Line spec: [id, no, label, spec]. spec: {h: true} heading without amount; {acc: [prefixes], ex: [prefixes]} balance of accounts;
// {sum: [ids]} total of lines; {result: 'current'|'prior'|'all'} undistributed result; {turnover: [prefixes]} debit turnover (expense, shown negative);
// {delta: [prefixes]} change of the balance over the period. Balance lines: asset side +(D−K), equity and liabilities −(D−K). P&L lines: −(D−K).
const B = (id, no, label, spec) => [id, no, label, spec];

const BALANCE_FULL = [
  B('h1', '', 'TURTAS', {h: true}),
  B('A', 'A.', 'ILGALAIKIS TURTAS', {sum: ['A1', 'A2', 'A3', 'A4']}),
  B('A1', '1.', 'NEMATERIALUSIS TURTAS', {sum: ['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5', 'A1.6']}),
  B('A1.1', '1.1.', 'Plėtros darbai', {acc: ['111']}),
  B('A1.2', '1.2.', 'Prestižas', {acc: ['112']}),
  B('A1.3', '1.3.', 'Programinė įranga', {acc: ['113']}),
  B('A1.4', '1.4.', 'Koncesijos, patentai, licencijos, prekių ženklai ir panašios teisės', {acc: ['114']}),
  B('A1.5', '1.5.', 'Kitas nematerialusis turtas', {acc: ['115', '110']}),
  B('A1.6', '1.6.', 'Sumokėti avansai', {acc: ['116']}),
  B('A2', '2.', 'MATERIALUSIS TURTAS', {sum: ['A2.1', 'A2.2', 'A2.3', 'A2.4', 'A2.5', 'A2.6', 'A2.7']}),
  B('A2.1', '2.1.', 'Žemė', {acc: ['120']}),
  B('A2.2', '2.2.', 'Pastatai ir statiniai', {acc: ['121']}),
  B('A2.3', '2.3.', 'Mašinos ir įranga', {acc: ['122']}),
  B('A2.4', '2.4.', 'Transporto priemonės', {acc: ['123']}),
  B('A2.5', '2.5.', 'Kiti įrenginiai, prietaisai ir įrankiai', {acc: ['124']}),
  B('A2.6', '2.6.', 'Investicinis turtas', {sum: ['A2.6.1', 'A2.6.2']}),
  B('A2.6.1', '2.6.1.', 'Žemė', {acc: ['1250']}),
  B('A2.6.2', '2.6.2.', 'Pastatai', {acc: ['1251']}),
  B('A2.7', '2.7.', 'Sumokėti avansai ir vykdomi materialiojo turto statybos (gamybos) darbai', {acc: ['126']}),
  B('A3', '3.', 'FINANSINIS TURTAS', {sum: ['A3.1', 'A3.2', 'A3.3', 'A3.4', 'A3.5', 'A3.6', 'A3.7', 'A3.8', 'A3.9']}),
  B('A3.1', '3.1.', 'Įmonių grupės įmonių akcijos', {acc: ['160']}),
  B('A3.2', '3.2.', 'Paskolos įmonių grupės įmonėms', {acc: ['161']}),
  B('A3.3', '3.3.', 'Iš įmonių grupės įmonių gautinos sumos', {acc: ['162']}),
  B('A3.4', '3.4.', 'Asocijuotųjų įmonių akcijos', {acc: ['163']}),
  B('A3.5', '3.5.', 'Paskolos asocijuotosioms įmonėms', {acc: ['164']}),
  B('A3.6', '3.6.', 'Iš asocijuotųjų įmonių gautinos sumos', {acc: ['165']}),
  B('A3.7', '3.7.', 'Ilgalaikės investicijos', {acc: ['166']}),
  B('A3.8', '3.8.', 'Po vienų metų gautinos sumos', {acc: ['167']}),
  B('A3.9', '3.9.', 'Kitas finansinis turtas', {acc: ['168']}),
  B('A4', '4.', 'KITAS ILGALAIKIS TURTAS', {sum: ['A4.1', 'A4.2', 'A4.3']}),
  B('A4.1', '4.1.', 'Atidėtojo pelno mokesčio turtas', {acc: ['171']}),
  B('A4.2', '4.2.', 'Biologinis turtas', {acc: ['172']}),
  B('A4.3', '4.3.', 'Kitas turtas', {acc: ['173']}),
  B('B', 'B.', 'TRUMPALAIKIS TURTAS', {sum: ['B1', 'B2', 'B3', 'B4']}),
  B('B1', '1.', 'ATSARGOS', {sum: ['B1.1', 'B1.2', 'B1.3', 'B1.4', 'B1.5', 'B1.6', 'B1.7']}),
  B('B1.1', '1.1.', 'Žaliavos, medžiagos ir komplektavimo detalės', {acc: ['201', '209']}),
  B('B1.2', '1.2.', 'Nebaigta produkcija ir vykdomi darbai', {acc: ['202']}),
  B('B1.3', '1.3.', 'Produkcija', {acc: ['203']}),
  B('B1.4', '1.4.', 'Pirktos prekės, skirtos perparduoti', {acc: ['204']}),
  B('B1.5', '1.5.', 'Biologinis turtas', {acc: ['205']}),
  B('B1.6', '1.6.', 'Ilgalaikis materialusis turtas, skirtas parduoti', {acc: ['206', '207']}),
  B('B1.7', '1.7.', 'Sumokėti avansai', {acc: ['208']}),
  B('B2', '2.', 'PER VIENUS METUS GAUTINOS SUMOS', {sum: ['B2.1', 'B2.2', 'B2.3', 'B2.4']}),
  B('B2.1', '2.1.', 'Pirkėjų skolos', {acc: ['241']}),
  B('B2.2', '2.2.', 'Įmonių grupės įmonių skolos', {acc: ['242']}),
  B('B2.3', '2.3.', 'Asocijuotųjų įmonių skolos', {acc: ['243']}),
  B('B2.4', '2.4.', 'Kitos gautinos sumos', {acc: ['244', '263']}),
  B('B3', '3.', 'TRUMPALAIKĖS INVESTICIJOS', {sum: ['B3.1', 'B3.2']}),
  B('B3.1', '3.1.', 'Įmonių grupės įmonių akcijos', {acc: ['261']}),
  B('B3.2', '3.2.', 'Kitos investicijos', {acc: ['262']}),
  B('B4', '4.', 'PINIGAI IR PINIGŲ EKVIVALENTAI', {acc: ['27']}),
  B('C', 'C.', 'ATEINANČIŲ LAIKOTARPIŲ SĄNAUDOS IR SUKAUPTOS PAJAMOS', {acc: ['29']}),
  B('TA', '', 'TURTO IŠ VISO', {sum: ['A', 'B', 'C'], grand: true}),
  B('h2', '', 'NUOSAVAS KAPITALAS IR ĮSIPAREIGOJIMAI', {h: true}),
  B('D', 'D.', 'NUOSAVAS KAPITALAS', {sum: ['D1', 'D2', 'D3', 'D4', 'D5'], side: 'L'}),
  B('D1', '1.', 'KAPITALAS', {sum: ['D1.1', 'D1.2', 'D1.3']}),
  B('D1.1', '1.1.', 'Įstatinis (pasirašytasis) arba pagrindinis kapitalas', {acc: ['301', '305', '308'], side: 'L'}),
  B('D1.2', '1.2.', 'Pasirašytasis neapmokėtas kapitalas (–)', {acc: ['302', '309'], side: 'L'}),
  B('D1.3', '1.3.', 'Savos akcijos, pajai (–)', {acc: ['303'], side: 'L'}),
  B('D2', '2.', 'AKCIJŲ PRIEDAI', {acc: ['304'], side: 'L'}),
  B('D3', '3.', 'PERKAINOJIMO REZERVAS', {acc: ['32'], side: 'L'}),
  B('D4', '4.', 'REZERVAI', {sum: ['D4.1', 'D4.2', 'D4.3']}),
  B('D4.1', '4.1.', 'Privalomasis rezervas arba atsargos (rezervinis) kapitalas', {acc: ['331'], side: 'L'}),
  B('D4.2', '4.2.', 'Savoms akcijoms įsigyti', {acc: ['332'], side: 'L'}),
  B('D4.3', '4.3.', 'Kiti rezervai', {acc: ['333'], side: 'L'}),
  B('D5', '5.', 'NEPASKIRSTYTASIS PELNAS (NUOSTOLIAI)', {sum: ['D5.1', 'D5.2']}),
  B('D5.1', '5.1.', 'Ataskaitinių metų pelnas (nuostoliai)', {result: 'current'}),
  B('D5.2', '5.2.', 'Ankstesnių metų pelnas (nuostoliai)', {result: 'prior'}),
  B('E', 'E.', 'DOTACIJOS, SUBSIDIJOS', {acc: ['40'], side: 'L'}),
  B('F', 'F.', 'ATIDĖJINIAI', {sum: ['F1', 'F2', 'F3']}),
  B('F1', '1.', 'Pensijų ir panašių įsipareigojimų atidėjiniai', {acc: ['411'], side: 'L'}),
  B('F2', '2.', 'Mokesčių atidėjiniai', {acc: ['412'], side: 'L'}),
  B('F3', '3.', 'Kiti atidėjiniai', {acc: ['413'], side: 'L'}),
  B('G', 'G.', 'MOKĖTINOS SUMOS IR KITI ĮSIPAREIGOJIMAI', {sum: ['G1', 'G2']}),
  B('G1', '1.', 'PO VIENŲ METŲ MOKĖTINOS SUMOS IR KITI ILGALAIKIAI ĮSIPAREIGOJIMAI', {sum: ['G1.1', 'G1.2', 'G1.3', 'G1.4', 'G1.5', 'G1.6', 'G1.7', 'G1.8']}),
  ...[['421', 'Skoliniai įsipareigojimai'], ['422', 'Skolos kredito įstaigoms'], ['423', 'Gauti avansai'], ['424', 'Skolos tiekėjams'], ['425', 'Pagal vekselius ir čekius mokėtinos sumos'],
    ['426', 'Įmonių grupės įmonėms mokėtinos sumos'], ['427', 'Asocijuotosioms įmonėms mokėtinos sumos'], ['428', 'Kitos mokėtinos sumos ir ilgalaikiai įsipareigojimai']]
    .map(([a, l], i) => B(`G1.${i + 1}`, `1.${i + 1}.`, l, {acc: [a], side: 'L'})),
  B('G2', '2.', 'PER VIENUS METUS MOKĖTINOS SUMOS IR KITI TRUMPALAIKIAI ĮSIPAREIGOJIMAI', {sum: Array.from({length: 10}, (_, i) => `G2.${i + 1}`)}),
  ...[['440', 'Skoliniai įsipareigojimai'], ['441', 'Skolos kredito įstaigoms'], ['442', 'Gauti avansai'], ['443', 'Skolos tiekėjams'], ['444', 'Pagal vekselius ir čekius mokėtinos sumos'],
    ['445', 'Įmonių grupės įmonėms mokėtinos sumos'], ['446', 'Asocijuotosioms įmonėms mokėtinos sumos'], ['447', 'Pelno mokesčio įsipareigojimai'], ['448', 'Su darbo santykiais susiję įsipareigojimai'],
    ['449', 'Kitos mokėtinos sumos ir trumpalaikiai įsipareigojimai']].map(([a, l], i) => B(`G2.${i + 1}`, `2.${i + 1}.`, l, {acc: [a], side: 'L'})),
  B('H', 'H.', 'SUKAUPTOS SĄNAUDOS IR ATEINANČIŲ LAIKOTARPIŲ PAJAMOS', {acc: ['49'], side: 'L'}),
  B('TL', '', 'NUOSAVO KAPITALO IR ĮSIPAREIGOJIMŲ IŠ VISO', {sum: ['D', 'E', 'F', 'G', 'H'], grand: true}),
];

const BALANCE_SHORT = [
  B('h1', '', 'TURTAS', {h: true}),
  B('A', 'A.', 'ILGALAIKIS TURTAS', {sum: ['A1', 'A2', 'A3', 'A4']}),
  B('A1', '1.', 'Nematerialusis turtas', {acc: ['11']}),
  B('A2', '2.', 'Materialusis turtas', {acc: ['12']}),
  B('A3', '3.', 'Finansinis turtas', {acc: ['16']}),
  B('A4', '4.', 'Kitas ilgalaikis turtas', {acc: ['17']}),
  B('B', 'B.', 'TRUMPALAIKIS TURTAS', {sum: ['B1', 'B2', 'B3', 'B4']}),
  B('B1', '1.', 'Atsargos', {acc: ['20']}),
  B('B2', '2.', 'Per vienus metus gautinos sumos', {acc: ['24', '263']}),
  B('B3', '3.', 'Trumpalaikės investicijos', {acc: ['261', '262']}),
  B('B4', '4.', 'Pinigai ir pinigų ekvivalentai', {acc: ['27']}),
  B('C', 'C.', 'ATEINANČIŲ LAIKOTARPIŲ SĄNAUDOS IR SUKAUPTOS PAJAMOS', {acc: ['29']}),
  B('TA', '', 'TURTO IŠ VISO', {sum: ['A', 'B', 'C'], grand: true}),
  B('h2', '', 'NUOSAVAS KAPITALAS IR ĮSIPAREIGOJIMAI', {h: true}),
  B('D', 'D.', 'NUOSAVAS KAPITALAS', {sum: ['D1', 'D2', 'D3', 'D4', 'D5']}),
  B('D1', '1.', 'Kapitalas', {acc: ['30'], ex: ['304'], side: 'L'}),
  B('D2', '2.', 'Akcijų priedai', {acc: ['304'], side: 'L'}),
  B('D3', '3.', 'Perkainojimo rezervas', {acc: ['32'], side: 'L'}),
  B('D4', '4.', 'Rezervai', {acc: ['33'], side: 'L'}),
  B('D5', '5.', 'Nepaskirstytasis pelnas (nuostoliai)', {result: 'all'}),
  B('E', 'E.', 'DOTACIJOS, SUBSIDIJOS', {acc: ['40'], side: 'L'}),
  B('F', 'F.', 'ATIDĖJINIAI', {acc: ['41'], side: 'L'}),
  B('G', 'G.', 'MOKĖTINOS SUMOS IR KITI ĮSIPAREIGOJIMAI', {sum: ['G1', 'G2']}),
  B('G1', '1.', 'Po vienų metų mokėtinos sumos ir kiti ilgalaikiai įsipareigojimai', {acc: ['42'], side: 'L'}),
  B('G2', '2.', 'Per vienus metus mokėtinos sumos ir kiti trumpalaikiai įsipareigojimai', {acc: ['44'], side: 'L'}),
  B('H', 'H.', 'SUKAUPTOS SĄNAUDOS IR ATEINANČIŲ LAIKOTARPIŲ PAJAMOS', {acc: ['49'], side: 'L'}),
  B('TL', '', 'NUOSAVO KAPITALO IR ĮSIPAREIGOJIMŲ IŠ VISO', {sum: ['D', 'E', 'F', 'G', 'H'], grand: true}),
];

const BALANCE_MICRO = [
  B('h1', '', 'TURTAS', {h: true}),
  B('A', 'A.', 'Ilgalaikis turtas', {sum: ['A1', 'A2']}),
  B('A1', '1.', 'Materialusis turtas', {acc: ['12']}),
  B('A2', '2.', 'Kitas ilgalaikis turtas', {acc: ['11', '16', '17']}),
  B('B', 'B.', 'Trumpalaikis turtas', {sum: ['B1', 'B2']}),
  B('B1', '1.', 'Atsargos', {acc: ['20']}),
  B('B2', '2.', 'Kitas trumpalaikis turtas', {acc: ['24', '26', '27']}),
  B('C', 'C.', 'Ateinančių laikotarpių sąnaudos ir sukauptos pajamos', {acc: ['29']}),
  B('TA', '', 'TURTO IŠ VISO', {sum: ['A', 'B', 'C'], grand: true}),
  B('h2', '', 'NUOSAVAS KAPITALAS IR ĮSIPAREIGOJIMAI', {h: true}),
  B('D', 'D.', 'Nuosavas kapitalas', {sum: ['D0', 'D9']}),
  B('D0', '', 'Kapitalas, rezervai', {acc: ['30', '32', '33'], side: 'L', hidden: true}),
  B('D9', '', 'Nepaskirstytasis pelnas (nuostoliai)', {result: 'all', hidden: true}),
  B('E', 'E.', 'Dotacijos, subsidijos', {acc: ['40'], side: 'L'}),
  B('F', 'F.', 'Atidėjiniai', {acc: ['41'], side: 'L'}),
  B('G', 'G.', 'Mokėtinos sumos ir kiti įsipareigojimai', {sum: ['G1', 'G2']}),
  B('G1', '1.', 'Po vienų metų mokėtinos sumos ir kiti ilgalaikiai įsipareigojimai', {acc: ['42'], side: 'L'}),
  B('G2', '2.', 'Per vienus metus mokėtinos sumos ir kiti trumpalaikiai įsipareigojimai', {acc: ['44'], side: 'L'}),
  B('H', 'H.', 'Sukauptos sąnaudos ir ateinančių laikotarpių pajamos', {acc: ['49'], side: 'L'}),
  B('TL', '', 'NUOSAVO KAPITALO IR ĮSIPAREIGOJIMŲ IŠ VISO', {sum: ['D', 'E', 'F', 'G', 'H'], grand: true}),
];

const PL_FULL = [
  B('1', '1.', 'Pardavimo pajamos', {acc: ['50']}),
  B('2', '2.', 'Pardavimo savikaina', {acc: ['60']}),
  B('3', '3.', 'Biologinio turto tikrosios vertės pokytis', {acc: ['51', '61']}),
  B('4', '4.', 'BENDRASIS PELNAS (NUOSTOLIAI)', {sum: ['1', '2', '3'], total: true}),
  B('5', '5.', 'Pardavimo sąnaudos', {acc: ['62']}),
  B('6', '6.', 'Bendrosios ir administracinės sąnaudos', {acc: ['63']}),
  B('7', '7.', 'Kitos veiklos rezultatai', {acc: ['52', '54', '64']}),
  B('8', '8.', 'Investicijų į patronuojančiosios, patronuojamųjų ir asocijuotųjų įmonių akcijas pajamos', {acc: ['55']}),
  B('9', '9.', 'Kitų ilgalaikių investicijų ir paskolų pajamos', {acc: ['56']}),
  B('10', '10.', 'Kitos palūkanų ir panašios pajamos', {acc: ['57', '58']}),
  B('11', '11.', 'Finansinio turto ir trumpalaikių investicijų vertės sumažėjimas', {acc: ['67']}),
  B('12', '12.', 'Palūkanų ir kitos panašios sąnaudos', {acc: ['65', '66', '68']}),
  B('13', '13.', 'PELNAS (NUOSTOLIAI) PRIEŠ APMOKESTINIMĄ', {sum: ['4', '5', '6', '7', '8', '9', '10', '11', '12'], total: true}),
  B('14', '14.', 'Pelno mokestis', {acc: ['69']}),
  B('15', '15.', 'GRYNASIS PELNAS (NUOSTOLIAI)', {sum: ['13', '14'], grand: true}),
];

// Very small companies, by nature of expense. Bought stock = debit turnover of inventory accounts (20) plus other cost-of-sales accounts;
// cost of goods sold postings (6000, 6005) are replaced by the inventory change, so purchases + change = cost of goods sold.
const WAGES = ['6003', '6203', '6304'];
const DEPRECIATION = ['6201', '6306', '6307', '6309', '67'];
const PL_MICRO = [
  B('1', '1.', 'Pardavimo pajamos', {acc: ['50']}),
  B('2', '2.', 'Kitos pajamos', {acc: ['51', '52', '53', '54', '55', '56', '57', '58', '59']}),
  B('3', '3.', 'Įsigytos atsargos ir sunaudoti ištekliai', {turnover: ['20'], acc: ['60', '61'], ex: ['6000', '6005', '6003']}),
  B('4', '4.', 'Atsargų likučio pokytis', {delta: ['20'], replaces: ['6000', '6005']}),
  B('5', '5.', 'Su darbo santykiais susijusios sąnaudos', {acc: WAGES, wages: true}),
  B('6', '6.', 'Nusidėvėjimas, amortizacija ir turto vertės sumažėjimas', {acc: DEPRECIATION}),
  B('7', '7.', 'Kitos sąnaudos', {acc: ['62', '63', '64', '65', '66', '68'], ex: [...WAGES, ...DEPRECIATION], exWages: true}),
  B('8', '8.', 'Pelno mokestis', {acc: ['69']}),
  B('9', '9.', 'GRYNASIS PELNAS (NUOSTOLIAI)', {sum: ['1', '2', '3', '4', '5', '6', '7', '8'], grand: true}),
];

export const FORMS = {
  'balansas': {kind: 'balance', title: 'BALANSAS', name: 'Balansas', standard: '2-ojo verslo apskaitos standarto „Balansas“', annex: '1 priedas', lines: BALANCE_FULL,
    who: 'Vidutinės ir didelės įmonės; mažos įmonės, pasirinkusios išsamų balansą.'},
  'balansas-sutrumpintas': {kind: 'balance', title: 'BALANSAS', name: 'Sutrumpintas balansas', standard: '2-ojo verslo apskaitos standarto „Balansas“', annex: '2 priedas', lines: BALANCE_SHORT,
    who: 'Mažos įmonės, pasirinkusios sutrumpintą balansą.'},
  'balansas-trumpas': {kind: 'balance', title: 'BALANSAS', name: 'Labai mažų įmonių trumpas balansas', standard: '2-ojo verslo apskaitos standarto „Balansas“', annex: '3 priedas', lines: BALANCE_MICRO,
    who: 'Labai mažos įmonės, pasirinkusios trumpą balansą.'},
  'pelno-nuostoliu': {kind: 'pl', title: 'PELNO (NUOSTOLIŲ) ATASKAITA', name: 'Pelno (nuostolių) ataskaita', standard: '3-iojo verslo apskaitos standarto „Pelno (nuostolių) ataskaita“', annex: '1 priedas', lines: PL_FULL,
    who: 'Visos įmonės, išskyrus labai mažas, pasirinkusias trumpą ataskaitą.'},
  'pinigu-srautai': {kind: 'cf', method: 'indirect', title: 'PINIGŲ SRAUTŲ ATASKAITA', name: 'Pinigų srautų ataskaita (netiesioginis būdas)', standard: '5-ojo verslo apskaitos standarto „Pinigų srautų ataskaita“', annex: '2 priedas', lines: CF_INDIRECT,
    who: 'Vidutinės ir didelės įmonės (mažoms – savanoriškai). Netiesioginis būdas: nuo grynojo pelno per balanso straipsnių pokyčius.', colTitles: ['Finansiniai metai', 'Praėję finansiniai metai']},
  'pinigu-srautai-tiesioginis': {kind: 'cf', method: 'direct', title: 'PINIGŲ SRAUTŲ ATASKAITA', name: 'Pinigų srautų ataskaita (tiesioginis būdas)', standard: '5-ojo verslo apskaitos standarto „Pinigų srautų ataskaita“', annex: '1 priedas', lines: CF_DIRECT,
    who: 'Vidutinės ir didelės įmonės (mažoms – savanoriškai). Tiesioginis būdas: banko ir kasos įplaukos bei išmokos pagal korespondenciją.', colTitles: ['Finansiniai metai', 'Praėję finansiniai metai']},
  'nuosavo-kapitalo-pokyciai': {kind: 'equity', title: 'NUOSAVO KAPITALO POKYČIŲ ATASKAITA', name: 'Nuosavo kapitalo pokyčių ataskaita', standard: '4-ojo verslo apskaitos standarto „Nuosavo kapitalo pokyčių ataskaita“', annex: '1 priedas', lines: [],
    who: 'Vidutinės ir didelės įmonės (mažoms – savanoriškai).'},
  'pelno-nuostoliu-trumpa': {kind: 'pl', title: 'PELNO (NUOSTOLIŲ) ATASKAITA', name: 'Labai mažų įmonių trumpa pelno (nuostolių) ataskaita', standard: '3-iojo verslo apskaitos standarto „Pelno (nuostolių) ataskaita“', annex: '2 priedas', lines: PL_MICRO,
    who: 'Labai mažos įmonės, pasirinkusios trumpą pelno (nuostolių) ataskaitą.'},
};

const starts = (code, list = []) => list.some((p) => code.startsWith(p));
const addYears = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate(); return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`; };
const roundEur = (v) => fromUnits(divRound(toUnits(v, 2), 100n) * 100n, 2);

/** Per-account balances needed for one column. */
async function accountData(db, kind, {from, to}) {
  if (kind === 'balance') {
    const fy = `${to.slice(0, 4)}-01-01`;
    const r = await db.query(`SELECT l.account_code AS code,
        coalesce(sum(l.debit - l.credit),0) AS bal,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date >= $2),0) AS bal_year,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date >= $2 AND ${NOT_CLOSING}),0) AS bal_year_result
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.entry_date <= $1 GROUP BY 1`, [to, fy]);
    return r.rows;
  }
  const r = await db.query(`SELECT l.account_code AS code,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date BETWEEN $1 AND $2),0) AS bal,
      coalesce(sum(l.debit) FILTER (WHERE e.entry_date BETWEEN $1 AND $2),0) AS debit,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $1),0) AS opening,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date <= $2),0) AS closing
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.entry_date <= $2 AND ${NOT_CLOSING} GROUP BY 1`, [from, to]);
  return r.rows;
}

function computeColumn(form, rows, {cents, wageAccounts = []}) {
  const leaf = new Map();
  const used = new Set();
  const isPL = (c) => c[0] === '5' || c[0] === '6';
  for (const [id, , , spec] of form.lines) {
    if (spec.h || spec.sum) continue;
    let v = '0.00';
    const sign = form.kind === 'pl' || spec.side === 'L' ? -1 : 1;
    if (spec.result) {
      // Undistributed result: 341/342/390 balances plus income and expense accounts not yet closed.
      for (const r of rows) {
        const c = r.code;
        // This year's result = income and expense of the year without closing entries (so closing into 341 and moving 341 → 342
        // change nothing); everything else in 5/6, 34x and 390 is undistributed result of earlier years.
        const inResult = isPL(c) || c.startsWith('34') || c.startsWith('390');
        const cur = isPL(c) ? r.bal_year_result : '0';
        const prior = inResult ? money.sub(r.bal, cur) : '0';
        const take = spec.result === 'current' ? cur : spec.result === 'prior' ? prior : money.add(cur, prior);
        if (!money.isZero(take)) v = money.add(v, money.neg(take));
        if (isPL(c) || c.startsWith('34') || c.startsWith('390')) used.add(c);
      }
    } else {
      for (const r of rows) {
        const c = r.code;
        const wage = spec.wages && wageAccounts.includes(c);
        if (spec.exWages && wageAccounts.includes(c)) continue;
        if (spec.turnover && starts(c, spec.turnover)) { v = money.sub(v, r.debit); continue; }
        if (spec.delta && starts(c, spec.delta)) { v = money.add(v, money.sub(r.closing, r.opening)); continue; }
        if ((starts(c, spec.acc) || wage) && !starts(c, spec.ex)) { v = money.add(v, sign < 0 ? money.neg(r.bal) : r.bal); used.add(c); }
      }
      if (spec.turnover || spec.delta) for (const r of rows) if (starts(r.code, spec.turnover || spec.delta) || starts(r.code, spec.replaces)) used.add(r.code);
    }
    leaf.set(id, cents ? money.norm(v) : roundEur(v));
  }
  return {...finishColumn(form, leaf), unmapped: unmappedOf(form, rows, used)};
}

function unmappedOf(form, rows, used) {
  const isPL = (c) => c[0] === '5' || c[0] === '6';
  const scope = form.kind === 'balance' ? (c) => !isPL(c) : (c) => isPL(c);
  return rows.filter((r) => scope(r.code) && !used.has(r.code) && !money.isZero(r.bal) && !(form.kind === 'pl' && form.lines.some(([, , , s]) => s.delta && starts(r.code, s.delta)))).map((r) => ({code: r.code, amount: money.norm(r.bal)}));
}

/** Leaf values (already rounded) → all line values with totals. */
function finishColumn(form, leaf) {
  const val = new Map(leaf);
  const get = (id) => {
    if (val.has(id)) return val.get(id);
    const spec = form.lines.find((l) => l[0] === id)?.[3];
    const v = spec?.sum ? money.sum(spec.sum.map(get)) : '0.00';
    val.set(id, v);
    return v;
  };
  for (const [id, , , spec] of form.lines) if (!spec.h) get(id);
  return {val};
}

export function periodsFor(form, q) {
  const today = q.today;
  if (form.kind === 'balance') {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : `${to.slice(0, 4)}-01-01`;
    const prevTo = /^\d{4}-\d{2}-\d{2}$/.test(q.prevTo || '') ? q.prevTo : `${Number(to.slice(0, 4)) - 1}-12-31`;
    return {cur: {from, to}, prev: {from: `${prevTo.slice(0, 4)}-01-01`, to: prevTo}};
  }
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : `${to.slice(0, 4)}-01-01`;
  return {cur: {from, to}, prev: {from: addYears(from, -1), to: addYears(to, -1)}};
}

/** Build a statement: lines with current and previous amounts, header data, checks. */
export async function buildStatement(db, key, q) {
  const form = Object.hasOwn(FORMS, key) ? FORMS[key] : null;
  if (!form) return null;
  const cents = q.precision === 'cents';
  const {cur, prev} = periodsFor(form, q);
  const wageAccounts = (await db.query(`SELECT DISTINCT expense_account AS c FROM employees UNION SELECT code FROM accounts WHERE system_role='payroll_expense'`).catch(() => ({rows: []}))).rows.map((r) => r.c);
  const company = (await db.query('SELECT * FROM company_settings WHERE id=1')).rows[0];
  const companyInfo = {legal_form: company.legal_form, name: company.name, code: company.company_code, address: company.address, manager: company.manager};
  const formInfo = {name: form.name, title: form.title, standard: form.standard, annex: form.annex, kind: form.kind, who: form.who, colTitles: form.colTitles || ['Ataskaitinis laikotarpis', 'Praėjęs ataskaitinis laikotarpis']};
  if (form.kind === 'equity') {
    const eq = await buildEquity(db, {to: cur.to});
    const r = (v) => (cents ? money.norm(v) : roundEur(v));
    const cells = Object.fromEntries(Object.entries(eq.cells).map(([row, cs]) => [row, Object.fromEntries(Object.entries(cs).map(([c, v]) => [c, r(v)]))]));
    return {key, form: formInfo, period: eq.period, previousPeriod: eq.previousPeriod, precision: cents ? 'cents' : 'eur', company: companyInfo, lines: [],
      matrix: {cols: [...EQ_COLS.map(([k, label]) => ({key: k, label})), {key: 'c10', label: 'Iš viso'}], rows: EQ_ROWS.map(([no, label]) => ({no, label, strong: ['1', '4', '17', '30'].includes(no)})), cells}, checks: eq.checks};
  }
  let c1, c2;
  const cfChecks = [];
  if (form.kind === 'cf') {
    const leafIds = form.lines.filter(([, , , s]) => !s.h && !s.sum).map(([id]) => id);
    const col = async (p, label) => {
      const r = await cashFlowColumn(db, form.method, p);
      cfChecks.push(...r.checks);
      const out = finishColumn(form, new Map(leafIds.map((id) => [id, cents ? money.norm(r.v.get(id) || '0') : roundEur(r.v.get(id) || '0')])));
      const d = money.sub(out.val.get('VII'), cents ? money.norm(r.cashClosing) : roundEur(r.cashClosing));
      if (!money.isZero(d)) cfChecks.push({level: 'warning', message: `Apvalinimo skirtumas ${label} laikotarpio pinigų likutyje: ${d} EUR.`});
      return {...out, unmapped: []};
    };
    c1 = await col(cur, 'ataskaitinio');
    c2 = await col(prev, 'praėjusio');
  } else {
    const [a, b] = await Promise.all([accountData(db, form.kind, cur), accountData(db, form.kind, prev)]);
    c1 = computeColumn(form, a, {cents, wageAccounts}); c2 = computeColumn(form, b, {cents, wageAccounts});
  }
  // Manually entered previous-period figures (e.g. the year before the company started using this program).
  const ov = new Map((await db.query('SELECT line_id, amount FROM fs_prior_values WHERE form_key=$1 AND period_end=$2', [key, prev.to])).rows.map((r) => [r.line_id, money.norm(r.amount)]));
  if (ov.size) {
    for (const [id, , , spec] of form.lines) if (!spec.h && !spec.sum && ov.has(id)) c2.val.set(id, cents ? ov.get(id) : roundEur(ov.get(id)));
    const recompute = (id) => { const spec = form.lines.find((l) => l[0] === id)[3]; if (spec.sum) { spec.sum.forEach(recompute); c2.val.set(id, money.sum(spec.sum.map((x) => c2.val.get(x)))); } };
    for (const [id, , , spec] of form.lines) if (spec.sum) recompute(id);
  }
  const lines = form.lines.filter(([, , , s]) => !s.hidden).map(([id, no, label, spec]) => ({id, no, label, heading: !!spec.h, total: !!(spec.sum || spec.total), grand: !!spec.grand,
    editablePrior: !spec.h && !spec.sum, priorOverridden: ov.has(id), current: spec.h ? null : c1.val.get(id), previous: spec.h ? null : c2.val.get(id)}));
  const checks = [...cfChecks];
  if (form.kind === 'balance') {
    for (const [col, c] of [['current', c1], ['previous', c2]]) {
      const diff = money.sub(c.val.get('TA'), c.val.get('TL'));
      if (!money.isZero(diff)) checks.push({level: cents || money.cmp(money.abs(diff), '5') > 0 ? 'error' : 'warning', message: `${col === 'current' ? 'Ataskaitinio' : 'Praėjusio'} laikotarpio turtas nesutampa su nuosavu kapitalu ir įsipareigojimais: skirtumas ${diff} EUR${cents ? '' : ' (galimas apvalinimo skirtumas)'}.`});
    }
  }
  if (c1.unmapped.length) checks.push({level: 'error', message: `Sąskaitos su likučiais, nepriskirtos jokiai formos eilutei: ${c1.unmapped.map((u) => `${u.code} (${u.amount})`).join(', ')}.`});
  return {key, form: formInfo, period: cur, previousPeriod: prev, precision: cents ? 'cents' : 'eur', company: companyInfo, lines, checks};
}
