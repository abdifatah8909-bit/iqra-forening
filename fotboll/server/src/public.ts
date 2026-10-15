import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isMinor, LOCKED_REPORT_STATUSES, type PublicData, type PublicMatchDetail } from '@fotboll/shared';
import type { Db } from './db.js';
import { mediaPath } from './media.js';

/**
 * Read-only public pages for supporters: fixtures, results, league tables and
 * clubs, without signing in. Only results from submitted or approved reports.
 * The only personal data is the submitted lineups of senior competitions
 * (name and shirt number, adults only); never referees, users, photos or
 * other player details.
 */

const fedParams = z.object({ id: z.string().uuid() });
const matchParams = z.object({ id: z.string().uuid(), matchId: z.string().uuid() });

/**
 * Lineups of one match, for senior competitions only. A team's lineup is shown
 * once its team sheet is submitted (or the match report is in); drafts never.
 * Players under 18 on match day are listed by shirt number only.
 */
export async function publicMatchDetail(db: Db, federationId: string, matchId: string): Promise<PublicMatchDetail | null> {
  const match = (
    await db.query(
      `select m.id, m.home_team_id, m.away_team_id, m.kickoff_at, c.is_senior,
              exists (select 1 from match_reports r where r.id = m.id and r.deleted_at is null
                      and r.status = any($3)) as report_in
       from matches m join competitions c on c.id = m.competition_id
       where m.id = $1 and m.federation_id = $2 and m.deleted_at is null`,
      [matchId, federationId, LOCKED_REPORT_STATUSES],
    )
  ).rows[0];
  if (!match) return null;
  if (!match.is_senior) return { lineups_public: false, published_team_ids: [], lineups: [] };
  const submitted = (
    await db.query(
      `select team_id from team_sheets where match_id = $1 and status = 'submitted' and deleted_at is null`,
      [matchId],
    )
  ).rows.map((r) => r.team_id as string);
  const published = match.report_in ? [match.home_team_id, match.away_team_id] : submitted;
  const rows = (
    await db.query(
      `select l.team_id, l.shirt_number, l.player_name, l.is_starter, l.is_captain, l.is_goalkeeper, p.birth_date
       from match_lineups l join players p on p.id = l.player_id
       where l.match_id = $1 and l.team_id = any($2) and l.deleted_at is null
       order by l.is_starter desc, l.shirt_number nulls last`,
      [matchId, published],
    )
  ).rows;
  const matchDay = new Date(match.kickoff_at);
  return {
    lineups_public: true,
    published_team_ids: published,
    lineups: rows.map((r) => ({
      team_id: r.team_id,
      shirt_number: r.shirt_number,
      name: isMinor(r.birth_date, matchDay) ? null : r.player_name,
      is_starter: r.is_starter,
      is_captain: r.is_captain,
      is_goalkeeper: r.is_goalkeeper,
    })),
  };
}

export async function publicData(db: Db, federationId: string): Promise<PublicData | null> {
  const federation = (
    await db.query(
      'select id, name, country, default_locale from federations where id = $1 and deleted_at is null',
      [federationId],
    )
  ).rows[0];
  if (!federation) return null;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.query(sql, [federationId, ...params])).rows;
  const [seasons, competitions, clubs, teams, venues, matches, results] = await Promise.all([
    q('select id, name, starts_on, ends_on from seasons where federation_id = $1 and deleted_at is null order by starts_on desc'),
    q(`select id, season_id, name, name_i18n, age_group, gender, points_win, points_draw, points_loss, is_senior
       from competitions where federation_id = $1 and deleted_at is null order by name`),
    q(`select id, name, short_name, city, logo_media_id from clubs
       where federation_id = $1 and deleted_at is null and status = 'active' order by name`),
    q('select id, club_id, competition_id, name from teams where federation_id = $1 and deleted_at is null'),
    q('select id, name, address from venues where federation_id = $1 and deleted_at is null'),
    q(`select id, competition_id, round, home_team_id, away_team_id, venue_id, kickoff_at, status
       from matches where federation_id = $1 and deleted_at is null order by kickoff_at`),
    q(
      `select id, home_score, away_score from match_reports
       where federation_id = $1 and deleted_at is null and status = any($2)`,
      [LOCKED_REPORT_STATUSES],
    ),
  ]);
  return { federation, seasons, competitions, clubs, teams, venues, matches, results } as unknown as PublicData;
}

export function registerPublicRoutes(app: FastifyInstance, db: Db, mediaDir: string) {
  app.get('/api/public/federations', async (_req, reply) => {
    const rows = await db.query('select id, name, country from federations where deleted_at is null order by name');
    return reply.header('cache-control', 'public, max-age=300').send(rows.rows);
  });

  app.get('/api/public/federations/:id', async (req, reply) => {
    const { id } = fedParams.parse(req.params);
    const data = await publicData(db, id);
    if (!data) return reply.code(404).send({ error: 'not_found' });
    // Results change on match days; a minute of caching keeps the server calm.
    return reply.header('cache-control', 'public, max-age=60').send(data);
  });

  app.get('/api/public/federations/:id/matches/:matchId', async (req, reply) => {
    const { id, matchId } = matchParams.parse(req.params);
    const detail = await publicMatchDetail(db, id, matchId);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'public, max-age=60').send(detail);
  });

  /** Club logos only; player photos are never public. */
  app.get('/api/public/media/:id', async (req, reply) => {
    const { id } = fedParams.parse(req.params);
    const media = (
      await db.query(
        `select m.mime from media m
         where m.id = $1 and m.kind = 'club_logo' and m.upload_status = 'done' and m.deleted_at is null
           and exists (select 1 from clubs c where c.logo_media_id = m.id and c.deleted_at is null)`,
        [id],
      )
    ).rows[0];
    if (!media) return reply.code(404).send({ error: 'not_found' });
    const bytes = await readFile(mediaPath(mediaDir, id));
    return reply.header('content-type', media.mime).header('cache-control', 'public, max-age=86400').send(bytes);
  });
}
