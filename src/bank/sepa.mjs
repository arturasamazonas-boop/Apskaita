// SEPA credit transfer initiation file (ISO 20022 pain.001.001.03), accepted for upload by Lithuanian banks
// (Swedbank, SEB, Luminor, Šiaulių bankas, Revolut Business …). The file only prepares payments: they are signed and sent in the bank.
import {money} from '../lib/money.mjs';
import {ibanValid, normalizeIban} from '../extraction/ids.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// SEPA character set: Latin letters, digits and / - ? : ( ) . , ' + space. Lithuanian letters are transliterated.
const LT = {ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z', Ą: 'A', Č: 'C', Ę: 'E', Ė: 'E', Į: 'I', Š: 'S', Ų: 'U', Ū: 'U', Ž: 'Z'};
export const sepaText = (s, max) => String(s ?? '').replace(/[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/g, (c) => LT[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[„“"]/g, '').replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const id35 = (s) => String(s).replace(/[^A-Za-z0-9/\-?:().,'+]/g, '').slice(0, 35) || 'NOTPROVIDED';

/** Validate payments; returns {ok, errors:[{index, message}]} */
export function checkPayments(debtor, payments) {
  const errors = [];
  if (!ibanValid(normalizeIban(debtor.iban))) errors.push({index: -1, message: `Mokėtojo sąskaita ${debtor.iban || '(tuščia)'} – netinkamas IBAN.`});
  payments.forEach((p, i) => {
    if (!p.name) errors.push({index: i, message: `${p.label || i + 1}: nenurodytas gavėjas.`});
    if (!ibanValid(normalizeIban(p.iban))) errors.push({index: i, message: `${p.label || p.name}: gavėjo IBAN ${p.iban || 'nenurodytas'} netinkamas.`});
    if (!/^\d+(\.\d{1,2})?$/.test(String(p.amount)) || money.cmp(p.amount, '0') <= 0) errors.push({index: i, message: `${p.label || p.name}: suma turi būti teigiama.`});
    if (money.cmp(p.amount || '0', '999999999.99') > 0) errors.push({index: i, message: `${p.label || p.name}: per didelė suma.`});
  });
  return {ok: errors.length === 0, errors};
}

/** pain.001.001.03 XML: one payment information block (one debtor account, one execution date). */
export function buildPain001({msgId, created, debtor, executionDate, payments, categoryPurpose = null}) {
  const total = money.sum(payments.map((p) => p.amount));
  const tx = payments.map((p) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${esc(id35(p.endToEndId))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${money.norm(p.amount)}</InstdAmt></Amt>
        <Cdtr><Nm>${esc(sepaText(p.name, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${esc(normalizeIban(p.iban))}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${esc(sepaText(p.remittance, 140) || 'Mokejimas')}</Ustrd></RmtInf>
      </CdtTrfTxInf>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${esc(id35(msgId))}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <NbOfTxs>${payments.length}</NbOfTxs>
      <CtrlSum>${total}</CtrlSum>
      <InitgPty><Nm>${esc(sepaText(debtor.name, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(id35(`${msgId}-1`))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${payments.length}</NbOfTxs>
      <CtrlSum>${total}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl>${categoryPurpose ? `<CtgyPurp><Cd>${esc(categoryPurpose)}</Cd></CtgyPurp>` : ''}</PmtTpInf>
      <ReqdExctnDt>${executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${esc(sepaText(debtor.name, 70))}</Nm>${debtor.companyCode ? `<Id><OrgId><Othr><Id>${esc(debtor.companyCode)}</Id></Othr></OrgId></Id>` : ''}</Dbtr>
      <DbtrAcct><Id><IBAN>${esc(normalizeIban(debtor.iban))}</IBAN></Id><Ccy>EUR</Ccy></DbtrAcct>
      <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}
