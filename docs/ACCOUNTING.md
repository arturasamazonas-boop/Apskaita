# Accounting rules

The starter chart (migration `005_reference_data.sql`) is a simplified version of common Lithuanian numbering. **The company's accountant must review it.** The posting roles below can be remapped in *Nustatymai → Kontavimo susiejimai*.

| Role | Default | Role | Default |
|---|---|---|---|
| receivable | 2410 | payable | 4430 |
| vat_input | 2441 | vat_output | 4492 |
| bank_default | 2710 | transfer_clearing | 2730 |
| advances_received | 4490 | advances_paid | 2070 |
| bank_fees | 6810 | processor_fees | 6820 |
| inventory | 2040 | cogs | 6000 |
| revenue_goods / services / shipping | 5000 / 5001 / 5002 | prepaid | 2810 |
| fixed_assets | 1240 | retained / current result | 3410 / 3420 |

## Posting rules

All amounts are computed as signed amounts per account and then converted to debit or credit, so credit notes reverse the sides automatically.

| Event | Entry |
|---|---|
| Purchase invoice | Dr line account (net + non-deductible VAT); Dr 2441 (deductible VAT); Cr 4430 gross (counterparty) |
| Sales invoice | Dr 2410 gross (counterparty); Cr revenue accounts (net); Cr 4492 VAT |
| Credit note | Same accounts with opposite signs. Linked to the original; outstanding = original + credit notes + corrections − allocations |
| Correction of a posted document | Delta only: the current group (original + earlier corrections) is reversed line by line and the corrected lines are added. Journal entry = new − old per account. The original rows are untouched. |
| Customer payment | Dr bank / Cr 2410 (no revenue, no VAT) |
| Supplier payment | Dr 4430 / Cr bank (no expense, no VAT) |
| Over-payment | Excess Cr 4490 (incoming) or Dr 2070 (outgoing) |
| Advance before the invoice | Dr bank / Cr 4490. Applying it later: Dr 4490 / Cr 2410, with **no second cash entry** |
| Bank fee | Dr 6810 / Cr bank (no VAT; a bank statement is not a VAT invoice) |
| Processor payout | Dr bank (payout) + Dr 6820 (fee) / Cr 2410 (invoice outstanding) |
| Transfer between own accounts | Dr 2730 / Cr bank A, then Dr bank B / Cr 2730 when the other side is imported |
| "Other" bank line | Account chosen by the user, with a required note. Flagged as needing a supporting document; VAT is never deducted |
| Cost of sales (manual) | Dr 6000 / Cr 2040 per month, recorded in `cogs_periods` |

Inventory purchases go to 2040 (not expenses). The P&L and balance sheet are **marked incomplete** for any month with goods sales and no confirmed cost-of-sales entry. Missing cost of sales is never treated as zero.

## Line classification

Each line gets a suggestion with an explanation, from these sources in order:

1. An approved **rule**: register, optional counterparty, optional text, priority, effective dates.
2. A **product** card (by SKU or external store mapping).
3. A built-in **keyword** suggestion.
4. The optional LLM.

Otherwise the account is left empty and must be chosen. Equipment at or above `asset_threshold` (company setting, default 500 EUR net) is suggested as a fixed asset (1240), cheaper equipment as small inventory (6312). Annual or "12 mėn." services are suggested as prepaid (2810). Goods for resale are suggested as inventory (2040).

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
