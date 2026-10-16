import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { teamSheetId } from '@fotboll/shared';
import { league, mutation, pullAs, pushAs, pushOk, setup, teardown, type TestEnv } from './helpers.js';

let env: TestEnv;
let clubB: string;
beforeEach(async () => {
  if (env) await teardown(env);
  env = await setup();
  await env.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { authorization: `Bearer ${env.tokens.admin}` },
    payload: { email: 'clubb@test.org', display_name: 'B admin', password: 'secret-pass', roles: [{ role: 'club_admin', club_id: env.clubB }] },
  });
  clubB = (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'clubb@test.org', password: 'secret-pass' } })).json().token;
});
afterAll(async () => teardown(env));

/** Club A's team with eight more squad players, and a valid lineup of 11 (minus what `omit` leaves out). */
async function lineup(l: Awaited<ReturnType<typeof league>>) {
  const extra = Array.from({ length: 8 }, (_, i) =>
    mutation('players', { club_id: env.clubA, first_name: `X${i}`, last_name: 'Alpha', birth_date: '1999-01-01', gender: 'male' }),
  );
  await pushOk(env, env.tokens.clubA, [
    ...extra,
    ...extra.map((p) => mutation('squad_members', { team_id: l.teamA, player_id: p.row_id })),
  ]);
  const ids = [...l.playersA, ...extra.map((p) => p.row_id)];
  return ids.map((player_id, i) =>
    mutation('match_lineups', {
      match_id: l.matchId,
      team_id: l.teamA,
      player_id,
      shirt_number: i + 1,
      is_starter: true,
      is_goalkeeper: i === 0,
      is_captain: i === 5,
    }),
  );
}

const sheet = (l: Awaited<ReturnType<typeof league>>, status: 'draft' | 'submitted', team = l.teamA) =>
  mutation('team_sheets', { id: teamSheetId(l.matchId, team), match_id: l.matchId, team_id: team, status });

describe('team sheets', () => {
  it('the club submits a valid lineup and everyone can read it', async () => {
    const l = await league(env);
    const rows = await lineup(l);

    // Not enough players yet.
    await pushOk(env, env.tokens.clubA, rows.slice(0, 5));
    const [tooFew] = await pushAs(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(tooFew.reason).toBe('sheet_too_few_starters');

    await pushOk(env, env.tokens.clubA, rows.slice(5));
    const [ok] = await pushOk(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(ok).toMatchObject({ status: 'submitted', submitted_by: env.userIds.clubA });
    expect(ok.submitted_at).toBeTruthy();

    // The opponent and the referee see the names, without access to the players' other data.
    for (const token of [clubB, env.tokens.referee]) {
      const pull = await pullAs(env, token);
      const named = (pull.changes.match_lineups ?? []).filter((r) => r.team_id === l.teamA);
      expect(named).toHaveLength(11);
      expect(named.every((r) => typeof r.player_name === 'string' && (r.player_name as string).endsWith('Alpha'))).toBe(true);
      expect(pull.changes.team_sheets?.[0]).toMatchObject({ status: 'submitted' });
    }
    expect((await pullAs(env, clubB)).changes.players?.some((p) => p.club_id === env.clubA)).toBeFalsy();
  });

  it('checks goalkeeper, captain and shirt numbers', async () => {
    const l = await league(env);
    const rows = await lineup(l);
    rows[0].data.is_goalkeeper = false;
    rows[5].data.is_captain = false;
    rows[7].data.shirt_number = 1;
    await pushOk(env, env.tokens.clubA, rows);
    const [noKeeper] = await pushAs(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(noKeeper.reason).toBe('sheet_no_goalkeeper');
    await pushOk(env, env.tokens.clubA, [mutation('match_lineups', { id: rows[0].row_id, is_goalkeeper: true })]);
    const [noCaptain] = await pushAs(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(noCaptain.reason).toBe('sheet_no_captain');
    await pushOk(env, env.tokens.clubA, [mutation('match_lineups', { id: rows[5].row_id, is_captain: true })]);
    const [dupes] = await pushAs(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(dupes.reason).toBe('sheet_duplicate_numbers');
  });

  it('a change by the club needs a new submission; the referee can correct without that', async () => {
    const l = await league(env);
    const rows = await lineup(l);
    await pushOk(env, env.tokens.clubA, [...rows, sheet(l, 'submitted')]);
    const status = async () => (await env.db.query('select status from team_sheets')).rows[0].status;

    await pushOk(env, env.tokens.referee, [mutation('match_lineups', { id: rows[10].row_id, is_starter: false })]);
    expect(await status()).toBe('submitted');
    await pushOk(env, env.tokens.clubA, [mutation('match_lineups', { id: rows[10].row_id, is_starter: true })]);
    expect(await status()).toBe('draft');
  });

  it('only the team’s own club submits its sheet', async () => {
    const l = await league(env);
    const rows = await lineup(l);
    await pushOk(env, env.tokens.clubA, rows);
    const [opponent] = await pushAs(env, clubB, [sheet(l, 'submitted')]);
    expect(opponent.reason).toBe('forbidden');
    const [referee] = await pushAs(env, env.tokens.referee, [sheet(l, 'submitted')]);
    expect(referee.reason).toBe('forbidden');
  });

  it('a suspended player blocks the submission', async () => {
    const l = await league(env);
    const rows = await lineup(l);
    // The federation put the player in (it may override), but the sheet cannot be submitted like that.
    await pushOk(env, env.tokens.admin, [
      mutation('suspensions', { player_id: l.playersA[1], competition_id: l.competitionId, matches: 1, starts_on: '2026-04-01' }),
    ]);
    await pushOk(env, env.tokens.admin, rows);
    const [blocked] = await pushAs(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    expect(blocked.reason).toBe('sheet_suspended_player');
  });

  it('publishes submitted lineups of senior competitions, without names of minors', async () => {
    const l = await league(env);
    const rows = await lineup(l);
    // One of the starters is 16.
    await env.db.query(`update players set birth_date = '2010-03-03' where id = $1`, [l.playersA[2]]);
    await pushOk(env, env.tokens.clubA, rows);
    const url = `/api/public/federations/${env.federationId}/matches/${l.matchId}`;
    const get = async () => (await env.app.inject({ method: 'GET', url })).json();

    // A draft is not public.
    expect(await get()).toEqual({ lineups_public: true, published_team_ids: [], lineups: [] });

    await pushOk(env, env.tokens.clubA, [sheet(l, 'submitted')]);
    const detail = await get();
    expect(detail.published_team_ids).toEqual([l.teamA]);
    expect(detail.lineups).toHaveLength(11);
    const minor = detail.lineups.find((r: { shirt_number: number }) => r.shirt_number === 3);
    expect(minor.name).toBeNull();
    expect(detail.lineups.filter((r: { name: string | null }) => r.name).length).toBe(10);
    expect(JSON.stringify(detail)).not.toContain('birth');

    // Youth competitions never publish lineups.
    await pushOk(env, env.tokens.admin, [mutation('competitions', { id: l.competitionId, is_senior: false })]);
    expect(await get()).toEqual({ lineups_public: false, published_team_ids: [], lineups: [] });
  });

  it('derives the same sheet id on every device', () => {
    const id = teamSheetId('01a13f7b-af42-71b8-99c8-169bc7740f2a', '01a13f7b-1111-72b8-99c8-269bc7740f2b');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(teamSheetId('01a13f7b-af42-71b8-99c8-169bc7740f2a', '01a13f7b-1111-72b8-99c8-269bc7740f2b')).toBe(id);
  });
});
