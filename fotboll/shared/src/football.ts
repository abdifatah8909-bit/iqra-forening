import type { EventType } from './tables.js';

export interface ScoreEvent {
  team_id: string;
  type: EventType;
  deleted_at?: string | null;
}

/**
 * The score is derived from goal events, never typed in by hand.
 * An own goal is recorded on the team of the player who scored it and
 * counts for the opponent.
 */
export function scoreFromEvents(
  events: ScoreEvent[],
  homeTeamId: string,
  awayTeamId: string,
): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const e of events) {
    if (e.deleted_at) continue;
    if (e.type === 'goal' || e.type === 'penalty_goal') {
      if (e.team_id === homeTeamId) home++;
      else if (e.team_id === awayTeamId) away++;
    } else if (e.type === 'own_goal') {
      if (e.team_id === homeTeamId) away++;
      else if (e.team_id === awayTeamId) home++;
    }
  }
  return { home, away };
}

export interface StandingsTeam {
  id: string;
  name: string;
}

export interface StandingsMatch {
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
}

export interface PointsRule {
  points_win: number;
  points_draw: number;
  points_loss: number;
}

export interface StandingsRow {
  team_id: string;
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  goal_diff: number;
  points: number;
  /** Last five results, oldest first. */
  form: ('W' | 'D' | 'L')[];
  position: number;
}

/**
 * League table from counted results. Pass only matches whose report is
 * submitted or approved, in chronological order (the order drives `form`).
 * Tie-breakers: points, goal difference, goals scored, wins, then name.
 */
export function computeStandings(
  teams: StandingsTeam[],
  matches: StandingsMatch[],
  rule: PointsRule,
): StandingsRow[] {
  const rows = new Map<string, StandingsRow>();
  for (const t of teams) {
    rows.set(t.id, {
      team_id: t.id,
      name: t.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goals_for: 0,
      goals_against: 0,
      goal_diff: 0,
      points: 0,
      form: [],
      position: 0,
    });
  }

  const apply = (row: StandingsRow, gf: number, ga: number) => {
    row.played++;
    row.goals_for += gf;
    row.goals_against += ga;
    let result: 'W' | 'D' | 'L';
    if (gf > ga) {
      row.won++;
      row.points += rule.points_win;
      result = 'W';
    } else if (gf === ga) {
      row.drawn++;
      row.points += rule.points_draw;
      result = 'D';
    } else {
      row.lost++;
      row.points += rule.points_loss;
      result = 'L';
    }
    row.form = [...row.form, result].slice(-5);
  };

  for (const m of matches) {
    const home = rows.get(m.home_team_id);
    const away = rows.get(m.away_team_id);
    // A match against a team that is not in this competition is ignored.
    if (!home || !away) continue;
    apply(home, m.home_score, m.away_score);
    apply(away, m.away_score, m.home_score);
  }

  const sorted = [...rows.values()]
    .map((r) => ({ ...r, goal_diff: r.goals_for - r.goals_against }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goal_diff - a.goal_diff ||
        b.goals_for - a.goals_for ||
        b.won - a.won ||
        a.name.localeCompare(b.name),
    );

  // Teams that are level on every numeric criterion share a position.
  sorted.forEach((row, i) => {
    const prev = sorted[i - 1];
    const level =
      prev &&
      prev.points === row.points &&
      prev.goal_diff === row.goal_diff &&
      prev.goals_for === row.goals_for &&
      prev.won === row.won;
    row.position = level ? prev.position : i + 1;
  });
  return sorted;
}

export interface Fixture {
  round: number;
  home_team_id: string;
  away_team_id: string;
}

/**
 * Round-robin schedule using the circle method. With `doubleRound` every
 * pairing is played twice with home and away swapped.
 */
export function roundRobin(teamIds: string[], doubleRound = false): Fixture[] {
  if (teamIds.length < 2) return [];
  const ids: (string | null)[] = [...teamIds];
  if (ids.length % 2 === 1) ids.push(null); // bye
  const n = ids.length;
  const rounds = n - 1;
  const fixtures: Fixture[] = [];
  const rotating = ids.slice(1);

  for (let r = 0; r < rounds; r++) {
    const lineup = [ids[0], ...rotating];
    for (let i = 0; i < n / 2; i++) {
      const a = lineup[i];
      const b = lineup[n - 1 - i];
      if (a === null || b === null) continue;
      // Alternate home advantage so no team stays at home all season.
      const swap = (r + i) % 2 === 1;
      fixtures.push({
        round: r + 1,
        home_team_id: swap ? b : a,
        away_team_id: swap ? a : b,
      });
    }
    rotating.unshift(rotating.pop()!);
  }

  if (doubleRound) {
    const second = fixtures.map((f) => ({
      round: f.round + rounds,
      home_team_id: f.away_team_id,
      away_team_id: f.home_team_id,
    }));
    fixtures.push(...second);
  }
  return fixtures;
}

/** Age in whole years on a given date (YYYY-MM-DD). */
export function ageOn(birthDate: string, on: Date = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = on.getUTCFullYear() - y;
  const month = on.getUTCMonth() + 1;
  if (month < m || (month === m && on.getUTCDate() < d)) age--;
  return age;
}

export const isMinor = (birthDate: string, on?: Date) => ageOn(birthDate, on) < 18;
