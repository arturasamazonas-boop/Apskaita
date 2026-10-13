-- Palūkanų kaupimas DK. Each accrual brings the interest booked for a loan up to the interest calculated to its
-- date: received loan D interest expense / K accrued expenses, granted loan D accrued income / K interest income.
-- Accounts come from the loan (when set) or from the posting roles below.
ALTER TABLE loans ADD COLUMN interest_account text REFERENCES accounts(code), ADD COLUMN accrual_account text REFERENCES accounts(code);

CREATE TABLE loan_accruals (
  id bigserial PRIMARY KEY,
  loan_id bigint NOT NULL REFERENCES loans(id),
  as_of date NOT NULL,
  period_from date,
  interest_total numeric(18,2) NOT NULL,           -- interest calculated to as_of (loan currency)
  amount numeric(18,2) NOT NULL CHECK (amount <> 0), -- booked by this accrual (loan currency; negative = correction)
  amount_eur numeric(18,2) NOT NULL,
  fx_rate numeric(18,6),
  include_last_day boolean NOT NULL,
  debit_account text NOT NULL,
  credit_account text NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  journal_entry_id bigint REFERENCES journal_entries(id),
  cancel_entry_id bigint REFERENCES journal_entries(id),
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_accruals_loan_idx ON loan_accruals(loan_id, as_of);
CREATE UNIQUE INDEX loan_accruals_posted_uq ON loan_accruals(loan_id, as_of) WHERE status = 'posted';

-- Posting roles (only where the role is not set yet).
UPDATE accounts a SET system_role = v.role FROM (VALUES ('6802', 'interest_expense'), ('491', 'interest_accrued'), ('5802', 'interest_income'), ('292', 'interest_receivable')) AS v(code, role)
 WHERE a.code = v.code AND a.system_role IS NULL AND a.active AND a.postable AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.system_role = v.role);
