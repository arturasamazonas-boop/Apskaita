-- Valiutų kursai ir perkainojimas.
-- Rates: units of the currency for 1 EUR (as published by Lietuvos bankas, type EU), by the date of publication.
CREATE TABLE fx_rates (
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'EUR'),
  rate_date date NOT NULL,
  rate numeric(18,6) NOT NULL CHECK (rate > 0),
  source text NOT NULL DEFAULT 'LB' CHECK (source IN ('LB', 'manual')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, rate_date)
);

-- Foreign-currency invoices are booked in EUR at the rate of the transaction date; the amounts in the invoice
-- currency are kept here (all other amount columns of invoices, lines and VAT rows are EUR).
ALTER TABLE invoices ADD COLUMN fx_rate numeric(18,6), ADD COLUMN fx_date date,
  ADD COLUMN orig_net numeric(18,2), ADD COLUMN orig_vat numeric(18,2), ADD COLUMN orig_gross numeric(18,2);

-- Period-end revaluation of open foreign-currency invoices and foreign-currency bank accounts.
CREATE TABLE fx_revaluations (
  id bigserial PRIMARY KEY,
  as_of date NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  journal_entry_id bigint REFERENCES journal_entries(id),
  cancel_entry_id bigint REFERENCES journal_entries(id),
  lines jsonb NOT NULL DEFAULT '[]',
  gain numeric(18,2) NOT NULL DEFAULT 0,
  loss numeric(18,2) NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fx_revaluations_posted_uq ON fx_revaluations(as_of) WHERE status = 'posted';

-- Allocations: amount stays EUR (what is cleared from the invoice's EUR balance); orig_amount is the part of the
-- invoice settled in the invoice currency. Revaluation changes the EUR balance without settling anything.
ALTER TABLE allocations ADD COLUMN orig_amount numeric(18,2), ADD COLUMN fx_revaluation_id bigint REFERENCES fx_revaluations(id);
ALTER TABLE allocations DROP CONSTRAINT allocations_kind_check;
ALTER TABLE allocations ADD CONSTRAINT allocations_kind_check CHECK (kind IN ('invoice','fee','own_transfer','advance','overpayment','refund','advance_application','other','fx_revaluation'));
ALTER TABLE allocations DROP CONSTRAINT allocations_source_chk;
ALTER TABLE allocations ADD CONSTRAINT allocations_source_chk CHECK (proposal_id IS NOT NULL OR cash_order_id IS NOT NULL OR fx_revaluation_id IS NOT NULL);

-- Foreign-currency bank transactions: EUR amount posted (at the rate of the booking date).
ALTER TABLE bank_transactions ADD COLUMN eur_amount numeric(18,2), ADD COLUMN fx_rate numeric(18,6);
