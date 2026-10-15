import { z } from 'zod';

/**
 * Row shapes for every table that is replicated to devices.
 *
 * Each schema describes the *client-writable* columns of a row. The sync
 * metadata (federation_id, created_at, updated_at, updated_by, deleted_at,
 * server_seq) is owned by the server and stripped from incoming patches.
 */

const uuid = z.string().uuid();
const optUuid = uuid.nullable().optional();
const text = (max = 200) => z.string().trim().min(1).max(max);
const optText = (max = 200) => z.string().trim().max(max).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.string().datetime({ offset: true });

export const ROLES = ['federation_admin', 'club_admin', 'referee'] as const;
export type Role = (typeof ROLES)[number];

export const LOCALES = ['so', 'en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const MATCH_STATUSES = ['scheduled', 'played', 'postponed', 'cancelled'] as const;
export const REPORT_STATUSES = ['draft', 'submitted', 'approved', 'reopened'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REGISTRATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const TRANSFER_STATUSES = ['pending_club', 'pending_federation', 'approved', 'rejected', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
/** Transfers in these states are still open; a player can have only one. */
export const OPEN_TRANSFER_STATUSES: TransferStatus[] = ['pending_club', 'pending_federation'];
export const EVENT_TYPES = [
  'goal',
  'penalty_goal',
  'own_goal',
  'yellow',
  'second_yellow',
  'red',
  'sub',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const schemas = {
  federations: z.object({
    id: uuid,
    name: text(),
    country: optText(80),
    default_locale: z.enum(LOCALES),
  }),
  clubs: z.object({
    id: uuid,
    name: text(),
    short_name: optText(20),
    city: optText(100),
    logo_media_id: optUuid,
    status: z.enum(['active', 'inactive']),
  }),
  players: z.object({
    id: uuid,
    club_id: optUuid,
    first_name: text(80),
    last_name: text(80),
    /** Name in another script, e.g. Arabic, shown alongside the Latin name. */
    name_alt: optText(160),
    birth_date: isoDate,
    gender: z.enum(['male', 'female']),
    photo_media_id: optUuid,
    /** Guardian consent for publishing a photo of a minor (GDPR art. 8). */
    photo_consent: z.boolean(),
    license_no: optText(40),
    status: z.enum(['active', 'inactive']),
  }),
  registrations: z.object({
    id: uuid,
    player_id: uuid,
    club_id: uuid,
    season_id: uuid,
    status: z.enum(REGISTRATION_STATUSES),
    note: optText(500),
  }),
  media: z.object({
    id: uuid,
    kind: z.enum(['player_photo', 'club_logo']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mime: z.enum(['image/webp', 'image/jpeg', 'image/png']),
    width: z.number().int().positive().max(4000),
    height: z.number().int().positive().max(4000),
  }),
  seasons: z.object({
    id: uuid,
    name: text(80),
    starts_on: isoDate,
    ends_on: isoDate,
  }),
  competitions: z.object({
    id: uuid,
    season_id: uuid,
    name: text(),
    name_i18n: z.record(z.enum(LOCALES), z.string().max(200)).nullable().optional(),
    age_group: optText(20),
    gender: z.enum(['male', 'female', 'mixed']),
    points_win: z.number().int().min(0).max(10),
    points_draw: z.number().int().min(0).max(10),
    points_loss: z.number().int().min(0).max(10),
    /** Yellow cards that give a one-match ban (0 = no accumulation). */
    yellow_card_limit: z.number().int().min(0).max(20),
    /** Matches banned for a red card / for a second yellow in one match. */
    red_card_ban: z.number().int().min(0).max(20),
    second_yellow_ban: z.number().int().min(0).max(20),
  }),
  teams: z.object({
    id: uuid,
    club_id: uuid,
    competition_id: uuid,
    name: text(),
  }),
  squad_members: z.object({
    id: uuid,
    team_id: uuid,
    player_id: uuid,
    shirt_number: z.number().int().min(0).max(99).nullable().optional(),
    position: z.enum(['GK', 'DF', 'MF', 'FW']).nullable().optional(),
  }),
  venues: z.object({
    id: uuid,
    name: text(),
    address: optText(200),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  }),
  matches: z.object({
    id: uuid,
    competition_id: uuid,
    round: z.number().int().min(1).max(200),
    home_team_id: uuid,
    away_team_id: uuid,
    venue_id: optUuid,
    kickoff_at: isoDateTime,
    status: z.enum(MATCH_STATUSES),
    referee_user_id: optUuid,
  }),
  match_reports: z.object({
    /** Same value as the match id: one report per match. */
    id: uuid,
    status: z.enum(REPORT_STATUSES),
    home_score: z.number().int().min(0).max(99),
    away_score: z.number().int().min(0).max(99),
    notes: optText(2000),
  }),
  match_lineups: z.object({
    id: uuid,
    match_id: uuid,
    team_id: uuid,
    player_id: uuid,
    shirt_number: z.number().int().min(0).max(99).nullable().optional(),
    is_starter: z.boolean(),
    is_captain: z.boolean(),
    is_goalkeeper: z.boolean(),
  }),
  match_events: z.object({
    id: uuid,
    match_id: uuid,
    team_id: uuid,
    player_id: optUuid,
    /** For substitutions: the player coming off. */
    related_player_id: optUuid,
    type: z.enum(EVENT_TYPES),
    minute: z.number().int().min(0).max(130),
    added_time: z.number().int().min(0).max(30).nullable().optional(),
  }),
  /** A club's submitted lineup for a match (truppanmälan); one per team and match. */
  team_sheets: z.object({
    id: uuid,
    match_id: uuid,
    team_id: uuid,
    status: z.enum(['draft', 'submitted']),
  }),
  /**
   * Transfer to another club. The receiving club applies; the current club
   * (`from_club_id`, set by the server) releases; the federation approves.
   */
  transfers: z.object({
    id: uuid,
    player_id: uuid,
    to_club_id: uuid,
    status: z.enum(TRANSFER_STATUSES),
    note: optText(500),
    response_note: optText(500),
  }),
  /**
   * Manual suspension decided by the federation, either a number of matches
   * in one competition (from `starts_on`) or every match in a date range.
   * Automatic bans from cards are derived, not stored (see discipline.ts).
   */
  suspensions: z.object({
    id: uuid,
    player_id: uuid,
    competition_id: optUuid,
    matches: z.number().int().min(1).max(50).nullable().optional(),
    starts_on: isoDate,
    ends_on: isoDate.nullable().optional(),
    reason: optText(500),
  }),
} as const;

export type WritableTable = keyof typeof schemas;
export const WRITABLE_TABLES = Object.keys(schemas) as WritableTable[];

/** Read-only projection of users (id + display name), so referees can be shown by name. */
export const READONLY_TABLES = ['user_profiles'] as const;

export type SyncTable = WritableTable | (typeof READONLY_TABLES)[number];
export const SYNC_TABLES: SyncTable[] = [...WRITABLE_TABLES, ...READONLY_TABLES];

export interface SyncMeta {
  federation_id: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
  server_seq: number;
}

/** Columns the server owns; never accepted from clients. */
export const SERVER_COLUMNS = [
  'federation_id',
  'created_at',
  'updated_at',
  'updated_by',
  'deleted_at',
  'server_seq',
] as const;

type Inferred<T extends WritableTable> = z.infer<(typeof schemas)[T]>;

export type Federation = Inferred<'federations'> & SyncMeta;
export type Club = Inferred<'clubs'> & SyncMeta;
export type Player = Inferred<'players'> & SyncMeta;
export type Registration = Inferred<'registrations'> &
  SyncMeta & { decided_by: string | null; decided_at: string | null };
export type Media = Inferred<'media'> & SyncMeta & { upload_status: 'pending' | 'done' };
export type Season = Inferred<'seasons'> & SyncMeta;
export type Competition = Inferred<'competitions'> & SyncMeta;
export type Team = Inferred<'teams'> & SyncMeta;
export type SquadMember = Inferred<'squad_members'> & SyncMeta;
export type Venue = Inferred<'venues'> & SyncMeta;
export type Match = Inferred<'matches'> & SyncMeta;
export type MatchReport = Inferred<'match_reports'> &
  SyncMeta & {
    submitted_at: string | null;
    submitted_by: string | null;
    approved_at: string | null;
    approved_by: string | null;
  };
/** `player_name` is set by the server so everyone who sees the lineup can read it. */
export type MatchLineup = Inferred<'match_lineups'> & SyncMeta & { player_name?: string | null };
export type TeamSheet = Inferred<'team_sheets'> &
  SyncMeta & { submitted_at: string | null; submitted_by: string | null };
export type MatchEvent = Inferred<'match_events'> & SyncMeta & { recorded_by: string | null };
export type Suspension = Inferred<'suspensions'> & SyncMeta;
export type Transfer = Inferred<'transfers'> &
  SyncMeta & {
    from_club_id: string | null;
    requested_by: string | null;
    released_by: string | null;
    released_at: string | null;
    decided_by: string | null;
    decided_at: string | null;
  };
export type UserProfile = { id: string; display_name: string; is_referee: boolean } & SyncMeta;

export interface RowTypes {
  federations: Federation;
  clubs: Club;
  players: Player;
  registrations: Registration;
  media: Media;
  seasons: Season;
  competitions: Competition;
  teams: Team;
  squad_members: SquadMember;
  venues: Venue;
  matches: Match;
  match_reports: MatchReport;
  match_lineups: MatchLineup;
  match_events: MatchEvent;
  suspensions: Suspension;
  transfers: Transfer;
  team_sheets: TeamSheet;
  user_profiles: UserProfile;
}

/** A report in one of these states is locked for everyone but the federation admin. */
export const LOCKED_REPORT_STATUSES: ReportStatus[] = ['submitted', 'approved'];
