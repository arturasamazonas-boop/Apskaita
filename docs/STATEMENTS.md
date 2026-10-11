# Financial statements in the official forms (VAS)

Menu: *Ataskaitos*. Every form can be viewed on screen, downloaded as a PDF laid out like the form, or opened in a new tab. Amounts come only from posted journal lines, grouped by the chart of accounts (migration 009).

| Form | Standard and annex | Who uses it |
|---|---|---|
| Balansas | 2 VAS „Balansas“ (VAS-41), 1 priedas | Medium and large companies; small companies that choose the full balance sheet |
| Sutrumpintas balansas | 2 VAS, 2 priedas | Small companies that choose the abbreviated balance sheet |
| Labai mažų įmonių trumpas balansas | 2 VAS, 3 priedas | Very small companies |
| Pelno (nuostolių) ataskaita | 3 VAS „Pelno (nuostolių) ataskaita“ (VAS-40), 1 priedas | All companies except very small ones that choose the short form |
| Trumpa pelno (nuostolių) ataskaita | 3 VAS, 2 priedas | Very small companies that choose the short form |

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

## Not included

- Cash flow statement and statement of changes in equity (required from medium and large companies).
- Explanatory notes.
- MB, VšĮ and farmer forms.
- Direct filing to Registrų centras: download the PDF and submit it through the JAR e-services.
