-- Paskolos ir palūkanų skaičiavimas. A loan is either received by the company (gauta paskola) or granted by it
-- (suteikta paskola). Interest accrues from the day the money arrived (disbursement events), never from the
-- signing date. Terms may come from the agreement in the document vault (read automatically and confirmed by
-- the user) or be entered by hand.
CREATE TABLE loans (
  id bigserial PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('received', 'granted')),
  counterparty_id bigint REFERENCES counterparties(id),
  counterparty_name text NOT NULL DEFAULT '',
  contract_no text NOT NULL DEFAULT '',
  contract_date date,
  maturity_date date,
  principal numeric(18,2) NOT NULL CHECK (principal > 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  annual_rate numeric(9,4) NOT NULL CHECK (annual_rate >= 0 AND annual_rate < 100),
  rate_variable boolean NOT NULL DEFAULT false,
  basis text NOT NULL DEFAULT 'act365' CHECK (basis IN ('act365', 'act360', 'actact', '30e360')),
  include_last_day boolean NOT NULL DEFAULT false,
  document_id bigint REFERENCES documents(id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'document')),
  extracted jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  notes text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loans_document_idx ON loans(document_id);

CREATE TABLE loan_events (
  id bigserial PRIMARY KEY,
  loan_id bigint NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  event_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('disbursement', 'repayment', 'rate_change', 'interest_payment')),
  amount numeric(18,2) CHECK (amount > 0),
  rate numeric(9,4) CHECK (rate >= 0 AND rate < 100),
  bank_transaction_id bigint REFERENCES bank_transactions(id),
  note text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'rate_change') = (rate IS NOT NULL AND amount IS NULL))
);
CREATE INDEX loan_events_loan_idx ON loan_events(loan_id, event_date);
