import { banFor, computeBans, LOCKED_REPORT_STATUSES, type Ban } from '@fotboll/shared';
import type { Tx } from '../db.js';

/**
 * Server side of the suspension rules: loads what computeBans needs for one
 * player in one match's competition and answers whether they are banned.
 */
export async function playerBanForMatch(tx: Tx, playerId: string, matchId: string): Promise<Ban | undefined> {
  const rows = async (sql: string, params: unknown[]) => (await tx.query(sql, params)).rows;
  const match = (await rows('select * from matches where id = $1', [matchId]))[0];
  if (!match) return undefined;
  const comp = match.competition_id;

  const competitions = await rows(
    'select id, yellow_card_limit, red_card_ban, second_yellow_ban from competitions where id = $1',
    [comp],
  );
  const teams = await rows('select id, competition_id from teams where competition_id = $1 and deleted_at is null', [
    comp,
  ]);
  const matches = await rows(
    `select id, competition_id, home_team_id, away_team_id, kickoff_at, status from matches
     where competition_id = $1 and deleted_at is null`,
    [comp],
  );
  const counted = await rows(
    `select r.id from match_reports r join matches m on m.id = r.id
     where m.competition_id = $1 and r.status = any($2) and r.deleted_at is null`,
    [comp, LOCKED_REPORT_STATUSES],
  );
  const events = await rows(
    `select e.match_id, e.team_id, e.player_id, e.type from match_events e join matches m on m.id = e.match_id
     where m.competition_id = $1 and e.player_id = $2 and e.deleted_at is null`,
    [comp, playerId],
  );
  const suspensions = await rows('select * from suspensions where player_id = $1 and deleted_at is null', [playerId]);
  const squads = await rows(
    'select team_id, player_id from squad_members where player_id = $1 and deleted_at is null',
    [playerId],
  );

  const bans = computeBans({
    competitions,
    teams,
    matches,
    counted: new Set(counted.map((r) => r.id)),
    events,
    suspensions,
    squads,
  });
  return banFor(bans, playerId, match);
}
