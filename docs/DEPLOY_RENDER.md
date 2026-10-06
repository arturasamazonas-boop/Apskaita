# Talpinimas Render (Frankfurtas, ES)

Konfigūracija yra faile [`render.yaml`](../render.yaml). Ji sukuria:

| Kas | Planas | Paskirtis |
|---|---|---|
| Interneto paslauga `apskaita` (Docker) | Starter | Programa, foninis atpažinimas (OCR) |
| Diskas `documents`, 5 GB, prijungtas prie `/data/storage` | apmokamas pagal GB | Originalūs dokumentai ir peržiūros |
| PostgreSQL 16 `apskaita-db` | basic-256mb | Duomenų bazė |

Nemokamas planas netinka: jame nėra nuolatinio disko, o nemokama duomenų bazė po 30 dienų ištrinama. Kainas tikrinkite render.com/pricing.

## Paleidimas (vieną kartą)

1. Prisiregistruokite render.com ir prisijunkite su savo GitHub paskyra („Sign in with GitHub“).
2. Įveskite mokėjimo kortelę: **Billing** skiltyje.
3. Spauskite **New → Blueprint**.
4. Suteikite Render prieigą prie saugyklos `arturasamazonas-boop/apskaita` ir ją pasirinkite.
5. Render parodys, ką sukurs, ir paprašys dviejų reikšmių:
   - `BOOTSTRAP_ADMIN_EMAIL`: jūsų el. paštas.
   - `BOOTSTRAP_ADMIN_PASSWORD`: pradinis slaptažodis, bent 10 simbolių.

   Jos naudojamos tik pirmą kartą, kol programoje dar nėra naudotojų.
6. Spauskite **Apply**. Pirmas paleidimas užtrunka apie 10 minučių: įdiegiama atpažinimo (OCR) programa ir sukuriama duomenų bazė.
7. Kai paslaugos būsena taps **Live**, atsidarykite adresą `https://apskaita-….onrender.com`, kuris rodomas paslaugos puslapio viršuje, ir prisijunkite.

Saugumo sumetimais po pirmo prisijungimo:
- Pasikeiskite slaptažodį.
- Paslaugos **Environment** skiltyje ištrinkite `BOOTSTRAP_ADMIN_PASSWORD`.

Programa veiks ir be šių kintamųjų.

## Kasdienis darbas

- **Pakeitimai:** kiekvienas įkėlimas į `main` šaką (`git push`) automatiškai įdiegiamas per kelias minutes. Diegimo metu programa trumpam būna nepasiekiama, nes diskas gali būti prijungtas tik prie vienos kopijos.
- **Kolegos:** prisijungimus kuriate *Nustatymai → Naudotojai* su vaidmeniu administratorius, buhalteris arba tik skaitymas.
- **Savas domenas:** paslaugos **Settings → Custom Domains**. HTTPS sertifikatas suteikiamas automatiškai.

## Atsarginės kopijos

- **Duomenų bazė:** mokamiems Render PostgreSQL planams kopijas daro Render (žr. duomenų bazės skiltį „Recovery“).
- **Diskas:** Render daro disko momentines kopijas (žr. paslaugos skiltį „Disks“).
- **Nepriklausoma pilna kopija:** duomenų bazė ir failai kartu, su patikra. Paslaugos **Shell** skiltyje vykdykite `node scripts/backup.mjs /data/storage/backups`, tada failą atsisiųskite. Smulkiau – [BACKUP.md](BACKUP.md).

## Jei kas nepavyksta

- **Paslauga neįsijungia:** žiūrėkite **Logs**. Turi matytis eilutės `[db] migrated …` ir `Apskaita: http://0.0.0.0:…`.
- **Nepavyksta prisijungti pirmą kartą:** **Logs** turi būti eilutė `[bootstrap] sukurtas pirmasis administratorius …`. Jei jos nėra, patikrinkite, ar įvesti abu `BOOTSTRAP_…` kintamieji ir ar slaptažodis turi bent 10 simbolių.

## Kas patikrinta

Prieš įkeliant šią konfigūraciją Docker atvaizdas buvo sukurtas ir paleistas su tokiais pat nustatymais kaip Render:
- prievadas 10000, `NODE_ENV=production`, saugūs slapukai, prijungtas diskas;
- administratorius sukurtas iš aplinkos kintamųjų;
- sveikatos patikra `/api/health` veikia;
- prisijungta, įkelta ir atpažinta sąskaita, i.SAF schemos patikra praėjo;
- po paleidimo iš naujo dokumentai ir duomenys išliko.

Pačiame Render diegimas dar neatliktas: tam reikia jūsų paskyros.
