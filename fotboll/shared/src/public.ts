import type { Competition, Match } from './tables.js';

/**
 * What the public pages (no sign-in) receive for one federation: fixtures,
 * counted results, clubs and competitions. Deliberately no personal data:
 * no players, referees or users.
 */
export interface PublicData {
  federation: { id: string; name: string; country: string | null; default_locale: string };
  seasons: { id: string; name: string; starts_on: string; ends_on: string }[];
  competitions: Pick<
    Competition,
    | 'id'
    | 'season_id'
    | 'name'
    | 'name_i18n'
    | 'age_group'
    | 'gender'
    | 'points_win'
    | 'points_draw'
    | 'points_loss'
    | 'is_senior'
  >[];
  clubs: { id: string; name: string; short_name: string | null; city: string | null; logo_media_id: string | null }[];
  teams: { id: string; club_id: string; competition_id: string; name: string }[];
  venues: { id: string; name: string; address: string | null }[];
  matches: Pick<
    Match,
    'id' | 'competition_id' | 'round' | 'home_team_id' | 'away_team_id' | 'venue_id' | 'kickoff_at' | 'status'
  >[];
  /** Only matches whose report is submitted or approved. */
  results: { id: string; home_score: number; away_score: number }[];
}

/** A lineup row on the public match page. `name` is null for players under 18. */
export interface PublicLineup {
  team_id: string;
  shirt_number: number | null;
  name: string | null;
  is_starter: boolean;
  is_captain: boolean;
  is_goalkeeper: boolean;
}

/** GET /api/public/federations/:id/matches/:matchId */
export interface PublicMatchDetail {
  /** False for youth competitions: no lineups are published at all. */
  lineups_public: boolean;
  /** Teams whose lineup is published (sheet submitted, or the match report is in). */
  published_team_ids: string[];
  lineups: PublicLineup[];
}
