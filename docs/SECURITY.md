# Security

## Authentication and sessions

- **Passwords:** scrypt (N=16384, r=8, p=1, 64-byte key, random salt), at least 10 characters.
- **Lockout:** after 5 failed attempts for the same e-mail and IP pair, login is blocked for 15 minutes (HTTP 429).
- **Sessions:**
  - A random 256-bit token is stored only as a SHA-256 hash.
  - The cookie is `HttpOnly; SameSite=Strict`, plus `Secure` when `SECURE_COOKIES=true` (the production default).
  - Sessions expire after 12 h. Changing a user's role, password or active flag ends their sessions.
- **CSRF protection** for every mutation:
  - a per-session token in the `X-CSRF-Token` header,
  - an `Origin`/`Referer` same-origin check.

  Webhooks are the only unauthenticated mutation; they are authenticated by signature instead.
- **Transport:** run behind a TLS reverse proxy, or set `TLS_CERT`/`TLS_KEY` for direct HTTPS. Store API URLs must use HTTPS (localhost is allowed for development).

## Authorization (server side, every route)

| Capability | admin | accountant | readonly |
|---|:-:|:-:|:-:|
| read (lists, reports, non-restricted documents) | ✓ | ✓ | ✓ |
| write (upload, edit proposals and metadata, import, sync) | ✓ | ✓ | |
| approve (post invoices, bank allocations, manual journal, i.SAF download) | ✓ | ✓ | |
| rules (create/version/retire classification rules) | ✓ | ✓ | |
| resolve (accept statement mismatches, duplicate decisions, audit log) | ✓ | ✓ | |
| lock (lock periods; unlocking needs settings) | ✓ | ✓ | |
| restricted documents | ✓ | ✓ | |
| settings, users, admin_only documents | ✓ | | |

Each document has a confidentiality level (`normal`, `restricted` or `admin_only`) that applies to:

- viewing, searching and listing (`visibilitySql`);
- downloading and editing;
- linked proposals.

A document the user may not see returns the same 404 as a missing one, so its existence is not disclosed.

## Files

- **Storage:** private and content-addressed (`objects/aa/<sha256>`), written once with mode 0440, outside the web root. Files are served only through `/api/files/:id/content` with:
  - a valid session,
  - a document access check,
  - an HMAC-signed link that expires after 5 minutes and is bound to the user and the file.

  Responses carry `Content-Security-Policy: sandbox` and are audited (view/download).
- **Uploads:**
  - The type is detected from file content and checked against per-workflow allowlists.
  - Size limit: `MAX_UPLOAD_MB`, default 25.
  - The file name is sanitized.
- **Safety checks:**
  - PDFs with `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile` or encryption are rejected.
  - DOCX/XLSX: limits on entry count and uncompressed size/ratio, and macro or executable entries are rejected.
  - PNG: a maximum pixel count.
  - Optional ClamAV via `CLAMSCAN_PATH`. **Without ClamAV, no signature-based antivirus scan is performed**; the upload result reports `antivirus: not_configured`.
- **Processing isolation:** conversion uses external tools only (pdftotext, pdftoppm, Tesseract, ImageMagick on PNG/JPG). Nothing is executed from documents, there are timeouts, and work happens in per-job temp directories that are removed afterwards. Legacy Office formats are not converted.

## Untrusted document content and AI

- Document text is data. The rules-based extractor only pattern-matches values; it never acts on instructions in the text. A fixture with an embedded "SYSTEM INSTRUCTION TO AI" is tested: it creates no rule, user, posting or approval, and the text stays searchable.
- **Optional LLM classifier** (`LLM_PROVIDER=anthropic`, off by default):
  - It receives only line descriptions, units, net amounts and allowed account codes/names, inside a delimited "untrusted data" block. The system prompt says to ignore instructions found in the data.
  - It has no tools.
  - Its output is parsed as JSON. Items with unknown keys, account codes outside the allowlist, or invalid line types are dropped (tested).
  - It may fill only lines that have no rule, product or keyword suggestion. Its suggestions are labelled "Kalbos modelio pasiūlymas".
  - It cannot create rules, approve or post entries, read the database or change permissions.
- Server-side validation and approval rules apply to every value, whatever produced it.

## Secrets and logging

- Configuration comes only from the environment. `.env` is git-ignored, and `.env.example` contains no values.
- Store API tokens and keys are encrypted with AES-256-GCM, using a key derived from `APP_SECRET_KEY`. They are write-only in the API.
- Logs contain no passwords, tokens or document content. The audit log stores actions and identifiers (and search terms limited to 100 characters), not file content.

## Audit trail

`audit_log` is append-only (a trigger rejects UPDATE and DELETE). It records:

- logins, uploads, versions and metadata changes, views and downloads;
- proposal edits, approvals and rejections (including version and content hash);
- rule versions with the user who signed off, scope, priority and dates;
- bank imports, resolutions and duplicate decisions;
- period locks, settings, users, store configuration, sync requests, rejected webhooks, report exports and i.SAF exports.

## Deletion and retention

- Originals, postings and the audit log cannot be deleted.
- "Pašalinti" archives and hides a document, and is refused while it is evidence for a posting or a bank statement, or is under legal hold.
- `retain_until` and `legal_hold` are informational settings. The app does **not** impose legally mandated retention periods.
