-- Ilgalaikis turtas: asset cards, monthly straight-line depreciation runs posted to the ledger, disposal (write-off / sale).

CREATE TABLE fixed_assets (
  id bigserial PRIMARY KEY,
  inv_no text NOT NULL UNIQUE,
  name text NOT NULL,
  cost_account text NOT NULL REFERENCES accounts(code),
  depreciation_account text NOT NULL REFERENCES accounts(code),
  expense_account text NOT NULL REFERENCES accounts(code),
  acquisition_date date NOT NULL,
  cost numeric(18,2) NOT NULL CHECK (cost > 0),
  residual_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months int NOT NULL CHECK (useful_life_months BETWEEN 1 AND 1200),
  -- First month of depreciation (LT practice: the month after the asset is put into use).
  depreciation_start text NOT NULL CHECK (depreciation_start ~ '^\d{4}-\d{2}$'),
  -- Assets taken over from an earlier system: depreciation accumulated up to and including opening_period.
  opening_accumulated numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_accumulated >= 0),
  opening_period text CHECK (opening_period IS NULL OR opening_period ~ '^\d{4}-\d{2}$'),
  location text NOT NULL DEFAULT '',
  responsible text NOT NULL DEFAULT '',
  invoice_line_id bigint UNIQUE REFERENCES invoice_lines(id),
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on date,
  disposal_kind text CHECK (disposal_kind IS NULL OR disposal_kind IN ('writeoff', 'sale')),
  disposal_entry_id bigint REFERENCES journal_entries(id),
  disposal_note text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (residual_value < cost),
  CHECK (opening_accumulated <= cost - residual_value)
);

-- One run per month for the whole company; cancelled runs keep their history (status), the ledger entry is reversed.
CREATE TABLE depreciation_runs (
  id bigserial PRIMARY KEY,
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  journal_entry_id bigint REFERENCES journal_entries(id),
  total numeric(18,2) NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX depreciation_runs_posted_uq ON depreciation_runs(period) WHERE status = 'posted';

CREATE TABLE depreciation_lines (
  run_id bigint NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL REFERENCES fixed_assets(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (run_id, asset_id)
);
