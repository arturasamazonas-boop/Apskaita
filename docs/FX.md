# Exchange rates and revaluation

## Rates (*Finansai → Valiutų kursai*)

**Source.** Euro exchange rates published by Lietuvos bankas: the FxRates web service, type **EU**. These are ECB reference rates plus the bank's own rates for other currencies. Each rate is stored as "units of the currency per 1 EUR" with its publication date (`fx_rates`).

**Getting rates:**
- daily, after 17:00 Vilnius time (scheduler);
- with the *Gauti iš Lietuvos banko* button for a date;
- as a currency's history over a period;
- typed in by hand. A manual rate is never overwritten by a fetched one.

**Which rate is used.** The rate of a date is the last one published on or before it, so weekends and holidays use the last working day. If the table has none (or it is more than 7 days old), the program asks Lietuvos bankas first.

**Configuration.** `FX_URL` sets the service address. An empty value means rates come only from the table, e.g. in tests.

## Invoices in another currency

**Booking.** A purchase invoice (from the inbox or entered by hand) may be in any currency. It is booked in EUR at the rate of the VAT point date, or the issue date if there is none. That rate is filled in automatically; it can be changed on the review screen and the typed rate is then kept.

**How the conversion works:**
- each line's net is converted;
- each VAT group's VAT is converted and spread over its lines, with the rounding cent on the largest line;
- so lines, VAT rows, totals and the journal entry agree to the cent.

**What is stored.** The invoice, its lines and VAT rows are stored in EUR. That covers the ledger, FR0600, i.SAF and debts. The invoice also keeps:
- `currency`;
- `fx_rate` and `fx_date`;
- `orig_net`, `orig_vat` and `orig_gross` in its own currency.

The review screen shows both the currency amounts and the EUR amounts.

Sales invoices issued in the program are in EUR.

## Payment and exchange differences

**Paid from a EUR account** (e.g. 1 079.77 EUR paid for an invoice of 1 210 USD):
- the payment settles the invoice's balance in its own currency (by default the whole balance);
- its booked EUR balance is cleared (1 070.98);
- the difference goes to **6803** *Neigiama valiutų kursų pokyčio įtaka* (here 8.79) or **5803** *Teigiama valiutų kursų pokyčio įtaka*.

**Foreign-currency bank account** (`bank_accounts.currency`):
- each transaction is posted in EUR at the rate of the booking date, stored as `bank_transactions.eur_amount` and `fx_rate`;
- an invoice in the same currency is settled in that currency, and the EUR difference is an exchange difference.

**Cash.** Cash orders do not settle invoices in another currency; those payments go through the bank.

## Revaluation (*Finansai → Valiutinių straipsnių perkainojimas*)

At a reporting date, monetary items in foreign currency are restated at that date's rate:

| Item | Before | After | Difference |
|---|---|---|---|
| Open invoice (receivable 2410 / payable 443) | EUR balance | own-currency balance / rate | 5803 / 6803 |
| Foreign-currency bank account | EUR ledger balance | currency balance (reconciled transactions) / rate | 5803 / 6803 |

- The revaluation is one journal entry dated on the reporting date (source type `fx_revaluation`).
- Each invoice's EUR balance follows it through an `fx_revaluation` allocation, which settles nothing in the invoice currency.
- The next revaluation or payment starts from the restated amount.
- Only the latest revaluation can be cancelled. Cancelling posts a reversing entry and the allocations back.

## Tests

- `test/23-fx.test.mjs` uses a local stub of the LB service. It covers:
  - parsing, fetching, the latest rate before a date, manual rates;
  - the conversion arithmetic;
  - a USD invoice booked in EUR;
  - a EUR payment with a 6803 loss;
  - revaluation of a USD invoice (loss) and a USD bank account (gain), and the cancellation.
- `test-browser/fx.mjs` covers the rates page, the review screen with EUR amounts, and posting a revaluation.
