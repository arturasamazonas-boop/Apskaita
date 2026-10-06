-- Invoice inbox: extractions, versioned proposals, rules, posted registers.

CREATE TABLE extractions (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  file_id bigint NOT NULL REFERENCES stored_files(id),
  provider text NOT NULL,
  provider_version text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extractions_doc_idx ON extractions(document_id, id DESC);
CREATE TRIGGER extractions_immutable BEFORE UPDATE OR DELETE ON extractions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE document_series (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{1,10}$'),
  register text NOT NULL CHECK (register IN ('sales')),
  doc_type text NOT NULL CHECK (doc_type IN ('invoice','credit_note')),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  padding int NOT NULL DEFAULT 6,
  active boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE stores (
  id bigserial PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('saleor','opencart')),
  name text NOT NULL,
  base_url text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  secret_encrypted text,
  invoice_mode text NOT NULL DEFAULT 'issue_here' CHECK (invoice_mode IN ('issue_here','import_external')),
  status_mapping jsonb NOT NULL DEFAULT '{}',
  is_demo boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sync_cursor text,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Proposals: each edit creates a new version; only the latest 'open' version may be approved.
CREATE TABLE proposals (
  id bigserial PRIMARY KEY,
  document_id bigint REFERENCES documents(id),
  external_order_id bigint,
  kind text NOT NULL CHECK (kind IN ('invoice','correction','credit_note','manual_invoice')),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','superseded','approved','rejected')),
  extraction_id bigint REFERENCES extractions(id),
  corrects_invoice_id bigint,
  data jsonb NOT NULL,
  validation jsonb NOT NULL,
  blocking boolean NOT NULL,
  content_hash char(64) NOT NULL,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by bigint REFERENCES users(id),
  decided_at timestamptz,
  decision_note text
);
CREATE UNIQUE INDEX proposals_doc_version_uq ON proposals(document_id, version) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX proposals_open_per_doc_uq ON proposals(document_id) WHERE status = 'open' AND document_id IS NOT NULL;
CREATE INDEX proposals_status_idx ON proposals(status, created_at DESC);

-- Approved classification rules (versioned; never learned automatically).
CREATE TABLE classification_rules (
  id bigserial PRIMARY KEY,
  rule_key text NOT NULL,
  version int NOT NULL,
  name text NOT NULL,
  register text NOT NULL CHECK (register IN ('purchase','sales')),
  counterparty_id bigint REFERENCES counterparties(id),
  match_text text NOT NULL DEFAULT '',
  priority int NOT NULL DEFAULT 100,
  effective_from date NOT NULL,
  effective_to date,
  account_code text NOT NULL REFERENCES accounts(code),
  line_type text NOT NULL CHECK (line_type IN ('expense','inventory','service','asset','prepaid','revenue_goods','revenue_services','other')),
  vat_treatment text NOT NULL CHECK (vat_treatment IN ('deductible','non_deductible','review','output')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by bigint NOT NULL REFERENCES users(id),
  approved_by bigint NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  note text NOT NULL DEFAULT '',
  UNIQUE (rule_key, version)
);
CREATE UNIQUE INDEX rules_active_key_uq ON classification_rules(rule_key) WHERE status = 'active';

-- Posted register rows (purchase and sales). Immutable financial particulars snapshot.
CREATE TABLE invoices (
  id bigserial PRIMARY KEY,
  register text NOT NULL CHECK (register IN ('purchase','sales')),
  doc_type text NOT NULL CHECK (doc_type IN ('invoice','vat_invoice','credit_note','debit_note','correction')),
  series text NOT NULL DEFAULT '',
  number text NOT NULL,
  number_key text NOT NULL,
  issue_date date NOT NULL,
  vat_point_date date,
  due_date date,
  currency char(3) NOT NULL,
  counterparty_id bigint REFERENCES counterparties(id),
  counterparty_key text NOT NULL,
  counterparty_snapshot jsonb NOT NULL,
  company_snapshot jsonb NOT NULL,
  net_total numeric(18,2) NOT NULL,
  vat_total numeric(18,2) NOT NULL,
  gross_total numeric(18,2) NOT NULL,
  deductible_vat numeric(18,2) NOT NULL DEFAULT 0,
  document_id bigint REFERENCES documents(id),
  proposal_id bigint NOT NULL UNIQUE REFERENCES proposals(id),
  journal_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  related_invoice_id bigint REFERENCES invoices(id),
  store_id bigint REFERENCES stores(id),
  external_order_id bigint,
  order_reference text NOT NULL DEFAULT '',
  payment_reference text NOT NULL DEFAULT '',
  approved_by bigint NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register, counterparty_key, number_key, doc_type)
);
CREATE INDEX invoices_date_idx ON invoices(register, issue_date DESC, id DESC);
CREATE INDEX invoices_cp_idx ON invoices(counterparty_id);
CREATE INDEX invoices_related_idx ON invoices(related_invoice_id);
CREATE UNIQUE INDEX invoices_document_uq ON invoices(document_id) WHERE document_id IS NOT NULL AND doc_type NOT IN ('correction');
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE invoice_lines (
  id bigserial PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  line_no int NOT NULL,
  description text NOT NULL,
  sku text NOT NULL DEFAULT '',
  product_id bigint,
  quantity numeric(18,4) NOT NULL,
  unit text NOT NULL DEFAULT '',
  unit_price numeric(18,4) NOT NULL,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  net numeric(18,2) NOT NULL,
  tax_code text NOT NULL,
  vat_rate numeric(6,2) NOT NULL,
  vat numeric(18,2) NOT NULL,
  gross numeric(18,2) NOT NULL,
  account_code text NOT NULL REFERENCES accounts(code),
  line_type text NOT NULL,
  vat_treatment text NOT NULL,
  rule_id bigint REFERENCES classification_rules(id),
  UNIQUE (invoice_id, line_no)
);
CREATE INDEX invoice_lines_product_idx ON invoice_lines(product_id);
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- VAT register rows per tax code (i.SAF DocumentTotals source).
CREATE TABLE invoice_vat_rows (
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  tax_code text NOT NULL,
  isaf_code text NOT NULL,
  rate numeric(6,2),
  taxable numeric(18,2) NOT NULL,
  vat numeric(18,2) NOT NULL,
  deductible_vat numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (invoice_id, tax_code)
);
CREATE TRIGGER invoice_vat_rows_immutable BEFORE UPDATE OR DELETE ON invoice_vat_rows
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE products (
  id bigserial PRIMARY KEY,
  sku text NOT NULL DEFAULT '',
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','service')),
  unit text NOT NULL DEFAULT 'vnt.',
  tax_code text NOT NULL DEFAULT 'PVM1',
  unit_price numeric(18,4),
  revenue_account text REFERENCES accounts(code),
  expense_account text REFERENCES accounts(code),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_uq ON products(sku) WHERE sku <> '';

CREATE TABLE product_external_refs (
  store_id bigint NOT NULL REFERENCES stores(id),
  external_id text NOT NULL,
  product_id bigint NOT NULL REFERENCES products(id),
  external_sku text NOT NULL DEFAULT '',
  PRIMARY KEY (store_id, external_id)
);

-- Cost-of-sales confirmations per month (manual accountant workflow).
CREATE TABLE cogs_periods (
  period char(7) PRIMARY KEY CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  journal_entry_id bigint REFERENCES journal_entries(id),
  confirmed_by bigint REFERENCES users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT ''
);
