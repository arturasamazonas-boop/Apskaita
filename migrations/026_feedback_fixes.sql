-- Payroll: a line can be paid on its own date (final settlement on the last working day, DK 146 str.),
-- so GPM313 counts it in the month it was really paid.
ALTER TABLE payroll_lines ADD COLUMN payment_date date;

-- Cash orders can be corrected (same number, new entry) or deleted when last in their series. The ledger stays
-- append-only: the old entry is reversed, and the pair is recorded here so the cash book can leave it out.
ALTER TABLE cash_orders DROP CONSTRAINT cash_orders_status_check;
ALTER TABLE cash_orders ADD CONSTRAINT cash_orders_status_check CHECK (status IN ('posted','cancelled','deleted'));
CREATE TABLE cash_order_revisions (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES cash_orders(id),
  kind text NOT NULL CHECK (kind IN ('edit','delete')),
  old_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  reversal_entry_id bigint NOT NULL REFERENCES journal_entries(id),
  before jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  changed_by bigint REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Invoices sent by e-mail: what was sent, to whom, and whether the e-mail service accepted it.
CREATE TABLE invoice_emails (
  id bigserial PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES invoices(id),
  recipients text NOT NULL,
  subject text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','failed')),
  provider_id text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  sent_by bigint REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_emails_invoice_idx ON invoice_emails(invoice_id);

-- Cost of sales posted with each sales invoice (perpetual inventory): the cost booked for a goods line is kept on
-- the line, so the monthly cost-of-sales check and calculation leave those lines out.
ALTER TABLE invoice_lines ADD COLUMN cogs_amount numeric(18,2);
ALTER TABLE company_settings ADD COLUMN auto_cogs boolean NOT NULL DEFAULT true;
-- A company that already books the cost of sales monthly keeps doing so (no double counting); it can switch in the settings.
UPDATE company_settings SET auto_cogs = false WHERE EXISTS (SELECT 1 FROM cogs_periods);
