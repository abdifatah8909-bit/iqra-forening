import { fileURLToPath } from 'node:url';
import { roundRobin, uuidv7, type Mutation, type WritableTable } from '@fotboll/shared';
import { hashPassword, loadUserContext } from './auth.js';
import { config } from './config.js';
import { createPool, withWriteLock, type Db } from './db.js';
import { migrate } from './migrate.js';
import { push } from './sync/push.js';

/**
 * Demo data: one federation, four clubs, a league with a full schedule and
 * one played match. Everything except accounts goes through the normal sync
 * push, so the seed also exercises the server rules.
 */

export const DEMO_PASSWORD = 'fotboll123';

async function createUser(db: Db, federationId: string, email: string, name: string, locale: string, roles: [string, string | null][]) {
  const id = uuidv7();
  const hash = await hashPassword(DEMO_PASSWORD);
  await withWriteLock(db, async (tx) => {
    await tx.query(
      'insert into users (id, federation_id, email, password_hash, display_name, locale) values ($1,$2,$3,$4,$5,$6)',
      [id, federationId, email, hash, name, locale],
    );
    for (const [role, clubId] of roles) {
      await tx.query('insert into role_assignments (user_id, role, club_id) values ($1,$2,$3)', [id, role, clubId]);
    }
  });
  return id;
}

export async function seed(db: Db) {
  const existing = await db.query('select 1 from federations limit 1');
  if (existing.rowCount) return false;

  const federationId = uuidv7();
  await withWriteLock(db, (tx) =>
    tx.query(`insert into federations (id, name, country, default_locale) values ($1, $2, $3, 'so')`, [
      federationId,
      'Iqra Fotbollsförbund',
      'SE',
    ]),
  );
  const adminId = await createUser(db, federationId, 'admin@example.org', 'Amina Hassan', 'so', [
    ['federation_admin', null],
  ]);
  const admin = (await loadUserContext(db, adminId))!;

  const mutations: Mutation[] = [];
  const upsert = (table: WritableTable, data: Record<string, unknown>) => {
    const id = (data.id as string) ?? uuidv7();
    mutations.push({ id: uuidv7(), table, op: 'upsert', row_id: id, data: { ...data, id } });
    return id;
  };

  const clubNames = [
    ['Iqra IF', 'IQR', 'Göteborg'],
    ['Hiiraan FC', 'HII', 'Stockholm'],
    ['Juba United', 'JUB', 'Uppsala'],
    ['Shabelle SK', 'SHA', 'Örebro'],
  ];
  const clubIds = clubNames.map(([name, short_name, city]) => upsert('clubs', { name, short_name, city }));
  const seasonId = upsert('seasons', { name: '2026', starts_on: '2026-04-01', ends_on: '2026-10-31' });
  const competitionId = upsert('competitions', {
    season_id: seasonId,
    name: 'Division 1 Herrar',
    name_i18n: { so: 'Horyaalka 1aad – Ragga', en: 'Division 1 Men', ar: 'الدرجة الأولى – رجال' },
    gender: 'male',
  });
  const venueIds = [
    upsert('venues', { name: 'Iqra Arena', address: 'Bergsjövägen 1, Göteborg' }),
    upsert('venues', { name: 'Rinkeby IP', address: 'Rinkebystråket 2, Stockholm' }),
  ];
  const teamIds = clubNames.map(([name], i) =>
    upsert('teams', { club_id: clubIds[i], competition_id: competitionId, name }),
  );

  const firstNames = ['Abdi', 'Mohamed', 'Ahmed', 'Hassan', 'Yusuf', 'Ali', 'Omar', 'Ismail', 'Khalid', 'Bashir', 'Farah', 'Liban', 'Said', 'Nur'];
  const lastNames = ['Warsame', 'Jama', 'Hirsi', 'Abdullahi', 'Osman', 'Aden', 'Mohamud', 'Nur', 'Ibrahim', 'Dualeh'];
  const positions = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'MF', 'DF', 'FW'];
  const squads: string[][] = [];
  clubIds.forEach((clubId, c) => {
    const squad: string[] = [];
    for (let i = 0; i < 14; i++) {
      const playerId = upsert('players', {
        club_id: clubId,
        first_name: firstNames[(i + c * 3) % firstNames.length],
        last_name: lastNames[(i * 7 + c) % lastNames.length],
        birth_date: `${1995 + ((i + c) % 10)}-0${1 + (i % 9)}-1${i % 9}`,
        gender: 'male',
        license_no: `IQ-${c + 1}${String(i + 1).padStart(3, '0')}`,
      });
      upsert('registrations', { player_id: playerId, club_id: clubId, season_id: seasonId, status: 'approved' });
      upsert('squad_members', { team_id: teamIds[c], player_id: playerId, shirt_number: i + 1, position: positions[i] });
      squad.push(playerId);
    }
    squads.push(squad);
  });

  await push(db, admin, mutations);
  mutations.length = 0;

  await createUser(db, federationId, 'klubb@example.org', 'Hodan Ali', 'so', [['club_admin', clubIds[0]]]);
  const refereeId = await createUser(db, federationId, 'domare@example.org', 'Faisal Omar', 'ar', [['referee', null]]);
  await createUser(db, federationId, 'domare2@example.org', 'Sara Lind', 'en', [['referee', null]]);

  // Saturdays from 2 May, 14:00 UTC.
  const fixtures = roundRobin(teamIds, true);
  const matchIds = fixtures.map((f) => {
    const kickoff = new Date(Date.UTC(2026, 4, 2 + (f.round - 1) * 7, 14));
    return upsert('matches', {
      competition_id: competitionId,
      round: f.round,
      home_team_id: f.home_team_id,
      away_team_id: f.away_team_id,
      venue_id: venueIds[f.round % 2],
      kickoff_at: kickoff.toISOString(),
      referee_user_id: refereeId,
    });
  });
  await push(db, admin, mutations);
  mutations.length = 0;

  // Play the first round: lineups, goals, cards and a submitted report.
  const results: [number, number][] = [[2, 1], [0, 0]];
  fixtures
    .filter((f) => f.round === 1)
    .forEach((f, i) => {
      const matchId = matchIds[fixtures.indexOf(f)];
      const home = squads[teamIds.indexOf(f.home_team_id)];
      const away = squads[teamIds.indexOf(f.away_team_id)];
      for (const [teamId, squad] of [[f.home_team_id, home], [f.away_team_id, away]] as const) {
        squad.slice(0, 11).forEach((playerId, n) =>
          upsert('match_lineups', {
            match_id: matchId,
            team_id: teamId,
            player_id: playerId,
            shirt_number: n + 1,
            is_starter: true,
            is_goalkeeper: n === 0,
            is_captain: n === 5,
          }),
        );
      }
      const [hg, ag] = results[i];
      for (let g = 0; g < hg; g++) upsert('match_events', { match_id: matchId, team_id: f.home_team_id, player_id: home[8 + g], type: 'goal', minute: 20 + g * 30 });
      for (let g = 0; g < ag; g++) upsert('match_events', { match_id: matchId, team_id: f.away_team_id, player_id: away[9 + g], type: 'goal', minute: 55 + g * 10 });
      upsert('match_events', { match_id: matchId, team_id: f.away_team_id, player_id: away[3], type: 'yellow', minute: 38 });
      // A sending-off, so the demo shows a suspension for the next round.
      if (i === 0) upsert('match_events', { match_id: matchId, team_id: f.home_team_id, player_id: home[4], type: 'red', minute: 71 });
      upsert('match_reports', { id: matchId, status: 'submitted', home_score: hg, away_score: ag });
    });
  const res = await push(db, admin, mutations);
  const rejected = res.filter((r) => r.status !== 'ok');
  if (rejected.length) throw new Error(`Seed rejected: ${JSON.stringify(rejected.slice(0, 3))}`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(config.databaseUrl);
  await migrate(db);
  const created = await seed(db);
  console.log(
    created
      ? `Demo data created. Log in with admin@example.org / klubb@example.org / domare@example.org, password "${DEMO_PASSWORD}".`
      : 'Database already has data; seed skipped.',
  );
  await db.end();
}
