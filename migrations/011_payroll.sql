-- Atlyginimai: employees, dated payroll parameters (MMA, NPD formula, GPM and Sodra rates), monthly payroll
-- sheets. Approving a sheet posts one journal entry (D 6304 / K 4480, 4481, 4482); cancelling reverses it.

CREATE TABLE employees (
  id bigserial PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  personal_code text NOT NULL DEFAULT '' CHECK (personal_code = '' OR personal_code ~ '^[0-9]{11}$'),
  sodra_no text NOT NULL DEFAULT '',
  position text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  employment_start date NOT NULL,
  employment_end date,
  contract_type text NOT NULL DEFAULT 'indefinite' CHECK (contract_type IN ('indefinite','fixed_term')),
  pay_type text NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','hourly')),
  base_salary numeric(18,2),
  hourly_rate numeric(18,4),
  hours_per_week numeric(5,2) NOT NULL DEFAULT 40,
  apply_npd boolean NOT NULL DEFAULT true,
  npd_fixed numeric(18,2),
  pension_extra boolean NOT NULL DEFAULT false,
  expense_account text NOT NULL DEFAULT '6304' REFERENCES accounts(code),
  iban text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (employment_end IS NULL OR employment_end >= employment_start),
  CHECK ((pay_type = 'monthly' AND base_salary IS NOT NULL) OR (pay_type = 'hourly' AND hourly_rate IS NOT NULL))
);
CREATE UNIQUE INDEX employees_personal_code_uq ON employees(personal_code) WHERE personal_code <> '';

-- Rates are data with effective dates, so a new year is a new row, not a code change.
CREATE TABLE payroll_params (
  effective_from date PRIMARY KEY,
  mma numeric(18,2) NOT NULL,             -- minimali mėnesinė alga
  vdu numeric(18,2),                      -- šalies vidutinis darbo užmokestis (informacija, GPM ribos)
  npd_max numeric(18,2) NOT NULL,         -- NPD = npd_max − npd_coef × (DU − MMA), kai DU > MMA
  npd_coef numeric(6,4) NOT NULL,
  gpm_rate numeric(5,2) NOT NULL,         -- taikomas išskaičiuojant kas mėnesį
  vsd_rate numeric(5,2) NOT NULL,         -- darbuotojo VSD (pensijų, ligos, motinystės, nedarbo)
  psd_rate numeric(5,2) NOT NULL,         -- darbuotojo PSD
  pension_extra_rate numeric(5,2) NOT NULL, -- papildomas kaupimas pensijų fonde (II pakopa)
  employer_rate numeric(5,2) NOT NULL,    -- darbdavio Sodra, neterminuota sutartis
  employer_rate_fixed numeric(5,2) NOT NULL, -- darbdavio Sodra, terminuota sutartis
  note text NOT NULL DEFAULT ''
);
INSERT INTO payroll_params VALUES
 ('2025-01-01', 1038.00, NULL, 747.00, 0.49, 20.00, 12.52, 6.98, 3.00, 1.77, 2.49, '2025 m.: MMA 1038 €, NPD 747 − 0,49 × (DU − 1038).'),
 ('2026-01-01', 1153.00, 2312.15, 747.00, 0.49, 20.00, 12.52, 6.98, 3.00, 1.77, 2.49, '2026 m.: MMA 1153 €, NPD 747 − 0,49 × (DU − MMA). GPM 25 % / 32 % taikomas metinėms pajamoms virš 36 / 60 VDU – mėnesinis išskaičiavimas 20 % (didesnis tik darbuotojo prašymu).');

CREATE TABLE payroll_runs (
  id bigserial PRIMARY KEY,
  period char(7) NOT NULL UNIQUE CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  payment_date date NOT NULL,
  norm_days int NOT NULL CHECK (norm_days BETWEEN 0 AND 31),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  approval_no int NOT NULL DEFAULT 0,
  journal_entry_id bigint REFERENCES journal_entries(id),
  note text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id),
  approved_by bigint REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_lines (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id bigint NOT NULL REFERENCES employees(id),
  worked_days numeric(5,2) NOT NULL DEFAULT 0,
  worked_hours numeric(7,2) NOT NULL DEFAULT 0,
  base numeric(18,2) NOT NULL DEFAULT 0,
  bonus numeric(18,2) NOT NULL DEFAULT 0,
  vacation_pay numeric(18,2) NOT NULL DEFAULT 0,
  sick_pay numeric(18,2) NOT NULL DEFAULT 0,
  other_pay numeric(18,2) NOT NULL DEFAULT 0,
  gross numeric(18,2) NOT NULL DEFAULT 0,
  npd numeric(18,2) NOT NULL DEFAULT 0,
  gpm numeric(18,2) NOT NULL DEFAULT 0,
  vsd numeric(18,2) NOT NULL DEFAULT 0,
  psd numeric(18,2) NOT NULL DEFAULT 0,
  pension numeric(18,2) NOT NULL DEFAULT 0,
  net numeric(18,2) NOT NULL DEFAULT 0,
  advance numeric(18,2) NOT NULL DEFAULT 0,
  to_pay numeric(18,2) NOT NULL DEFAULT 0,
  employer_sodra numeric(18,2) NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '',
  UNIQUE (run_id, employee_id)
);
