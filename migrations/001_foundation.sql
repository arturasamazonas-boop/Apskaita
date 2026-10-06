-- Apskaita: foundation schema (company, users, audit, ledger, vault, jobs).
-- All money columns are NUMERIC(18,2); unit prices/quantities NUMERIC(18,4).

CREATE TABLE company_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL DEFAULT '',
  legal_form text NOT NULL DEFAULT '',
  company_code text NOT NULL DEFAULT '',
  vat_code text NOT NULL DEFAULT '',
  vat_registered boolean NOT NULL DEFAULT false,
  vat_registered_from date,
  address text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT 'LT',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  timezone text NOT NULL DEFAULT 'Europe/Vilnius',
  asset_threshold numeric(18,2) NOT NULL DEFAULT 500.00,
  locked_through date,
  onboarding_done boolean NOT NULL DEFAULT false,
  retention_note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO company_settings (id) VALUES (1);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('admin','accountant','readonly')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_attempts (
  key text PRIMARY KEY,
  failures int NOT NULL DEFAULT 0,
  blocked_until timestamptz
);

-- Append-only audit trail.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id bigint REFERENCES users(id),
  actor text NOT NULL DEFAULT 'user',
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_at_idx ON audit_log(at DESC);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Chart of accounts.
CREATE TABLE accounts (
  code text PRIMARY KEY CHECK (code ~ '^[0-9]{1,8}$'),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  subtype text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  system_role text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tax codes with effective dates (rates verified by accountant; see docs/TAX_RULES.md).
CREATE TABLE tax_codes (
  id bigserial PRIMARY KEY,
  code text NOT NULL,
  isaf_code text NOT NULL,
  rate numeric(6,2), -- NULL = no rate (exempt / outside scope)
  description text NOT NULL,
  applies_to text NOT NULL CHECK (applies_to IN ('sales','purchase','both')),
  effective_from date NOT NULL,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (code, effective_from)
);

CREATE TABLE counterparties (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  company_code text NOT NULL DEFAULT '',
  vat_code text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT 'LT',
  email text NOT NULL DEFAULT '',
  iban text NOT NULL DEFAULT '',
  is_supplier boolean NOT NULL DEFAULT false,
  is_customer boolean NOT NULL DEFAULT false,
  is_individual boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX counterparties_code_uq ON counterparties(company_code) WHERE company_code <> '';
CREATE INDEX counterparties_vat_idx ON counterparties(vat_code) WHERE vat_code <> '';
CREATE INDEX counterparties_iban_idx ON counterparties(iban) WHERE iban <> '';
CREATE INDEX counterparties_name_idx ON counterparties(lower(name));

-- Journal: immutable once inserted; balance enforced by deferred constraint trigger.
CREATE TABLE journal_entries (
  id bigserial PRIMARY KEY,
  entry_date date NOT NULL,
  description text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  reverses_entry_id bigint REFERENCES journal_entries(id),
  idempotency_key text NOT NULL UNIQUE,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_date_idx ON journal_entries(entry_date);
CREATE INDEX journal_entries_source_idx ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL REFERENCES journal_entries(id),
  account_code text NOT NULL REFERENCES accounts(code),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  counterparty_id bigint REFERENCES counterparties(id),
  description text NOT NULL DEFAULT '',
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_code);

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'UNBALANCED: journal entry % debit % credit % lines %', NEW.entry_id, d, c, n;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Period locking applies to every insert, including background jobs.
CREATE FUNCTION check_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked date;
BEGIN
  SELECT locked_through INTO locked FROM company_settings WHERE id = 1;
  IF locked IS NOT NULL AND NEW.entry_date <= locked THEN
    RAISE EXCEPTION 'PERIOD_LOCKED: % is on or before locked date %', NEW.entry_date, locked;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_period BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- Document vault.
CREATE TABLE documents (
  id bigserial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'unknown' CHECK (kind IN
    ('unknown','purchase_invoice','sales_invoice','credit_note','proforma','contract','bank_statement','receipt','generated_invoice','other')),
  title text NOT NULL DEFAULT '',
  counterparty_id bigint REFERENCES counterparties(id),
  reference_number text NOT NULL DEFAULT '',
  issue_date date,
  start_date date,
  end_date date,
  contract_status text CHECK (contract_status IN ('draft','active','expired','terminated','archived')),
  contract_status_manual boolean NOT NULL DEFAULT false,
  contract_value numeric(18,2),
  contract_currency char(3),
  tags text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  confidentiality text NOT NULL DEFAULT 'normal' CHECK (confidentiality IN ('normal','restricted','admin_only')),
  workflow text NOT NULL DEFAULT 'vault' CHECK (workflow IN ('vault','invoice','bank','generated')),
  processing_status text NOT NULL DEFAULT 'uploaded' CHECK (processing_status IN
    ('uploaded','processing','needs_review','ready','posted','rejected','failed','stored')),
  processing_error text,
  split_hint jsonb,
  parent_document_id bigint REFERENCES documents(id),
  archived boolean NOT NULL DEFAULT false,
  retain_until date,
  legal_hold boolean NOT NULL DEFAULT false,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_text tsvector
);
CREATE INDEX documents_status_idx ON documents(workflow, processing_status, created_at DESC);
CREATE INDEX documents_kind_idx ON documents(kind, created_at DESC);
CREATE INDEX documents_created_idx ON documents(created_at DESC, id DESC);
CREATE INDEX documents_search_idx ON documents USING gin(search_text);
CREATE INDEX documents_tags_idx ON documents USING gin(tags);

CREATE TABLE stored_files (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  version int NOT NULL,
  role text NOT NULL CHECK (role IN ('original','preview','ocr_text','split_part','generated')),
  page int,
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL,
  mime text NOT NULL,
  original_name text NOT NULL DEFAULT '',
  storage_key text NOT NULL,
  derived_from_file_id bigint REFERENCES stored_files(id),
  uploaded_by bigint REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX stored_files_original_version_uq ON stored_files(document_id, version) WHERE role = 'original';
CREATE INDEX stored_files_sha_idx ON stored_files(sha256);
CREATE INDEX stored_files_doc_idx ON stored_files(document_id, role);
CREATE TRIGGER stored_files_immutable BEFORE UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE document_pages (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  file_id bigint NOT NULL REFERENCES stored_files(id),
  page int NOT NULL,
  method text NOT NULL,
  text text NOT NULL,
  UNIQUE (file_id, page)
);

CREATE TABLE document_links (
  from_document_id bigint NOT NULL REFERENCES documents(id),
  to_document_id bigint NOT NULL REFERENCES documents(id),
  relation text NOT NULL,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_document_id, to_document_id, relation)
);

-- Durable background jobs.
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  progress jsonb,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs(status, run_at) WHERE status IN ('queued','running');
