# E-commerce integrations

Both adapters implement one interface (`fetchOrdersPage`, `fetchOrder`, `verifyWebhook`, `orderFromWebhook`) and return a **normalized order**. That order is ingested by `src/integrations/common.mjs`, which is the same code path for both platforms.

Data flows **store → accounting only**. The app never writes to a store.

## Common behaviour

- **Identity:** an order is identified by `(store_id, external_id)`, with a unique constraint. Equal order numbers in different stores are separate records (tested).
- **Idempotency:**
  - Each normalized order is hashed. An unchanged hash is a no-op, and every distinct version is kept in `external_order_versions`.
  - Webhook deliveries are de-duplicated by `(store, sha256(event + body))`.
  - A refund is processed once per `(store, refund id)`.
  - At most one open proposal per order (partial unique index), and at most one original invoice per order (unique index).
- **Out of order:** a payload whose `updatedAt` is older than the stored one is recorded as `stale` and ignored. Webhooks fetch the current order from the API when possible.
- **Status mapping** (configurable per store): external status → `invoice` / `wait` / `ignore`. Only `invoice` creates a proposal. Nothing is posted until a person approves it.
- **Invoice mode** (per store):
  - `issue_here`: this app assigns numbers from its series and the store must not issue invoices.
  - `import_external`: the store's invoice number is used, and no number is assigned here.

  Changing the mode after invoices exist requires explicit confirmation, to avoid issuing the same invoice twice.
- **After posting:** a posted invoice is never changed.
  - New refunds become **credit-note proposals** linked to the original.
  - Other changes set the state `changed_after_post` with an explanation.
- **Review routing:** unsupported currencies (anything other than EUR), unknown tax rates or discounts with an unknown rate become blocking proposal errors or `needs_review`.
- **Customers:**
  - A known customer is matched by company code or e-mail.
  - B2B company and VAT codes come from Saleor order metadata (`company_code`, `vat_code`).
  - Otherwise the customer is treated as an individual. On approval a counterparty is created from the snapshot.
- **Durable jobs:**
  - `store_sync` (`initial` / `incremental` / `reconcile`) persists its cursor after every page, so a retried job resumes where it stopped.
  - HTTP 429 is retried after `Retry-After`; 5xx and network errors are retried with backoff; 401/403 are permanent errors.
  - A per-store rate limiter (`config.requestsPerSecond`) spaces requests.
  - Scheduling: an incremental sync every 15 min, a reconcile daily, and manual "Sinchronizuoti dabar" / "Pilnas importas".
- **Status in the UI:** last run counts (fetched, created, updated, unchanged, errors), last error, failed jobs with "Kartoti", and order states.
- **Secrets:** API tokens and keys are encrypted at rest (AES-256-GCM, key derived from `APP_SECRET_KEY`) and never returned by the API.

## Saleor

- **Target:** Saleor **3.22+**. The queries use `orders(where: {updatedAt: {gte}})`, which was added in 3.22.
- **Verified:** both GraphQL documents (`ORDERS_QUERY`, `ORDER_QUERY`) were validated with graphql-js against the `schema.graphql` of the Saleor **3.23.40** source tag, the latest stable release on 2026-10-06.
- **Auth:** an app token in `Authorization: Bearer`, with permission **MANAGE_ORDERS**.
- **Queries:**
  - `orders(first, after, where:{updatedAt:{gte}}, sortBy:{field: LAST_MODIFIED_AT, direction: ASC})` with relay cursors (`first` = 50).
  - `order(id)` for webhook follow-ups.
  - Fields used: number, status, chargeStatus, created, updatedAt, userEmail, billingAddress, total/shippingPrice (net/gross/tax), shippingTaxRate, lines (productSku, productVariantId, quantity, taxRate, unitPrice net/gross, totalPrice), invoices, fulfillments, grantedRefunds (status `SUCCESS`, lines, shippingCostsIncluded) and metadata.
- **Webhooks:** `POST /api/webhooks/saleor/<storeId>`. Configure these asynchronous events in the Saleor app: `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_FULLY_PAID`, `ORDER_FULFILLED`, `ORDER_REFUNDED`, `ORDER_FULLY_REFUNDED`, `ORDER_CANCELLED`.
- **Signature check:** `Saleor-Signature` is verified as a detached, unencoded JWS (`{"alg":"RS256","b64":false,"crit":["b64"]}`) against the keys at `<origin>/.well-known/jwks.json` (cached for 1 h).
  - The deprecated HMAC-SHA256 hex signature is accepted only if a webhook secret is configured.
  - `Saleor-Api-Url` must match the store's origin.
  - Unverified requests get 401 and are written to the audit log.
- **Limitation (unverified):** whether `OrderLine.taxRate` is a fraction (0.21) or a percentage. The adapter accepts either and cross-checks it against the line's net/gross prices. An inconsistent rate becomes unknown, so the proposal goes to review.
- **Limitation:** order-level vouchers are assumed to be included in Saleor's line `unitPrice` (as documented for 3.x). Totals are cross-checked, and a mismatch blocks the proposal.

## OpenCart

- **Target:** OpenCart **4.1.x**. The latest stable release on 2026-10-06 was 4.1.0.4. The source was inspected; no live install was tested.
- **Why an extension:** the built-in catalog API (`api/order`, `api/subscription`, HMAC-SHA1 signed) can only build or edit orders. It cannot list or read existing orders. A minimal **read-only extension** is therefore bundled, and it does not modify core files:
  - Source: `integrations/opencart/apskaita_export/`
  - Package: `integrations/opencart/apskaita_export.ocmod.zip`
  - Admin: *Extensions → Other → Apskaita order export*. Settings are enable, shared key (≥ 32 characters), optional IP allowlist, and the return-status IDs that count as completed refunds.
- **Endpoint:** `index.php?route=extension/apskaita_export/other/apskaita_export&since=YYYY-MM-DD HH:MM:SS&after_id=N&limit=50`
- **Authentication:**
  - `X-Apskaita-Timestamp` must be within ±300 s.
  - `X-Apskaita-Signature` = hex HMAC-SHA256(key, `ts\nsince\nafter_id\nlimit`), compared with `hash_equals`.
- **Queries:** SELECT-only over `order`, `order_status`, `order_product`, `order_total` and `return`. Paging is keyset-based on `(date_modified, order_id)`, so it is stable and resumable.
- **Normalization:**
  - Line VAT rate = `tax / price` (snapped to known rates).
  - Shipping VAT is derived from the tax total.
  - Coupons and vouchers become a negative discount line at the single product rate, or go to review when the order has mixed rates.
  - The invoice number is `invoice_prefix + invoice_no` when `invoice_no > 0`.
  - Local times are converted from the shop zone (default Europe/Vilnius, DST-aware).
- **No webhooks:** polling and the daily reconcile only.
- **Installation:** *Extensions → Installer → Upload* the `.ocmod.zip`, then Install and Edit under *Extensions → Other*. Copy the key into *Integracijos* along with the shop base URL (without `index.php`).

## What the tests cover (fixture tests, not live verification)

`test/05-integrations.test.mjs`:

- **Saleor:** a local mock GraphQL server plus a JWKS endpoint with a test RSA key. Webhooks are signed exactly as described above.
- **OpenCart:** the real extension PHP code runs under `php -S` with a stub engine and DB (`test/php/oc-harness.php`) answering from `fixtures/stores/opencart-orders.json`.

Covered behaviour:

- initial import, repeated imports, equal order numbers across stores, status mapping, unsupported currency, approval in both invoice modes;
- duplicate and invalid webhook signatures, out-of-order delivery, refund → credit note, change after posting;
- 429 retry and resume, rejected OpenCart signatures and stale timestamps, labelled demo connections.

## Live verification checklist (not yet done)

1. **Saleor:**
   - Create an app with MANAGE_ORDERS. Run "Tikrinti ryšį", then "Pilnas importas" on a staging store.
   - Compare counts and totals for 10 orders.
   - Configure webhooks, fulfil, refund and cancel test orders, and confirm states and signatures.
2. **OpenCart 4.1:**
   - Install the zip on staging, enable it and set the key and allowed IP.
   - Run "Tikrinti ryšį" and "Pilnas importas", and compare totals including coupons and shipping.
   - Create a return with a completed status and confirm the credit-note proposal.
3. Confirm the tax rates and discount handling of real orders, and the status mapping, with the accountant.
