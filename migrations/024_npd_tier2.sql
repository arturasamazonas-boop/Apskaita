-- NPD second tier (GPMĮ 20 str.): in 2025, for monthly pay above 2 387,29 €, NPD = 400 − 0,18 × (DU − 642).
-- From 2026 there is a single formula, so the 2026/2027 rows leave these empty.
ALTER TABLE payroll_params ADD COLUMN npd2_from numeric(18,2), ADD COLUMN npd2_max numeric(18,2), ADD COLUMN npd2_base numeric(18,2), ADD COLUMN npd2_coef numeric(6,4);
UPDATE payroll_params SET npd2_from = 2387.29, npd2_max = 400.00, npd2_base = 642.00, npd2_coef = 0.18 WHERE effective_from = '2025-01-01';
