# Performance

Measured with `npm run perf` (`scripts/perf.mjs`), 2026-10-06.

## Setup

- **Data**, bulk-inserted into a dedicated database:
  - 10,000 documents, of which 9,000 are in the invoice inbox, with proposals, and 1,000 are vault contracts;
  - 7,000 posted invoices with lines, VAT rows and balanced journal entries;
  - 500 counterparties;
  - 5,000 bank transactions.

  The insert triggers (balance check, period lock) were active during seeding.
- **Environment:** Intel Xeon @ 2.80 GHz × 4 vCPU, 17 GB RAM, Node v22.22.0, PostgreSQL 16.15.
  - App and database on the same host, in a cloud container.
  - Default PostgreSQL settings, `ANALYZE` after seeding.
  - Each endpoint was timed over HTTP with 7 sequential authenticated requests (first included), measuring the full response including the body.
- **Targets:** primary lists within 1 s, standard reports within 3 s.

## Results


| Užklausa | Mediana, ms | Maks., ms | Tikslas, ms | Rezultatas |
|---|---:|---:|---:|---|
| Dokumentų dėžutė (sąrašas, 50) | 9 | 19 | 1000 | atitinka |
| Dokumentų dėžutė (filtras + paieška) | 10 | 18 | 1000 | atitinka |
| Dokumentai: viso teksto paieška | 7 | 25 | 1000 | atitinka |
| Pirkimų sąrašas | 26 | 28 | 1000 | atitinka |
| Pardavimų sąrašas su mokėjimų būsena | 21 | 27 | 1000 | atitinka |
| Banko operacijos (nesuderintos) | 10 | 12 | 1000 | atitinka |
| Apžvalga | 88 | 113 | 3000 | atitinka |
| Bandomasis balansas | 26 | 32 | 3000 | atitinka |
| Pelno (nuostolių) ataskaita | 17 | 27 | 3000 | atitinka |
| Balansas | 22 | 24 | 3000 | atitinka |
| PVM registras (metai) | 29 | 37 | 3000 | atitinka |
| Pirkėjų skolos (senėjimas) | 48 | 56 | 3000 | atitinka |
| Pardavimai pagal prekę | 15 | 17 | 3000 | atitinka |
| Didžioji knyga 5000 (500 eil.) | 16 | 22 | 3000 | atitinka |

All targets were met with a wide margin on this machine.

## Measures that keep these numbers

- Keyset and offset pagination capped at 200 rows.
- Indexes on status, date and created time.
- A GIN `tsvector` index and `pg_trgm` indexes for search.
- Indexes on journal lines by account, and on invoices by journal entry (added after the first measurement: the general ledger went from 478 ms to 16 ms).
- OCR and imports run in background jobs, so navigation never waits for them.

## Caveats

- **Synthetic data:** real documents have more lines.
- Run concurrently with heavy OCR, this machine's 4 vCPUs are shared. OCR of one scanned page took about 4–9 s in tests.
- Response times under concurrent users were not measured.
