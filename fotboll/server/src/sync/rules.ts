import {
  initialTransferStatus,
  isMinor,
  LOCKED_REPORT_STATUSES,
  OPEN_TRANSFER_STATUSES,
  scoreFromEvents,
  teamSheetProblems,
  transferActions,
  type ReportStatus,
  type TransferStatus,
  type WritableTable,
} from '@fotboll/shared';
import type { UserContext } from '../auth.js';
import type { Tx } from '../db.js';
import { bansForMatch, playerBanForMatch } from './discipline.js';

type Row = Record<string, any>;

export interface RuleArgs {
  tx: Tx;
  ctx: UserContext;
  /** Current row, or null when inserting. */
  before: Row | null;
  /** Row as it would be after the mutation (equals `before` for deletes). */
  after: Row;
  op: 'insert' | 'update' | 'delete';
}

export interface TableRules {
  /** Returns a rejection reason, or null when allowed. */
  check(a: RuleArgs): Promise<string | null>;
  /** Server-owned column values to write alongside the client's fields. */
  serverFields?(a: RuleArgs): Promise<Row>;
  /** Side effects on other rows, run after the write in the same transaction. */
  afterWrite?(a: RuleArgs): Promise<void>;
}

/** Defaults for columns a client may omit on insert. */
export const INSERT_DEFAULTS: Partial<Record<WritableTable, Row>> = {
  clubs: { status: 'active', short_name: null, city: null, logo_media_id: null },
  players: {
    status: 'active',
    photo_consent: false,
    club_id: null,
    name_alt: null,
    photo_media_id: null,
    license_no: null,
  },
  registrations: { status: 'pending', note: null },
  competitions: {
    points_win: 3,
    points_draw: 1,
    points_loss: 0,
    gender: 'male',
    age_group: null,
    name_i18n: null,
    yellow_card_limit: 3,
    red_card_ban: 1,
    second_yellow_ban: 1,
    is_senior: true,
  },
  squad_members: { shirt_number: null, position: null },
  venues: { address: null, lat: null, lng: null },
  matches: { status: 'scheduled', venue_id: null, referee_user_id: null },
  match_reports: { status: 'draft', home_score: 0, away_score: 0, notes: null },
  match_lineups: { is_starter: true, is_captain: false, is_goalkeeper: false, shirt_number: null },
  match_events: { player_id: null, related_player_id: null, added_time: null },
  suspensions: { competition_id: null, matches: null, ends_on: null, reason: null },
  transfers: { status: 'pending_club', note: null, response_note: null },
  team_sheets: { status: 'draft' },
};

/**
 * Foreign keys checked against the caller's federation before writing, so a
 * client can never link to another federation's rows.
 */
export const REFERENCES: Partial<Record<WritableTable, Record<string, string>>> = {
  clubs: { logo_media_id: 'media' },
  players: { club_id: 'clubs', photo_media_id: 'media' },
  registrations: { player_id: 'players', club_id: 'clubs', season_id: 'seasons' },
  competitions: { season_id: 'seasons' },
  teams: { club_id: 'clubs', competition_id: 'competitions' },
  squad_members: { team_id: 'teams', player_id: 'players' },
  matches: {
    competition_id: 'competitions',
    home_team_id: 'teams',
    away_team_id: 'teams',
    venue_id: 'venues',
    referee_user_id: 'users',
  },
  match_reports: { id: 'matches' },
  match_lineups: { match_id: 'matches', team_id: 'teams', player_id: 'players' },
  match_events: { match_id: 'matches', team_id: 'teams', player_id: 'players', related_player_id: 'players' },
  suspensions: { player_id: 'players', competition_id: 'competitions' },
  transfers: { player_id: 'players', to_club_id: 'clubs' },
  team_sheets: { match_id: 'matches', team_id: 'teams' },
};

const FORBIDDEN = 'forbidden';

async function one(tx: Tx, sql: string, params: unknown[]): Promise<Row | undefined> {
  return (await tx.query(sql, params)).rows[0];
}

const fedAdminOnly: TableRules = {
  check: async ({ ctx }) => (ctx.isFedAdmin ? null : FORBIDDEN),
};

interface MatchInfo {
  match: Row;
  reportStatus: ReportStatus | null;
}

async function matchInfo(tx: Tx, matchId: string): Promise<MatchInfo> {
  const match = (await one(tx, 'select * from matches where id = $1', [matchId]))!;
  const report = await one(tx, 'select status from match_reports where id = $1', [matchId]);
  return { match, reportStatus: (report?.status as ReportStatus) ?? null };
}

const isLocked = (s: ReportStatus | null) => s !== null && LOCKED_REPORT_STATUSES.includes(s);

async function teamClub(tx: Tx, teamId: string): Promise<string> {
  return (await one(tx, 'select club_id from teams where id = $1', [teamId]))!.club_id;
}

export const RULES: Record<WritableTable, TableRules> = {
  federations: {
    check: async ({ ctx, op, after }) =>
      ctx.isFedAdmin && op === 'update' && after.id === ctx.federationId ? null : FORBIDDEN,
  },

  seasons: fedAdminOnly,
  competitions: fedAdminOnly,
  venues: fedAdminOnly,
  teams: fedAdminOnly,

  matches: {
    async check({ tx, ctx, after }) {
      if (!ctx.isFedAdmin) return FORBIDDEN;
      const teams = await tx.query(
        'select id from teams where id = any($1) and competition_id = $2',
        [[after.home_team_id, after.away_team_id], after.competition_id],
      );
      if (teams.rowCount !== 2) return 'team_not_in_competition';
      if (after.referee_user_id) {
        const ref = await one(
          tx,
          `select 1 from role_assignments where user_id = $1 and role = 'referee'`,
          [after.referee_user_id],
        );
        if (!ref) return 'not_a_referee';
      }
      return null;
    },
  },

  clubs: {
    async check({ ctx, op, before, after }) {
      if (ctx.isFedAdmin) return null;
      // Club admins may edit their own club's details, but not create, delete or deactivate it.
      if (op !== 'update' || !ctx.clubIds.includes(after.id)) return FORBIDDEN;
      return before!.status === after.status ? null : FORBIDDEN;
    },
  },

  media: {
    async check({ ctx, op }) {
      if (op === 'insert') return ctx.isFedAdmin || ctx.clubIds.length > 0 ? null : FORBIDDEN;
      // Media rows are immutable; a new photo is a new row.
      return op === 'delete' && ctx.isFedAdmin ? null : FORBIDDEN;
    },
  },

  players: {
    async check({ ctx, op, before, after }) {
      if (after.photo_media_id && isMinor(after.birth_date) && !after.photo_consent) {
        return 'photo_consent_required';
      }
      if (ctx.isFedAdmin) return null;
      if (op === 'insert') return ctx.clubIds.includes(after.club_id) ? null : FORBIDDEN;
      // Moving a player between clubs goes through an approved registration.
      if (!ctx.clubIds.includes(before!.club_id) || after.club_id !== before!.club_id) return FORBIDDEN;
      return null;
    },
    async afterWrite({ tx, op, after }) {
      // Lineups show the player's name to everyone who sees the match; keep it current.
      if (op !== 'update') return;
      await tx.query(
        `update match_lineups set player_name = $2
         where player_id = $1 and player_name is distinct from $2`,
        [after.id, `${after.first_name} ${after.last_name}`],
      );
    },
  },

  registrations: {
    async check({ tx, ctx, op, before, after }) {
      if (ctx.isFedAdmin) return null;
      if (!ctx.clubIds.includes(after.club_id)) return FORBIDDEN;
      if (op === 'insert') {
        if (after.status !== 'pending') return FORBIDDEN;
        const player = await one(tx, 'select club_id from players where id = $1', [after.player_id]);
        // New players and renewals only; transfers between clubs are handled by the federation.
        return ctx.clubIds.includes(player!.club_id) ? null : 'transfer_requires_federation';
      }
      if (before!.status !== 'pending') return 'registration_decided';
      if (after.status !== before!.status || after.club_id !== before!.club_id) return FORBIDDEN;
      return null;
    },
    async serverFields({ ctx, before, after }) {
      if (after.status !== 'pending' && after.status !== before?.status) {
        return { decided_by: ctx.userId, decided_at: new Date().toISOString() };
      }
      return {};
    },
    async afterWrite({ tx, op, before, after }) {
      if (op !== 'delete' && after.status === 'approved' && before?.status !== 'approved') {
        await tx.query('update players set club_id = $1 where id = $2 and club_id is distinct from $1', [
          after.club_id,
          after.player_id,
        ]);
      }
    },
  },

  squad_members: {
    async check({ tx, ctx, after }) {
      if (ctx.isFedAdmin) return null;
      const clubId = await teamClub(tx, after.team_id);
      if (!ctx.clubIds.includes(clubId)) return FORBIDDEN;
      const player = await one(tx, 'select club_id from players where id = $1', [after.player_id]);
      return player!.club_id === clubId ? null : 'player_not_in_club';
    },
  },

  match_lineups: {
    async check({ tx, ctx, op, before, after }) {
      const { match, reportStatus } = await matchInfo(tx, after.match_id);
      if (after.team_id !== match.home_team_id && after.team_id !== match.away_team_id) {
        return 'team_not_in_match';
      }
      if (!ctx.isFedAdmin) {
        if (isLocked(reportStatus)) return 'report_locked';
        const isReferee = match.referee_user_id === ctx.userId;
        const isClub = ctx.clubIds.includes(await teamClub(tx, after.team_id));
        if (!isReferee && !isClub) return FORBIDDEN;
      }
      const inSquad = await one(
        tx,
        'select 1 from squad_members where team_id = $1 and player_id = $2 and deleted_at is null',
        [after.team_id, after.player_id],
      );
      if (!inSquad) return 'player_not_in_squad';
      // A suspended player cannot be picked. Rows added before the ban was known
      // may still be edited, and the federation can override.
      if (!ctx.isFedAdmin && (op === 'insert' || before!.player_id !== after.player_id)) {
        if (await playerBanForMatch(tx, after.player_id, after.match_id)) return 'player_suspended';
      }
      return null;
    },
    async serverFields({ tx, op, before, after }) {
      if (op === 'update' && before!.player_id === after.player_id) return {};
      const p = await one(tx, 'select first_name, last_name from players where id = $1', [after.player_id]);
      return { player_name: p ? `${p.first_name} ${p.last_name}` : null };
    },
    async afterWrite({ tx, ctx, after }) {
      // The club changed a submitted lineup: it must be submitted again. The referee's
      // and the federation's corrections on match day leave the sheet as it is.
      if (ctx.isFedAdmin) return;
      const match = await one(tx, 'select referee_user_id from matches where id = $1', [after.match_id]);
      if (match?.referee_user_id === ctx.userId) return;
      await tx.query(
        `update team_sheets set status = 'draft', updated_by = $3
         where match_id = $1 and team_id = $2 and status = 'submitted' and deleted_at is null`,
        [after.match_id, after.team_id, ctx.userId],
      );
    },
  },

  team_sheets: {
    async check({ tx, ctx, op, before, after }) {
      if (op === 'delete') return ctx.isFedAdmin ? null : FORBIDDEN;
      if (before && (before.match_id !== after.match_id || before.team_id !== after.team_id)) return FORBIDDEN;
      const { match, reportStatus } = await matchInfo(tx, after.match_id);
      if (after.team_id !== match.home_team_id && after.team_id !== match.away_team_id) return 'team_not_in_match';
      if (!ctx.isFedAdmin) {
        // Only the team's own club submits its sheet, until the match report is in.
        if (!ctx.clubIds.includes(await teamClub(tx, after.team_id))) return FORBIDDEN;
        if (isLocked(reportStatus)) return 'report_locked';
      }
      if (after.status !== 'submitted') return null;
      const lineups = (
        await tx.query('select * from match_lineups where match_id = $1 and team_id = $2 and deleted_at is null', [
          after.match_id,
          after.team_id,
        ])
      ).rows;
      const banned = await bansForMatch(tx, after.match_id, lineups.map((l) => l.player_id));
      const problems = teamSheetProblems(lineups, new Set(banned.keys()));
      return problems.length ? `sheet_${problems[0]}` : null;
    },
    async serverFields({ ctx, before, after }) {
      if (after.status === 'submitted' && before?.status !== 'submitted') {
        return { submitted_at: new Date().toISOString(), submitted_by: ctx.userId };
      }
      return {};
    },
  },

  transfers: {
    async check({ tx, ctx, op, before, after }) {
      if (op === 'delete') return ctx.isFedAdmin ? null : FORBIDDEN;
      if (op === 'insert') {
        // The receiving club applies (or the federation on its behalf).
        if (!ctx.isFedAdmin && !ctx.clubIds.includes(after.to_club_id)) return FORBIDDEN;
        const player = await one(tx, 'select club_id from players where id = $1', [after.player_id]);
        return player!.club_id === after.to_club_id ? 'already_in_club' : null;
      }
      if (after.player_id !== before!.player_id || after.to_club_id !== before!.to_club_id) return FORBIDDEN;
      const from = before!.status as TransferStatus;
      if (!OPEN_TRANSFER_STATUSES.includes(from)) return 'transfer_decided';
      const involved =
        ctx.isFedAdmin || ctx.clubIds.includes(before!.to_club_id) || ctx.clubIds.includes(before!.from_club_id);
      if (!involved) return FORBIDDEN;
      if (after.status === from) return null; // notes only
      // Each step belongs to one party; the federation can only approve after the release.
      const state = { status: from, from_club_id: before!.from_club_id, to_club_id: before!.to_club_id };
      if (!transferActions(state, ctx).includes(after.status)) return FORBIDDEN;
      if (after.status === 'pending_federation' || after.status === 'approved') {
        // The player has moved some other way since the request: it no longer applies.
        const player = await one(tx, 'select club_id from players where id = $1', [after.player_id]);
        if ((player!.club_id ?? null) !== before!.from_club_id) return 'transfer_outdated';
      }
      return null;
    },
    async serverFields({ tx, ctx, op, before, after }) {
      const now = new Date().toISOString();
      if (op === 'insert') {
        const player = await one(tx, 'select club_id from players where id = $1', [after.player_id]);
        const fromClub = player!.club_id ?? null;
        return { from_club_id: fromClub, status: initialTransferStatus(fromClub), requested_by: ctx.userId };
      }
      if (after.status === before?.status) return {};
      if (after.status === 'pending_federation') return { released_by: ctx.userId, released_at: now };
      if (after.status === 'approved' || after.status === 'rejected') return { decided_by: ctx.userId, decided_at: now };
      return {};
    },
    async afterWrite({ tx, ctx, op, before, after }) {
      if (op === 'delete' || after.status !== 'approved' || before?.status === 'approved') return;
      // The player moves: new club, out of the old club's squads, registered for the season.
      await tx.query('update players set club_id = $1, updated_by = $3 where id = $2', [
        after.to_club_id,
        after.player_id,
        ctx.userId,
      ]);
      await tx.query(
        `update squad_members set deleted_at = now(), updated_by = $3
         where player_id = $1 and deleted_at is null
           and team_id in (select id from teams where club_id is distinct from $2)`,
        [after.player_id, after.to_club_id, ctx.userId],
      );
      const season = await one(
        tx,
        `select id from seasons where federation_id = $1 and deleted_at is null
         order by (current_date between starts_on and ends_on) desc, starts_on desc limit 1`,
        [ctx.federationId],
      );
      if (season) {
        await tx.query(
          `insert into registrations (id, federation_id, player_id, club_id, season_id, status, note,
                                      decided_by, decided_at, updated_by)
           select gen_random_uuid(), $1, $2, $3, $4, 'approved', 'transfer', $5, now(), $5
           where not exists (select 1 from registrations where player_id = $2 and club_id = $3
                             and season_id = $4 and status = 'approved' and deleted_at is null)`,
          [ctx.federationId, after.player_id, after.to_club_id, season.id, ctx.userId],
        );
      }
    },
  },

  suspensions: {
    async check({ ctx, op, after }) {
      if (!ctx.isFedAdmin) return FORBIDDEN;
      if (op === 'delete') return null;
      // Either N matches in one competition, or a date range.
      const byMatches = after.matches != null && after.competition_id != null && after.ends_on == null;
      const byDates = after.matches == null && after.ends_on != null && after.ends_on >= after.starts_on;
      return byMatches || byDates ? null : 'invalid';
    },
  },

  match_events: {
    async check({ tx, ctx, after }) {
      const { match, reportStatus } = await matchInfo(tx, after.match_id);
      if (!ctx.isFedAdmin) {
        if (match.referee_user_id !== ctx.userId) return FORBIDDEN;
        if (isLocked(reportStatus)) return 'report_locked';
      }
      if (after.team_id !== match.home_team_id && after.team_id !== match.away_team_id) {
        return 'team_not_in_match';
      }
      for (const playerId of [after.player_id, after.related_player_id]) {
        if (!playerId) continue;
        const inLineup = await one(
          tx,
          `select 1 from match_lineups
           where match_id = $1 and team_id = $2 and player_id = $3 and deleted_at is null`,
          [after.match_id, after.team_id, playerId],
        );
        if (!inLineup) return 'player_not_in_lineup';
      }
      if (after.type === 'sub' && (!after.player_id || !after.related_player_id)) return 'invalid';
      return null;
    },
    async serverFields({ ctx, op }) {
      return op === 'insert' ? { recorded_by: ctx.userId } : {};
    },
  },

  match_reports: {
    async check({ tx, ctx, op, before, after }) {
      if (op === 'delete') return ctx.isFedAdmin ? null : FORBIDDEN;
      if (ctx.isFedAdmin) return null;
      const match = (await one(tx, 'select referee_user_id from matches where id = $1', [after.id]))!;
      if (match.referee_user_id !== ctx.userId) return FORBIDDEN;
      const from: ReportStatus | null = before?.status ?? null;
      if (isLocked(from)) return 'report_locked';
      // A referee can save drafts and submit; approving and reopening is for the federation.
      const allowed: ReportStatus[] = from === 'reopened' ? ['reopened', 'submitted'] : ['draft', 'submitted'];
      return allowed.includes(after.status) ? null : FORBIDDEN;
    },
    async serverFields({ tx, ctx, before, after }) {
      const fields: Row = {};
      if (after.status === 'submitted' || after.status === 'approved') {
        // The official result is always derived from the recorded goals.
        const match = (await one(tx, 'select home_team_id, away_team_id from matches where id = $1', [after.id]))!;
        const events = (await tx.query('select team_id, type, deleted_at from match_events where match_id = $1', [after.id]))
          .rows;
        const score = scoreFromEvents(events, match.home_team_id, match.away_team_id);
        fields.home_score = score.home;
        fields.away_score = score.away;
      }
      if (after.status === 'submitted' && before?.status !== 'submitted') {
        fields.submitted_at = new Date().toISOString();
        fields.submitted_by = ctx.userId;
      }
      if (after.status === 'approved' && before?.status !== 'approved') {
        fields.approved_at = new Date().toISOString();
        fields.approved_by = ctx.userId;
      }
      return fields;
    },
    async afterWrite({ tx, op, after }) {
      if (op !== 'delete' && (after.status === 'submitted' || after.status === 'approved')) {
        await tx.query(`update matches set status = 'played' where id = $1 and status <> 'played'`, [after.id]);
      }
    },
  },
};
