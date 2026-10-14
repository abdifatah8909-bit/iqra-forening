import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOCALES, ROLES } from '@fotboll/shared';
import { hashPassword } from './auth.js';
import { withWriteLock, type Db, type Tx } from './db.js';
import { removeMediaFile } from './media.js';

/**
 * Account management and GDPR erasure. These need the server (passwords,
 * cross-user changes), so they are online-only by design.
 */

const roleSchema = z.object({ role: z.enum(ROLES), club_id: z.string().uuid().nullable().optional() });
const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  display_name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  locale: z.enum(LOCALES).default('so'),
  roles: z.array(roleSchema).min(1),
});
const updateUserSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
  is_active: z.boolean().optional(),
  roles: z.array(roleSchema).min(1).optional(),
});
const idParams = z.object({ id: z.string().uuid() });

function requireFedAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user.isFedAdmin) {
    reply.code(403).send({ error: 'forbidden' });
    return;
  }
  done();
}

async function setRoles(tx: Tx, federationId: string, userId: string, roles: z.infer<typeof roleSchema>[]) {
  for (const r of roles) {
    if ((r.role === 'club_admin') !== Boolean(r.club_id)) throw new BadRequest('club_required_for_club_admin');
    if (r.club_id) {
      const club = await tx.query('select 1 from clubs where id = $1 and federation_id = $2', [r.club_id, federationId]);
      if (!club.rowCount) throw new BadRequest('invalid_reference');
    }
  }
  await tx.query('delete from role_assignments where user_id = $1', [userId]);
  for (const r of roles) {
    await tx.query(
      'insert into role_assignments (user_id, role, club_id) values ($1, $2, $3) on conflict do nothing',
      [userId, r.role, r.club_id ?? null],
    );
  }
  // Roles are part of the synced user profile (is_referee); bump its server_seq.
  await tx.query('update users set updated_at = now() where id = $1', [userId]);
}

class BadRequest extends Error {}

export function registerAdminRoutes(app: FastifyInstance, db: Db, mediaDir: string) {
  app.register(async (admin) => {
    admin.addHook('preHandler', requireFedAdmin);
    admin.setErrorHandler((err, _req, reply) => {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', issues: err.issues });
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_taken' });
      throw err;
    });

    admin.get('/api/admin/users', async (req) => {
      const users = await db.query(
        `select u.id, u.email, u.display_name, u.locale, u.is_active,
                coalesce(json_agg(json_build_object('role', r.role, 'club_id', r.club_id))
                  filter (where r.role is not null), '[]') as roles
         from users u left join role_assignments r on r.user_id = u.id
         where u.federation_id = $1 and u.deleted_at is null
         group by u.id order by u.display_name`,
        [req.user.federationId],
      );
      return users.rows;
    });

    admin.post('/api/admin/users', async (req, reply) => {
      const body = createUserSchema.parse(req.body);
      const id = randomUUID();
      const passwordHash = await hashPassword(body.password);
      await withWriteLock(db, async (tx) => {
        await tx.query(
          `insert into users (id, federation_id, email, password_hash, display_name, locale)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, req.user.federationId, body.email, passwordHash, body.display_name, body.locale],
        );
        await setRoles(tx, req.user.federationId, id, body.roles);
      });
      return reply.code(201).send({ id });
    });

    admin.patch('/api/admin/users/:id', async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateUserSchema.parse(req.body);
      const passwordHash = body.password ? await hashPassword(body.password) : undefined;
      const found = await withWriteLock(db, async (tx) => {
        const user = await tx.query('select 1 from users where id = $1 and federation_id = $2 for update', [
          id,
          req.user.federationId,
        ]);
        if (!user.rowCount) return false;
        await tx.query(
          `update users set display_name = coalesce($2, display_name),
                            password_hash = coalesce($3, password_hash),
                            is_active = coalesce($4, is_active)
           where id = $1`,
          [id, body.display_name ?? null, passwordHash ?? null, body.is_active ?? null],
        );
        if (body.roles) await setRoles(tx, req.user.federationId, id, body.roles);
        // A password reset or deactivation signs the user out everywhere.
        if (passwordHash || body.is_active === false) await tx.query('delete from sessions where user_id = $1', [id]);
        return true;
      });
      return found ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });

    /**
     * Right to erasure (GDPR art. 17). The player row is kept so historical
     * match reports and tables stay correct, but every personal field and the
     * photo are removed.
     */
    admin.post('/api/admin/players/:id/erase', async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const photoId = await withWriteLock(db, async (tx) => {
        const player = (
          await tx.query('select photo_media_id from players where id = $1 and federation_id = $2 for update', [
            id,
            req.user.federationId,
          ])
        ).rows[0];
        if (!player) return undefined;
        await tx.query(
          `update players set first_name = '–', last_name = '–', name_alt = null, birth_date = '1900-01-01',
                  photo_media_id = null, photo_consent = false, license_no = null, status = 'inactive',
                  deleted_at = coalesce(deleted_at, now()), updated_by = $2
           where id = $1`,
          [id, req.user.userId],
        );
        if (player.photo_media_id) {
          await tx.query('update media set deleted_at = now() where id = $1', [player.photo_media_id]);
        }
        return player.photo_media_id as string | null;
      });
      if (photoId === undefined) return reply.code(404).send({ error: 'not_found' });
      if (photoId) await removeMediaFile(mediaDir, photoId);
      return { ok: true };
    });

    admin.get('/api/admin/conflicts', async (req) => {
      const rows = await db.query(
        `select c.* from conflict_log c join users u on u.id = c.user_id
         where u.federation_id = $1 order by c.id desc limit 100`,
        [req.user.federationId],
      );
      return rows.rows;
    });
  });
}
