# VAT rules, sources and assumptions

**This software does not guarantee or certify tax compliance.** It applies a small set of explicit rules and asks for a decision whenever treatment is uncertain. An accountant must review the configuration before production use.

## Sources used (checked 2026-10-06)

- **VMI PVM classifier:** order VA-49, consolidated version in force from 2026-01-01, retrieved from e-seimas.lrs.lt (the official legal register).
  - URL: https://e-seimas.lrs.lt/portal/legalAct/lt/TAD/3673ab602fe311e598499e1e1ba6e454/asr
  - The table is kept in `vendor/isaf/pvm_klasifikatorius_VA-49_2026-01-01.tsv`.
- **i.SAF register rules:** order VA-55, version in force from 2025-05-01.
  - URL: https://e-seimas.lrs.lt/portal/legalAct/lt/TAD/TAIS.231504/asr
- vmi.lt itself was not reachable from the build environment (Cloudflare challenge). See [ISAF.md](ISAF.md) for the XSD provenance.

## VAT codes configured

| Code | Rate | Effective | Use |
|---|---|---|---|
| PVM1 | 21 % | – | Standard rate (PVMĮ 19 str. 1 d.) |
| PVM2 | 9 % | until **2025-12-31** | Reduced rate. After this date, 9 % on a document is flagged. |
| PVM3 | 5 % | – | Reduced rate (PVMĮ 19 str. 4 d.) |
| PVM58 | 12 % | from **2026-01-01** | Domestic services (PVMĮ 19 str. 3 d.) |
| PVM5 | no rate | – | Exempt. Requires an accountant's choice. |
| PVM12, PVM13 | 0 % | – | Export / EU supply of goods. Must be chosen explicitly. |
| PVM100 | – | – | Other purchase cases. Must be chosen explicitly. |

Rates and codes are selected by **document date and effective dates**. A rate printed on an invoice is matched to a code only when exactly that code is valid on that date. A 0 % rate is never mapped automatically, because the reason code (export, EU supply, exempt…) must be chosen. Further codes from the classifier can be added in *Nustatymai → PVM kodai*.

**Open question (unverified):** whether any 9 % rate for goods continues after 2025-12-31. The consolidated classifier lists no successor goods code at 9 %. Confirm against the current PVMĮ 19 str. before relying on 9 % handling.

## Input VAT deductibility (purchases)

Printed VAT never establishes recoverability on its own. Each line gets a VAT treatment from the first matching rule:

1. Company not VAT-registered → **non-deductible**; the VAT is added to the cost.
2. 0 % / no VAT → nothing to deduct.
3. An approved classification rule with an explicit VAT treatment → that treatment.
4. Built-in **BR-REPR** (representation/entertainment keywords) → **non-deductible**. This is an assumption to confirm with the accountant.
5. Built-in **BR-CAR** (passenger cars, fuel) → **review**: an explicit decision is required.
6. Supplier VAT code not Lithuanian → **review**. Reverse charge is not automated.
7. Supplier VAT code missing or malformed → **review**.
8. Document is not a VAT invoice (plain "sąskaita faktūra") → **review**.
9. Otherwise, built-in **BR-LT-STD** → **deductible**. Conditions:
   - the company is VAT-registered,
   - the supplier has a valid-format LT VAT code,
   - the document is a VAT invoice or credit/debit note,
   - the line is not in a restricted category.

   This is an assumption the accountant must approve; it does not check business use of the purchase.

A line with **review** treatment blocks approval until the reviewer chooses deductible or non-deductible.

## Sales

Sales VAT is computed from line tax codes. A company that is not VAT-registered cannot issue a VAT invoice (this blocks approval). Credit notes use negative amounts linked to the original invoice.

## Not supported automatically (routed to review or manual entry)

- Reverse charge (PVMĮ 96 str.).
- Intra-EU acquisitions of goods, and services bought from EU or non-EU suppliers.
- Imports.
- Margin schemes.
- The cash accounting scheme (i.SAF `SpecialTaxation=T`).
- Foreign-currency documents.
- Partial deduction ratios.
- Private use.
- Agricultural compensatory rates.

## Required particulars

Proposals check for these before approval:

- document number,
- issue date (not in the future, not in a locked period),
- counterparty name,
- the supplier VAT code on a VAT invoice (warning),
- currency (EUR only),
- at least one line with description, quantity, price, VAT code, account and VAT treatment,
- arithmetic consistency,
- duplicates.

Manual sales invoices show the company and buyer particulars, series and number, dates and VAT per rate.

The legal list of required invoice particulars (PVMĮ 80 str.) should be confirmed by the accountant for the company's invoice template.
