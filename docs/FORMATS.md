# Supported formats

The format is detected from file **content** (magic bytes), not from the file name. Anything not on these lists is rejected with an explanation in Lithuanian.

## Invoice inbox

| Format | Processing |
|---|---|
| Digital PDF | Native text with word boxes (`pdftotext -bbox`). Pages with fewer than 25 text characters are rendered at 300 dpi and OCR'd. Up to 60 pages. |
| Scanned PDF | Each image-only page: ImageMagick auto-orient + grayscale + deskew, then Tesseract OSD rotation (applied when confidence ≥ 1.5), then Tesseract `lit+eng` (`--psm 3`). Word confidences are kept. |
| JPG / PNG (photos, scans) | Same as scanned PDF. |
| DOCX | `word/document.xml`: paragraphs and tables in body order. Provenance = paragraph number, or table/row/cell. |

**Not supported, with an explanation:**

- `.doc`, `.xls`, `.rtf`, `.odt`: no safe conversion is implemented, so the user is asked to save as DOCX/PDF/XLSX.
- HEIC, ZIP archives, password-protected PDFs.
- PDFs with JavaScript, Launch actions or embedded files.

**Extraction (`rules-lt`):**

- Document type from the title: PVM sąskaita faktūra, sąskaita faktūra, kreditinė, debetinė, išankstinė/proforma, sutartis, kvitas.
- Series and number, dates (ISO, `DD.MM.YYYY`, `YYYY.MM.DD`, "2026 m. rugsėjo 5 d."), due date, currency, payment reference, order number, corrected document.
- Seller and buyer blocks, side by side or stacked: name, company code, VAT code (LT check digit verified), address, IBAN (mod-97 verified).
- A line table found by its header keywords, with column assignment by word position. Handles wrapped descriptions, two-line headers and continuation pages.
- Totals: net, VAT per rate, VAT total, gross.

**Multiple documents in one file:** if a later page has its own title and a different number, the proposal is blocked and splitting is offered.

**Field status:**

- `ok`: the value was extracted cleanly.
- `missing`: the value was not found; a reason is given.
- `uncertain`: an OCR word scored below 70/100 (the Tesseract score is labelled as such and is not a probability), a checksum failed, or a value was unreadable.
- `conflict`: for example, several currencies on one document.
- `defaulted`: for example, no currency printed, so EUR is assumed with a visible warning; this blocks approval for foreign counterparties.

Values are never invented. Uncertain and conflicting fields block approval until corrected or explicitly confirmed.

## Bank statements

| Format | Variants and behaviour |
|---|---|
| CSV | Delimiter `;`, `,` or tab detected; UTF-8 or Windows-1257. Header row auto-detected with Lithuanian and English names. Mapping can be overridden in the preview. Supports one signed amount column, separate debit/credit columns, or a D/C flag. Balances can be entered by hand. |
| XLSX | First sheet; otherwise as CSV. |
| CAMT.053 | `camt.053.001.02` to `.08` (namespace prefixes ignored). Exactly one `<Stmt>` per file. Balances: `OPBD`/`PRCD` opening, `CLBD` closing. Only entries with status `BOOK` are imported. Transaction ID is `AcctSvcrRef`, then `TxDtls/Refs/AcctSvcrRef`, then `NtryRef`. Batch entries are imported as one transaction, with a warning. |
| MT940 | One message per file: `:25:`, `:28C:`, `:60F/M:`, `:61:` (bank reference after `//`), `:86:`, `:62F/M:`. |
| PDF / JPG / PNG | Fallback: rows that start with a date and end with an amount, plus balances and period from labelled lines. Always flagged for review. |

**Balance check:** opening + credits − debits must equal closing. A mismatch or missing balances block approval of the statement's transactions until fixed, or until a user with the `resolve` capability accepts it with a note of at least 10 characters; the note is written to the audit log.

**Gaps and continuity** with the previous statement of the same account produce warnings or errors.

**Deduplication:**

- The key is `id:<bank transaction id>` when the bank provides one.
- Otherwise it is `fp:<sha256(account, date, amount, counterparty IBAN, normalized name and reference)>:<n>`, where *n* is the occurrence index of identical rows within the statement.
- Overlapping statements therefore re-import nothing, and two genuinely identical payments are both kept.
- A row that looks like an existing transaction under a different identity (for example, the same day and amount, one with a bank ID and one without) is imported, flagged as a possible duplicate, and blocked until a reviewer decides.
