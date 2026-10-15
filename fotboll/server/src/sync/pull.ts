import { createHash } from 'node:crypto';
import { PULL_PAGE_SIZE, SYNC_TABLES, type PullResponse, type SyncTable } from '@fotboll/shared';
import type { UserContext } from '../auth.js';
import type { Db } from '../db.js';

/**
 * What a user may see. Everything competition-related (clubs, fixtures,
 * results, lineups) is shared across the federation so schedules and tables
 * work offline for everyone. Personal data is minimised (GDPR):
 *  - players: federation admins see all; club admins their own club;
 *    referees the squads of teams in matches they are assigned to.
 *  - registrations: federation admins and the club concerned.
 *  - suspensions: like players.
 *  - users: only id and display name.
 */
interface Scope {
  key: string;
  refereeTeamIds: string[];
}

async function computeScope(db: Db, ctx: UserContext): Promise<Scope> {
  let refereeTeamIds: string[] = [];
  let squadFingerprint = '';
  if (!ctx.isFedAdmin && ctx.isReferee) {
    refereeTeamIds = (
      await db.query<{ team_id: string }>(
        `select distinct unnest(array[home_team_id, away_team_id]) as team_id
         from matches where referee_user_id = $1 and deleted_at is null order by 1`,
        [ctx.userId],
      )
    ).rows.map((r) => r.team_id);
    // Adding a player to one of those squads makes an older player row visible,
    // which an incremental pull would miss, so it must change the scope.
    squadFingerprint = (
      await db.query<{ fp: string | null }>(
        `select md5(string_agg(team_id::text || player_id::text, ',' order by team_id, player_id)) as fp
         from squad_members where team_id = any($1) and deleted_at is null`,
        [refereeTeamIds],
      )
    ).rows[0].fp ?? '';
  }
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        u: ctx.userId,
        fa: ctx.isFedAdmin,
        clubs: [...ctx.clubIds].sort(),
        teams: refereeTeamIds,
        squads: squadFingerprint,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return { key, refereeTeamIds };
}

function tableQuery(table: SyncTable, ctx: UserContext, scope: Scope): { sql: string; params: unknown[] } {
  const params: unknown[] = [ctx.federationId];
  let from = table as string;
  let select = '*';
  let where = 'federation_id = $1';

  switch (table) {
    case 'federations':
      where = 'id = $1';
      break;
    case 'user_profiles':
      from = 'users';
      select = `id, display_name, federation_id, created_at, updated_at, null as updated_by, deleted_at, server_seq,
        exists (select 1 from role_assignments r where r.user_id = users.id and r.role = 'referee') as is_referee`;
      break;
    case 'players':
      if (!ctx.isFedAdmin) {
        params.push(ctx.clubIds, scope.refereeTeamIds);
        where += ` and (club_id = any($2) or id in (
          select player_id from squad_members where team_id = any($3) and deleted_at is null))`;
      }
      break;
    case 'suspensions':
      // Disciplinary data follows player visibility.
      if (!ctx.isFedAdmin) {
        params.push(ctx.clubIds, scope.refereeTeamIds);
        where += ` and player_id in (select id from players where club_id = any($2) or id in (
          select player_id from squad_members where team_id = any($3) and deleted_at is null))`;
      }
      break;
    case 'registrations':
      if (!ctx.isFedAdmin) {
        params.push(ctx.clubIds);
        where += ' and club_id = any($2)';
      }
      break;
  }
  params.push(PULL_PAGE_SIZE + 1);
  const sinceParam = params.length + 1;
  return {
    sql: `select ${select} from ${from} where ${where} and server_seq > $${sinceParam}
          order by server_seq limit $${params.length}`,
    params,
  };
}

export async function pull(db: Db, ctx: UserContext, since: number, clientScope: string | undefined): Promise<PullResponse> {
  const scope = await computeScope(db, ctx);
  const reset = clientScope !== scope.key;
  const from = reset ? 0 : since;

  const perTable = new Map<SyncTable, Record<string, unknown>[]>();
  let cutoff = Infinity;
  for (const table of SYNC_TABLES) {
    const q = tableQuery(table, ctx, scope);
    const rows = (await db.query(q.sql, [...q.params, from])).rows;
    if (rows.length > PULL_PAGE_SIZE) {
      // This table has more; everything up to its last full-page row is complete.
      rows.length = PULL_PAGE_SIZE;
      cutoff = Math.min(cutoff, rows[rows.length - 1].server_seq);
    }
    perTable.set(table, rows);
  }

  const hasMore = cutoff !== Infinity;
  let cursor = from;
  const changes: PullResponse['changes'] = {};
  for (const [table, rows] of perTable) {
    const kept = hasMore ? rows.filter((r) => (r.server_seq as number) <= cutoff) : rows;
    if (kept.length) changes[table] = kept;
    for (const r of kept) cursor = Math.max(cursor, r.server_seq as number);
  }
  return { cursor, scope: scope.key, reset, has_more: hasMore, changes };
}
