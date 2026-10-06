# Architecture

## Modules (modular monolith)

The modules are in-process, all in one Node.js process. One PostgreSQL database holds every table, and a single private directory holds stored files.

| Module | Responsibility |
|---|---|
| `src/http.mjs`, `src/app.mjs`, `src/routes/*` | Routing, JSON and multipart parsing, sessions, CSRF, security headers, the error mapping layer |
| `src/auth` | Users, scrypt passwords, sessions, login throttling, role capabilities |
| `src/vault` | Content-addressed write-once storage, documents and versions, upload validation and scanning, search, signed downloads |
| `src/extraction` | Text layer (poppler), OCR (Tesseract with orientation and skew correction), DOCX parsing, the `rules-lt` invoice parser, ID checksums, the optional LLM classifier |
| `src/invoices` | Proposal construction, classification, deterministic computation and validation, duplicates, versioned edits, approval, corrections, splitting |
| `src/ledger` | Postings (`postEntry`), reversals, posting roles, invoice balances |
| `src/bank` | Statement adapters, import and deduplication, matching, reconciliation proposals, allocations, advances |
| `src/sales` | Manual invoices, credit notes, PDF rendering |
| `src/reports` | Ledger-derived statements, registers, aging, sales, exports |
| `src/isaf` | i.SAF XML generation and XSD validation |
| `src/integrations` | Saleor and OpenCart adapters, ingestion, sync jobs, webhooks |
| `src/jobs.mjs`, `src/worker.mjs`, `src/scheduler.mjs` | Durable job queue: `FOR UPDATE SKIP LOCKED`, retries with backoff, idempotency keys, stale-lock recovery |

## Main data model

- **documents** and **stored_files**:
  - Each version of an original is an immutable row (`role='original'`, version n).
  - Derived files are separately identifiable: previews per page, the generated PDF, split parts. `derived_from_file_id` links each one to its source.
  - **document_pages** hold the extracted text used for search.
- **extractions**: immutable provider output. It includes the layout used to show provenance, and an `is_demo` flag.
- **proposals**: editable data plus a server-computed `validation` (issues, totals, entries) and a `content_hash`.
  - Each edit inserts a new version and supersedes the previous one.
  - Only one proposal per document or order can be `open`, enforced by a partial unique index.
- **invoices**, **invoice_lines**, **invoice_vat_rows**: the posted registers. They are immutable and store snapshots of the counterparty and company particulars, prices and tax treatment.
  - Corrections and credit notes are new rows linked through `related_invoice_id`.
- **journal_entries** and **journal_lines**: the ledger. These are immutable, and every entry carries an idempotency key.
- **bank_statements**, **bank_statement_rows**, **bank_transactions** and **statement_coverage** store imported data separately from postings.
  - **reconciliation_proposals** are versioned.
  - **allocations** are immutable.
- **external_orders**, **external_order_versions**, **external_refunds**, **webhook_events**, **sync_runs** and **stores** support the integrations.
- **classification_rules** are versioned. Each version records who signed it off, its scope, priority and effective dates.
- **audit_log** is append-only and cannot be updated or deleted.

## How the required invariants are enforced

| Requirement | Enforcement |
|---|---|
| Debits equal credits | `validateLines` in `postEntry`, plus a deferred constraint trigger `check_entry_balanced` at commit. Raw SQL is rejected too (tested). |
| Approval and its records commit together | `approveProposal` and `approveRecon` run in one `tx()`: counterparty, invoice, lines, VAT rows, journal entry, document status, audit. |
| Exact decimals and documented rounding | `src/lib/money.mjs` uses BigInt cents with half-up rounding at documented points; the DB uses `NUMERIC`. See ACCOUNTING.md. Unit tests cover it. |
| Posted records are never overwritten | `forbid_change` triggers on journal, invoice, line, VAT-row, allocation, file, extraction and audit tables. Corrections, credit notes and reversals are new rows. |
| Historical snapshots | `counterparty_snapshot`, `company_snapshot`, line-level prices, tax code, rate and account are stored on each invoice. |
| Orders, invoices, payments and revenue are distinct | Separate tables. Revenue exists only from posted invoices. Order metrics are labelled "operational". |
| Unique numbers under concurrency | The `document_series` row is locked by `UPDATE … RETURNING` inside the approval transaction, plus a unique `(register, counterparty_key, number_key, doc_type)` constraint. Eight concurrent approvals are tested. |
| Locked periods and permissions apply everywhere | The `check_period_open` trigger on `journal_entries` covers every insert path, including jobs. Capabilities are checked by `requireCap` in every mutating service, and document access by `visibilitySql`. |
| AI never posts | No code path lets extraction or LLM output post entries or create rules. Approval requires an authenticated user with the `approve` capability and the exact version hash. |

## Proposal lifecycle

```text
upload → job extract_invoice → extraction (immutable) → proposal v1 (validation computed)
  ↳ edit (PUT, base hash) → proposal v2 (v1 superseded; provenance keeps extracted value + correction)
  ↳ approve (version hash) → recompute + duplicates + period lock inside the transaction → invoice + entry (idempotency key proposal:<id>)
  ↳ reject / move to vault (proforma, contract) / split (several documents in one file)
posted + re-extract → correction proposal (delta only, after approval)
```

Validation is stored with each version and re-run live when a proposal is opened, so duplicates that appeared later are shown. It is run again inside the approval transaction.

## Background processing

`jobs` rows with `idempotency_key`, `attempts`, `max_attempts` and `run_at`. The worker claims a job atomically and stores the error message on failure. It retries with exponential backoff, or after `Retry-After` for a 429, and marks the job `dead` after the last attempt. A dead `extract_invoice` job sets the document to `failed` with an actionable message. Retries are available in the UI (*Integracijos*, *Nustatymai → Foninės užduotys*).

Job types:

- `extract_invoice`
- `index_document`
- `render_invoice_pdf`
- `store_sync`
- `webhook_event`

The scheduler enqueues an incremental store sync every 15 minutes and a daily reconciliation. Its idempotency keys make running several schedulers harmless.
