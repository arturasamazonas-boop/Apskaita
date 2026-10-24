-- Tax calendar: which returns were filed (the calendar itself is computed from the rules in src/tax/calendar.mjs).
CREATE TABLE tax_filings (
  form text NOT NULL,
  period text NOT NULL,                 -- YYYY-MM for monthly returns, YYYY for annual ones
  filed_on date NOT NULL,
  reference text NOT NULL DEFAULT '',   -- e.g. the EDS registration number
  note text NOT NULL DEFAULT '',
  filed_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form, period)
);

-- Bank CSV/XLSX column mapping remembered by the header row, so the next file of the same bank needs no mapping.
CREATE TABLE bank_csv_profiles (
  header_key text PRIMARY KEY,
  headers jsonb NOT NULL,
  mapping jsonb NOT NULL,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Recurring sales invoices: a template that creates draft invoices for review on its schedule.
CREATE TABLE recurring_invoices (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  counterparty_id bigint NOT NULL REFERENCES counterparties(id),
  series_code text NOT NULL DEFAULT 'PP',
  lines jsonb NOT NULL,
  interval_months smallint NOT NULL DEFAULT 1 CHECK (interval_months BETWEEN 1 AND 12),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),  -- kept when a month is shorter
  next_date date NOT NULL,
  end_date date,
  due_days smallint NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 0 AND 365),
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  last_document_id bigint REFERENCES documents(id),
  last_run_at timestamptz,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
