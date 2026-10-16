import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fotboll/shared';
import { league, mutation, pullAs, pushAs, pushOk, setup, teardown, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  if (env) await teardown(env);
  env = await setup();
});
afterAll(async () => teardown(env));

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const linkToken = (text: string) => text.match(/\/set-password\/([\w-]+)/)![1];

describe('invitations and password reset', () => {
  it('invites a user who then chooses a password and is signed in', async () => {
    // The email names the federation in the user's language.
    await env.db.query(`update federations set name_i18n = '{"en": "Test Football Federation"}'`);
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: auth(env.tokens.admin),
      payload: { email: 'invited@test.org', display_name: 'Invited Ref', locale: 'en', roles: [{ role: 'referee' }] },
    });
    expect(created.statusCode).toBe(201);
    const { link } = created.json();
    expect(link).toMatchObject({ purpose: 'invite', emailed: true });

    // The same link was emailed, in the user's language.
    expect(env.mailer.sent).toHaveLength(1);
    expect(env.mailer.sent[0].to).toBe('invited@test.org');
    expect(env.mailer.sent[0].text).toContain(`https://fotboll.test/set-password/${link.token}`);
    expect(env.mailer.sent[0].text).toContain('invited to Nidaamka UKCS by Test Football Federation');

    // No password works before the invitation is used.
    const early = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'invited@test.org', password: '!' } });
    expect(early.statusCode).toBe(401);

    const info = await env.app.inject({ method: 'GET', url: `/api/auth/token/${link.token}` });
    expect(info.json()).toMatchObject({ purpose: 'invite', display_name: 'Invited Ref' });

    const set = await env.app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token: link.token, password: 'my-new-password' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().user.roles).toEqual([{ role: 'referee', club_id: null }]);
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: auth(set.json().token) });
    expect(me.json().email).toBe('invited@test.org');

    // The link works once.
    const again = await env.app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token: link.token, password: 'another-password' },
    });
    expect(again.statusCode).toBe(410);
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'invited@test.org', password: 'my-new-password' },
    });
    expect(login.statusCode).toBe(200);

    const users = (await env.app.inject({ method: 'GET', url: '/api/admin/users', headers: auth(env.tokens.admin) })).json();
    expect(users.find((u: { email: string }) => u.email === 'invited@test.org').invited).toBe(false);
  });

  it('emails a reset link without revealing which addresses exist', async () => {
    const unknown = await env.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@test.org' } });
    const known = await env.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'REF@test.org' } });
    expect(unknown.json()).toEqual(known.json());
    await new Promise((r) => setTimeout(r, 50)); // the email is sent in the background
    expect(env.mailer.sent.map((m) => m.to)).toEqual(['ref@test.org']);

    const token = linkToken(env.mailer.sent[0].text);
    const set = await env.app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token, password: 'reset-password' } });
    expect(set.statusCode).toBe(200);
    // Every other device is signed out.
    const old = await env.app.inject({ method: 'GET', url: '/api/me', headers: auth(env.tokens.referee) });
    expect(old.statusCode).toBe(401);
  });

  it('only the newest link works, and deactivated users cannot use one', async () => {
    const first = (await env.app.inject({ method: 'POST', url: `/api/admin/users/${env.userIds.referee}/link`, headers: auth(env.tokens.admin) })).json();
    const second = (await env.app.inject({ method: 'POST', url: `/api/admin/users/${env.userIds.referee}/link`, headers: auth(env.tokens.admin) })).json();
    expect(second.purpose).toBe('reset');
    expect((await env.app.inject({ method: 'GET', url: `/api/auth/token/${first.token}` })).statusCode).toBe(410);
    expect((await env.app.inject({ method: 'GET', url: `/api/auth/token/${second.token}` })).statusCode).toBe(200);

    await env.app.inject({ method: 'PATCH', url: `/api/admin/users/${env.userIds.referee}`, headers: auth(env.tokens.admin), payload: { is_active: false } });
    expect((await env.app.inject({ method: 'GET', url: `/api/auth/token/${second.token}` })).statusCode).toBe(410);

    const forbidden = await env.app.inject({ method: 'POST', url: `/api/admin/users/${env.userIds.admin}/link`, headers: auth(env.tokens.clubA) });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('suspensions', () => {
  /** A second match between the same teams, a week after the first. */
  async function nextMatch(l: Awaited<ReturnType<typeof league>>, days = 7) {
    const m = mutation('matches', {
      competition_id: l.competitionId,
      round: 2,
      home_team_id: l.teamB,
      away_team_id: l.teamA,
      kickoff_at: new Date(Date.parse('2026-05-02T14:00:00.000Z') + days * 86400000).toISOString(),
      referee_user_id: env.userIds.referee,
    });
    await pushOk(env, env.tokens.admin, [m]);
    return m.row_id;
  }

  async function playMatch(matchId: string, teamId: string, players: string[], cards: [string, 'yellow' | 'red' | 'second_yellow'][]) {
    await pushOk(env, env.tokens.referee, [
      ...players.map((p) => mutation('match_lineups', { match_id: matchId, team_id: teamId, player_id: p })),
      ...cards.map(([p, type]) => mutation('match_events', { match_id: matchId, team_id: teamId, player_id: p, type, minute: 30 })),
      mutation('match_reports', { id: matchId, status: 'submitted' }),
    ]);
  }

  it('a red card keeps the player out of the next match only', async () => {
    const l = await league(env);
    const second = await nextMatch(l);
    const third = await nextMatch(l, 14);
    const [sent, other] = l.playersA;
    await playMatch(l.matchId, l.teamA, [sent, other], [[sent, 'red']]);

    // The club cannot pick the suspended player for the next match, but can pick others.
    const [banned, fine] = await pushAs(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: sent }),
      mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: other }),
    ]);
    expect(banned).toMatchObject({ status: 'rejected', reason: 'player_suspended' });
    expect(fine.status).toBe('ok');
    // The match after that is fine.
    await pushOk(env, env.tokens.clubA, [mutation('match_lineups', { match_id: third, team_id: l.teamA, player_id: sent })]);
    // The federation can override.
    await pushOk(env, env.tokens.admin, [mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: sent })]);
  });

  it('yellow cards accumulate per competition, second yellows do not count', async () => {
    const l = await league(env);
    await pushOk(env, env.tokens.admin, [mutation('competitions', { id: l.competitionId, yellow_card_limit: 2 })]);
    const second = await nextMatch(l);
    const third = await nextMatch(l, 14);
    const p = l.playersA[0];
    const q = l.playersA[1];
    // p: one yellow. q: two yellows and a second yellow in one match (a sending-off, not accumulation).
    await playMatch(l.matchId, l.teamA, [p, q], [[p, 'yellow'], [q, 'yellow'], [q, 'second_yellow']]);

    const [pOk, qBanned] = await pushAs(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: p }),
      mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: q }),
    ]);
    expect(pOk.status).toBe('ok');
    expect(qBanned.reason).toBe('player_suspended');

    // p's second yellow reaches the limit of 2: out of the third match.
    await pushOk(env, env.tokens.referee, [
      mutation('match_events', { match_id: second, team_id: l.teamA, player_id: p, type: 'yellow', minute: 10 }),
      mutation('match_reports', { id: second, status: 'submitted' }),
    ]);
    const [pBanned, qOk] = await pushAs(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: third, team_id: l.teamA, player_id: p }),
      mutation('match_lineups', { match_id: third, team_id: l.teamA, player_id: q }),
    ]);
    expect(pBanned.reason).toBe('player_suspended');
    expect(qOk.status).toBe('ok');
  });

  it('federation admins add manual suspensions, which sync like players', async () => {
    const l = await league(env);
    const second = await nextMatch(l);
    const p = l.playersA[2];
    const byMatches = mutation('suspensions', {
      player_id: p,
      competition_id: l.competitionId,
      matches: 2,
      starts_on: '2026-05-01',
      reason: 'Disciplinary committee',
    });
    const [forbidden] = await pushAs(env, env.tokens.clubA, [byMatches]);
    expect(forbidden.reason).toBe('forbidden');
    const [invalid] = await pushAs(env, env.tokens.admin, [mutation('suspensions', { player_id: p, starts_on: '2026-05-01' })]);
    expect(invalid.reason).toBe('invalid');
    await pushOk(env, env.tokens.admin, [byMatches]);

    const [first, next] = await pushAs(env, env.tokens.clubA, [
      mutation('match_lineups', { match_id: l.matchId, team_id: l.teamA, player_id: p }),
      mutation('match_lineups', { match_id: second, team_id: l.teamA, player_id: p }),
    ]);
    expect(first.reason).toBe('player_suspended');
    expect(next.reason).toBe('player_suspended');

    // The club sees its own player's suspension; the other club's admin would not.
    expect((await pullAs(env, env.tokens.clubA)).changes.suspensions).toHaveLength(1);
    const pB = l.playersB[0];
    await pushOk(env, env.tokens.admin, [mutation('suspensions', { player_id: pB, starts_on: '2026-05-01', ends_on: '2026-12-31' })]);
    expect((await pullAs(env, env.tokens.clubA)).changes.suspensions).toHaveLength(1);
  });
});

describe('public pages', () => {
  it('publishes fixtures, counted results and clubs, but no personal data', async () => {
    const l = await league(env);
    const feds = (await env.app.inject({ method: 'GET', url: '/api/public/federations' })).json();
    expect(feds).toEqual([{ id: env.federationId, name: 'Test FF', name_i18n: null, country: null }]);

    const before = (await env.app.inject({ method: 'GET', url: `/api/public/federations/${env.federationId}` })).json();
    expect(before.matches).toHaveLength(1);
    expect(before.results).toEqual([]);

    await pushOk(env, env.tokens.referee, [
      mutation('match_lineups', { match_id: l.matchId, team_id: l.teamA, player_id: l.playersA[0] }),
      mutation('match_events', { match_id: l.matchId, team_id: l.teamA, player_id: l.playersA[0], type: 'goal', minute: 5 }),
      mutation('match_reports', { id: l.matchId, status: 'draft' }),
    ]);
    // Drafts are not published.
    expect((await env.app.inject({ method: 'GET', url: `/api/public/federations/${env.federationId}` })).json().results).toEqual([]);
    await pushOk(env, env.tokens.referee, [mutation('match_reports', { id: l.matchId, status: 'submitted' })]);

    const res = await env.app.inject({ method: 'GET', url: `/api/public/federations/${env.federationId}` });
    expect(res.headers['cache-control']).toContain('public');
    const data = res.json();
    expect(data.results).toEqual([{ id: l.matchId, home_score: 1, away_score: 0 }]);
    expect(data.clubs.map((c: { name: string }) => c.name).sort()).toEqual(['Club A', 'Club B']);
    const text = res.body;
    expect(text).not.toContain(l.playersA[0]);
    expect(text).not.toContain(env.userIds.referee);
    expect(text).not.toContain('Alpha');
    expect(data.matches[0]).not.toHaveProperty('referee_user_id');

    expect((await env.app.inject({ method: 'GET', url: `/api/public/federations/${uuidv7()}` })).statusCode).toBe(404);
  });

  it('serves club logos but never player photos', async () => {
    const photo = mutation('media', { kind: 'player_photo', sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1 });
    await pushOk(env, env.tokens.admin, [photo]);
    await env.db.query(`update media set upload_status = 'done' where id = $1`, [photo.row_id]);
    expect((await env.app.inject({ method: 'GET', url: `/api/public/media/${photo.row_id}` })).statusCode).toBe(404);
  });
});
