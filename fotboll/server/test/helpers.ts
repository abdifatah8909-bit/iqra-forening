import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { uuidv7, type Mutation, type MutationResult, type PullResponse, type WritableTable } from '@fotboll/shared';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { createPool, withWriteLock, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/fotboll_test';
export const PASSWORD = 'secret-pass';

export interface TestEnv {
  db: Db;
  app: FastifyInstance;
  mediaDir: string;
  federationId: string;
  clubA: string;
  clubB: string;
  tokens: { admin: string; clubA: string; referee: string; referee2: string };
  userIds: { admin: string; clubA: string; referee: string; referee2: string };
}

export async function setup(): Promise<TestEnv> {
  const db = createPool(TEST_DB);
  await db.query('drop schema public cascade; create schema public;');
  await migrate(db);
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'fotboll-media-'));
  const app = await buildApp({ db, mediaDir });

  const federationId = uuidv7();
  const clubA = uuidv7();
  const clubB = uuidv7();
  const hash = await hashPassword(PASSWORD);
  const userIds = { admin: uuidv7(), clubA: uuidv7(), referee: uuidv7(), referee2: uuidv7() };
  await withWriteLock(db, async (tx) => {
    await tx.query(`insert into federations (id, name) values ($1, 'Test FF')`, [federationId]);
    for (const [id, name] of [[clubA, 'Club A'], [clubB, 'Club B']]) {
      await tx.query('insert into clubs (id, federation_id, name) values ($1, $2, $3)', [id, federationId, name]);
    }
    const users: [string, string, string, string | null][] = [
      [userIds.admin, 'admin@test.org', 'federation_admin', null],
      [userIds.clubA, 'club@test.org', 'club_admin', clubA],
      [userIds.referee, 'ref@test.org', 'referee', null],
      [userIds.referee2, 'ref2@test.org', 'referee', null],
    ];
    for (const [id, email, role, clubId] of users) {
      await tx.query(
        `insert into users (id, federation_id, email, password_hash, display_name) values ($1, $2, $3, $4, $3)`,
        [id, federationId, email, hash],
      );
      await tx.query('insert into role_assignments (user_id, role, club_id) values ($1, $2, $3)', [id, role, clubId]);
    }
  });

  const login = async (email: string) =>
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })).json()
      .token as string;
  const tokens = {
    admin: await login('admin@test.org'),
    clubA: await login('club@test.org'),
    referee: await login('ref@test.org'),
    referee2: await login('ref2@test.org'),
  };
  return { db, app, mediaDir, federationId, clubA, clubB, tokens, userIds };
}

export async function teardown(env: TestEnv) {
  await env.app.close();
  await env.db.end();
}

export function mutation(
  table: WritableTable,
  data: Record<string, unknown>,
  extra: Partial<Mutation> = {},
): Mutation {
  const rowId = (data.id as string) ?? uuidv7();
  return { id: uuidv7(), table, op: 'upsert', row_id: rowId, data: { ...data, id: rowId }, ...extra };
}

export async function pushAs(env: TestEnv, token: string, mutations: Mutation[]): Promise<MutationResult[]> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: { authorization: `Bearer ${token}` },
    payload: { mutations },
  });
  if (res.statusCode !== 200) throw new Error(`push failed ${res.statusCode}: ${res.body}`);
  return res.json().results;
}

/** Push and require every mutation to succeed; returns canonical rows. */
export async function pushOk(env: TestEnv, token: string, mutations: Mutation[]) {
  const results = await pushAs(env, token, mutations);
  const bad = results.filter((r) => r.status !== 'ok');
  if (bad.length) throw new Error(`rejected: ${JSON.stringify(bad.map((b) => b.reason))}`);
  return results.map((r) => r.row!);
}

export async function pullAs(env: TestEnv, token: string, since = 0, scope?: string): Promise<PullResponse> {
  const qs = new URLSearchParams({ since: String(since), ...(scope ? { scope } : {}) });
  const res = await env.app.inject({
    method: 'GET',
    url: `/api/sync/pull?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.statusCode !== 200) throw new Error(`pull failed ${res.statusCode}: ${res.body}`);
  return res.json();
}

/** A league with two teams, squads, one match assigned to `referee`. */
export async function league(env: TestEnv) {
  const season = mutation('seasons', { name: '2026', starts_on: '2026-04-01', ends_on: '2026-10-31' });
  const comp = mutation('competitions', { season_id: season.row_id, name: 'Div 1', gender: 'male' });
  const teamA = mutation('teams', { club_id: env.clubA, competition_id: comp.row_id, name: 'A' });
  const teamB = mutation('teams', { club_id: env.clubB, competition_id: comp.row_id, name: 'B' });
  const players = (club: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      mutation('players', {
        club_id: club,
        first_name: `P${i}`,
        last_name: club === env.clubA ? 'Alpha' : 'Bravo',
        birth_date: '1998-05-05',
        gender: 'male',
      }),
    );
  const pa = players(env.clubA, 3);
  const pb = players(env.clubB, 3);
  const squad = [
    ...pa.map((p) => mutation('squad_members', { team_id: teamA.row_id, player_id: p.row_id })),
    ...pb.map((p) => mutation('squad_members', { team_id: teamB.row_id, player_id: p.row_id })),
  ];
  const match = mutation('matches', {
    competition_id: comp.row_id,
    round: 1,
    home_team_id: teamA.row_id,
    away_team_id: teamB.row_id,
    kickoff_at: '2026-05-02T14:00:00.000Z',
    referee_user_id: env.userIds.referee,
  });
  await pushOk(env, env.tokens.admin, [season, comp, teamA, teamB, ...pa, ...pb, ...squad, match]);
  return {
    seasonId: season.row_id,
    competitionId: comp.row_id,
    teamA: teamA.row_id,
    teamB: teamB.row_id,
    playersA: pa.map((p) => p.row_id),
    playersB: pb.map((p) => p.row_id),
    matchId: match.row_id,
  };
}
