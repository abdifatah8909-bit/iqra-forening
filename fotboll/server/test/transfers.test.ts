import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { league, mutation, pullAs, pushAs, pushOk, setup, teardown, type TestEnv } from './helpers.js';

let env: TestEnv;
let clubB: string; // token for an admin of club B
beforeEach(async () => {
  if (env) await teardown(env);
  env = await setup();
  const headers = { authorization: `Bearer ${env.tokens.admin}` };
  await env.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers,
    payload: { email: 'clubb@test.org', display_name: 'B admin', password: 'secret-pass', roles: [{ role: 'club_admin', club_id: env.clubB }] },
  });
  clubB = (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'clubb@test.org', password: 'secret-pass' } })).json().token;
});
afterAll(async () => teardown(env));

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const setStatus = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  mutation('transfers', { id, status, ...extra });

async function playerRow(id: string) {
  return (await env.db.query('select club_id from players where id = $1', [id])).rows[0];
}

describe('transfers', () => {
  it('needs the receiving club, the current club and then the federation', async () => {
    const l = await league(env);
    const player = l.playersA[0];
    await env.db.query(`update players set license_no = 'SO-123' where id = $1`, [player]);

    // Club B finds the player by licence number and applies.
    const search = await env.app.inject({ method: 'GET', url: '/api/players/search?license_no=so-123', headers: auth(clubB) });
    expect(search.json()).toMatchObject([{ id: player, club_id: env.clubA, club_name: 'Club A', open_transfer: false }]);
    const request = mutation('transfers', { player_id: player, to_club_id: env.clubB, status: 'pending_federation', note: 'Moving city' });
    const [created] = await pushOk(env, clubB, [request]);
    // The server decides where it starts, whatever the client sent.
    expect(created).toMatchObject({ status: 'pending_club', from_club_id: env.clubA, to_club_id: env.clubB });

    // While the request is open, club B can see the player.
    expect((await pullAs(env, clubB)).changes.players?.map((p) => p.id)).toContain(player);

    // Nobody can skip the current club's step.
    const [fedTooEarly] = await pushAs(env, env.tokens.admin, [setStatus(request.row_id, 'approved')]);
    expect(fedTooEarly.reason).toBe('forbidden');
    const [selfRelease] = await pushAs(env, clubB, [setStatus(request.row_id, 'pending_federation')]);
    expect(selfRelease.reason).toBe('forbidden');

    // Club A releases the player, then the federation approves.
    const [released] = await pushOk(env, env.tokens.clubA, [setStatus(request.row_id, 'pending_federation', { response_note: 'Good luck' })]);
    expect(released.released_by).toBe(env.userIds.clubA);
    const [clubCannotApprove] = await pushAs(env, env.tokens.clubA, [setStatus(request.row_id, 'approved')]);
    expect(clubCannotApprove.reason).toBe('forbidden');
    const [approved] = await pushOk(env, env.tokens.admin, [setStatus(request.row_id, 'approved')]);
    expect(approved.decided_by).toBe(env.userIds.admin);

    // The player has moved: new club, out of club A's squad, registered for the season with club B.
    expect((await playerRow(player)).club_id).toBe(env.clubB);
    const squad = await env.db.query('select deleted_at from squad_members where player_id = $1', [player]);
    expect(squad.rows.every((r) => r.deleted_at)).toBe(true);
    const reg = await env.db.query('select club_id, status, season_id from registrations where player_id = $1', [player]);
    expect(reg.rows).toEqual([{ club_id: env.clubB, status: 'approved', season_id: l.seasonId }]);

    // Decided transfers are final.
    const [late] = await pushAs(env, env.tokens.admin, [setStatus(request.row_id, 'rejected')]);
    expect(late.reason).toBe('transfer_decided');
    // Club A no longer has the player on its devices.
    const pullA = await pullAs(env, env.tokens.clubA);
    expect(pullA.changes.players?.map((p) => p.id)).not.toContain(player);
  });

  it('the current club can refuse and the receiving club can withdraw', async () => {
    const l = await league(env);
    const [p1, p2] = l.playersA;
    const r1 = mutation('transfers', { player_id: p1, to_club_id: env.clubB, status: 'pending_club' });
    const r2 = mutation('transfers', { player_id: p2, to_club_id: env.clubB, status: 'pending_club' });
    await pushOk(env, clubB, [r1, r2]);

    // One open transfer per player.
    const [dup] = await pushAs(env, clubB, [mutation('transfers', { player_id: p1, to_club_id: env.clubB, status: 'pending_club' })]);
    expect(dup.reason).toBe('duplicate');

    await pushOk(env, env.tokens.clubA, [setStatus(r1.row_id, 'rejected', { response_note: 'Under contract' })]);
    const [cannotCancelOthers] = await pushAs(env, env.tokens.clubA, [setStatus(r2.row_id, 'cancelled')]);
    expect(cannotCancelOthers.reason).toBe('forbidden');
    await pushOk(env, clubB, [setStatus(r2.row_id, 'cancelled')]);
    expect((await playerRow(p1)).club_id).toBe(env.clubA);
    expect((await playerRow(p2)).club_id).toBe(env.clubA);

    // After refusal the player is no longer visible to club B; a new request is possible.
    const visible = ((await pullAs(env, clubB)).changes.players ?? []).map((p) => p.id);
    expect(visible).not.toContain(p1);
    expect(visible).not.toContain(p2);
    await pushOk(env, clubB, [mutation('transfers', { player_id: p1, to_club_id: env.clubB, status: 'pending_club' })]);
  });

  it('only the receiving club or the federation applies, never for its own player', async () => {
    const l = await league(env);
    const [notMine] = await pushAs(env, env.tokens.clubA, [mutation('transfers', { player_id: l.playersB[0], to_club_id: env.clubB, status: 'pending_club' })]);
    expect(notMine.reason).toBe('forbidden');
    const [own] = await pushAs(env, env.tokens.clubA, [mutation('transfers', { player_id: l.playersA[0], to_club_id: env.clubA, status: 'pending_club' })]);
    expect(own.reason).toBe('already_in_club');
    const [referee] = await pushAs(env, env.tokens.referee, [mutation('transfers', { player_id: l.playersA[0], to_club_id: env.clubB, status: 'pending_club' })]);
    expect(referee.reason).toBe('forbidden');
    // The federation can apply on a club's behalf; the club still has to release.
    const [onBehalf] = await pushOk(env, env.tokens.admin, [mutation('transfers', { player_id: l.playersA[1], to_club_id: env.clubB, status: 'pending_club' })]);
    expect(onBehalf.status).toBe('pending_club');
  });

  it('a player without a club goes straight to the federation', async () => {
    const free = mutation('players', { club_id: null, first_name: 'Free', last_name: 'Agent', birth_date: '2000-02-02', gender: 'male' });
    await pushOk(env, env.tokens.admin, [free]);
    const [t] = await pushOk(env, clubB, [mutation('transfers', { player_id: free.row_id, to_club_id: env.clubB, status: 'pending_club' })]);
    expect(t).toMatchObject({ status: 'pending_federation', from_club_id: null });
    await pushOk(env, env.tokens.admin, [setStatus(t.id as string, 'approved')]);
    expect((await playerRow(free.row_id)).club_id).toBe(env.clubB);
  });

  it('search needs a licence number or full name with date of birth', async () => {
    const l = await league(env);
    const byName = await env.app.inject({
      method: 'GET',
      url: `/api/players/search?first_name=p0&last_name=ALPHA&birth_date=1998-05-05`,
      headers: auth(clubB),
    });
    expect(byName.json().map((h: { id: string }) => h.id)).toEqual([l.playersA[0]]);
    const nameOnly = await env.app.inject({ method: 'GET', url: '/api/players/search?first_name=P0&last_name=Alpha', headers: auth(clubB) });
    expect(nameOnly.statusCode).toBe(400);
    const referee = await env.app.inject({ method: 'GET', url: '/api/players/search?license_no=x1', headers: auth(env.tokens.referee) });
    expect(referee.statusCode).toBe(403);
  });
});
