# Palūkanos (loan interest)

Menu: **Finansai → Palūkanos** (`#/palukanos`).

## What it does

- Lists every loan the company has received (*gauta paskola*) or granted (*suteikta paskola*). For each loan it
  shows the interest accrued up to a chosen date, the interest already paid and the amount still due.
- **Interest starts on the day the money arrived** (or, for a granted loan, the day it was paid out). It never
  starts on the signing date. The arrival day is a loan event. You can pick it from a matching bank transaction
  or type it in.
- **Įskaičiuoti grąžinimo (paskutinę) dieną**: when ticked, interest is also charged for the repayment day and for
  the "calculate to" date. Otherwise the repaid amount stops earning interest on the repayment day itself. Each loan
  stores its own default, and the list and loan card have a checkbox to change it for the current calculation.
- Partial disbursements, partial repayments, rate changes (from a date) and interest payments are separate
  events. The loan card shows the calculation by period: balance × rate × days / year basis.
- **Year basis** (*dienų skaičiavimo bazė*): actual/365 (default), actual/360, actual/actual (365 or 366, split at
  1 January), or 30E/360.
- Each period's interest is kept to 1/10 000 cent. Only the total is rounded to cents (ROUND_HALF_UP).

## Reading the agreement

Upload the agreement (PDF, DOCX, JPG/PNG) with **Įkelti paskolos sutartį**. The file is stored in the document
vault as a contract tagged `paskola`, and its text is read (PDF text layer, DOCX, or OCR for scans).
`src/loans/contract-parser.mjs` then finds the following:

| Field | How |
|---|---|
| Loan amount | An amount with a currency next to "paskolos suma", "suteikia … paskolą", "loan amount". Penalties and fees are skipped |
| Annual rate | A percentage next to "palūkanos" or "interest", preferring "metinės / per metus / per annum". Late-payment rates (*delspinigiai*, penalty) are ignored. EURIBOR + margin is flagged as variable |
| Year basis | "360 dienų", "365 dienų", "30/360", "Actual/365", "faktinis … metų dienų" |
| Dates | Signing date, repayment deadline (*grąžinti iki*), planned disbursement. Accepted formats: `2026-03-15`, `2026.03.15`, `15.03.2026`, `2026 m. kovo 15 d.` |
| Parties | "Paskolos davėjas / gavėjas" (Lender / Borrower), either as `Label: UAB „X“` or `UAB „X“ …, toliau – Label`. The company's own name or code decides whether the loan is received or granted. The other party's code is matched to Pirkėjai / Tiekėjai |
| Number | "Sutartis Nr. …" / "Agreement No. …" |

Each value is shown with the sentence it was read from. Nothing is saved until the user checks the form and
presses **Išsaugoti paskolą**. Bank transactions that look like the loan money are offered: same amount, the other
party's code or name, or "paskola" in the payment details. Agreements already in the vault that look like loan
agreements but have no loan yet are listed on the Palūkanos page with **Nuskaityti sąlygas**.

## Without an agreement

**Skaičiavimas ranka** takes an amount, the day the money arrived, an end date, the rate and the year basis, plus the
same repayment-day checkbox. The result can be saved as a loan.

## Not included

Interest is calculated, not posted. Accrual entries (D 68xx / K 44xx, or D 24xx / K 58xx for granted loans),
compound interest, annuity schedules and automatic EURIBOR rates are not done. A EURIBOR change is entered as a
rate-change event.
