# i.SAF export

Path in the UI: *Ataskaitos → i.SAF eksportas*. The API has two endpoints:

- `GET /api/isaf/check?from&to&type=F|S|P` returns blocking errors per document, warnings, excluded documents and the XSD validation result.
- `GET /api/isaf/download` returns the XML file. It works only when there are no blocking errors and the XSD validation passes. The file is also archived in the vault (tag `isaf`).

**Generating a file is not submitting it.** The user uploads it to the VMI i.SAF system. Under VA-55 §30–32 (version from 2025-05-01), a legal person's period is a calendar month and the file is due by the 20th of the following month.

## XSD provenance – action required

`vendor/isaf/isaf_1.2.xsd` (SHA-256 `4a3b8746c7266e396b1e042eccb37f0658269c49e8332448c95c5c545bed071a`) was obtained from public GitHub mirrors. It was not downloaded from vmi.lt, which blocked automated access.

- Two independent mirrors were byte-identical. A third differed only in the minimum allowed `SelectionEndDate`.
- Element names, enumerations and annotations match the official VA-55 annex text.

Before production use, **download the official file from VMI in a browser and compare it**: https://www.vmi.lt/evmi/documents/20142/847717/isaf_1.2.xsd/3c630fb1-5bac-55fc-365a-2b7e0bf7d59e

If the two differ, replace the vendored file and re-run `npm test`.

## Mapping

| i.SAF | Source |
|---|---|
| Header | `FileVersion=iSAF1.2`, `DataType` F/S/P, `RegistrationNumber` = company code (≤ 11 digits, blocking if missing), `NumberOfParts=1`, `PartNumber=1`, `SelectionCriteria` = the chosen period |
| Sections | `PurchaseInvoices`, then `SalesInvoices` (the XSD order) |
| `InvoiceNo` | series + number, without spaces (≤ 70 characters) |
| `CustomerInfo` / `SupplierInfo` | Taken from the invoice's counterparty snapshot. The VAT code is written as `ND` when unknown; `RegistrationNumber` is the company code or `ND`; `Country` and `Name` are filled in, with `ND` for a missing name. Master data is not used. |
| `InvoiceType` | `vat_invoice` → `SF`, `credit_note` → `KS`, `debit_note` → `DS`. Non-VAT invoices are **excluded**, with a reason. |
| `References` | For credit notes: the original's number and date. A missing link is a **blocking** error. |
| `VATPointDate` | The supply date when it differs from the invoice date; otherwise `xsi:nil` |
| `RegistrationAccountDate` (purchases) | The approval (registration) date in Europe/Vilnius |
| `DocumentTotals` | One `DocumentTotal` per tax code from `invoice_vat_rows`: `TaxableValue`, `TaxCode`, `TaxPercentage` (`0` written as `0`; nil when there is no rate), `Amount`. Corrections are **merged into the corrected invoice's totals**, because they fix the register rather than form separate documents. |

The selection rule (assumption): invoices are included by **invoice date** within the period, for both registers.

## Checks

- The company code is present.
- Each invoice has a number, has VAT rows, uses valid `PVM` codes, and has no "be PVM" rows on a VAT invoice.
- Credit notes reference their original invoice.
- The sum of `TaxableValue` equals the net total including corrections.
- The file validates with `xmllint --schema vendor/isaf/isaf_1.2.xsd`. Messages are shown in the UI.

Tests in `test/06-isaf.test.mjs` generate a mixed month (B2B and B2C sales, 5 %, 12 % and 21 % rates, a credit note, an OCR'd purchase) and validate it with xmllint. They also check blocking errors and the reporting of schema violations.
