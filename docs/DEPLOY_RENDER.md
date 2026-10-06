# Talpinimas internete nemokamai: Render + Neon (ES)

Konfigūracija yra faile [`render.yaml`](../render.yaml).

| Kas | Planas | Pastabos |
|---|---|---|
| Programa: Render web service (Docker), Frankfurtas | **Free** | Po 15 min. be lankytojų „užmiega“. Pirmas atidarymas po to trunka apie minutę. 750 nemokamų valandų per mėnesį. |
| Duomenų bazė: Neon PostgreSQL, AWS Europe Central (Frankfurtas) | **Free** | 0,5 GB. Galioja neribotą laiką ir neištrinama po 30 dienų, kitaip nei Render nemokama bazė. |
| Įkelti failai | – | Saugomi duomenų bazėje (`STORAGE_BACKEND=postgres`), nes nemokamas Render planas neturi nuolatinio disko. |

## Ribojimai (svarbu žinoti)

- **Lėtas OCR.** Nemokamas serveris labai silpnas (≈0,1 CPU, 512 MB). Testuojant tokiomis sąlygomis:
  - skaitmeninis PDF atpažintas per ~5 s;
  - **skenuotas PDF – per ~6 min.**

  Užduotys vykdomos fone po vieną. Puslapio laikyti atidaryto nebūtina.
- **Atsibudimas.** Programai užmigus, nebaigta užduotis automatiškai paleidžiama iš naujo, kai programa vėl atsibunda (patikrinta).
- **Vieta.** 0,5 GB pakanka maždaug keliems šimtams dokumentų su peržiūromis. Paskyrą užpildžius, reikės mokamo Neon plano.
- **Paskirtis.** Šis variantas skirtas bandymui ir dalijimuisi su kolegomis. Realiai įmonės apskaitai rekomenduojamas mokamas planas (žr. apačioje).

## 1. Neon duomenų bazė (~5 min.)

1. Prisiregistruokite https://neon.com (galima su GitHub paskyra).
2. Sukurkite projektą:
   - **Name:** `apskaita`
   - **Postgres version:** 16 arba naujesnė
   - **Region:** *AWS Europe Central 1 (Frankfurt)*
3. Projekto puslapyje spauskite **Connect** ir nukopijuokite **Connection string**. Jis atrodo taip: `postgresql://…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require…`.

   Laikykite jį slaptai, nes tai prieiga prie visų duomenų.

## 2. Render programa (~15 min.)

1. Prisiregistruokite https://render.com su „Sign in with GitHub“. Kortelės nereikia.
2. Spauskite **New → Blueprint**.
3. Suteikite prieigą prie saugyklos **Apskaita** ir ją pasirinkite.
4. Įveskite vienintelį lauką `DATABASE_URL`: Neon connection string iš 1 žingsnio.
5. Spauskite **Apply**. Pirmas diegimas užtrunka ~10–15 min.
6. Kai būsena taps **Live**, atsidarykite `https://apskaita-….onrender.com`. Programa atsidaro **be slaptažodžio**.

   Pirmą kartą atsidarys pradinių nustatymų vedlys.

### Testinė versija be slaptažodžio (`OPEN_ACCESS=true`)

Kiekvienas, turintis nuorodą, dirba kaip administratorius (*testas@apskaita.local*). Tai tinka tik bandymams. **Nekelkite tikrų sąskaitų, išrašų ar sutarčių.**

Kai prireiks tikro naudojimo, Render → **apskaita** → **Environment**:
1. `OPEN_ACCESS` pakeiskite į `false`.
2. Pridėkite `BOOTSTRAP_ADMIN_EMAIL` ir `BOOTSTRAP_ADMIN_PASSWORD` (bent 10 simbolių).

   Jei duomenų bazėje jau yra testinis naudotojas, administratorius automatiškai nesukuriamas. Tokiu atveju naudokite naują Neon duomenų bazę, nes testinių duomenų vis tiek nereikėtų laikyti.
3. **Save Changes**.

Kolegoms prisijungimus kuriate *Nustatymai → Naudotojai*.

## Pakeitimai

Kiekvienas įkėlimas į `main` šaką automatiškai įdiegiamas per ~10 min. Atnaujinimo metu programa trumpai nepasiekiama.

## Perėjimas į mokamą variantą vėliau

Render paslaugos **Settings → Instance Type** pasirinkite *Starter*. Taip programa nebeužmigs ir OCR veiks keliasdešimt kartų greičiau.

Dalyvaujančius nustatymus galima palikti, nes failai toliau bus saugomi duomenų bazėje. Neon galima pakeisti mokamu planu arba Render PostgreSQL. Duomenų perkėlimui naudokite `scripts/backup.mjs` ir `scripts/restore.mjs` ([BACKUP.md](BACKUP.md)).

## Atsarginės kopijos

- **Neon:** nemokamas planas leidžia atkurti duomenis iki trumpo laikotarpio atgal (žr. Neon „Restore“).
- **Nepriklausoma pilna kopija:** savo kompiuteryje, su Docker arba Node, paleiskite:

  ```
  DATABASE_URL=<Neon connection string> node scripts/backup.mjs
  ```

  Failai yra pačioje duomenų bazėje, todėl patenka į kopiją.

## Jei kas nepavyksta

- **Paslauga neįsijungia:** žiūrėkite Render **Logs**. Turi matytis eilutės `[db] migrated …` ir `Apskaita: http://0.0.0.0:…`.
- **Klaida apie duomenų bazę:** patikrinkite, ar `DATABASE_URL` nukopijuotas visas.
- **Nepavyksta prisijungti:** **Logs** turi būti `[bootstrap] sukurtas pirmasis administratorius …`.

## Kas patikrinta

Tas pats Docker atvaizdas buvo paleistas su nemokamo Render ribojimais (`--cpus=0.1 --memory=512m`) ir šiais nustatymais. Patikrinta:
- sukurtas administratorius;
- skaitmeninė ir skenuota sąskaita atpažintos;
- atminties naudota ~80 MB;
- serverį nutraukus OCR viduryje, užduotis po paleidimo baigta;
- failai saugomi duomenų bazėje ir išlieka.

Pačiame Render ir Neon diegimas neatliktas: tam reikia jūsų paskyrų. Neon jungtis su SSL (`sslmode=require`) lokaliai netikrinta.
