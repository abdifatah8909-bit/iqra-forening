import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCKED_REPORT_STATUSES, type PublicData } from '@fotboll/shared';
import type { Db } from './db.js';
import { mediaPath } from './media.js';

/**
 * Read-only public pages for supporters: fixtures, results, league tables and
 * clubs, without signing in. No personal data is published here: no players,
 * no referees, no users. Only results from submitted or approved reports.
 */

const fedParams = z.object({ id: z.string().uuid() });

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
    q(`select id, season_id, name, name_i18n, age_group, gender, points_win, points_draw, points_loss
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
