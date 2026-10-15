/**
 * Team sheet (truppanmälan) checks, shared by the server and the app.
 * A club submits its lineup for a match; it must be a valid team sheet.
 */

export interface SheetLineup {
  player_id: string;
  shirt_number?: number | null;
  is_starter: boolean;
  is_captain: boolean;
  is_goalkeeper: boolean;
  deleted_at?: string | null;
}

export const MIN_STARTERS = 7;
export const MAX_STARTERS = 11;

export type SheetProblem =
  | 'too_few_starters'
  | 'too_many_starters'
  | 'no_goalkeeper'
  | 'several_goalkeepers'
  | 'no_captain'
  | 'missing_numbers'
  | 'duplicate_numbers'
  | 'suspended_player';

/** What stops this lineup from being submitted; empty when it is a valid team sheet. */
export function teamSheetProblems(lineups: SheetLineup[], suspendedPlayerIds: Set<string> = new Set()): SheetProblem[] {
  const rows = lineups.filter((l) => !l.deleted_at);
  const starters = rows.filter((l) => l.is_starter);
  const problems: SheetProblem[] = [];
  if (starters.length < MIN_STARTERS) problems.push('too_few_starters');
  if (starters.length > MAX_STARTERS) problems.push('too_many_starters');
  const keepers = starters.filter((l) => l.is_goalkeeper).length;
  if (keepers === 0) problems.push('no_goalkeeper');
  if (keepers > 1) problems.push('several_goalkeepers');
  if (!starters.some((l) => l.is_captain)) problems.push('no_captain');
  if (rows.some((l) => l.shirt_number == null)) problems.push('missing_numbers');
  const numbers = rows.map((l) => l.shirt_number).filter((n) => n != null);
  if (new Set(numbers).size !== numbers.length) problems.push('duplicate_numbers');
  if (rows.some((l) => suspendedPlayerIds.has(l.player_id))) problems.push('suspended_player');
  return problems;
}

/**
 * The sheet's id is derived from the match and the team, so two devices of
 * the same club write to the same row instead of creating two sheets.
 * (Both ids XOR-ed, stamped as a version 8 UUID.)
 */
export function teamSheetId(matchId: string, teamId: string): string {
  const a = matchId.replace(/-/g, '');
  const b = teamId.replace(/-/g, '');
  const hex = Array.from({ length: 32 }, (_, i) => (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16));
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
