import { describe, expect, it } from 'vitest';
import { banFor, computeBans, isActiveBan, remainingMatches, type DisciplineEvent, type DisciplineMatch } from '../src/index.js';

const comp = 'c1';
const A = 'team-a';
const B = 'team-b';

/** Weekly matches A–B, alternating home team, starting 2 May. */
function fixtures(n: number, overrides: Partial<Record<number, Partial<DisciplineMatch>>> = {}): DisciplineMatch[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    competition_id: comp,
    home_team_id: i % 2 ? B : A,
    away_team_id: i % 2 ? A : B,
    kickoff_at: new Date(Date.UTC(2026, 4, 2 + i * 7, 14)).toISOString(),
    status: 'scheduled',
    ...overrides[i + 1],
  }));
}
const card = (match: string, player: string, type: DisciplineEvent['type'], team = A): DisciplineEvent => ({
  match_id: match,
  team_id: team,
  player_id: player,
  type,
});

describe('computeBans', () => {
  const base = { competitions: [{ id: comp }], teams: [{ id: A, competition_id: comp }, { id: B, competition_id: comp }] };

  it('bans for the next match after a red card and counts it served once played', () => {
    const matches = fixtures(3);
    const input = { ...base, matches, counted: new Set(['m1']), events: [card('m1', 'p', 'red')] };
    const [ban] = computeBans(input);
    expect(ban).toMatchObject({ reasons: ['red'], matches: 1, banned_match_ids: ['m2'], served: 0 });
    expect(banFor([ban], 'p', matches[1])).toBe(ban);
    expect(banFor([ban], 'p', matches[2])).toBeUndefined();
    expect(isActiveBan(ban)).toBe(true);

    const [served] = computeBans({ ...input, counted: new Set(['m1', 'm2']) });
    expect(served.served).toBe(1);
    expect(isActiveBan(served)).toBe(false);
  });

  it('ignores cards in reports that are not submitted yet', () => {
    expect(computeBans({ ...base, matches: fixtures(2), counted: new Set(), events: [card('m1', 'p', 'red')] })).toEqual([]);
  });

  it('skips cancelled and postponed matches when serving a ban', () => {
    const matches = fixtures(4, { 2: { status: 'postponed' }, 3: { status: 'cancelled' } });
    const [ban] = computeBans({ ...base, matches, counted: new Set(['m1']), events: [card('m1', 'p', 'red')] });
    expect(ban.banned_match_ids).toEqual(['m4']);
  });

  it('accumulates yellows across matches, ignoring the ones in a second-yellow match', () => {
    const matches = fixtures(5);
    const events = [
      card('m1', 'p', 'yellow'),
      card('m2', 'p', 'yellow'),
      card('m2', 'p', 'second_yellow'), // sent off: these two yellows do not accumulate
      card('m3', 'p', 'yellow'),
      card('m4', 'p', 'yellow'),
    ];
    const bans = computeBans({ ...base, matches, counted: new Set(['m1', 'm2', 'm3', 'm4']), events });
    expect(bans.map((b) => [b.source_match_id, b.reasons, b.banned_match_ids])).toEqual([
      ['m2', ['second_yellow'], ['m3']],
      ['m4', ['yellow_accumulation'], ['m5']],
    ]);
  });

  it('adds up a red card and accumulation in the same match', () => {
    const matches = fixtures(4);
    const events = [card('m1', 'p', 'yellow'), card('m1', 'p', 'red')];
    const [ban] = computeBans({
      ...base,
      competitions: [{ id: comp, yellow_card_limit: 1, red_card_ban: 2 }],
      matches,
      counted: new Set(['m1']),
      events,
    });
    expect(ban).toMatchObject({ reasons: ['red', 'yellow_accumulation'], matches: 3, banned_match_ids: ['m2', 'm3', 'm4'] });
    expect(remainingMatches(ban)).toBe(3);
  });

  it('respects rules turned off', () => {
    const events = [card('m1', 'p', 'yellow'), card('m1', 'p', 'red')];
    const bans = computeBans({
      ...base,
      competitions: [{ id: comp, yellow_card_limit: 0, red_card_ban: 0 }],
      matches: fixtures(2),
      counted: new Set(['m1']),
      events,
    });
    expect(bans).toEqual([]);
  });

  it('applies manual suspensions by matches (from a date) and by date range', () => {
    const matches = fixtures(4);
    const bans = computeBans({
      ...base,
      matches,
      counted: new Set(),
      events: [],
      squads: [{ team_id: A, player_id: 'p' }],
      suspensions: [
        { id: 's1', player_id: 'p', competition_id: comp, matches: 2, starts_on: '2026-05-08' },
        { id: 's2', player_id: 'q', starts_on: '2026-05-01', ends_on: '2026-05-10' },
        { id: 's3', player_id: 'r', competition_id: comp, matches: 1, starts_on: '2026-05-01' },
      ],
    });
    const byId = new Map(bans.map((b) => [b.suspension_id, b]));
    expect(byId.get('s1')!.banned_match_ids).toEqual(['m2', 'm3']);
    expect(banFor(bans, 'q', matches[0])).toBe(byId.get('s2'));
    expect(banFor(bans, 'q', matches[2])).toBeUndefined();
    expect(isActiveBan(byId.get('s2')!, '2026-05-11')).toBe(false);
    // Not in any squad yet: listed, but no matches assigned.
    expect(byId.get('s3')).toMatchObject({ team_id: null, banned_match_ids: [], served: 0 });
    expect(isActiveBan(byId.get('s3')!)).toBe(true);
  });
});
