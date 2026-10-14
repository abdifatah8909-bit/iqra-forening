import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fotboll/shared';
import { league, mutation, pullAs, pushAs, pushOk, setup, teardown, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  if (env) await teardown(env);
  env = await setup();
});
afterAll(async () => teardown(env));

describe('auth', () => {
  it('rejects wrong passwords and unauthenticated requests', async () => {
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.org', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/sync/pull' })).statusCode).toBe(401);
  });

  it('returns the user with roles', async () => {
    const me = await env.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${env.tokens.clubA}` },
    });
    expect(me.json().roles).toEqual([{ role: 'club_admin', club_id: env.clubA }]);
  });

  it('logout revokes the token', async () => {
    const headers = { authorization: `Bearer ${env.tokens.referee}` };
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
  });
});

describe('push and pull', () => {
  it('pulls incrementally by cursor', async () => {
    const first = await pullAs(env, env.tokens.admin);
    expect(first.reset).toBe(true);
    expect(first.changes.clubs).toHaveLength(2);

    const venue = mutation('venues', { name: 'Arena' });
    await pushOk(env, env.tokens.admin, [venue]);
    const next = await pullAs(env, env.tokens.admin, first.cursor, first.scope);
    expect(next.reset).toBe(false);
    expect(Object.keys(next.changes)).toEqual(['venues']);
    expect(next.cursor).toBeGreaterThan(first.cursor);

    const idle = await pullAs(env, env.tokens.admin, next.cursor, next.scope);
    expect(idle.changes).toEqual({});
    expect(idle.cursor).toBe(next.cursor);
  });

  it('pages large pulls without losing rows', async () => {
    const venues = Array.from({ length: 2500 }, (_, i) => mutation('venues', { name: `V${i}` }));
    for (let i = 0; i < venues.length; i += 200) await pushOk(env, env.tokens.admin, venues.slice(i, i + 200));
    let since = 0;
    let scope: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const res = await pullAs(env, env.tokens.admin, since, scope);
      for (const v of res.changes.venues ?? []) seen.add(v.id as string);
      since = res.cursor;
      scope = res.scope;
      if (!res.has_more) break;
    }
    expect(seen.size).toBe(2500);
  });

  it('applies a retried mutation only once', async () => {
    const m = mutation('venues', { name: 'Once' });
    const [a] = await pushAs(env, env.tokens.admin, [m]);
    const [b] = await pushAs(env, env.tokens.admin, [m]);
    expect(b).toEqual(a);
    const count = await env.db.query('select count(*)::int as n from venues');
    expect(count.rows[0].n).toBe(1);
  });

  it('merges concurrent edits field by field and logs the conflict', async () => {
    const venue = mutation('venues', { name: 'Old', address: 'Old street' });
    const [created] = await pushOk(env, env.tokens.admin, [venue]);
    const base = created.server_seq as number;
    // Two devices edited the same version offline, different fields.
    await pushOk(env, env.tokens.admin, [
      { ...mutation('venues', { id: venue.row_id, name: 'New name' }), data: { name: 'New name' }, base_seq: base },
    ]);
    const [merged] = await pushOk(env, env.tokens.admin, [
      { ...mutation('venues', { id: venue.row_id }), data: { address: 'New street' }, base_seq: base },
    ]);
    expect(merged).toMatchObject({ name: 'New name', address: 'New street' });
    const log = await env.db.query('select * from conflict_log');
    expect(log.rowCount).toBe(1);
  });

  it('soft-deletes and propagates tombstones', async () => {
    const venue = mutation('venues', { name: 'Temp' });
    await pushOk(env, env.tokens.admin, [venue]);
    const before = await pullAs(env, env.tokens.admin);
    await pushOk(env, env.tokens.admin, [{ ...venue, id: uuidv7(), op: 'delete', data: {} }]);
    const after = await pullAs(env, env.tokens.admin, before.cursor, before.scope);
    expect(after.changes.venues?.[0].deleted_at).toBeTruthy();
  });

  it('rejects invalid data and returns the server row for rollback', async () => {
    const [res] = await pushAs(env, env.tokens.admin, [mutation('venues', { name: '' })]);
    expect(res).toMatchObject({ status: 'rejected', reason: 'invalid', row: null });
  });

  it('never lets a client reference another federation', async () => {
    const otherFed = uuidv7();
    const otherClub = uuidv7();
    await env.db.query(`insert into federations (id, name) values ($1, 'Other')`, [otherFed]);
    await env.db.query(`insert into clubs (id, federation_id, name) values ($1, $2, 'X')`, [otherClub, otherFed]);
    const [res] = await pushAs(env, env.tokens.admin, [
      mutation('players', { club_id: otherClub, first_name: 'A', last_name: 'B', birth_date: '2000-01-01', gender: 'male' }),
    ]);
    expect(res.reason).toBe('invalid_reference');
    const [edit] = await pushAs(env, env.tokens.admin, [mutation('clubs', { id: otherClub, name: 'Hijack' })]);
    expect(edit.reason).toBe('forbidden');
  });
});

describe('permissions', () => {
  it('club admins manage their own players only', async () => {
    const own = mutation('players', {
      club_id: env.clubA,
      first_name: 'Own',
      last_name: 'Player',
      birth_date: '2001-02-03',
      gender: 'male',
    });
    await pushOk(env, env.tokens.clubA, [own]);
    const [other] = await pushAs(env, env.tokens.clubA, [
      mutation('players', { club_id: env.clubB, first_name: 'X', last_name: 'Y', birth_date: '2001-02-03', gender: 'male' }),
    ]);
    expect(other.reason).toBe('forbidden');
    const [move] = await pushAs(env, env.tokens.clubA, [
      { ...mutation('players', { id: own.row_id }), data: { club_id: env.clubB } },
    ]);
    expect(move.reason).toBe('forbidden');
    const [club] = await pushAs(env, env.tokens.clubA, [mutation('clubs', { name: 'New club' })]);
    expect(club.reason).toBe('forbidden');
  });

  it('requires guardian consent before storing a photo of a minor', async () => {
    const media = mutation('media', {
      kind: 'player_photo',
      sha256: 'a'.repeat(64),
      mime: 'image/webp',
      width: 100,
      height: 100,
    });
    const minor = mutation('players', {
      club_id: env.clubA,
      first_name: 'Young',
      last_name: 'Talent',
      birth_date: `${new Date().getUTCFullYear() - 12}-01-01`,
      gender: 'female',
      photo_media_id: media.row_id,
    });
    const [, res] = await pushAs(env, env.tokens.clubA, [media, minor]);
    expect(res.reason).toBe('photo_consent_required');
    const ok = { ...minor, id: uuidv7(), data: { ...minor.data, photo_consent: true } };
    await pushOk(env, env.tokens.clubA, [ok]);
  });

  it('approving a registration moves the player to the new club', async () => {
    const l = await league(env);
    const reg = mutation('registrations', {
      player_id: l.playersB[0],
      club_id: env.clubA,
      season_id: l.seasonId,
    });
    // Club A cannot poach a player from club B on its own.
    const [poach] = await pushAs(env, env.tokens.clubA, [reg]);
    expect(poach.reason).toBe('transfer_requires_federation');
    await pushOk(env, env.tokens.admin, [reg]);
    const [approved] = await pushOk(env, env.tokens.admin, [
      { ...mutation('registrations', { id: reg.row_id }), data: { status: 'approved' } },
    ]);
    expect(approved.decided_by).toBe(env.userIds.admin);
    const player = await env.db.query('select club_id from players where id = $1', [l.playersB[0]]);
    expect(player.rows[0].club_id).toBe(env.clubA);
  });
});

describe('match report', () => {
  it('runs the referee flow: lineup, events, submit, lock, reopen', async () => {
    const l = await league(env);
    const ref = env.tokens.referee;
    const lineup = [
      ...l.playersA.map((p) => mutation('match_lineups', { match_id: l.matchId, team_id: l.teamA, player_id: p })),
      ...l.playersB.map((p) => mutation('match_lineups', { match_id: l.matchId, team_id: l.teamB, player_id: p })),
    ];
    await pushOk(env, ref, lineup);

    const event = (team: string, player: string, type: string, minute: number) =>
      mutation('match_events', { match_id: l.matchId, team_id: team, player_id: player, type, minute });
    await pushOk(env, ref, [
      event(l.teamA, l.playersA[0], 'goal', 10),
      event(l.teamA, l.playersA[1], 'penalty_goal', 30),
      event(l.teamB, l.playersB[0], 'own_goal', 50), // counts for A
      event(l.teamB, l.playersB[1], 'goal', 70),
      event(l.teamB, l.playersB[2], 'yellow', 80),
    ]);

    // A player who is not in the lineup cannot score.
    const [stranger] = await pushAs(env, ref, [event(l.teamA, l.playersB[0], 'goal', 85)]);
    expect(stranger.reason).toBe('player_not_in_lineup');
    // Another referee cannot touch this match.
    const [intruder] = await pushAs(env, env.tokens.referee2, [event(l.teamA, l.playersA[0], 'goal', 86)]);
    expect(intruder.reason).toBe('forbidden');

    // The typed score is ignored: the result comes from the events.
    const [report] = await pushOk(env, ref, [
      mutation('match_reports', { id: l.matchId, status: 'submitted', home_score: 9, away_score: 9 }),
    ]);
    expect(report).toMatchObject({ home_score: 3, away_score: 1, submitted_by: env.userIds.referee });
    const match = await env.db.query('select status from matches where id = $1', [l.matchId]);
    expect(match.rows[0].status).toBe('played');

    // Submitted reports are locked for the referee...
    const [late] = await pushAs(env, ref, [event(l.teamA, l.playersA[2], 'goal', 89)]);
    expect(late.reason).toBe('report_locked');
    const [approve] = await pushAs(env, ref, [
      { ...mutation('match_reports', { id: l.matchId }), data: { status: 'approved' } },
    ]);
    expect(approve.reason).toBe('report_locked');

    // ...until the federation reopens it.
    await pushOk(env, env.tokens.admin, [
      { ...mutation('match_reports', { id: l.matchId }), data: { status: 'reopened' } },
    ]);
    await pushOk(env, ref, [event(l.teamA, l.playersA[2], 'goal', 89)]);
    const [resubmitted] = await pushOk(env, ref, [
      { ...mutation('match_reports', { id: l.matchId }), data: { status: 'submitted' } },
    ]);
    expect(resubmitted).toMatchObject({ home_score: 4, away_score: 1 });
    const [approved] = await pushOk(env, env.tokens.admin, [
      { ...mutation('match_reports', { id: l.matchId }), data: { status: 'approved' } },
    ]);
    expect(approved.approved_by).toBe(env.userIds.admin);
  });

  it('club admins set their own lineup but not the opponent', async () => {
    const l = await league(env);
    await pushOk(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: l.matchId, team_id: l.teamA, player_id: l.playersA[0] }),
    ]);
    const [res] = await pushAs(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: l.matchId, team_id: l.teamB, player_id: l.playersB[0] }),
    ]);
    expect(res.reason).toBe('forbidden');
  });
});

describe('pull scoping (data minimisation)', () => {
  it('club admins see only their own players and registrations', async () => {
    const l = await league(env);
    const res = await pullAs(env, env.tokens.clubA);
    const ids = (res.changes.players ?? []).map((p) => p.id);
    expect(ids.sort()).toEqual([...l.playersA].sort());
    expect(res.changes.matches).toHaveLength(1); // fixtures are shared
    const profiles = res.changes.user_profiles ?? [];
    expect(Object.keys(profiles[0]).includes('email')).toBe(false);
  });

  it('referees see squads of their matches and resync when assignments change', async () => {
    const l = await league(env);
    const first = await pullAs(env, env.tokens.referee);
    expect(first.changes.players).toHaveLength(6);

    const ref2 = await pullAs(env, env.tokens.referee2);
    expect(ref2.changes.players ?? []).toHaveLength(0);

    // Reassign the match: referee2's scope changes, so it gets a full resync.
    await pushOk(env, env.tokens.admin, [
      { ...mutation('matches', { id: l.matchId }), data: { referee_user_id: env.userIds.referee2 } },
    ]);
    const after = await pullAs(env, env.tokens.referee2, ref2.cursor, ref2.scope);
    expect(after.reset).toBe(true);
    expect(after.changes.players).toHaveLength(6);
  });
});

describe('media', () => {
  it('stores verified uploads and enforces visibility', async () => {
    const bytes = Buffer.from('fake-webp-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const media = mutation('media', { kind: 'player_photo', sha256, mime: 'image/webp', width: 10, height: 10 });
    const player = mutation('players', {
      club_id: env.clubA,
      first_name: 'Photo',
      last_name: 'Player',
      birth_date: '1990-01-01',
      gender: 'male',
      photo_media_id: media.row_id,
    });
    await pushOk(env, env.tokens.clubA, [media, player]);

    const put = (body: Buffer) =>
      env.app.inject({
        method: 'PUT',
        url: `/api/media/${media.row_id}`,
        headers: { authorization: `Bearer ${env.tokens.clubA}`, 'content-type': 'image/webp' },
        payload: body,
      });
    expect((await put(Buffer.from('tampered'))).statusCode).toBe(400);
    expect((await put(bytes)).statusCode).toBe(200);

    const get = (token: string) =>
      env.app.inject({ method: 'GET', url: `/api/media/${media.row_id}`, headers: { authorization: `Bearer ${token}` } });
    const own = await get(env.tokens.clubA);
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload.equals(bytes)).toBe(true);
    expect((await get(env.tokens.referee)).statusCode).toBe(403);
  });
});

describe('admin', () => {
  it('creates users and erases players (GDPR)', async () => {
    const headers = { authorization: `Bearer ${env.tokens.admin}` };
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers,
      payload: {
        email: 'New@Test.org',
        display_name: 'New Ref',
        password: 'longenough',
        roles: [{ role: 'referee' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'new@test.org', password: 'longenough' },
    });
    expect(login.statusCode).toBe(200);

    const forbidden = await env.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${env.tokens.clubA}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const p = mutation('players', { club_id: env.clubA, first_name: 'Erase', last_name: 'Me', birth_date: '2000-01-01', gender: 'male' });
    await pushOk(env, env.tokens.admin, [p]);
    const erase = await env.app.inject({ method: 'POST', url: `/api/admin/players/${p.row_id}/erase`, headers });
    expect(erase.statusCode).toBe(200);
    const row = (await env.db.query('select first_name, birth_date, deleted_at from players where id = $1', [p.row_id])).rows[0];
    expect(row.first_name).toBe('–');
    expect(row.deleted_at).toBeTruthy();
  });
});
