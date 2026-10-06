// Unit tests: exact money arithmetic and rounding, identifiers, parsers, VAT tolerance logic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {money, parseAmount, toUnits, fromUnits, divRound} from '../src/lib/money.mjs';
import {ltVatValid, ibanValid, numberKey, normalizeName} from '../src/extraction/ids.mjs';
import {parseDate} from '../src/extraction/invoice-parser.mjs';
import {computeProposal, taxCodeFor, contentHash} from '../src/invoices/engine.mjs';
import {validateLines} from '../src/ledger/ledger.mjs';
import {balanceCheck, fingerprint} from '../src/bank/import.mjs';

test('money: exact decimal arithmetic, no float drift', () => {
  assert.equal(money.add('0.10', '0.20'), '0.30');
  assert.equal(money.sum(Array(10).fill('0.10')), '1.00');
  assert.equal(money.sub('1000000000.01', '0.02'), '999999999.99');
  assert.equal(money.neg('5.00'), '-5.00');
  assert.equal(fromUnits(toUnits('-0.05')), '-0.05');
});

test('rounding: ROUND_HALF_UP (away from zero) at documented points', () => {
  assert.equal(money.vat('100.00', '21'), '21.00');
  assert.equal(money.vat('0.10', '21'), '0.02');   // 0.021 → 0.02
  assert.equal(money.vat('0.50', '21'), '0.11');   // 0.105 → 0.11 (half up)
  assert.equal(money.vat('-0.50', '21'), '-0.11'); // symmetric for credit notes
  assert.equal(money.vat('33.33', '9'), '3.00');   // 2.9997
  assert.equal(money.lineNet('3', '33.3333'), '100.00');
  assert.equal(money.lineNet('0.335', '10'), '3.35');
  assert.equal(money.lineNet('2', '4.505'), '9.01');
  assert.equal(money.lineNet('2', '4.50', '1.00'), '8.00');
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(toUnits('1.005'), 101n);
});

test('allocation of a total by weights sums exactly', () => {
  assert.deepEqual(money.allocate('10.00', ['1', '1', '1']), ['3.34', '3.33', '3.33']);
  assert.deepEqual(money.allocate('0.05', ['1', '1']), ['0.03', '0.02']);
  assert.deepEqual(money.allocate('-0.05', ['1', '2']), ['-0.02', '-0.03']);
  const parts = money.allocate('199.50', ['45.00', '899.00', '6.00']);
  assert.equal(money.sum(parts), '199.50');
});

test('parseAmount handles Lithuanian and international formats', () => {
  assert.equal(parseAmount('1 234,56'), '1234.56');
  assert.equal(parseAmount('1.234,56'), '1234.56');
  assert.equal(parseAmount('1,234.56'), '1234.56');
  assert.equal(parseAmount('-2,50'), '-2.50');
  assert.equal(parseAmount('12,50 €'), '12.50');
  assert.equal(parseAmount('(10,00)'), '-10.00');
  assert.equal(parseAmount('4D'), null);
  assert.equal(parseAmount('abc'), null);
});

test('dates: ISO, Lithuanian dotted and long forms', () => {
  assert.equal(parseDate('2026-09-03'), '2026-09-03');
  assert.equal(parseDate('03.09.2026'), '2026-09-03');
  assert.equal(parseDate('2026.09.03'), '2026-09-03');
  assert.equal(parseDate('2026 m. rugsėjo 5 d.'), '2026-09-05');
  assert.equal(parseDate('2026-02-30'), null);
});

test('identifiers: LT VAT check digit, IBAN mod-97, number keys', () => {
  assert.equal(ltVatValid('LT222222219'), true);
  assert.equal(ltVatValid('LT222222218'), false);
  assert.equal(ltVatValid('LT100015555519'), true);
  assert.equal(ibanValid('LT601010012345678901'), true);
  assert.equal(ibanValid('LT601010012345678902'), false);
  assert.equal(numberKey('BT', '000123'), 'BT123');
  assert.equal(numberKey('', 'BT-000123'), 'BT123');
  assert.equal(normalizeName('UAB „Biuro tiekimas“'), 'biuro tiekimas');
});

test('ledger validation rejects unbalanced or malformed lines', () => {
  assert.equal(validateLines([{account: '1', debit: '10'}, {account: '2', credit: '10'}]).ok, true);
  assert.equal(validateLines([{account: '1', debit: '10'}, {account: '2', credit: '9.99'}]).ok, false);
  assert.equal(validateLines([{account: '1', debit: '10', credit: '10'}, {account: '2', credit: '0'}]).ok, false);
  assert.equal(validateLines([{account: '1', debit: '10'}]).ok, false);
});

const taxCodes = [
  {code: 'PVM1', isaf_code: 'PVM1', rate: '21.00', applies_to: 'both', effective_from: '2009-09-01', effective_to: null, active: true},
  {code: 'PVM2', isaf_code: 'PVM2', rate: '9.00', applies_to: 'both', effective_from: '2009-09-01', effective_to: '2025-12-31', active: true},
  {code: 'PVM58', isaf_code: 'PVM58', rate: '12.00', applies_to: 'both', effective_from: '2026-01-01', effective_to: null, active: true},
];
const ctx = {
  company: {vat_registered: true, locked_through: null, currency: 'EUR', asset_threshold: '500.00'},
  roles: {payable: '4430', receivable: '2410', vat_input: '2441', vat_output: '4492'},
  accounts: new Map([['6308', {type: 'expense', name: 'x'}], ['4430', {type: 'liability'}], ['2441', {type: 'asset'}], ['5000', {type: 'revenue'}]]),
  taxCodes, today: '2026-10-06', duplicates: {},
};
const line = (o) => ({description: 'x', quantity: '1', unitPrice: '10.00', discount: '0', sourceNet: '', vatRate: '21', taxCode: 'PVM1', accountCode: '6308', lineType: 'expense', vatTreatment: 'deductible', ...o});
const base = (o) => ({docType: 'vat_invoice', register: 'purchase', number: '1', issueDate: '2026-09-01', currency: 'EUR', counterparty: {name: 'A', vatCode: 'LT222222219'}, lines: [line()], sourceTotals: {net: '', vat: '', gross: '', vatByRate: []}, provenance: {}, ...o});

test('tax codes respect effective dates (9 % ended 2025-12-31; 12 % from 2026)', () => {
  assert.equal(taxCodeFor('9', '2025-06-01', 'purchase', taxCodes), 'PVM2');
  assert.equal(taxCodeFor('9', '2026-03-01', 'purchase', taxCodes), null);
  assert.equal(taxCodeFor('12', '2026-03-01', 'sales', taxCodes), 'PVM58');
  assert.equal(taxCodeFor('0', '2026-03-01', 'sales', taxCodes), null);
});

test('VAT: printed per-line-rounded VAT within tolerance is used and explained; larger difference blocks', () => {
  // Three lines of 0.50 at 21 %: per-line VAT 0.11 × 3 = 0.33; on total 1.50 × 21 % = 0.32 (0.315 → 0.32).
  const lines = [line({unitPrice: '0.50'}), line({unitPrice: '0.50'}), line({unitPrice: '0.50'})];
  const ok = computeProposal(base({lines, sourceTotals: {net: '1.50', vat: '0.33', gross: '1.83', vatByRate: [{rate: '21', amount: '0.33'}]}}), ctx);
  assert.equal(ok.blocking, false, JSON.stringify(ok.issues));
  assert.equal(ok.computed.vat, '0.33');
  assert.ok(ok.issues.some((i) => i.code === 'vat_rounding'));
  const bad = computeProposal(base({lines, sourceTotals: {net: '1.50', vat: '0.50', gross: '2.00', vatByRate: [{rate: '21', amount: '0.50'}]}}), ctx);
  assert.ok(bad.issues.some((i) => i.code === 'vat_mismatch' && i.level === 'error'));
});

test('entries are balanced; non-deductible VAT is added to cost; credit notes reverse sides', () => {
  const c = computeProposal(base({lines: [line({unitPrice: '100.00', vatTreatment: 'non_deductible'})]}), ctx);
  assert.deepEqual(c.computed.entries.map((e) => [e.account, e.debit, e.credit]), [['6308', '121.00', '0.00'], ['4430', '0.00', '121.00']]);
  const cn = computeProposal(base({docType: 'credit_note', lines: [line({quantity: '-1', unitPrice: '100.00'})]}), ctx);
  assert.deepEqual(cn.computed.entries.map((e) => [e.account, e.debit, e.credit]), [['6308', '0.00', '100.00'], ['2441', '0.00', '21.00'], ['4430', '121.00', '0.00']]);
});

test('content hash is order-independent and changes with data', () => {
  assert.equal(contentHash({a: 1, b: [1, 2]}), contentHash({b: [1, 2], a: 1}));
  assert.notEqual(contentHash({a: 1}), contentHash({a: 2}));
});

test('bank: balance check and fingerprint stability', () => {
  assert.equal(balanceCheck({opening: '100.00', closing: '150.00'}, [{amount: '60.00'}, {amount: '-10.00'}]).status, 'ok');
  assert.equal(balanceCheck({opening: '100.00', closing: '151.00'}, [{amount: '60.00'}, {amount: '-10.00'}]).status, 'mismatch');
  assert.equal(balanceCheck({opening: null, closing: null}, []).status, 'missing');
  const r = {bookingDate: '2026-09-12', amount: '50.00', counterpartyIban: 'LT091234567890123456', counterpartyName: 'Jonas', reference: 'Užsakymas 1042'};
  assert.equal(fingerprint(1, r), fingerprint(1, {...r, reference: 'UZSAKYMAS 1042'}));
  assert.notEqual(fingerprint(1, r), fingerprint(2, r));
});
