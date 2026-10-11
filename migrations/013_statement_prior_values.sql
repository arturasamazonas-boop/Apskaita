-- Previous-period figures for financial statement forms entered by hand
-- (e.g. the last year before the company's books were kept in this program).
CREATE TABLE fs_prior_values (
  form_key text NOT NULL,
  period_end date NOT NULL,
  line_id text NOT NULL,
  amount numeric(18,2) NOT NULL,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_key, period_end, line_id)
);
-- Signatures and numbering on statement forms.
ALTER TABLE company_settings
  ADD COLUMN manager_title text NOT NULL DEFAULT 'Direktorius',
  ADD COLUMN accountant_title text NOT NULL DEFAULT 'Buhalteris',
  ADD COLUMN accountant_name text NOT NULL DEFAULT '';
