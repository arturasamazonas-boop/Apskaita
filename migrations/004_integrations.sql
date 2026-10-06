-- E-commerce integrations: store identity + external object identity is unique.

CREATE TABLE external_orders (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  external_id text NOT NULL,
  order_number text NOT NULL,
  external_status text NOT NULL DEFAULT '',
  currency char(3) NOT NULL,
  external_updated_at timestamptz,
  data jsonb NOT NULL,
  data_hash char(64) NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK (state IN ('new','waiting_status','proposed','posted','changed_after_post','needs_review','ignored')),
  state_note text,
  invoice_id bigint REFERENCES invoices(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, external_id)
);
CREATE INDEX external_orders_store_idx ON external_orders(store_id, updated_at DESC);

CREATE TABLE external_order_versions (
  id bigserial PRIMARY KEY,
  external_order_id bigint NOT NULL REFERENCES external_orders(id),
  data_hash char(64) NOT NULL,
  data jsonb NOT NULL,
  external_updated_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  UNIQUE (external_order_id, data_hash)
);

-- Refunds/returns observed on the store, each resolved once.
CREATE TABLE external_refunds (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  external_order_id bigint NOT NULL REFERENCES external_orders(id),
  external_id text NOT NULL,
  amount numeric(18,2) NOT NULL,
  data jsonb NOT NULL,
  proposal_id bigint REFERENCES proposals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, external_id)
);

CREATE TABLE webhook_events (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  event_key text NOT NULL,
  event_type text NOT NULL,
  verified boolean NOT NULL,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  UNIQUE (store_id, event_key)
);

CREATE TABLE sync_runs (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  kind text NOT NULL CHECK (kind IN ('initial','incremental','reconcile','webhook')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  fetched int NOT NULL DEFAULT 0,
  created int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  unchanged int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  cursor text,
  last_error text
);
CREATE INDEX sync_runs_store_idx ON sync_runs(store_id, started_at DESC);

ALTER TABLE proposals ADD CONSTRAINT proposals_ext_order_fk FOREIGN KEY (external_order_id) REFERENCES external_orders(id);
CREATE UNIQUE INDEX proposals_open_per_order_uq ON proposals(external_order_id) WHERE status = 'open' AND external_order_id IS NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_ext_order_fk FOREIGN KEY (external_order_id) REFERENCES external_orders(id);
-- One original sales invoice per external order (prevents double issuance).
CREATE UNIQUE INDEX invoices_one_per_order_uq ON invoices(external_order_id) WHERE external_order_id IS NOT NULL AND doc_type IN ('invoice','vat_invoice');
