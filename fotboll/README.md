# Iqra Fotboll – administrationssystem för gräsrotsförbund (MVP)

En mobil-först PWA som fungerar **offline**, på somaliska, engelska och arabiska (höger-till-vänster).

**Funktioner**

- Klubb- och spelarregister med foto
- Truppsammansättning
- Spelschema med round-robin-generator
- Matchrapport med trupper, mål, kort och byten
- Serietabeller som räknas fram på enheten

**Roller:** förbundsadmin, klubbadmin och domare.

Datamodell, synkprotokoll och rollmatris beskrivs i [`docs/arkitektur.md`](docs/arkitektur.md).

## Struktur

```
fotboll/
├── shared/   Typer, zod-scheman, synkprotokoll, tabell- och schemalogik (används av båda sidor)
├── server/   Node + Fastify + Postgres: inloggning, push/pull-synk, regler, foton, admin
└── web/      React + Vite PWA: IndexedDB (Dexie), synkmotor, i18n (so/en/ar)
```

## Kom igång

Kräver Node 22 och Postgres 14 eller senare.

```bash
cd fotboll
npm install

# Databas (eller: docker compose up -d)
createdb fotboll
export DATABASE_URL=postgres://postgres@localhost:5432/fotboll

npm run seed          # migrerar och skapar demodata
npm run dev:server    # API på :3000
npm run dev:web       # PWA på :5173 (proxar /api till :3000)
```

Demokonton (lösenord `fotboll123`):

| E-post | Roll | Språk |
|---|---|---|
| admin@example.org | Förbundsadmin | somaliska |
| klubb@example.org | Klubbadmin (Iqra IF) | somaliska |
| domare@example.org | Domare | arabiska |
| domare2@example.org | Domare | engelska |

### Produktion

```bash
npm run build                                          # bygger web/dist med service worker
WEB_DIST=$PWD/web/dist MEDIA_DIR=/var/lib/fotboll/uploads npm start
```

Servern kör migreringarna när den startar, och serverar både API:t och PWA:n.

> `WEB_DIST` och `MEDIA_DIR` tolkas relativt `server/`. Använd absoluta sökvägar.

PWA:n kräver HTTPS, utom på `localhost`. Placera servern bakom en TLS-proxy (t.ex. Caddy eller nginx).

| Miljövariabel | Standardvärde |
|---|---|
| `DATABASE_URL` | `postgres://postgres@localhost:5432/fotboll` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` |
| `MEDIA_DIR` | `server/uploads` |
| `WEB_DIST` | (inget: servern serverar bara API:t) |

**GDPR:** Eftersom användarna finns både i EU och i diasporan bör både databas och `MEDIA_DIR`
ligga hos en leverantör i EU. Ta backup av båda.

## Tester

```bash
createdb fotboll_test   # servertesterna tömmer och återskapar den här databasen
npm test                # shared + server (mot riktig Postgres) + klientens synkmotor
npm run typecheck
```

Testerna täcker:

- **Synkprotokollet:** inkrementell pull, sidindelning (2 500 rader), idempotens, fältvis sammanslagning med konfliktlogg och gravstenar.
- **Behörigheter:** klubbadmin och domare, referenser mellan förbund, samtycke för foto av minderåriga.
- **Domarflödet:** trupp, händelser, inskickad rapport, lås och återöppning.
- **Scopade pulls (dataminimering):** vad varje roll får se.
- **Övrigt:** foto-uppladdning, adminfunktioner och GDPR-radering.
- **Klientens synkmotor mot riktig server:** en domare som rapporterar offline och synkar senare, samt rebase av osynkade ändringar.
- **Översättningar:** alla språk har samma nycklar, och alla nycklar som används i koden finns.

## Kända begränsningar i MVP:n

- **Översättningar:** De somaliska och arabiska texterna är maskinnära utkast och bör granskas av modersmålstalare.
- **Bakgrundssynk på iOS:** Fungerar inte. Synken körs när appen är öppen eller öppnas igen.
- **Övergångar mellan klubbar:** Sköts av förbundsadmin. Det finns inget ansökningsflöde för klubbar ännu.
- **Inbjudningar och lösenord:** Inga e-postinbjudningar eller återställning av lösenord. Admin sätter lösenordet.
- **Inloggningsspärren:** Ligger i minnet och gäller per serverinstans.
- **Konfliktloggen:** Sparas, men visas inte i UI:t ännu (`GET /api/admin/conflicts`).
- **Statistik:** Ingen statistik per spelare (skytteliga, avstängningar). Datat finns i `match_events`.
