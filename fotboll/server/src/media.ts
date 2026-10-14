import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserContext } from './auth.js';
import { withWriteLock, type Db } from './db.js';

export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const MIME_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

const params = z.object({ id: z.string().uuid() });

export function mediaPath(mediaDir: string, id: string) {
  return path.join(mediaDir, id);
}

export async function removeMediaFile(mediaDir: string, id: string) {
  await rm(mediaPath(mediaDir, id), { force: true });
}

/** Whether `ctx` may download this image. Player photos follow player visibility (see pull.ts). */
async function canView(db: Db, ctx: UserContext, media: { id: string; kind: string; updated_by: string | null }) {
  if (ctx.isFedAdmin || media.kind === 'club_logo' || media.updated_by === ctx.userId) return true;
  const res = await db.query(
    `select 1 from players p
     where p.photo_media_id = $1 and p.federation_id = $2 and p.deleted_at is null and (
       p.club_id = any($3) or p.id in (
         select sm.player_id from squad_members sm
         join matches m on sm.team_id in (m.home_team_id, m.away_team_id)
         where m.referee_user_id = $4 and m.deleted_at is null and sm.deleted_at is null))`,
    [media.id, ctx.federationId, ctx.clubIds, ctx.userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export function registerMediaRoutes(app: FastifyInstance, db: Db, mediaDir: string) {
  app.addContentTypeParser(MIME_TYPES, { parseAs: 'buffer', bodyLimit: MAX_MEDIA_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  /** Upload the bytes for a media row that was already created through sync. */
  app.put('/api/media/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: 'unsupported_media_type' });
    const ctx = req.user;
    const media = (
      await db.query('select * from media where id = $1 and federation_id = $2 and deleted_at is null', [
        id,
        ctx.federationId,
      ])
    ).rows[0];
    if (!media) return reply.code(404).send({ error: 'not_found' });
    if (!ctx.isFedAdmin && media.updated_by !== ctx.userId) return reply.code(403).send({ error: 'forbidden' });
    if (req.headers['content-type'] !== media.mime) return reply.code(400).send({ error: 'mime_mismatch' });
    if (createHash('sha256').update(body).digest('hex') !== media.sha256) {
      return reply.code(400).send({ error: 'checksum_mismatch' });
    }
    if (media.upload_status !== 'done') {
      await mkdir(mediaDir, { recursive: true });
      await writeFile(mediaPath(mediaDir, id), body);
      await withWriteLock(db, (tx) => tx.query(`update media set upload_status = 'done' where id = $1`, [id]));
    }
    return { ok: true };
  });

  app.get('/api/media/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    const media = (
      await db.query(
        `select id, kind, mime, updated_by, upload_status from media
         where id = $1 and federation_id = $2 and deleted_at is null`,
        [id, req.user.federationId],
      )
    ).rows[0];
    if (!media || media.upload_status !== 'done') return reply.code(404).send({ error: 'not_found' });
    if (!(await canView(db, req.user, media))) return reply.code(403).send({ error: 'forbidden' });
    const bytes = await readFile(mediaPath(mediaDir, id));
    // Content is addressed by an immutable id; let the client cache it.
    return reply.header('content-type', media.mime).header('cache-control', 'private, max-age=31536000, immutable').send(bytes);
  });
}
