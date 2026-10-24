# Time-savers for the accountant and the director

## Vadovo suvestinė (Ataskaitos → Vadovo suvestinė, also on the toolbar)

- **Key figures:**
  - cash in bank and the cash desk (ledger balance of 271, 272 and the bank accounts' ledger accounts);
  - sales this year, with the change against the same period last year;
  - gross margin;
  - net result;
  - receivables and payables, with the overdue part;
  - DSO and DPO: open balance divided by the last 90 days' invoices with VAT, × 90;
  - an estimate of the VAT payable (balance of the output and input VAT accounts).
- **Management P&L by month:** from the ledger, without year-end closing entries.
  - Lines: sales revenue (50), cost of sales (60), gross profit and margin %, operating costs (62–63), other activity (51, 54, 61, 64), EBITDA, depreciation, EBIT, finance (55–59, 65–68), profit tax (69), net result.
  - Depreciation means expense accounts whose name contains "nusidėvėjimas" or "amortizacija".
  - Downloadable as XLSX or CSV (`/api/reports/management-pl?year=`).
- **Cash forecast, 8 weeks:**
  - open sales and purchase invoices by due date;
  - an invoice without a due date counts at issue date + 30 days;
  - overdue invoices go into the first week.
  - It does **not** include payroll, taxes, loan repayments or invoices not yet issued.
- **Top customers this year and largest debtors.** Clicking a debtor opens the debt reconciliation act.

## Mėnesio uždarymas (Servisas or Finansai → Mėnesio uždarymas)

One checklist for a month. Every item links to the page where it is fixed.

- **Documents:** inbox documents dated up to the month end, or undated.
- **Bank:**
  - unreconciled operations of the month;
  - statements with a balance problem;
  - a missing statement for the last days of the month;
  - the statement closing balance against the ledger. A difference made up only of unapproved operations is a warning; any other difference is an error.
  - the unidentified-payments account;
  - a negative cash balance.
- **Month-end entries:** checked only when the item exists for the company.
  - depreciation;
  - cost of sales;
  - payroll sheet approved;
  - loan interest accrued to the month end;
  - revaluation of foreign-currency items. This one is informational.
- **VAT:** output and input VAT turnover of the month and the net amount, with a link to FR0600.
- **Locking:** the button locks the period through the month end, using the same rule as Laikotarpių užrakinimas.

## Bank

- **Recurring payments without an invoice** (rent, taxes, leasing):
  - When no open invoice matches, the suggestion repeats the last approved booking with the same counterparty IBAN, or the same name when there is no IBAN, in the same direction.
  - This applies only when that booking was a single "other" or "fee" line to an active account. The account and the note are reused, with the earlier operation as evidence.
- **Bulk approval:** on the operations list, ready proposals can be ticked, or all ticked with "Pažymėti visus paruoštus", and approved together. A ready proposal has no errors and is not ambiguous. Each one is approved separately, so a stale one does not stop the others.
- **Pasiūlyti iš naujo:** re-runs matching for open operations, for example after new invoices arrive. Proposals edited by hand are left alone.

## Purchases and sales: counterparty memory

When no approved rule or product card applies to a line, the line gets the booking used on the counterparty's posted invoices from the last 2 years. The account, the line type and a non-review VAT treatment are reused.

- A line with exactly the same description is booked as before.
- Otherwise, if all the counterparty's earlier lines went to one account, that account is used. Assets and prepayments are never spread this way.

The suggestion source shows as "ankstesnės kontrahento sąskaitos", and the explanation names the earlier invoice. A manual invoice typed with the name or code of a known counterparty is linked to that counterparty.

## Global search

The search box is in the header (Ctrl+K or "/"). It finds:
- invoices by number, counterparty or amount;
- counterparties by name, code, VAT code or IBAN;
- bank operations by counterparty, purpose or amount;
- documents;
- products;
- journal entries by text or number.

Use the arrow keys and Enter to open a result.
