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
    'id' | 'season_id' | 'name' | 'name_i18n' | 'age_group' | 'gender' | 'points_win' | 'points_draw' | 'points_loss'
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
