import { createHash, randomBytes } from 'node:crypto';
import { localName } from '@fotboll/shared';
import type { Db, Tx } from './db.js';
import { tokenEmail, type Mailer } from './mail.js';

/**
 * One-time links for invitations and password resets (table auth_tokens).
 * The raw token only exists in the link; the database keeps its hash.
 */

export type TokenPurpose = 'invite' | 'reset';

export const INVITE_DAYS = 14;
export const RESET_HOURS = 24;

/** Placeholder hash for users who have not chosen a password yet; no password matches it. */
export const NO_PASSWORD = '!';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createAuthToken(
  tx: Tx | Db,
  userId: string,
  purpose: TokenPurpose,
  createdBy: string | null,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  // Only the newest link works.
  await tx.query('delete from auth_tokens where user_id = $1 and used_at is null', [userId]);
  await tx.query(
    `insert into auth_tokens (token_hash, user_id, purpose, created_by, expires_at)
     values ($1, $2, $3, $4, now() + $5::interval)`,
    [sha256(token), userId, purpose, createdBy, purpose === 'invite' ? `${INVITE_DAYS} days` : `${RESET_HOURS} hours`],
  );
  return token;
}

export interface TokenInfo {
  user_id: string;
  purpose: TokenPurpose;
  email: string;
  display_name: string;
  locale: string;
}

/** A valid, unused, unexpired token for an active user; `lock` for the transaction that uses it. */
export async function findAuthToken(tx: Tx | Db, token: string, lock = false): Promise<TokenInfo | null> {
  const res = await tx.query<TokenInfo>(
    `select t.user_id, t.purpose, u.email, u.display_name, u.locale
     from auth_tokens t join users u on u.id = t.user_id
     where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
       and u.is_active and u.deleted_at is null${lock ? ' for update of t' : ''}`,
    [sha256(token)],
  );
  return res.rows[0] ?? null;
}

export async function markTokenUsed(tx: Tx, token: string, userId: string) {
  await tx.query('update auth_tokens set used_at = now() where token_hash = $1', [sha256(token)]);
  await tx.query('delete from auth_tokens where user_id = $1 and used_at is null', [userId]);
}

export const setPasswordLink = (publicUrl: string, token: string) => `${publicUrl}/set-password/${token}`;

/** Emails the link when mail and PUBLIC_URL are configured. Returns whether it was sent. */
export async function emailToken(
  db: Db,
  mailer: Mailer,
  publicUrl: string | undefined,
  userId: string,
  purpose: TokenPurpose,
  token: string,
): Promise<boolean> {
  if (!mailer.enabled || !publicUrl) return false;
  const user = (
    await db.query(
      `select u.email, u.display_name, u.locale, f.name, f.name_i18n
       from users u join federations f on f.id = u.federation_id where u.id = $1`,
      [userId],
    )
  ).rows[0];
  if (!user) return false;
  const msg = tokenEmail(purpose, user.locale, {
    name: user.display_name,
    federation: localName(user, user.locale),
    link: setPasswordLink(publicUrl, token),
    days: INVITE_DAYS,
    hours: RESET_HOURS,
  });
  await mailer.send({ to: user.email, ...msg });
  return true;
}
