import type { EventType } from './tables.js';

/**
 * Suspensions (avstängningar), derived on every device from the match
 * reports, like the league table. Nothing automatic is stored: a red card in
 * a submitted report is enough for every phone to know the player is out of
 * the team's next match, even offline.
 *
 * Rules, per competition:
 *  - red card: `red_card_ban` matches (default 1)
 *  - second yellow: `second_yellow_ban` matches (default 1); the two yellows
 *    in that match do not count towards accumulation
 *  - every `yellow_card_limit` yellows (default 3, 0 = off): 1 match
 *
 * A ban is served in the team's next matches in the same competition.
 * Cancelled and postponed matches do not count. Federation admins can add
 * manual suspensions: a number of matches in one competition, or a date
 * range that applies everywhere.
 */

export interface CardRules {
  yellow_card_limit?: number | null;
  red_card_ban?: number | null;
  second_yellow_ban?: number | null;
}

export const DEFAULT_CARD_RULES = { yellow_card_limit: 3, red_card_ban: 1, second_yellow_ban: 1 };

export function cardRules(c: CardRules | undefined) {
  return {
    yellow_card_limit: c?.yellow_card_limit ?? DEFAULT_CARD_RULES.yellow_card_limit,
    red_card_ban: c?.red_card_ban ?? DEFAULT_CARD_RULES.red_card_ban,
    second_yellow_ban: c?.second_yellow_ban ?? DEFAULT_CARD_RULES.second_yellow_ban,
  };
}

export interface DisciplineMatch {
  id: string;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
  status: string;
  deleted_at?: string | null;
}

export interface DisciplineEvent {
  match_id: string;
  team_id: string;
  player_id?: string | null;
  type: EventType;
  deleted_at?: string | null;
}

export interface ManualSuspension {
  id: string;
  player_id: string;
  competition_id?: string | null;
  matches?: number | null;
  starts_on: string;
  ends_on?: string | null;
  reason?: string | null;
  deleted_at?: string | null;
}

export type BanReason = 'red' | 'second_yellow' | 'yellow_accumulation' | 'manual';

export interface Ban {
  /** Stable key for lists. */
  key: string;
  player_id: string;
  team_id: string | null;
  competition_id: string | null;
  reasons: BanReason[];
  /** The match where the cards were shown (automatic bans). */
  source_match_id: string | null;
  /** The manual suspension row (manual bans). */
  suspension_id: string | null;
  note: string | null;
  /** Match-count bans: how many matches, which ones, and how many are already played. */
  matches: number | null;
  banned_match_ids: string[];
  served: number;
  /** Date-range bans (inclusive, YYYY-MM-DD). */
  starts_on: string | null;
  ends_on: string | null;
}

export interface DisciplineInput {
  competitions: ({ id: string } & CardRules)[];
  teams: { id: string; competition_id: string; deleted_at?: string | null }[];
  matches: DisciplineMatch[];
  /** Ids of matches whose report is submitted or approved. Only these count. */
  counted: Set<string>;
  events: DisciplineEvent[];
  suspensions?: ManualSuspension[];
  squads?: { team_id: string; player_id: string; deleted_at?: string | null }[];
}

const NOT_PLAYED = new Set(['cancelled', 'postponed']);
const byKickoff = (a: DisciplineMatch, b: DisciplineMatch) =>
  a.kickoff_at.localeCompare(b.kickoff_at) || a.id.localeCompare(b.id);
const dateOf = (iso: string) => iso.slice(0, 10);

export function computeBans(input: DisciplineInput): Ban[] {
  const rules = new Map(input.competitions.map((c) => [c.id, cardRules(c)]));
  const matches = input.matches.filter((m) => !m.deleted_at).sort(byKickoff);
  const matchById = new Map(matches.map((m) => [m.id, m]));

  // Each team's fixtures in kickoff order; a team belongs to one competition.
  const fixtures = new Map<string, DisciplineMatch[]>();
  for (const m of matches) {
    if (NOT_PLAYED.has(m.status)) continue;
    for (const team of [m.home_team_id, m.away_team_id]) {
      if (!fixtures.has(team)) fixtures.set(team, []);
      fixtures.get(team)!.push(m);
    }
  }
  const isPlayed = (m: DisciplineMatch) => input.counted.has(m.id) || m.status === 'played';

  const bans: Ban[] = [];
  const addMatchBan = (
    base: Omit<Ban, 'banned_match_ids' | 'served' | 'starts_on' | 'ends_on'>,
    upcoming: DisciplineMatch[],
  ) => {
    const banned = upcoming.slice(0, base.matches ?? 0);
    bans.push({
      ...base,
      banned_match_ids: banned.map((m) => m.id),
      served: banned.filter(isPlayed).length,
      starts_on: null,
      ends_on: null,
    });
  };

  // ── Automatic bans from cards in counted reports ──
  const perMatchPlayer = new Map<string, DisciplineEvent[]>();
  for (const e of input.events) {
    if (e.deleted_at || !e.player_id || !input.counted.has(e.match_id) || !matchById.has(e.match_id)) continue;
    if (e.type !== 'yellow' && e.type !== 'second_yellow' && e.type !== 'red') continue;
    const key = `${e.player_id}|${e.match_id}`;
    if (!perMatchPlayer.has(key)) perMatchPlayer.set(key, []);
    perMatchPlayer.get(key)!.push(e);
  }
  // Walk each player's carded matches in kickoff order, per competition, so yellows accumulate correctly.
  const grouped = new Map<string, { match: DisciplineMatch; events: DisciplineEvent[] }[]>();
  for (const [key, events] of perMatchPlayer) {
    const [playerId, matchId] = key.split('|');
    const match = matchById.get(matchId)!;
    const g = `${playerId}|${match.competition_id}`;
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push({ match, events });
  }
  for (const [g, list] of grouped) {
    const [playerId, competitionId] = g.split('|');
    const r = cardRules(rules.get(competitionId));
    let yellows = 0;
    for (const { match, events } of list.sort((a, b) => byKickoff(a.match, b.match))) {
      const count = (t: EventType) => events.filter((e) => e.type === t).length;
      const reasons: BanReason[] = [];
      let length = 0;
      if (count('red') && r.red_card_ban > 0) {
        reasons.push('red');
        length += r.red_card_ban;
      }
      if (count('second_yellow')) {
        if (r.second_yellow_ban > 0) {
          reasons.push('second_yellow');
          length += r.second_yellow_ban;
        }
      } else if (r.yellow_card_limit > 0) {
        const before = Math.floor(yellows / r.yellow_card_limit);
        yellows += count('yellow');
        const reached = Math.floor(yellows / r.yellow_card_limit) - before;
        if (reached > 0) {
          reasons.push('yellow_accumulation');
          length += reached;
        }
      }
      if (!length) continue;
      const teamId = events[0].team_id;
      const teamFixtures = fixtures.get(teamId) ?? [];
      addMatchBan(
        {
          key: `auto:${match.id}:${playerId}`,
          player_id: playerId,
          team_id: teamId,
          competition_id: competitionId,
          reasons,
          source_match_id: match.id,
          suspension_id: null,
          note: null,
          matches: length,
        },
        teamFixtures.filter((m) => byKickoff(m, match) > 0),
      );
    }
  }

  // ── Manual suspensions ──
  const teamCompetition = new Map(input.teams.filter((t) => !t.deleted_at).map((t) => [t.id, t.competition_id]));
  for (const s of input.suspensions ?? []) {
    if (s.deleted_at) continue;
    const base = {
      player_id: s.player_id,
      competition_id: s.competition_id ?? null,
      reasons: ['manual' as const],
      source_match_id: null,
      suspension_id: s.id,
      note: s.reason ?? null,
    };
    if (s.ends_on) {
      bans.push({
        ...base,
        key: `manual:${s.id}`,
        team_id: null,
        matches: null,
        banned_match_ids: [],
        served: 0,
        starts_on: s.starts_on,
        ends_on: s.ends_on,
      });
      continue;
    }
    const teams = (input.squads ?? [])
      .filter((sq) => !sq.deleted_at && sq.player_id === s.player_id && teamCompetition.get(sq.team_id) === s.competition_id)
      .map((sq) => sq.team_id);
    if (!teams.length) {
      // Not in a squad yet: the ban waits until the player joins a team in the competition.
      addMatchBan({ ...base, key: `manual:${s.id}`, team_id: null, matches: s.matches ?? 0 }, []);
      continue;
    }
    for (const teamId of [...new Set(teams)]) {
      addMatchBan(
        { ...base, key: `manual:${s.id}:${teamId}`, team_id: teamId, matches: s.matches ?? 0 },
        (fixtures.get(teamId) ?? []).filter((m) => dateOf(m.kickoff_at) >= s.starts_on),
      );
    }
  }
  return bans;
}

/** The ban that keeps this player out of this match, if any. */
export function banFor(bans: Ban[], playerId: string, match: { id: string; kickoff_at: string }): Ban | undefined {
  const day = dateOf(match.kickoff_at);
  return bans.find(
    (b) =>
      b.player_id === playerId &&
      (b.banned_match_ids.includes(match.id) || (b.ends_on !== null && b.starts_on! <= day && day <= b.ends_on)),
  );
}

/** Still to be served: match bans with matches left, or date bans that have not ended. */
export function isActiveBan(b: Ban, today: string = new Date().toISOString().slice(0, 10)): boolean {
  if (b.ends_on !== null) return b.ends_on >= today;
  return b.served < (b.matches ?? 0);
}

/** Matches still to sit out (for match bans). */
export const remainingMatches = (b: Ban) => Math.max(0, (b.matches ?? 0) - b.served);
