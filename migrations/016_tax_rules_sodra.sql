-- PLN204: expense accounts whose amounts (or a share of them) are non-deductible for profit tax (PMĮ 31 str.),
-- with the PLN204S kind code (S1). Sodra employer code for the SAM report.
CREATE TABLE tax_nondeductible_rules (
  account_code text PRIMARY KEY REFERENCES accounts(code),
  code text NOT NULL CHECK (code ~ '^[0-9]{2}$'),
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  note text NOT NULL DEFAULT ''
);
INSERT INTO tax_nondeductible_rules(account_code, code, percent, note)
SELECT code, x.c, x.p, x.n FROM accounts JOIN (VALUES
  ('6311', '01', 100, 'Baudos ir delspinigiai'),
  ('6804', '01', 100, 'Baudos ir delspinigiai (finansinė veikla)'),
  ('6319', '06', 50, 'Reprezentacija: leidžiami atskaitymai – 50 % (PMĮ 22 str.)')
) AS x(a, c, p, n) ON x.a = accounts.code;

ALTER TABLE company_settings ADD COLUMN sodra_code text NOT NULL DEFAULT '';
