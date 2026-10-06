-- Bank statements, imported transactions (separate from postings), reconciliation.

CREATE TABLE bank_accounts (
  id bigserial PRIMARY KEY,
  iban text NOT NULL UNIQUE,
  name text NOT NULL,
  bank_name text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR',
  ledger_account text NOT NULL REFERENCES accounts(code),
  kind text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','processor')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE bank_statements (
  id bigserial PRIMARY KEY,
  bank_account_id bigint NOT NULL REFERENCES bank_accounts(id),
  document_id bigint NOT NULL REFERENCES documents(id),
  file_id bigint NOT NULL REFERENCES stored_files(id),
  format text NOT NULL,
  statement_ref text NOT NULL DEFAULT '',
  period_from date,
  period_to date,
  opening_balance numeric(18,2),
  closing_balance numeric(18,2),
  credits_total numeric(18,2) NOT NULL DEFAULT 0,
  debits_total numeric(18,2) NOT NULL DEFAULT 0,
  balance_status text NOT NULL CHECK (balance_status IN ('ok','mismatch','missing')),
  issues jsonb NOT NULL DEFAULT '[]',
  resolved_by bigint REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  rows_total int NOT NULL DEFAULT 0,
  rows_new int NOT NULL DEFAULT 0,
  rows_duplicate int NOT NULL DEFAULT 0,
  rows_review int NOT NULL DEFAULT 0,
  imported_by bigint REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id)
);

CREATE TABLE bank_transactions (
  id bigserial PRIMARY KEY,
  bank_account_id bigint NOT NULL REFERENCES bank_accounts(id),
  first_statement_id bigint NOT NULL REFERENCES bank_statements(id),
  dedupe_key text NOT NULL,
  bank_tx_id text,
  fingerprint char(64) NOT NULL,
  occurrence int NOT NULL DEFAULT 1,
  booking_date date NOT NULL,
  value_date date,
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL,
  counterparty_name text NOT NULL DEFAULT '',
  counterparty_iban text NOT NULL DEFAULT '',
  counterparty_code text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  end_to_end_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','proposed','needs_review','approved','ignored')),
  duplicate_review boolean NOT NULL DEFAULT false,
  duplicate_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, dedupe_key)
);
CREATE INDEX bank_tx_status_idx ON bank_transactions(status, booking_date DESC);
CREATE INDEX bank_tx_fp_idx ON bank_transactions(bank_account_id, fingerprint);

-- Every row as extracted, with provenance, and what happened to it.
CREATE TABLE bank_statement_rows (
  id bigserial PRIMARY KEY,
  statement_id bigint NOT NULL REFERENCES bank_statements(id),
  row_no int NOT NULL,
  raw jsonb NOT NULL,
  source jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('new','duplicate','review','invalid')),
  transaction_id bigint REFERENCES bank_transactions(id),
  issue text,
  UNIQUE (statement_id, row_no)
);

CREATE TABLE statement_coverage (
  statement_id bigint NOT NULL REFERENCES bank_statements(id),
  transaction_id bigint NOT NULL REFERENCES bank_transactions(id),
  PRIMARY KEY (statement_id, transaction_id)
);

-- Reconciliation proposals (versioned like invoice proposals).
CREATE TABLE reconciliation_proposals (
  id bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES bank_transactions(id),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','superseded','approved','rejected')),
  data jsonb NOT NULL,
  validation jsonb NOT NULL,
  blocking boolean NOT NULL,
  content_hash char(64) NOT NULL,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by bigint REFERENCES users(id),
  decided_at timestamptz,
  UNIQUE (transaction_id, version)
);
CREATE UNIQUE INDEX recon_open_uq ON reconciliation_proposals(transaction_id) WHERE status = 'open';

-- Approved allocations. amount is in the invoice's settlement direction (positive reduces outstanding).
CREATE TABLE allocations (
  id bigserial PRIMARY KEY,
  transaction_id bigint REFERENCES bank_transactions(id),
  source_allocation_id bigint REFERENCES allocations(id),
  proposal_id bigint NOT NULL REFERENCES reconciliation_proposals(id),
  kind text NOT NULL CHECK (kind IN ('invoice','fee','own_transfer','advance','overpayment','refund','advance_application','other')),
  invoice_id bigint REFERENCES invoices(id),
  counterparty_id bigint REFERENCES counterparties(id),
  account_code text REFERENCES accounts(code),
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  journal_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  note text NOT NULL DEFAULT '',
  approved_by bigint NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allocations_invoice_idx ON allocations(invoice_id);
CREATE INDEX allocations_tx_idx ON allocations(transaction_id);
CREATE TRIGGER allocations_immutable BEFORE UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
