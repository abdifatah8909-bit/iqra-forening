import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { LOCALES, pushRequestSchema } from '@fotboll/shared';
import {
  authenticate,
  bearer,
  createSession,
  deleteSession,
  hashPassword,
  LoginLimiter,
  loadUserContext,
  meResponse,
  verifyPassword,
} from './auth.js';
import type { Db } from './db.js';
import { registerAdminRoutes } from './admin.js';
import { registerMediaRoutes } from './media.js';
import { pull } from './sync/pull.js';
import { push } from './sync/push.js';

export interface AppOptions {
  db: Db;
  mediaDir: string;
  webDist?: string;
  logger?: boolean;
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
const updateMeSchema = z.object({
  locale: z.enum(LOCALES).optional(),
  display_name: z.string().trim().min(1).max(120).optional(),
  current_password: z.string().optional(),
  new_password: z.string().min(8).max(200).optional(),
});
const pullQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  scope: z.string().max(64).optional(),
});

const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health']);

export async function buildApp({ db, mediaDir, webDist, logger = false }: AppOptions) {
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 });
  const limiter = new LoginLimiter();
  const requireUser = authenticate(db);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || PUBLIC_ROUTES.has(url)) return;
    await requireUser(req, reply);
  });

  app.get('/api/health', async () => {
    await db.query('select 1');
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);
    if (limiter.blocked(email)) return reply.code(429).send({ error: 'too_many_attempts' });
    const user = (
      await db.query(
        'select id, password_hash from users where lower(email) = $1 and is_active and deleted_at is null',
        [email],
      )
    ).rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      limiter.fail(email);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    limiter.reset(email);
    const token = await createSession(db, user.id);
    const ctx = (await loadUserContext(db, user.id))!;
    return { token, user: meResponse(ctx) };
  });

  app.post('/api/auth/logout', async (req) => {
    await deleteSession(db, bearer(req)!);
    return { ok: true };
  });

  app.get('/api/me', async (req) => meResponse(req.user));

  app.patch('/api/me', async (req, reply) => {
    const body = updateMeSchema.parse(req.body);
    let passwordHash: string | null = null;
    if (body.new_password) {
      const row = (await db.query('select password_hash from users where id = $1', [req.user.userId])).rows[0];
      if (!body.current_password || !(await verifyPassword(body.current_password, row.password_hash))) {
        return reply.code(400).send({ error: 'invalid_credentials' });
      }
      passwordHash = await hashPassword(body.new_password);
    }
    await db.query(
      `update users set locale = coalesce($2, locale), display_name = coalesce($3, display_name),
                        password_hash = coalesce($4, password_hash)
       where id = $1`,
      [req.user.userId, body.locale ?? null, body.display_name ?? null, passwordHash],
    );
    return meResponse((await loadUserContext(db, req.user.userId))!);
  });

  app.post('/api/sync/push', async (req) => {
    const { mutations } = pushRequestSchema.parse(req.body);
    return { results: await push(db, req.user, mutations) };
  });

  app.get('/api/sync/pull', async (req) => {
    const { since, scope } = pullQuery.parse(req.query);
    return pull(db, req.user, since, scope);
  });

  registerMediaRoutes(app, db, mediaDir);
  registerAdminRoutes(app, db, mediaDir);

  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // Single-page app: unknown non-API paths get index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
