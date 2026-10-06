# Accounting rules

## Chart of accounts

The chart comes from the accountant's workbook (`Buhalterija_*.xlsm`, sheet *Saskaitu planas*, UAB variant). It was imported by `scripts/chart-from-xlsx.py` into `migrations/009_chart_of_accounts.sql`. The structure is class (1 digit) → group (2) → sub-group (3) → account (4). Only the deepest level is open for posting. Group accounts (`postable = false`) are rejected by the API and by a database trigger. The *Sąskaitų planas* page shows the tree.

A few application accounts were kept as sub-accounts:

| Code | Name |
|---|---|
| 2710 / 2711 | Bank accounts (271 became a group) |
| 4497 | Unidentified payments |
| 5002 | Delivery revenue |
| 6205 | Payment-processor fees |
| 6206 | Transport and delivery costs |
| 6316–6322 | Telecom, IT, professional services, entertainment, utilities, small inventory, office supplies |

A sub-account can be added under any leaf that has no postings and no posting role. The leaf then becomes a group.

**Upgrading an existing database.** Old starter accounts that already had postings are kept as inactive accounts named "(ankstesnis planas)". Unused old accounts are deleted. Bank accounts that pointed at a retired account are moved to 2710 (or 2711 for payment processors). Some codes have a new meaning; for example, 6304 is now salaries. Postings made before the change keep their code, so test data entered before migration 009 should be reviewed or re-entered.

To use the MB, VšĮ or ūkininko variant of the workbook, regenerate the migration with `python3 scripts/chart-from-xlsx.py file.xlsm MB` before the first start.

Posting roles can be remapped in *Servisas → Kontavimo susiejimai*:

| Role | Default | Role | Default |
|---|---|---|---|
| receivable | 2410 | payable | 443 |
| vat_input | 2441 | vat_output | 4492 |
| bank_default | 2710 | transfer_clearing | 273 |
| advances_received | 442 | advances_paid | 208 |
| bank_fees | 6314 | processor_fees | 6205 |
| inventory | 204 | cogs | 6000 |
| revenue_goods / services / shipping | 5000 / 5001 / 5002 | prepaid | 291 |
| fixed_assets | 1240 | retained / current result | 342 / 341 |
| unidentified | 4497 | payroll_expense | 6304 |
| payroll_payable / gpm / sodra | 4480 / 4481 / 4482 | payroll_other | 4484 |

## Posting rules

All amounts are computed as signed amounts per account and then converted to debit or credit, so credit notes reverse the sides automatically.

| Event | Entry |
|---|---|
| Purchase invoice | Dr line account (net + non-deductible VAT); Dr 2441 (deductible VAT); Cr 443 gross (counterparty) |
| Sales invoice | Dr 2410 gross (counterparty); Cr revenue accounts (net); Cr 4492 VAT |
| Credit note | Same accounts with opposite signs. Linked to the original; outstanding = original + credit notes + corrections − allocations |
| Correction of a posted document | Delta only: the current group (original + earlier corrections) is reversed line by line and the corrected lines are added. Journal entry = new − old per account. The original rows are untouched. |
| Customer payment | Dr bank / Cr 2410 (no revenue, no VAT) |
| Supplier payment | Dr 443 / Cr bank (no expense, no VAT) |
| Over-payment | Excess Cr 442 (incoming) or Dr 208 (outgoing) |
| Advance before the invoice | Dr bank / Cr 442. Applying it later: Dr 442 / Cr 2410, with **no second cash entry** |
| Bank fee | Dr 6314 / Cr bank (no VAT; a bank statement is not a VAT invoice) |
| Processor payout | Dr bank (payout) + Dr 6205 (fee) / Cr 2410 (invoice outstanding) |
| Transfer between own accounts | Dr 273 / Cr bank A, then Dr bank B / Cr 273 when the other side is imported |
| "Other" bank line | Account chosen by the user, with a required note. Flagged as needing a supporting document; VAT is never deducted |
| Cost of sales (manual) | Dr 6000 / Cr 204 per month, recorded in `cogs_periods` |

Inventory purchases go to 204 (not expenses). The P&L and balance sheet are **marked incomplete** for any month with goods sales and no confirmed cost-of-sales entry. Missing cost of sales is never treated as zero.

## Line classification

Each line gets a suggestion with an explanation, from these sources in order:

1. An approved **rule**: register, optional counterparty, optional text, priority, effective dates.
2. A **product** card (by SKU or external store mapping).
3. A built-in **keyword** suggestion.
4. The optional LLM.

Otherwise the account is left empty and must be chosen. Equipment at or above `asset_threshold` (company setting, default 500 EUR net) is suggested as a fixed asset (1240), cheaper equipment as small inventory (6321). Annual or "12 mėn." services are suggested as prepaid (291). Goods for resale are suggested as inventory (204).

Rules are created only by an explicit action from a user with the `rules` capability (from *Nustatymai* or from a reviewed line). Editing a rule creates a new version and retires the old one.

## Rounding

These are the only rounding points (ROUND_HALF_UP, i.e. half away from zero):

1. **Line net** = round₂(quantity₄ × unit price₄) − discount₂.
   - If a printed line amount differs by at most |qty| × 0.005 + 0.01, the printed amount is used and an explanation is shown. This covers unit prices printed rounded to cents.
   - A larger difference is a blocking error.
2. **VAT per tax code** = round₂(Σ line nets × rate).
   - If the document prints a VAT amount per rate within **0.01 × number of lines** of the computed amount (per-line rounding on the source), the printed amount is used and the difference is explained.
   - A larger difference blocks approval until a line, the rate or the printed VAT is corrected (or the reviewer explicitly confirms).
3. **VAT distributed to lines** (for deductible/non-deductible splits): largest-remainder allocation, so the shares always add up exactly to the group VAT.
4. **Percentage discounts** = round₂(base × pct).

Source totals and computed totals are both kept and displayed. Neither is changed silently.

## Payment status

`unpaid`, `partial`, `paid`, `overpaid`, `credited` are computed from invoice groups and approved allocations as of a date. This status is independent of the approval status of the document.

## Payroll

| Event | Entry |
|---|---|
| Approved monthly payroll sheet | Dr employee expense account (6304 by default, or 6203 / 6003 per employee) with gross pay plus employer Sodra; Cr 4480 net pay; Cr 4481 GPM; Cr 4482 employee VSD + PSD + extra pension plus employer Sodra. The entry date is the last day of the month. |
| Cancelling an approval | Reversal entry; the sheet returns to draft. Re-approving posts a new entry. |
| Paying salaries and taxes | Bank line "Kita (pasirinkta sąskaita)" to 4480 / 4481 / 4482. |

See [PAYROLL.md](PAYROLL.md) for the calculation.

## Stock

Product quantities come from posted invoice lines linked to a product: purchases add stock and sales subtract it, and credit notes reverse automatically through their negative quantities. Manual movements add to this: opening balance, count adjustment and write-off (a write-off needs a reason). Movements are immutable, so a wrong one is corrected with another adjustment.

Average cost is the weighted cost of incoming quantities. It is informational only; the ledger inventory value is account 204, posted by purchases and the monthly COGS entry.
