import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mutation, MutationResult, PullResponse } from '@fotboll/shared';
import { league, setup, teardown, type TestEnv } from '../../server/test/helpers';
import { ApiError } from '../src/api';
import { LocalDb, useDatabase } from '../src/db';
import { remove, save } from '../src/mutate';
import { SyncEngine, type Transport } from '../src/sync';

/**
 * End-to-end: the real client sync engine against the real server, with
 * each "device" getting its own IndexedDB (fake-indexeddb in Node).
 */

let env: TestEnv;
let l: Awaited<ReturnType<typeof league>>;

beforeAll(async () => {
  env = await setup();
  l = await league(env);
});
afterAll(() => teardown(env));

function device(token: string, name: string) {
  const local = new LocalDb(name);
  let online = true;
  const transport: Transport = {
    async push(mutations: Mutation[]) {
      if (!online) throw new ApiError(0, 'network');
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: { authorization: `Bearer ${token}` },
        payload: { mutations },
      });
      return res.json().results as MutationResult[];
    },
    async pull(since, scope) {
      if (!online) throw new ApiError(0, 'network');
      const res = await env.app.inject({
        method: 'GET',
        url: `/api/sync/pull?since=${since}${scope ? `&scope=${scope}` : ''}`,
        headers: { authorization: `Bearer ${token}` },
      });
      return res.json() as PullResponse;
    },
  };
  const engine = new SyncEngine(transport);
  return {
    db: local,
    engine,
    setOnline: (v: boolean) => (online = v),
    /** Make this device the active one (the app has one database per device). */
    use: async () => {
      useDatabase(local);
      await local.setMeta('federation_id', env.federationId);
    },
  };
}

describe('client sync engine', () => {
  it('records a match offline, syncs it later and adopts server-derived results', async () => {
    const ref = device(env.tokens.referee, 'referee-phone');
    await ref.use();
    await ref.engine.syncNow();
    expect(ref.engine.state.status).toBe('idle');
    expect(await ref.db.data('players').count()).toBe(6);
    expect(await ref.db.data('matches').get(l.matchId)).toBeTruthy();

    // No network at the pitch.
    ref.setOnline(false);
    for (const [team, players] of [[l.teamA, l.playersA], [l.teamB, l.playersB]] as const) {
      for (const player of players) {
        await save('match_lineups', {
          match_id: l.matchId,
          team_id: team,
          player_id: player,
          is_starter: true,
          is_captain: false,
          is_goalkeeper: false,
        });
      }
    }
    await save('match_events', { match_id: l.matchId, team_id: l.teamA, player_id: l.playersA[0], type: 'goal', minute: 12 });
    await save('match_events', { match_id: l.matchId, team_id: l.teamA, player_id: l.playersA[1], type: 'goal', minute: 40 });
    const wrong = await save('match_events', { match_id: l.matchId, team_id: l.teamB, player_id: l.playersB[0], type: 'goal', minute: 60 });
    await remove('match_events', wrong); // entered by mistake
    await save('match_reports', { id: l.matchId, status: 'submitted', home_score: 7, away_score: 7 });

    await ref.engine.syncNow();
    expect(ref.engine.state.status).toBe('offline');
    expect(await ref.db.outbox.count()).toBe(11);
    expect(await ref.db.data('match_events').count()).toBe(2); // visible locally while offline

    // Back online.
    ref.setOnline(true);
    await ref.engine.syncNow();
    expect(ref.engine.state.status).toBe('idle');
    expect(await ref.db.outbox.count()).toBe(0);
    expect(await ref.db.sync_errors.count()).toBe(0);
    const report = await ref.db.data('match_reports').get(l.matchId);
    expect(report).toMatchObject({ status: 'submitted', home_score: 2, away_score: 0 });
    expect((await ref.db.data('matches').get(l.matchId))?.status).toBe('played');

    // The report is locked now: a late edit is rejected and rolled back locally.
    await save('match_events', { match_id: l.matchId, team_id: l.teamB, player_id: l.playersB[1], type: 'goal', minute: 90 });
    await ref.engine.syncNow();
    expect(await ref.db.data('match_events').count()).toBe(2);
    const [error] = await ref.db.sync_errors.toArray();
    expect(error.reason).toBe('report_locked');
  });

  it('keeps unsynced local edits on top of newer server data', async () => {
    const club = device(env.tokens.clubA, 'club-phone');
    const admin = device(env.tokens.admin, 'admin-laptop');
    const playerId = l.playersA[2];

    await club.use();
    await club.engine.syncNow();
    club.setOnline(false);
    await save('players', { id: playerId, name_alt: 'محمد' });

    // Meanwhile the federation corrects the licence number.
    await admin.use();
    await admin.engine.syncNow();
    await save('players', { id: playerId, license_no: 'LIC-42' });
    await admin.engine.syncNow();

    // The club phone pulls first (rebase), then pushes: both edits survive.
    await club.use();
    club.setOnline(true);
    await club.engine.pull();
    expect(await club.db.data('players').get(playerId)).toMatchObject({ name_alt: 'محمد', license_no: 'LIC-42' });
    await club.engine.syncNow();

    await admin.use();
    await admin.engine.syncNow();
    expect(await admin.db.data('players').get(playerId)).toMatchObject({ name_alt: 'محمد', license_no: 'LIC-42' });
  });
});
