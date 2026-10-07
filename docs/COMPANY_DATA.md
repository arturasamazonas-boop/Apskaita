# Company details from rekvizitai.lt

**Where:**

- *Žinynai → Įmonė iš rekvizitai.lt*
- the *⇩ Užpildyti iš rekvizitai.lt* button in the counterparty form, *Servisas → Įmonės duomenys* and the first-start wizard

## Why through the browser

rekvizitai.lt (UAB "Verslo žinios") is behind Cloudflare bot protection, and it refuses requests from servers (verified: HTTP 403 challenge). Its data API is a paid product that needs a token. Registrų centras open data (`get.data.gov.lt`, `registrucentras.lt`) was also not reachable from the test environment. So the application does not scrape. It takes the text of the page the user has already opened in their own browser:

1. **Bookmarklet "→ Apskaita"**:
   - Drag it from the *Įmonė iš rekvizitai.lt* page to the bookmarks bar.
   - On a company page, click it. It reads that page's visible text and opens this application at `#/rekvizitai?d=…`.
   - The text is in the URL fragment, which browsers do not send to servers. The page removes it from the address bar and history right away.
2. **Paste**: copy the whole company page (Ctrl+A, Ctrl+C) and paste it into the dialog. This also works on phones.

The text is parsed in the browser by `public/js/lib/company-parse.mjs`. Parsing combines the usual labels (Įmonės kodas, PVM kodas, Adresas, Telefonas, El. paštas, Tinklalapis, Vadovas, Banko sąskaita) with format checks:

| Field | Check |
|---|---|
| Company code | 9 digits |
| VAT code | `LT` + 9 or 12 digits |
| IBAN | LT IBAN |
| Phone | +370 / 8… |

`Energitech, UAB` becomes `UAB „Energitech“`, and the legal form is derived from it. The user reviews every field before saving. Nothing is saved automatically.

On the review page:

- *Sukurti kontrahentą*: choose supplier and/or customer.
- *Atnaujinti kontrahentą*: shown when the company code or VAT code already exists.
- *Naudoti kaip mano įmonės duomenis*: administrators only.

## VAT check (VIES)

*Tikrinti VIES* calls the EU VIES REST service (`VIES_URL`, default `https://ec.europa.eu/taxation_customs/vies/rest-api`) with only the VAT number. It returns validity and the registered name. Lithuania does not publish addresses in VIES. On the review page the check runs automatically.

## Possible later addition

If the production server can reach Registrų centras open data, a daily import of the legal-entity list would allow lookup by company code alone. The VAT code is not part of that dataset.
