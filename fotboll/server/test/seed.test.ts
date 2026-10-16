import { afterAll, beforeAll, expect, it } from 'vitest';
import { computeStandings } from '@fotboll/shared';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { TEST_DB } from './helpers.js';

let db: Db;
beforeAll(async () => {
  db = createPool(TEST_DB);
  await db.query('drop schema public cascade; create schema public;');
  await migrate(db);
});
afterAll(() => db.end());

it('seeds demo data through the sync rules and produces a sensible table', async () => {
  expect(await seed(db)).toBe(true);
  expect(await seed(db)).toBe(false); // idempotent

  const teams = (await db.query('select id, name from teams')).rows;
  const played = (
    await db.query(
      `select m.home_team_id, m.away_team_id, r.home_score, r.away_score
       from matches m join match_reports r on r.id = m.id where r.status in ('submitted', 'approved')`,
    )
  ).rows;
  expect(played).toHaveLength(2);
  const table = computeStandings(teams, played, { points_win: 3, points_draw: 1, points_loss: 0 });
  expect(table[0]).toMatchObject({ points: 3, goals_for: 2, goals_against: 1 });
  expect(table.reduce((s, r) => s + r.played, 0)).toBe(4);
});
