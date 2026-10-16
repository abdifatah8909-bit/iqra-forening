import { describe, expect, it } from 'vitest';
import { ageOn, computeStandings, roundRobin, scoreFromEvents, uuidv7 } from '../src/index.js';

const rule = { points_win: 3, points_draw: 1, points_loss: 0 };

describe('scoreFromEvents', () => {
  it('counts goals, penalties and own goals, ignoring deleted events and cards', () => {
    const score = scoreFromEvents(
      [
        { team_id: 'H', type: 'goal' },
        { team_id: 'H', type: 'penalty_goal' },
        { team_id: 'H', type: 'own_goal' }, // counts for away
        { team_id: 'A', type: 'goal', deleted_at: '2026-01-01T00:00:00Z' },
        { team_id: 'A', type: 'yellow' },
      ],
      'H',
      'A',
    );
    expect(score).toEqual({ home: 2, away: 1 });
  });
});

describe('computeStandings', () => {
  const teams = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Bravo' },
    { id: 'c', name: 'Charlie' },
  ];

  it('awards points and sorts by points, goal difference and goals scored', () => {
    const table = computeStandings(
      teams,
      [
        { home_team_id: 'a', away_team_id: 'b', home_score: 2, away_score: 0 },
        { home_team_id: 'b', away_team_id: 'c', home_score: 1, away_score: 1 },
        { home_team_id: 'c', away_team_id: 'a', home_score: 3, away_score: 1 },
      ],
      rule,
    );
    expect(table.map((r) => [r.team_id, r.points, r.goal_diff, r.position])).toEqual([
      ['c', 4, 2, 1],
      ['a', 3, 0, 2],
      ['b', 1, -2, 3],
    ]);
    expect(table[0].form).toEqual(['D', 'W']);
  });

  it('gives teams that are completely level the same position', () => {
    const table = computeStandings(teams, [], rule);
    expect(table.map((r) => r.position)).toEqual([1, 1, 1]);
    expect(table.map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('ignores matches involving teams outside the competition', () => {
    const table = computeStandings(
      teams,
      [{ home_team_id: 'a', away_team_id: 'zzz', home_score: 5, away_score: 0 }],
      rule,
    );
    expect(table.every((r) => r.played === 0)).toBe(true);
  });
});

describe('roundRobin', () => {
  it('pairs every team exactly once per leg', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const fixtures = roundRobin(ids, true);
    expect(fixtures).toHaveLength(20);
    const pairs = new Set(fixtures.map((f) => `${f.home_team_id}-${f.away_team_id}`));
    expect(pairs.size).toBe(20); // each ordered pairing exactly once
    // No team plays twice in the same round.
    const byRound = new Map<number, string[]>();
    for (const f of fixtures) {
      const list = byRound.get(f.round) ?? [];
      list.push(f.home_team_id, f.away_team_id);
      byRound.set(f.round, list);
    }
    for (const list of byRound.values()) expect(new Set(list).size).toBe(list.length);
    expect(byRound.size).toBe(10);
  });
});

describe('ageOn', () => {
  it('handles birthdays not yet reached this year', () => {
    expect(ageOn('2010-06-15', new Date('2026-06-14T12:00:00Z'))).toBe(15);
    expect(ageOn('2010-06-15', new Date('2026-06-15T12:00:00Z'))).toBe(16);
  });
});

describe('uuidv7', () => {
  it('produces valid, time-ordered v7 UUIDs', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
