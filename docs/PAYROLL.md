# Payroll (Atlyginimai)

Menu: *Atlyginimai* (sheets, employees, rates) and *Žinynai → Darbuotojai*.

## Parameters

Parameters are stored in `payroll_params` with an effective date. Each sheet uses the row in force on the last day of its month. A new year is added as a new row in *Atlyginimai → Tarifai ir parametrai*, and older sheets are not recalculated. The seeded values must be checked by the accountant.

| From | MMA | NPD | GPM (monthly) | Employee Sodra | Extra pension | Employer Sodra |
|---|---|---|---|---|---|---|
| 2025-01-01 | 1038 € | 747 − 0.49 × (DU − 1038) | 20 % | VSD 12.52 % + PSD 6.98 % | 3 % | 1.77 % (fixed-term 2.49 %) |
| 2026-01-01 | 1153 € | 747 − 0.49 × (DU − 1153) | 20 % | VSD 12.52 % + PSD 6.98 % | 3 % | 1.77 % (fixed-term 2.49 %) |
| 2027-01-01 | 1245 € (hourly 7.61 €) | 747 − 0.49 × (DU − 1245) | 20 % | VSD 12.52 % + PSD 6.98 % | 3 % | 1.77 % (fixed-term 2.49 %) |

Above 60 VDU of employment income in a calendar year at this employer (2026: 60 × 2312.15 = 138 729 €), GPM on the part above is withheld at 32 % (`gpm_rate_high`) and the employee's VSD is no longer charged on it (the 60 VDU contribution ceiling); PSD has no ceiling. For 2027, the Government approved the MMA (1245 €, decision of 2026-07-01). The 2027 insured-income amount (VDU) is not approved yet, so the 2027 row has no VDU. Until it is entered, the payroll sheet shows a warning and the 60 VDU limit is not applied. Click the 2027 row on the Tarifai page to load it into the form, add the VDU and save. The additional NPD for children from 2027 (87 € a month per child) is claimed in the annual return, not withheld monthly. The year-to-date gross comes from the employee's earlier payroll sheets of the same year. The 25 % rate for 36–60 VDU is settled in the annual return and is not withheld monthly. Hourly rates keep 4 decimals: rate × hours is rounded once, to cents.

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
  - Where the year's tariff row has a second tier (2025: above 2387.29 €, NPD = 400 − 0.18 × (gross − 642)), that formula applies above the threshold.
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
