import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@fotboll/shared';
import type { Db } from './db.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Sessions are long-lived opaque tokens so a referee can work offline for
 * weeks. Only a hash is stored; the expiry slides forward on use.
 */
const SESSION_DAYS = 90;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at)
     values ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS],
  );
  return token;
}

export async function deleteSession(db: Db, token: string) {
  await db.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

export interface UserContext {
  userId: string;
  federationId: string;
  email: string;
  displayName: string;
  locale: string;
  roles: { role: Role; club_id: string | null }[];
  isFedAdmin: boolean;
  isReferee: boolean;
  /** Clubs this user administers. */
  clubIds: string[];
}

export async function loadUserContext(db: Db, userId: string): Promise<UserContext | null> {
  const user = (
    await db.query(
      `select id, federation_id, email, display_name, locale from users
       where id = $1 and is_active and deleted_at is null`,
      [userId],
    )
  ).rows[0];
  if (!user) return null;
  const roles = (
    await db.query<{ role: Role; club_id: string | null }>(
      'select role, club_id from role_assignments where user_id = $1 order by role, club_id',
      [userId],
    )
  ).rows;
  return {
    userId: user.id,
    federationId: user.federation_id,
    email: user.email,
    displayName: user.display_name,
    locale: user.locale,
    roles,
    isFedAdmin: roles.some((r) => r.role === 'federation_admin'),
    isReferee: roles.some((r) => r.role === 'referee'),
    clubIds: roles.filter((r) => r.role === 'club_admin').map((r) => r.club_id!),
  };
}

export async function userFromToken(db: Db, token: string): Promise<UserContext | null> {
  const session = (
    await db.query<{ user_id: string; stale: boolean }>(
      `select user_id, last_used_at < now() - interval '1 day' as stale
       from sessions where token_hash = $1 and expires_at > now()`,
      [sha256(token)],
    )
  ).rows[0];
  if (!session) return null;
  if (session.stale) {
    await db.query(
      `update sessions set last_used_at = now(), expires_at = now() + make_interval(days => $2)
       where token_hash = $1`,
      [sha256(token), SESSION_DAYS],
    );
  }
  return loadUserContext(db, session.user_id);
}

export function meResponse(ctx: UserContext) {
  return {
    id: ctx.userId,
    email: ctx.email,
    display_name: ctx.displayName,
    locale: ctx.locale,
    federation_id: ctx.federationId,
    roles: ctx.roles,
  };
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserContext;
  }
}

export function authenticate(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const user = token ? await userFromToken(db, token) : null;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
  };
}

/** Small in-memory brute-force guard for login: 10 failures per email per 15 minutes. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; until: number }>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60 * 1000,
  ) {}
  blocked(key: string): boolean {
    const f = this.failures.get(key);
    if (!f) return false;
    if (Date.now() > f.until) {
      this.failures.delete(key);
      return false;
    }
    return f.count >= this.max;
  }
  fail(key: string) {
    const f = this.failures.get(key);
    if (!f || Date.now() > f.until) this.failures.set(key, { count: 1, until: Date.now() + this.windowMs });
    else f.count++;
  }
  reset(key: string) {
    this.failures.delete(key);
  }
}
