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

## Inbox: approve and next

**Patvirtinti ir kitas ›** (also Ctrl+Enter) approves the document and opens the next one waiting in the inbox: ready ones first, then those that need review. Rejecting does the same. A draft from a recurring template opens the next such draft. An invoice issued here goes back to the list as before.

## Mokesčių kalendorius (Ataskaitos → Mokesčių kalendorius ir pateikimai)

Returns and payments with their deadlines, computed from general rules:

| Obligation | Deadline | Shown when |
|---|---|---|
| GPM313, SAM, payment of GPM and Sodra contributions | 15th of the next month | The company has employees or payroll sheets |
| i.SAF | 20th of the next month | The company is a VAT payer |
| FR0600 and VAT payment | 25th of the next month | The company is a VAT payer |
| FR0564 | 25th of the next month | Only for months with PVM13 sales |
| PLN204 and profit tax | 15 June | Every year |
| Annual set to Registrų centras | 30 May | Every year (approved within 4 months, filed within 30 days) |

A deadline on a weekend or public holiday moves to the next working day. The program does not file returns.

- After filing in EDS or EDAS, mark the return with **Pateikta** / **Sumokėta**. You can add the registration number.
- **Pažymėti visas vėluojančias pateiktomis** marks returns filed before the program was used.
- Overdue and upcoming returns show on the dashboard (*Mokesčių terminai*) and in the month-close checklist.
- Special regimes (half-yearly VAT, profit tax advances) are **not** in the calendar.

## FR0564 data (Ataskaitos → FR0564 duomenys)

Sales with tax code PVM13, by VAT point month, grouped by buyer country and VAT code, in cents and in whole euros. Buyers without a valid EU VAT code are flagged. Copy the lines into the FR0564 form in EDS: an EDS upload file is not generated for this form.

## Bank: remembered column mapping

- The first time a CSV/XLSX file has headers the program cannot recognise, map the columns in the preview. The mapping is saved for that header row when you import.
- The next file with the same headers, from any bank (Swedbank, SEB, Luminor…), is mapped automatically. The preview says so.
- No built-in Swedbank or SEB profile is included, because no sample file was available to test against.

## Savikaina: automatic calculation

**Apskaičiuoti pagal prekių judėjimą** on the Savikaina page calculates the month's cost of sales:

- For each goods product: the quantity sold in the month (net of credit notes) × the weighted average cost of the goods received up to the month end. Goods received means purchases, opening balances and positive adjustments that have a cost.
- A product with no purchases uses the purchase price on its card. This is flagged.
- A product with no cost at all is left out and flagged.
- Goods sales lines without a product card are flagged with their amount, to be added by hand.
- A negative stock at the month end is flagged.

The amount is filled into the form, and the accountant posts it as before (D 6000 / K 204, one entry per month).

## Pasikartojančios sąskaitos (Prekyba → Pasikartojančios sąskaitos)

A template holds the customer, lines, period (every 1, 2, 3, 6 or 12 months), first date, optional end date, payment term and series. Every day from 06:00, or with **Sukurti suėjusius juodraščius dabar**, it creates a draft sales invoice for each date that has come:

- missed periods are caught up;
- the day of the month is kept (31 → 28/29 → 31);
- a draft is never dated in the future.

Drafts are ordinary proposals. The number is given and the invoice is posted only when the draft is approved. Drafts waiting for approval are listed on the same tab.

## Atostoginiai pagal VDU (payroll sheet → VDU)

The **VDU** button next to *Atostoginiai* asks for the number of vacation working days and fills in the amount:

- **average daily pay** = earnings of the last 3 calendar months before the vacation month (base, bonuses and other pay from approved sheets, without earlier vacation or sick pay) / days actually worked in those months;
- **vacation pay** = average daily pay × vacation days.

When there are no worked months yet, the monthly salary / working days of the month is used.

Simplifications:
- annual and quarterly bonuses are counted in the month they were paid, not spread over the year;
- the hourly variant for summed working time is not implemented.

Reduce the worked days and press *Perskaičiuoti*.
