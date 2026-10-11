# FR0600 as in VMI EDS, and the i.SAF preview

## PVM deklaracija FR0600 (*Ataskaitos → PVM deklaracija FR0600 (EDS forma)*)

The page shows the VAT return on the official FR0600 version 03 form page, the same one EDS uses. Values sit in the form's cells: amounts are right-aligned and text is in capitals. Dates are written as `YYYY-MM-DD` with the printed dashes.

### Where the form comes from

- The layout was extracted from the VMI template `FR0600.mxfd` (EDS form list, FR0600 version 03) by `scripts/mxfd-layout.py`. That covers field names and types, cell rectangles at 300 dpi, alignment and read-only flags.
- `assets/forms/fr0600-v3.json` holds the layout.
- `assets/forms/fr0600-v3.pdf` is the form page, vector, converted from the template's EMF background. It is used for the PDF.
- `public/img/fr0600-v3.png` is the 150 dpi image used on the web page.

### Field values

Rules follow the filling instructions (Aprašas, VA-129 2025-12-22 version).

- Amounts are whole euros. 49 cents and less are dropped, 50 cents and more round up.
- Empty fields stay empty; zeros are not written.

| Field | Source |
|---|---|
| 1, 2 | Company name (max 30 characters) and company code |
| 7 | Period from / to |
| 8 | Pirminė or Patikslinta (radio group `E8`) |
| 9 | "Mokestinio laikotarpio" (radio group `E9`) |
| 11 | Taxable value of sales PVM1/2/3/58 |
| 13 / 17 / 18 / 19 | PVM5 / PVM12 / PVM13 / other sales codes |
| 25 | All purchase VAT |
| 29 / 29A / 30 / 31 | Output VAT PVM1 / PVM58 / PVM2 / PVM3 |
| 35 | Deductible VAT |
| 36 | 27+29+29A+30+31+32+33+34−35, calculated from the rounded fields as EDS does |

- **Filled by EDS, left empty here:** fields 3–6 and 10.
- **Not filled by the program:** reverse charge, import and EU acquisitions (12, 14–16, 20–24, 26–28, 32–34). The page says so.

### Editing on the form

Any editable field can be typed into by clicking it. Amounts must be whole numbers, field 28 must be 0–100, and field 36 is recalculated as you type. The edits go into the downloaded files; the server validates them again (`applyEdits`).

### Files

- **⇩ EDS failas (.ffdata):** FFData XML in the EDS format (`FFData → Form FormDefId → DocumentPages → Pages/Page FR0600 → Fields`, all 45 fields). Upload it in EDS: *Pildyti formą → FR0600 → Įkelti failą*. Check it there and submit.
- **⇩ PDF:** the form page with the values, for the file or for printing.

**Not tested:** the FFData file was not uploaded to the real EDS, because that needs a taxpayer login. The structure follows the official template (form ID, group "Visa forma", page and field names). Before the first real submission, upload it in EDS and check that every field is filled.

The previous table (*FR0600 skaičiavimo išklotinė*) remains as a breakdown by VAT code.

## GPM313 (*Atlyginimai → GPM313 deklaracija*)

This is the monthly income tax return, version 01 (VMI order VA-121). The page shows it on the official form page, landscape, the same as EDS. The template is `GPM313.mxfd` from the EDS form list, extracted to `assets/forms/gpm313-v1.*`.

**Which month.** The return is filed for the month in which pay was paid out, by the 15th of the next month. Approved payroll sheets are taken by their payment date.

| Field | Source |
|---|---|
| 1, 2 | Company code and name (2 rows of 29 cells) |
| 3, 4 | Year, month |
| 5 | Gross pay (A class, employment) of sheets paid in the month |
| 6 | GPM withheld from pay paid up to the 15th |
| 7 | GPM withheld from pay paid after the 15th |
| 8–12 | Non-employment A class and B class payouts (royalties, rent and so on): typed in on the form |

- Amounts have 2 decimals with a comma. The comma is printed on the form between the cells, so the cells hold digits only.
- Advances are treated as paid together with the sheet. If an advance was paid in another month or the other half of the month, correct fields 5–7 on the form. The page says so.
- The FFData file and PDF work the same way as for FR0600. Both forms share `src/reports/eds-forms.mjs` and `public/js/lib/eds-form.mjs`.
- **Not tested:** uploading the file to the real EDS (it needs a login).

## i.SAF (*Ataskaitos → i.SAF eksportas*)

After *Tikrinti* the page shows the registers taken directly from the generated XML file:

- the header: file version, date, data type, company code, part, period;
- the issued invoice register;
- the received invoice register.

Each row is one `DocumentTotal` (VAT code). Columns follow the order of the i.SAF 1.2 specification: number, date, type, party VAT code, registration number, country, name, special taxation, corrected invoice, VAT point date, registration date (received invoices), taxable value, VAT code, rate and VAT amount. Totals are shown at the bottom.

The column set follows the specification. The VMI i.SAF web interface itself was not compared, because it needs a login.
