-- Extra company details filled from rekvizitai.lt (via the user's browser) or entered by hand.
ALTER TABLE counterparties
  ADD COLUMN legal_form text NOT NULL DEFAULT '',
  ADD COLUMN phone text NOT NULL DEFAULT '',
  ADD COLUMN website text NOT NULL DEFAULT '',
  ADD COLUMN manager text NOT NULL DEFAULT '',
  ADD COLUMN vat_checked_at timestamptz,
  ADD COLUMN vat_check_name text NOT NULL DEFAULT '';
ALTER TABLE company_settings
  ADD COLUMN website text NOT NULL DEFAULT '',
  ADD COLUMN manager text NOT NULL DEFAULT '',
  ADD COLUMN iban text NOT NULL DEFAULT '',
  ADD COLUMN bank_name text NOT NULL DEFAULT '';
