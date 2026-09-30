# Dnevni promet ugostitelja

Otvoren kod evidencije za ugostitelja: artikli, recepture, nabavka, prodaja, rashod, popis, smene, troškovi i izveštaj. Živa aplikacija je na https://acre-island-glow-stone.grok.me

Ovaj repozitorijum je javan. Grana nije zaključana. Drugi alat može da čita kod i da predloži izmenu. Knjige (računi, zalihe, keš, ključ bota) nisu ovde. One su samo u aplikaciji.

## Šta ne sme

- Ne pogađati cenu, količinu, jedinicu ni način naplate. Ako podatak fali, stavka ostaje na proveri. Nula, komad, gram i keš se ne izmišljaju.
- Nabavka nije promet. Polog ne smanjuje promet. Kartica nije keš.
- Rashod nije utrošak recepture i nije popis.
- Proknjižen dokument se ne briše. Ispravka je storno, uz razlog.
- Ne stavljati u kod ključ bota, lozinku, `DATABASE_URL` ni `XAI_API_KEY`.

## Bot

Upis: `POST /api/dpu/v1/radnja`  
Čitanje: `GET /api/dpu/v1/pregled?od=GGGG-MM-DD&do=GGGG-MM-DD`  
Zaglavlje: `Authorization: Bearer ključ`

Ključ se pravi u aplikaciji, stranica Povezivanje, na živoj adresi. Ključ iz ovog repozitorijuma ne postoji jer ovde nema baze.

## Gde je program

Poslovna pravila su u `src/lib/h/` (`engine.ts`, `engine-ops.ts`, `bot.ts`, `api.ts`). Ekrani su u `src/components/`. Šema je u `migrations/0002_hospitality.sql`.

Kad se kod ovde izmeni, izmena nije na živoj adresi dok se ne prenese nazad u aplikaciju i dok se aplikacija ponovo ne objavi.
