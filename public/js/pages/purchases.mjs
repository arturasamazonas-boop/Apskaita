import {invoiceList, invoiceDetail, manualForm} from './invoices.mjs';

export async function render(main, rest, state) {
  if (rest[0] === 'nauja') return manualForm(main, 'purchase', state);
  if (rest[0] === 's') return invoiceDetail(main, rest[1], state);
  return invoiceList(main, 'purchase', state);
}
