-- Kasos pajamų (KPO) ir išlaidų (KIO) orderiai: numbered cash documents posted to the cash account (272),
-- settling invoices (allocations), transfers with the bank, accountable persons and other accounts.
CREATE TABLE cash_order_series (
  kind text PRIMARY KEY CHECK (kind IN ('receipt','payment')),
  prefix text NOT NULL CHECK (prefix ~ '^[A-Z0-9]{1,10}$'),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  padding int NOT NULL DEFAULT 6
);
INSERT INTO cash_order_series(kind, prefix) VALUES ('receipt', 'KPO'), ('payment', 'KIO');

CREATE TABLE cash_orders (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('receipt','payment')),
  series text NOT NULL,
  number text NOT NULL,
  doc_date date NOT NULL,
  cash_account text NOT NULL REFERENCES accounts(code),
  purpose text NOT NULL CHECK (purpose IN ('invoice','advance','bank','accountable','other')),
  invoice_id bigint REFERENCES invoices(id),
  counterparty_id bigint REFERENCES counterparties(id),
  employee_id bigint REFERENCES employees(id),
  person_name text NOT NULL DEFAULT '',
  person_code text NOT NULL DEFAULT '',
  account_code text NOT NULL REFERENCES accounts(code),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  basis text NOT NULL DEFAULT '',
  attachment text NOT NULL DEFAULT '',
  journal_entry_id bigint REFERENCES journal_entries(id),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
  cancel_entry_id bigint REFERENCES journal_entries(id),
  cancel_reason text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series, number)
);
CREATE INDEX cash_orders_date_idx ON cash_orders(doc_date);

-- Invoice payments in cash are allocations without a bank transaction / reconciliation proposal.
ALTER TABLE allocations ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE allocations ADD COLUMN cash_order_id bigint REFERENCES cash_orders(id);
ALTER TABLE allocations ADD CONSTRAINT allocations_source_chk CHECK (proposal_id IS NOT NULL OR cash_order_id IS NOT NULL);
