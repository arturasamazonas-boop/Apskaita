# Apskaita – accounting for a small Lithuanian business with online stores

A working web application for one Lithuanian legal entity (EUR, Europe/Vilnius). The core workflow is: **upload a document or bank statement → automatic extraction → proposed classification and double-entry postings → human review → posting only after "Patvirtinti"**. The user interface is in Lithuanian; this documentation is in English.

> Not certified software. Tax treatment, the chart of accounts and i.SAF output must be reviewed by the company's accountant. See [docs/TAX_RULES.md](docs/TAX_RULES.md).

## What is implemented

| Area | Status |
|---|---|
| Invoice inbox | Single and batch upload; native PDF, DOCX, scanned PDF, JPG and PNG. OCR uses Tesseract `lit+eng` with orientation and skew correction. Detects files that contain several documents and splits them. Extracted fields keep their provenance (page/bbox, DOCX paragraph or table cell). Uncertain, missing and conflicting values are flagged with a reason. Provides classification rules, keyword suggestions and an optional LLM provider. Deterministic server recalculation and validation. Versioned proposals, approval tied to the exact version hash, idempotent posting, bulk approval of selected items. Duplicate detection by file hash and by business identifiers. Re-extraction of a posted document creates a correction proposal. |
| Document vault | Private, content-addressed, write-once storage with explicit versions. Originals are kept separate from derived files (previews, OCR). Metadata, tags, contract lifecycle, full-text search with authorization, signed download links, access log, deletion guard, retention fields. |
| Bank | CSV/XLSX with column mapping and preview, CAMT.053, MT940, PDF/image fallback. Balance and continuity checks, with authorized resolution that requires a note. Deduplication by bank ID or by fingerprint plus occurrence count, so two identical legitimate payments are both kept. Evidence-based matching with many-to-many allocations, partial and over-payments, refunds, bank and processor fees, processor payouts, own-account transfers, and advances through a clearing account that are later applied without moving cash a second time. |
| Ledger and reports | Chart of accounts and posting roles; journal with DB-enforced balance, period lock and immutability; reversals; opening balances; manual cost-of-sales workflow. Reports: trial balance, general ledger with drill-down, P&L (flagged incomplete when cost of sales is missing), balance sheet, VAT registers, receivables and payables aging, sales (period/store/customer/product), operational order metrics, purchases, payments. CSV/XLSX export. Ledger reconciliation checks. |
| Sales | Manual invoices with series numbering assigned on approval (unique under concurrency), PDF generation, credit notes/partial returns linked to the original, manual purchases. |
| Integrations | Saleor (GraphQL, JWS-verified webhooks, initial, incremental and reconcile syncs) and OpenCart (a bundled read-only extension, because the core API cannot list orders). Durable, resumable jobs with retries and rate limits. Out-of-order protection. Configurable status mapping and invoice mode, with protection against double issuing. Refunds become credit-note proposals; posted invoices are never changed. Demo connections are explicitly labelled. |
| i.SAF | i.SAF 1.2 XML export, validated with xmllint against the XSD, with blocking errors per document. Export ≠ submission. |
| Security | scrypt passwords and DB sessions, role checks on every API route, CSRF tokens plus same-origin check, strict CSP, upload type and size checks, PDF active-content and zip-bomb checks, optional ClamAV, encrypted store secrets, append-only audit log. |
| Operations | Durable PostgreSQL job queue, backup and restore scripts with verification, Dockerfile and docker-compose, a performance script measured with 10,000 documents. |

**Deferred by scope:** payroll, manufacturing, advanced warehouse/FIFO, automated fixed-asset depreciation, multi-company, direct bank APIs, international tax automation (reverse charge, EU acquisitions, OSS), multi-currency postings, legacy `.doc`/`.xls` conversion.

## Stack and why

The app is a modular monolith on **Node.js 22 (ES modules) and PostgreSQL 16**:

- The repository already uses Node and `pg`.
- There is no front-end build step: the Lithuanian SPA is plain ES modules served under a strict CSP.
- Business rules live on the server. Money uses exact decimals (BigInt cents; `NUMERIC` in the DB).

System tools do the document work: poppler (`pdftotext -bbox`, `pdftoppm`, `pdfseparate`, `pdfunite`), Tesseract 5 with `lit`/`eng`/`osd`, ImageMagick (deskew/rotation) and libxml2 `xmllint` (XSD).

npm dependencies are kept small: `pg`, `busboy`, `exceljs`, `jszip`, `fast-xml-parser`, `pdfkit`; dev only: `playwright`.

## Quick start (local)

Requirements: Node ≥ 20, PostgreSQL ≥ 14 (with `pg_trgm`), `tesseract-ocr tesseract-ocr-lit poppler-utils imagemagick libxml2-utils postgresql-client`.

```bash
npm ci
createdb apskaita_dev                      # or set DATABASE_URL
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/apskaita_dev
npm run migrate
npm run create-admin -- admin@jusu-imone.lt "Vardas Pavardė"   # asks for a password (≥ 10 chars)
npm start                                   # http://127.0.0.1:3100, the job worker runs in-process
```

The first admin login opens the onboarding wizard (company, VAT, accounts, numbering, bank, stores).

**Demo data (fictional, empty database only):** `npm run demo:seed` creates demo users with generated passwords printed once, fixture invoices, a contract, a bank statement and a store marked **DEMO**.

**Online, free (Render + Neon, EU):** see [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md). `render.yaml` creates a free Render web service; files are stored in the (Neon) database; every push to `main` deploys automatically.

**Docker:**

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and APP_SECRET_KEY
docker compose up -d --build
docker compose exec app node src/cli.mjs create-admin admin@jusu-imone.lt "Vardas"
```

The app listens on 127.0.0.1:3100. Put a TLS reverse proxy in front of it. Behind a TLS-inspecting proxy, build with `--secret id=ca,src=ca.pem`.

## Configuration

See [.env.example](.env.example). Secrets are read only from the environment and never returned by the API.

- `APP_SECRET_KEY` is required in production.
- `STORAGE_DIR` must not be web-served.
- `WORKER_IN_PROCESS=false` together with `npm run worker` runs jobs in a separate process.

## Providers and data leaving the server

| Provider | Default | What is sent externally |
|---|---|---|
| Text layer (poppler), OCR (Tesseract), structured extraction (`rules-lt`) | Enabled, local | Nothing |
| LLM line classification (`LLM_PROVIDER=anthropic`) | **Disabled** | Only line descriptions, units, net amounts and the list of allowed account codes/names. No party names, codes, IBANs or files. |
| ClamAV (`CLAMSCAN_PATH`) | Disabled | Nothing (local) |

When the LLM provider is enabled, its output is validated against a strict schema and an account allowlist. It can only fill lines that have no rule, product or keyword suggestion, and its suggestions are labelled. It never creates rules, posts entries or changes permissions; see [docs/SECURITY.md](docs/SECURITY.md). With no provider configured, the workflow is complete and runs locally.

## Backups

`npm run backup [dir]` dumps the database first, then archives the write-once file storage, and writes a manifest with SHA-256 checksums. `npm run restore <backupDir>` restores into an empty database and an empty storage directory. It then verifies every stored file's hash and that the ledger balances. A test exercises the full cycle; see [docs/BACKUP.md](docs/BACKUP.md).

## Tests

```bash
createdb apskaita_test   # dedicated DB; tests DROP and recreate its public schema
npm run check            # syntax of all JS and PHP files
npm test                 # 45 tests: units, the 14 acceptance scenarios, integrations, i.SAF, backup, deployment bootstrap
npm run test:browser     # Chromium UI smoke test (Playwright), screenshots in var/screenshots
npm run perf             # 10,000-document timing (uses database apskaita_perf)
```

[docs/TESTING.md](docs/TESTING.md) maps tests to the acceptance scenarios and states what was executed. **Integration tests use local mocks and the real OpenCart extension code under `php -S`. No live Saleor or OpenCart store was contacted.**

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – modules, data model, how each server invariant is enforced
- [docs/ACCOUNTING.md](docs/ACCOUNTING.md) – posting rules, rounding, settlements, cost of sales
- [docs/FORMATS.md](docs/FORMATS.md) – supported upload and bank formats, extraction behaviour and limits
- [docs/TAX_RULES.md](docs/TAX_RULES.md) – VAT codes, sources, supported scenarios, assumptions needing accountant review
- [docs/ISAF.md](docs/ISAF.md) – i.SAF mapping, XSD provenance, validation
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) – Saleor and OpenCart: versions, permissions, limitations, setup, live verification checklist
- [docs/SECURITY.md](docs/SECURITY.md) – authentication, authorization matrix, uploads, AI safety, secrets
- [docs/BACKUP.md](docs/BACKUP.md) – backup and tested restoration procedure
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) – measured results with 10,000 documents
- [docs/TESTING.md](docs/TESTING.md) – executed checks and their scope

## Layout

```text
src/            server (app, http, db, jobs, auth, vault, extraction, invoices, bank, ledger, sales, reports, isaf, integrations, routes)
public/         Lithuanian SPA (ES modules, CSS)
migrations/     SQL migrations (run automatically on start)
fixtures/       committed test documents, bank statements, store orders (fictional)
vendor/isaf/    i.SAF 1.2 XSD and VMI PVM classifier table
integrations/   OpenCart extension source and .ocmod.zip package
scripts/        fixtures generator, backup/restore, perf, syntax check
test/           node:test suites (+ PHP harness); test-browser/ Playwright smoke test
```

## Screenshots

Taken by the browser smoke test: the review screen with the selected field's source highlighted on the original, an unclear OCR'd VAT amount blocking approval, bank reconciliation, the trial balance, the i.SAF check, and the mobile layout. See [docs/screenshots](docs/screenshots).
