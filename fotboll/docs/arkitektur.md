# Arkitektur: datamodell och offline-synk

## Översikt

```
 Telefon (PWA)                                   Server
┌──────────────────────────────┐       ┌───────────────────────────────┐
│ React-UI                     │       │ Fastify (Node)                │
│   │ läser/skriver            │       │                               │
│   ▼                          │ push  │ /api/sync/push  regler/tabell │
│ IndexedDB (Dexie)            │──────▶│   ├ behörighet per roll       │
│   ├ datatabeller (kopior)    │       │   ├ affärsregler (lås, GDPR)  │
│   ├ outbox (köade ändringar) │◀──────│   └ idempotens               │
│   └ blobs (foton)            │ pull  │ /api/sync/pull  scope-filter  │
│ Service worker (app-skal)    │       │ Postgres  (global sync_seq)   │
└──────────────────────────────┘       └───────────────────────────────┘
```

Gränssnittet läser och skriver **bara** mot den lokala databasen. Synkmotorn
(`web/src/sync.ts`) flyttar ändringar i bakgrunden. Den körs efter varje
lokal ändring (med 1,5 s fördröjning), när nätet kommer tillbaka, när appen
visas igen, en gång i minuten och när man trycker på synkknappen.

## Datamodell

Se `server/migrations/001_init.sql` (Postgres) och `shared/src/tables.ts` (zod-scheman).

| Område | Tabeller |
|---|---|
| Organisation och åtkomst | `federations`, `users`, `role_assignments`, `sessions` |
| Register | `clubs`, `players`, `registrations`, `media` |
| Tävling | `seasons`, `competitions`, `teams`, `squad_members`, `venues`, `matches` |
| Matchrapport | `match_reports` (id = match-id), `match_lineups`, `match_events` |
| Synkhantering | `applied_mutations`, `conflict_log` |

Alla synkade tabeller har kolumnerna `federation_id, created_at, updated_at, updated_by, deleted_at, server_seq`.

- **ID:n är UUIDv7 och skapas på klienten.** Det går att skapa rader offline utan att de krockar.
- **Mjuk radering:** `deleted_at` synkas som en gravsten (tombstone) så att alla enheter tar bort raden.
- **`players.club_id`** är spelarens nuvarande klubb. Den ändras bara när en registrering godkänns.
  Klubbadmins kan registrera nya spelare (status pending). Övergångar från andra klubbar sköts av förbundet.
- **Resultatet räknas fram från `match_events`.** När rapporten skickas in räknar servern om
  `home_score/away_score` från målhändelserna. Ett inskrivet resultat ignoreras.
- **Serietabellen sparas aldrig.** Funktionen `computeStandings` (shared) räknar fram den på enheten,
  från matcher med rapport i status `submitted` eller `approved`. Därför fungerar den offline.

## Synkprotokoll

### Push: `POST /api/sync/push`

Klienten skickar sin kö i ordning, högst 200 ändringar per anrop:

```json
{ "id": "<uuid>", "table": "match_events", "op": "upsert", "row_id": "<uuid>",
  "data": { "minute": 23 }, "base_seq": 1234 }
```

- **Idempotent:** `id` sparas i `applied_mutations`. Om samma ändring skickas igen efter ett
  nätverksfel svarar servern med det sparade resultatet och tillämpar den inte en gång till.
- **Fältvis senast-vinner:** `data` innehåller bara de fält som ändrats. Servern lägger
  dem ovanpå den aktuella raden. Om två enheter har ändrat olika fält i samma rad behålls båda.
  Om raden har ändrats sedan `base_seq` sparas den överskrivna versionen i `conflict_log`.
- **Varje ändring körs i en egen savepoint.** En avvisad ändring stoppar inte resten av batchen.
  Svaret är `ok` (med den kanoniska raden) eller `rejected` (med `reason` och serverns version av raden).
  Klienten använder serverns version för att backa sin optimistiska ändring, och visar orsaken översatt.

### Pull: `GET /api/sync/pull?since=<cursor>&scope=<scope>`

- **Global sekvens:** Varje skrivning får nästa värde ur sekvensen `sync_seq` via en trigger.
  Skrivande transaktioner håller ett advisory lock (`withWriteLock`), så sekvensordningen är
  densamma som commit-ordningen. Därför missar `server_seq > cursor` aldrig en rad som committas sent.
- **Sidor:** Varje anrop ger högst 1000 rader per tabell. När något är kvar sätts `has_more` och klienten fortsätter.
- **Scope:** Ett fingeravtryck av vad användaren får se. Det ändras till exempel när en domare
  tilldelas en ny match eller en spelare läggs till i en trupp. Då svarar servern `reset: true`.
  Klienten rensar sin lokala kopia, laddar om allt och spelar upp sin kö igen ovanpå.
- **Rebase:** När en serverrad tas emot spelas köade lokala ändringar av samma rad upp igen ovanpå den.
  Användaren ser alltså aldrig sina osynkade ändringar försvinna.

### Konfliktregler per datatyp

| Data | Regel |
|---|---|
| Matchhändelser | Bara domaren som är tilldelad matchen får registrera dem, och bara spelare i matchens trupp får anges. Varje händelse har ett eget UUID, så två enheter kan aldrig skriva över varandras händelser. |
| Matchrapport | Statusflöde: `draft → submitted → approved`. Bara förbundsadmin kan sätta `reopened`. Rapporter i status `submitted` eller `approved` är låsta för alla utom förbundsadmin. |
| Laguppställning | Klubbadmin (eget lag) eller domaren, tills rapporten är inskickad. Spelaren måste finnas i lagets trupp. |
| Register | Fältvis senast-vinner. Överskrivna versioner loggas. |
| Registreringar | Servern bestämmer. Bara förbundsadmin godkänner eller avslår, och ett godkännande flyttar spelaren till den nya klubben. |
| Konton | Bara online (`/api/admin/*`), eftersom de innehåller lösenord och påverkar andra användare. |

### Foton

1. Fotot komprimeras på enheten till högst 800 px WebP (JPEG i äldre Safari), ungefär 100 kB.
2. Bilden sparas i `blobs`. En `media`-rad med sha256 synkas som vanligt.
3. När `media`-raden har nått servern laddas bytes upp med `PUT /api/media/:id`.
   Servern kontrollerar mime-typ, storlek (högst 2 MB) och sha256.
4. Andra enheter hämtar bilden vid behov (`GET /api/media/:id`, med behörighetskontroll) och cachar den lokalt.

## Roller och dataminimering (GDPR)

| | Förbundsadmin | Klubbadmin | Domare |
|---|---|---|---|
| Klubbar, serier, spelschema, resultat, tabell | läsa/skriva | läsa, redigera egen klubb | läsa |
| Spelare (personuppgifter) | alla | egen klubb | trupperna i tilldelade matcher |
| Registreringar | alla, godkänna | egen klubb, ansöka | – |
| Trupp | alla | egna lag | läsa |
| Laguppställning | alla | eget lag, tills rapporten är inskickad | tilldelade matcher |
| Matchrapport och händelser | alla, godkänna, öppna igen | läsa | tilldelade matcher |
| Användare | hantera (online) | – | – |

Andra skydd:

- **Foto på barn:** Ett foto på en spelare under 18 år kräver att `photo_consent` (vårdnadshavarens samtycke) är satt. Servern kontrollerar detta.
- **Rätten att bli glömd:** `POST /api/admin/players/:id/erase` tömmer namn, födelsedatum, licens och foto.
  Spelar-raden finns kvar anonymiserad, så att historiska rapporter och tabeller fortfarande stämmer.
- **Användarprofiler:** Andra användare syns bara som id, namn och om de är domare. E-postadresser synkas aldrig.
- **Delad telefon:** Lokal data raderas vid utloggning och när en annan användare loggar in på samma enhet.
