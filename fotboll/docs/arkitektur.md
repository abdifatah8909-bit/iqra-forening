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
| Organisation och åtkomst | `federations` (namn per språk i `name_i18n`), `users`, `role_assignments`, `sessions` |
| Register | `clubs`, `players`, `registrations`, `media` |
| Tävling | `seasons`, `competitions`, `teams`, `squad_members`, `venues`, `matches` |
| Matchrapport | `match_reports` (id = match-id), `team_sheets`, `match_lineups`, `match_events` |
| Övergångar | `transfers` |
| Disciplin | `suspensions` (manuella avstängningar). Kortregler finns på `competitions`. |
| Synkhantering | `applied_mutations`, `conflict_log` |
| Inloggning | `auth_tokens` (engångslänkar för inbjudan och nytt lösenord, synkas inte) |

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

### Truppanmälan

Klubben fyller i sin laguppställning (`match_lineups`) och lämnar in den (`team_sheets`, en per lag och match).

- **Kontroller före inlämning** (`shared/src/teamsheet.ts`): 7–11 startspelare, exakt en målvakt bland
  startspelarna, en kapten, tröjnummer på alla utan dubbletter, och inga avstängda spelare. Servern kontrollerar
  samma sak och avvisar med `sheet_<problem>`.
- **Vem som lämnar in:** Bara lagets egen klubb, eller förbundet, och bara tills matchrapporten är inskickad.
- **Ändringar efter inlämning:** Ändrar klubben laguppställningen sätter servern anmälan tillbaka till `draft`, och den måste lämnas in igen.
  Domarens och förbundets rättelser på matchdagen påverkar inte anmälan.
- **Id:** Anmälans id räknas fram från match och lag (`teamSheetId`). Två telefoner i samma klubb skriver då till samma rad.
- **Namn:** `match_lineups.player_name` sätts av servern, så att domaren, motståndaren och förbundet kan läsa
  laguppställningen utan att få spelarens övriga personuppgifter. Namnet hålls aktuellt när spelaren byter namn,
  och töms vid GDPR-radering.

### Avstängningar

Automatiska avstängningar sparas aldrig, precis som serietabellen. Funktionen `computeBans`
(`shared/src/discipline.ts`) räknar fram dem på varje enhet från rapporter i status `submitted`
eller `approved`. Därför vet en klubbadmin offline att en spelare är avstängd så fort domarens
rapport har synkats.

| Regel (per tävling) | Standard |
|---|---|
| Rött kort | `red_card_ban` = 1 match |
| Två gula i samma match | `second_yellow_ban` = 1 match. De två gula korten räknas inte in i ackumuleringen. |
| Ackumulerade gula kort | var `yellow_card_limit` = 3:e gula kort ger 1 match (0 stänger av regeln) |

- **Avtjänas:** Avstängningen avtjänas i lagets nästa matcher i samma tävling. Uppskjutna och inställda matcher räknas inte.
- **Manuella avstängningar** (`suspensions`) läggs in av förbundsadmin, på ett av två sätt: ett antal matcher
  i en tävling från ett visst datum, eller alla matcher i ett datumintervall.
- **Servern stoppar** avstängda spelare i `match_lineups` (`player_suspended`). Förbundsadmin kan
  göra undantag. Rader som lades in innan avstängningen blev känd kan fortfarande redigeras och
  markeras som avstängda i appen.
- **Synlighet:** `suspensions` synkas med samma regler som `players`.

### Övergångar

```
pending_club ──(nuvarande klubb släpper)──▶ pending_federation ──(förbundet)──▶ approved
     │                                            │
     └──────── rejected / cancelled ◀─────────────┘
```

- **Ansökan:** Den mottagande klubbens admin skapar övergången. Förbundsadmin kan också göra det åt en klubb.
  Servern sätter `from_club_id` (spelarens nuvarande klubb) och startsteget, oavsett vad appen skickar.
  En spelare utan klubb hoppar över steget där klubben släpper spelaren.
- **Stegen:** Den nuvarande klubben släpper spelaren eller avslår. Den mottagande klubben kan dra tillbaka sin ansökan.
  Förbundet kan godkänna först när spelaren har släppts, men kan avslå när som helst.
  Reglerna finns i `shared/src/transfers.ts` och används av både servern och appen.
- **Bara en öppen övergång per spelare.** Har spelaren hunnit byta klubb på annat sätt avvisas
  steget (`transfer_outdated`).
- **När förbundet godkänner** flyttas spelaren (`players.club_id`), tas bort ur den gamla klubbens
  trupper och registreras för säsongen i den nya klubben.
- **Hitta spelaren:** En klubbadmin ser inte andra klubbars spelare. Den mottagande klubben söker därför online
  (`GET /api/players/search`) på licensnummer, eller på fullständigt namn tillsammans med födelsedatum.
  Svaret innehåller bara namn, födelseår och klubb. Medan ansökan är öppen ser klubben spelaren i synken.
- **Synlighet:** De två klubbarna och förbundet ser övergången.

### Inbjudningar och nytt lösenord

- **Inbjudan:** När förbundsadmin skapar en användare utan lösenord får kontot `password_hash = '!'`,
  som inget lösenord matchar. Samtidigt skapas en engångslänk (`/set-password/<token>`).
- **Lagring:** Servern sparar bara en sha256-hash av token. Det är bara den senast skapade länken som gäller.
  En inbjudan gäller i 14 dagar och en länk för nytt lösenord i 24 timmar.
- **Utskick:** Länken mejlas om SMTP är inställt. Admin får den också tillbaka på skärmen, så att den kan delas via WhatsApp eller SMS.
- **"Glömt lösenordet?"** svarar alltid likadant och mejlar länken i bakgrunden, så att svaret inte
  avslöjar vilka adresser som har konton. Gränser: 3 försök per adress och timme, och 30 per IP-adress och timme.
- **När länken används** sätts lösenordet, användaren loggas ut på alla andra enheter och loggas in direkt.

### Publik sida

`/public` i appen och `GET /api/public/...` på servern är öppna utan inloggning.

- **Visas:** tävlingar, lag, klubbar (namn, ort och logotyp), arenor, spelschema och resultat från inskickade
  eller godkända rapporter.
- **Laguppställningar** (`GET /api/public/federations/:id/matches/:matchId`) visas bara för seniorserier
  (`competitions.is_senior`). Ett lags laguppställning blir publik när truppen är inlämnad, eller när matchrapporten är inskickad.
  Bara tröjnummer, namn och roll (startspelare, kapten, målvakt) visas. Spelare som är under 18 år på matchdagen visas utan namn,
  även i seniorserier. Ungdomsserier publicerar inga laguppställningar alls.
- **Visas aldrig:** spelarnas övriga uppgifter, domare, användare, foton på spelare eller utkast.
- **Tabellen** räknas fram i webbläsaren med samma `computeStandings`.
- **Svaren cachas** i 60 sekunder (`Cache-Control: public`).

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
