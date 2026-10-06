# Payroll (Atlyginimai)

Menu: *Atlyginimai* (sheets, employees, rates) and *Žinynai → Darbuotojai*.

## Parameters

Parameters are stored in `payroll_params` with an effective date. Each sheet uses the row in force on the last day of its month. A new year is added as a new row in *Atlyginimai → Tarifai ir parametrai*, and older sheets are not recalculated. The seeded values must be checked by the accountant.

| From | MMA | NPD | GPM (monthly) | Employee Sodra | Extra pension | Employer Sodra |
|---|---|---|---|---|---|---|
| 2025-01-01 | 1038 € | 747 − 0.49 × (DU − 1038) | 20 % | VSD 12.52 % + PSD 6.98 % | 3 % | 1.77 % (fixed-term 2.49 %) |
| 2026-01-01 | 1153 € | 747 − 0.49 × (DU − 1153) | 20 % | VSD 12.52 % + PSD 6.98 % | 3 % | 1.77 % (fixed-term 2.49 %) |

2026 progressive GPM (25 % above 36 VDU, 32 % above 60 VDU of yearly income) is settled annually. Employers withhold 20 % monthly unless the employee asks otherwise, so the higher rates are not applied automatically. The 2026 VDU of 2312.15 € is stored for reference.

## Calculation (per employee, per month)

All amounts are exact decimals, rounded half-up to cents on each tax line (`src/payroll/calc.mjs`).

- **Base pay:**
  - monthly salary × worked days / norm days (the full salary when the whole norm is worked);
  - for hourly pay, rate × hours.
- **Gross** = base + bonuses + vacation pay + employer-paid sick days + other pay. Vacation pay and sick pay are entered as amounts; the program does not calculate average pay (VDU) for them.
- **NPD:**
  - zero if the employee has not applied for it;
  - a fixed amount if one is set on the card (reduced working capacity, e.g. 1127 € or 1057 €);
  - otherwise 747 € when gross ≤ MMA, or 747 − 0.49 × (gross − MMA) above it.
  - NPD is never below 0 and never more than gross.
- **GPM** = (gross − NPD) × 20 %.
- **Employee Sodra:** VSD = gross × 12.52 % and PSD = gross × 6.98 %. The extra pension contribution is gross × 3 % if the employee joined it.
- **Net** = gross − GPM − VSD − PSD − extra pension.
- **To pay** = net − advance already paid.
- **Employer Sodra** = gross × 1.77 %, or 2.49 % for fixed-term contracts.

**Working-day norm:** Monday to Friday, excluding Lithuanian public holidays (Darbo kodekso 123 str.), including Easter Monday. Employees who start or leave mid-month get pro-rata worked days. The norm and the worked days can be edited on the sheet.

**Example (2026, 2000 € gross, NPD applied):**

| | € |
|---|---|
| NPD | 331.97 |
| GPM | 333.61 |
| VSD | 250.40 |
| PSD | 139.60 |
| Net | 1276.39 |
| Employer Sodra | 35.40 |

At MMA (1153 €) the net pay is 846.96 €. Both examples are covered by `test/10-chart-products-payroll.test.mjs`.

## Workflow

1. **Create:** *Atlyginimai → Naujas žiniaraštis* for a month (one sheet per month). Active employees working that month are added.
2. **Edit:** enter worked days or hours, bonuses, vacation and sick pay, other pay and advances, then *Perskaičiuoti ir išsaugoti*. The server recalculates every line.
3. **Approve:** *Patvirtinti ir kontuoti* (needs the `approve` capability) posts one journal entry (see ACCOUNTING.md). Approving twice posts once. An approved sheet is read-only.
4. **Cancel:** *Atšaukti patvirtinimą* needs a reason. It posts a reversal, and the sheet returns to draft. Locked periods block both approving and cancelling.
5. **Payslips:** *Algalapis* (one employee) or *Visi algalapiai* opens a printable view.

## Not included

- Sodra (SAM, 12-SD) and VMI (GPM313) declaration files. The sheet shows the monthly GPM and Sodra totals to declare.
- Automatic vacation and sick pay from average earnings.
- Vacation reserve accruals (account 4485).
- Annual GPM recalculation.
- Bank payment files.
