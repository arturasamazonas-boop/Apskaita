# Fixed assets, year-end closing, cash and payment files

## Ilgalaikis turtas (*Turtas* menu)

**Asset card.**
- Fields: inventory number, name, asset account (11x0 intangible / 12x0 tangible), acquisition (in-use) date, cost, residual value and useful life in months.
- Depreciation start defaults to the month after the asset is put into use.
- Accounts: accumulated depreciation defaults to 12x7 / 11x8, expense to 6306 / 6307.
- Assets taken over from an earlier system carry the depreciation accumulated up to a given month. The program continues from the month after.
- A card can be created from a purchase invoice line booked to an 11 or 12 account.

**Method.** Straight line by months.
- Monthly amount = (cost − residual) / useful life, rounded to cents.
- The last month takes the remainder, so the total is exactly cost − residual.
- Once depreciation has been posted, financial fields are frozen. Descriptive fields (location, responsible person, notes) stay editable.

**Monthly run** (*Nusidėvėjimo skaičiavimas*).
- One journal entry on the last day of the month: D expense / K accumulated depreciation, grouped by account. Source type `depreciation`.
- Months are posted in order: a month cannot be posted while an earlier month of any asset is missing.
- Only the latest run can be cancelled. Cancelling posts a reversing entry.

**Disposal (write-off or sale).**
- Depreciation must already be posted up to and including the disposal month.
- Entry: D accumulated depreciation, D 6400 net book value / K cost. Source type `asset_disposal`.
- Sale proceeds are a separate sales invoice to 5400.

**Register.**
- Cost, accumulated depreciation and net book value at a date.
- Reconciled with ledger balances of the 11 and 12 accounts. A difference means an asset without a card, or depreciation posted by hand.

Tax depreciation (CIT law annex periods) is not tracked separately. The useful life is chosen by the accountant.

## Metų uždarymas (*Servisas → Metų uždarymas*)

1. **Close the year (31 December).** Every class 5 and 6 account with a balance is closed into 341 in one entry (source type `year_close`).
2. **Transfer the result (1 January of the next year).** The result is moved from 341 to 342 (source type `year_transfer`).

How closing entries are treated in the reports:

- **Profit (loss) statement, P&L report, FR-forms:** leave closing entries out. Excluded are the `year_close` entries and any entry that touches only 5/6 and 34x/390 accounts, so a closing entry made by hand counts too.
- **Balance sheet, current-year result (D5.1):** taken from income and expense of the year without closing entries. Everything else in 5/6, 34x and 390 is a prior-year result (D5.2).

Both entries can be reversed from the journal.

## Mokėjimų ruošimas – SEPA (*Finansai → Mokėjimų ruošimas*)

The page prepares an ISO 20022 `pain.001.001.03` credit transfer file. Lithuanian banks accept it for upload; the payments are signed in the bank.

- **Supplier invoices.** Open purchase invoices show their outstanding amount and the supplier's IBAN (from the counterparty card, else from the invoice). You can change the amount; it may not exceed the balance. The remittance text is the payment reference or the invoice number.
- **Payroll.** For an approved payroll sheet, each employee's "to pay" amount is paid to the IBAN on the employee card, with category purpose `SALA`.
- **Format rules:**
  - IBANs are checksum-validated.
  - Lithuanian letters are transliterated (SEPA character set).
  - There is one payment information block (one debtor account and one execution date), and `ChrgBr` is `SLEV`.
- **Validation.** Tests validate the file against the official ISO 20022 XSD (`vendor/sepa/pain.001.001.03.xsd`, from iso20022.org).
- **Ledger.** The file posts nothing. Payments reach the ledger when the bank statement is imported and matched.

## Kasa – cash orders (*Finansai → Kasos orderiai*)

**Orders.** A cash receipt order (KPO) or cash payment order (KIO) gets its number from the KPO / KIO series when it is saved. It is posted at once against the cash account 272.

| Operation | KPO (receipt) | KIO (payment) |
|---|---|---|
| Invoice payment | D 272 / K 2410 + allocation to the sales invoice | D 443 / K 272 + allocation to the purchase invoice |
| Advance | K 442 (counterparty) | D 208 (counterparty) |
| Bank | taken from the bank: K 273 | paid into the bank: D 273 |
| Accountable person | returned: K 2445 (employee) | given: D 2445 |
| Other | K chosen account | D chosen account |

**Rules.**
- A payment may not exceed the cash on hand at the end of that day, so the cash desk never goes negative.
- Invoice payments may not exceed the invoice's outstanding amount.
- Cash settlements over 5 000 € per transaction get a warning (*Atsiskaitymų grynaisiais pinigais ribojimo įstatymas*).

**Cancelling.** A reversing entry is posted, plus a negative allocation, so the invoice is unpaid again. A KPO that would leave the cash desk negative cannot be cancelled.

**PDF.**
- The PDF prints the order with the amount in Lithuanian words (`src/lib/lt-words.mjs`) and signature lines.
- A KPO also prints a receipt (kvitas) for the payer.

**Kasos knyga.** Every movement of 272 by day, with the opening balance, receipts, payments and closing balance.
