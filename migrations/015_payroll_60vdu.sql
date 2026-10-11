-- GPM 32 % on employment income above 60 VDU a year at the employer, and the 60 VDU ceiling for the employee's VSD.
ALTER TABLE payroll_params ADD COLUMN gpm_rate_high numeric(5,2) NOT NULL DEFAULT 32.00;
UPDATE payroll_params SET vdu = 2108.88 WHERE effective_from = '2025-01-01' AND vdu IS NULL;
UPDATE payroll_params SET note = '2025 m.: MMA 1038 €, NPD 747 − 0,49 × (DU − 1038). VDU 2108,88 €: metinėms darbo pajamoms virš 60 VDU – GPM 32 %, VSD neskaičiuojamas.' WHERE effective_from = '2025-01-01';
UPDATE payroll_params SET note = '2026 m.: MMA 1153 €, NPD 747 − 0,49 × (DU − MMA). VDU 2312,15 €: metinėms darbo pajamoms virš 60 VDU – GPM 32 %, VSD neskaičiuojamas (PSD – be lubų). 25 % tarifas (36–60 VDU) – metinėje deklaracijoje.' WHERE effective_from = '2026-01-01';
