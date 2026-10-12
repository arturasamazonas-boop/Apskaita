-- 2027 m. atlyginimų parametrai. MMA 1245 € (valandinis 7,61 €) – Vyriausybės 2026-07-01 sprendimas, galioja nuo
-- 2027-01-01. NPD formulė (747 − 0,49 × (DU − MMA)), GPM ir Sodros tarifai nesikeičia. 2027 m. draudžiamųjų pajamų
-- dydis (VDU, 60 VDU riba) dar nepatvirtintas – vdu paliekamas tuščias ir įrašomas, kai Vyriausybė jį patvirtins.
INSERT INTO payroll_params(effective_from, mma, vdu, npd_max, npd_coef, gpm_rate, gpm_rate_high, vsd_rate, psd_rate, pension_extra_rate, employer_rate, employer_rate_fixed, note)
VALUES ('2027-01-01', 1245.00, NULL, 747.00, 0.49, 20.00, 32.00, 12.52, 6.98, 3.00, 1.77, 2.49,
  '2027 m.: MMA 1245 € (valandinis 7,61 €), NPD 747 − 0,49 × (DU − MMA). VDU 2027 m. dar nepatvirtintas – įrašykite, kai Vyriausybė patvirtins (60 VDU riba: GPM 32 %, VSD lubos). Papildomas NPD už vaikus (87 €/mėn. vienam vaikui) taikomas metinėje deklaracijoje, ne kas mėnesį.')
ON CONFLICT (effective_from) DO NOTHING;
