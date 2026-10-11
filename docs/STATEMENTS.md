# Financial statements in the official forms (VAS)

Menu: *Ataskaitos*. Every form can be viewed on screen, downloaded as a PDF laid out like the form, or opened in a new tab. Amounts come only from posted journal lines, grouped by the chart of accounts (migration 009).

| Form | Standard and annex | Who uses it |
|---|---|---|
| Balansas | 2 VAS „Balansas“ (VAS-41), 1 priedas | Medium and large companies; small companies that choose the full balance sheet |
| Sutrumpintas balansas | 2 VAS, 2 priedas | Small companies that choose the abbreviated balance sheet |
| Labai mažų įmonių trumpas balansas | 2 VAS, 3 priedas | Very small companies |
| Pelno (nuostolių) ataskaita | 3 VAS „Pelno (nuostolių) ataskaita“ (VAS-40), 1 priedas | All companies except very small ones that choose the short form |
| Trumpa pelno (nuostolių) ataskaita | 3 VAS, 2 priedas | Very small companies that choose the short form |
| Pinigų srautų ataskaita (netiesioginis būdas) | 5 VAS „Pinigų srautų ataskaita“ (VAS-14), 2 priedas | Medium and large companies (voluntary for small ones) |
| Pinigų srautų ataskaita (tiesioginis būdas) | 5 VAS, 1 priedas | Same; choose one method |
| Nuosavo kapitalo pokyčių ataskaita | 4 VAS „Nuosavo kapitalo pokyčių ataskaita“ (VAS-6), 1 priedas | Medium and large companies (voluntary for small ones) |

**Sources:**

- The balance sheet line items were taken from the text of VAS-41 published in the Register of Legal Acts (e-seimas).
- The full P&L follows the accountant's workbook (*P(N) ATASKAITA*, 15 items).
- The short P&L items (9) follow the published description of 3 VAS annex 2.

Check the forms against the current consolidated text of the standards before filing.

## Form header and signatures

The header follows the form layout:

- legal form, name and code;
- registered address, with the register where the data are kept (Juridinių asmenų registras);
- legal status, only if the company is in liquidation, reorganisation or bankruptcy;
- approval mark;
- the title "YYYY-MM-DD BALANSAS" or "… PELNO (NUOSTOLIŲ) ATASKAITA";
- date of compilation and number;
- reporting period;
- precision and currency.

Two signature lines (manager, accountant) show the title and name. The defaults are stored in the company settings and can be saved from the form page.

Columns: *Eil. Nr.*, *Straipsniai*, *Pastabos Nr.* (left empty for the explanatory notes), *Ataskaitinis laikotarpis*, *Praėjęs ataskaitinis laikotarpis*. Negative amounts are shown in parentheses and zero as "–".

**Precision:** whole euros (the default) or euros and cents. With whole euros each item is rounded half-up and totals are the sum of the rounded items. A difference of a few euros between total assets and total equity and liabilities can then appear; it is shown as a warning.

## Mapping (UAB chart)

**Balance sheet, annex 1.** Each item corresponds to the 3-digit group of the same name:

| Items | Groups |
|---|---|
| A.1.1–1.6 | 111–116 (110 in 1.5) |
| A.2.1–2.7 | 120–126; investment property 1250 / 1251 |
| A.3.1–3.9 | 160–168 |
| A.4.1–4.3 | 171–173 |
| B.1.1 | 201, 209 (fuel) |
| B.1.2–1.5 | 202–205 |
| B.1.6 | 206, 207 |
| B.1.7 | 208 |
| B.2.1–2.3 | 241–243 |
| B.2.4 | 244, 263 |
| B.3.1 / 3.2 | 261 / 262 |
| B.4 | 27 |
| C | 29 |
| D.1.1 | 301, 305, 308 |
| D.1.2 | 302, 309 |
| D.1.3 | 303 |
| D.2 | 304 |
| D.3 | 32 |
| D.4.1–4.3 | 331–333 |
| E | 40 |
| F.1–3 | 411–413 |
| G.1.1–1.8 | 421–428 |
| G.2.1–2.10 | 440–449 |
| H | 49 |

Contra accounts (depreciation and amortisation, "(-)") reduce their item.

**Undistributed result.** Income and expense accounts are not closed during the year, so the result is calculated:

- *Ataskaitinių metų pelnas (nuostoliai)* = 341 + income and expenses of the year up to the balance-sheet date;
- *Ankstesnių metų pelnas (nuostoliai)* = 342, 390 + income and expenses of earlier years.

Total assets therefore equal total equity and liabilities without year-end closing entries.

**Abbreviated (annex 2) and very small (annex 3) balance sheets** use the 2-digit groups. The very small form has fewer items:

- *Kitas ilgalaikis turtas* = 11 + 16 + 17;
- *Kitas trumpalaikis turtas* = 24 + 26 + 27.

**P&L, annex 1:**

| Item | Groups |
|---|---|
| 1 | 50 |
| 2 | 60 |
| 3 | 51 + 61 |
| 5 | 62 |
| 6 | 63 |
| 7 (other activities) | 52, 54 + 64 |
| 8 | 55 |
| 9 | 56 |
| 10 | 57, 58 |
| 11 | 67 |
| 12 | 65, 66, 68 |
| 14 | 69 |

Subtotals 4, 13 and 15 are calculated. Income is positive and expenses negative.

**Short P&L, annex 2 (by nature of expense):**

| Item | Groups |
|---|---|
| 1 | 50 |
| 2 | other income 51–59 |
| 3 bought stock and resources used | debit turnover of inventory accounts 20 + other 60/61 accounts (except 6000, 6005, 6003) |
| 4 change in stock | closing − opening balance of 20 |
| 5 employment costs | 6003, 6203, 6304 and the expense accounts of employees |
| 6 depreciation, amortisation and impairment | 6201, 6306, 6307, 6309, 67 |
| 7 other expenses | remaining 62–68 |
| 8 | 69 |

Items 3 and 4 together equal the cost of goods sold when stock moves only through purchases and the cost-of-sales posting.

## Checks

- Any account with a balance that no item covers is listed as an error, so nothing disappears silently.
- For balance sheets, total assets are compared with total equity and liabilities.

## Previous period

The previous-period column is calculated from the ledger:

- balance sheet: the previous year-end, or the date entered;
- P&L: the same period one year earlier.

For the year before the company started using the program, the amounts can be entered by hand with *Įvesti praėjusio laikotarpio sumas ranka*. This needs the `approve` capability. Only items without sub-items can be entered; totals are recalculated. Manually entered amounts are shown in italics, and every change is written to the audit log.

## Cash flow statement (5 VAS)

**Sources and form.** The line items were taken from the VAS-14 text in the Register of Legal Acts (e-seimas). That text is the 2010 approval, in force since 2011. Check the current consolidated text before filing; the standard was later amended for periods from 2016. The columns are *Finansiniai metai* and *Praėję finansiniai metai*.

**What counts as a movement.** Every journal line of the period counts, except two kinds of entry:

- *Opening-balance entries* count as the opening balance.
- *Year-end closing entries*, which contain only income/expense accounts and 34x, are ignored.

Every account is assigned to exactly one line, so V (net change) always equals the change in cash (accounts 27). VI and VII are the cash balances at the start and end. A mismatch would be reported as an error.

**Indirect method (annex 2):**

| Lines | Calculation |
|---|---|
| I.1 | Net result: income and expense of the period |
| I.2 | Depreciation and amortisation expense (6201, 6306, 6307) |
| I.3–I.16 | Changes in the balance-sheet groups named in each line, with the sign as on the form (an asset increase is negative, a liability increase positive) |
| I.17 | Gain or loss on disposal of fixed assets (5400, 6400), moved to II.2 |
| I.18 | Interest and investment income and costs, moved to II.7 and III.2.2.3 |
| I.19 | Impairment (6309, 67), revaluation (32, 1xx1) and deferred tax (171) |
| II.1 | Debit turnover of fixed-asset cost accounts (11x/12x), net of new lease liabilities |
| II.2 | The rest of the fixed-asset movement (disposal proceeds) |
| II.3–II.6 | Investments and loans granted, gross: debits are acquisitions or loans given, credits are disposals or repayments |
| III.1.1–III.1.3 | Capital accounts |
| III.1.4 | Dividends paid: 33, 34x, 390, 4490, 4491, 4495 together, so declared but unpaid dividends and reserve transfers net out |
| III.2.1 / III.2.2 | Borrowings, gross (422, 441, 4214, 4403, 4404; bonds 4210, 4400; lease repayments 4211, 4401) |
| IV | 0, because all postings are in EUR |

**Direct method (annex 1).** Each entry with cash lines is split over its other lines, and the counter-account decides the line:

| Counter-account | Line |
|---|---|
| Customers and income | I.1.1 |
| Suppliers and expenses | I.2.1 |
| Salaries and payroll taxes (448) | I.2.2 |
| VAT and other taxes paid to the budget | I.2.3 |
| Fixed assets, investments, loans granted, interest income | II |
| Capital, dividends, borrowings, interest paid | III |
| Anything else | I.1.2 (receipts) / I.2.4 (payments) |

VAT in the same entry as a customer or supplier is shown with them ("su PVM"). Transfers between own cash accounts are not flows.

## Statement of changes in equity (4 VAS)

**Sources and form.** The rows and columns were taken from the VAS-6 text (2015, in force from 2016). The statement covers two years, with rows 1–30.

**Columns:**

| Column | Accounts |
|---|---|
| Paid-up capital | 301, 302, 305, 308, 309 |
| Share premium | 304 |
| Own shares | 303 |
| Revaluation reserve, fixed assets | 321 |
| Revaluation reserve, financial assets | 322 |
| Legal reserves | 331, 332 |
| Other reserves | 333 |
| Undistributed result | 34x, 390, plus income and expenses not yet closed |
| Total | Sum of the columns |

**Rows:**

- **Balance rows (1, 17, 30):** balances at the end of the year before last, of the previous year and of the reporting period. Opening-balance entries dated inside a year belong to that year's opening row.
- **Net result (9, 22):** from income and expenses; closing entries are ignored.
- **Other movements:** classified by the other side of the entry:
  - reserves formed or used → 12/25 and 13/26;
  - dividends payable (4490) → 10/23;
  - capital accounts → 14/27, or 16/29 for 308/309;
  - revaluation → 5/18 (fixed assets) or 8/21 (financial assets);
  - own shares → 7/20;
  - anything else in the undistributed result → 11/24.
- **Rows 2, 3 and 6 (2, 3 also in the second year):** accounting policy changes, error corrections and hedging are not recorded separately and stay 0.

Each column is checked: start + movements = end balance. Row 30 equals equity in the balance sheet. The PDF is printed in landscape.

## Annual set for Registrų centras (*Ataskaitos → Metinis rinkinys Registrų centrui*)

**Size category.** The company's size is worked out from the ledger: total assets and sales at year end, and employees on the employee list. The thresholds are those of the Financial Statements Act, art. 5, as amended in 2024: not exceeding two of the three.
- Very small (labai maža): 450 000 € assets, 900 000 € revenue, 10 staff.
- Small (maža): 5 000 000 €, 10 000 000 €, 50.
- Medium (vidutinė): 25 000 000 €, 50 000 000 €, 250.

The category can be chosen by hand.

**Forms in the set.**
- Very small: short balance sheet (annex 3) and short P&L (annex 2).
- Small: abridged balance sheet (annex 2) and P&L.
- Medium or large: full balance sheet, P&L, cash flow statement and statement of changes in equity.

The fuller form of the same statement can be chosen instead. The documents to attach are listed on the page.

**Checks, as on the RC e-form:**
- Assets equal equity and liabilities in each balance sheet.
- Net profit in the P&L equals the balance sheet's "current-year profit (loss)".
- Cash at the end in the cash flow statement equals the balance sheet.
- Closing equity in the statement of changes in equity equals the balance sheet.
- Manually entered prior-year figures are flagged: RC loads last year's set itself.
- Precision must be whole euros.

**Output.**
- The whole set as one PDF, for approval, signing and attaching.
- The line data (form, line number, item, current year, prior year) as XLSX or CSV. On the page, clicking an amount copies it.

**Deadlines.** The general meeting approves the set within 4 months after the year end (by 30 April), and the set is filed with RC within 30 days of approval.

The RC e-form itself (registrucentras.lt) was not reachable from the development environment. The line numbering follows the VAS annexes the e-form uses. No data-file import for small companies was found in public sources.

## Other reports

### PVM deklaracijos FR0600 duomenys

Field amounts come from invoices whose VAT point falls in the period, using FR0600 version 3 (2026, with field 29A for the 12 % rate).

| Field | Source |
|---|---|
| 11 | Taxable value of sales at 21 %, 12 %, 9 % and 5 % |
| 13 | Exempt sales (PVM5) |
| 17 | Export (PVM12) |
| 18 | Supplies of goods to EU VAT payers (PVM13) |
| 19 | Other 0 % sales |
| 25 | Deductible purchase VAT |
| 29 / 29A / 30 / 31 | Output VAT at 21 / 12 / 9 / 5 % |
| 35 | Deductible VAT (= 25) |
| 36 | Payable (29 + 29A + 30 + 31 − 35) |

Reverse charge, import and EU acquisitions (12, 21–24, 26, 27, 32–34) are marked as not filled automatically. The return itself is submitted in VMI EDS.

The table above is the breakdown. The return itself, on the official form with an EDS upload file (.ffdata) and a PDF, is described in [EDS.md](EDS.md).

### Skolų suderinimo aktas

For one counterparty on a date the act shows:

- *Jūsų skola mums (+)*: receivable and advances paid;
- *Mūsų skola jums (–)*: payable and advances received;
- the balance and the list of open invoices.

Amounts come from ledger lines with that counterparty. The PDF has signature blocks and a confirmation section for the counterparty.

### Kitos ataskaitos

*Ataskaitos → Kitos ataskaitos ▸* collects the analytical reports:

- apyvartos žiniaraštis (trial balance), didžioji knyga, kasos knyga (account 272);
- profit and balance sheet by account;
- receivables and payables, the debt reconciliation act;
- sales, orders, purchases and payments.

## Not included

- Explanatory notes.
- MB, VšĮ and farmer forms.
- Direct filing to Registrų centras: download the PDF and submit it through the JAR e-services.
