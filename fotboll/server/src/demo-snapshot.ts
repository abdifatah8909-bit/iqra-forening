import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadUserContext, meResponse } from './auth.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { pull } from './sync/pull.js';

/**
 * Exports what each demo account would receive on its first sync, for the
 * browser-only demo build (web: npm run build:demo). Run after `npm run seed`.
 */
const ACCOUNTS = { admin: 'admin@example.org', club: 'klubb@example.org', referee: 'domare@example.org' };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'demo', 'snapshots.json');

const db = createPool(config.databaseUrl);
const accounts: Record<string, unknown> = {};
let data: Awaited<ReturnType<typeof pull>> | undefined;
for (const [key, email] of Object.entries(ACCOUNTS)) {
  const user = (await db.query('select id from users where lower(email) = $1', [email])).rows[0];
  if (!user) throw new Error(`${email} not found: run npm run seed first`);
  const ctx = (await loadUserContext(db, user.id))!;
  accounts[key] = meResponse(ctx);
  // All demo roles share the federation admin's full copy, so work done in
  // one role (e.g. a submitted report) can be continued in another.
  if (ctx.isFedAdmin) data = await pull(db, ctx, 0, undefined);
}
if (!data || data.has_more) throw new Error('Demo data missing or larger than one pull page');
// The demo has no photo server; drop references so avatars show initials.
for (const p of data.changes.players ?? []) p.photo_media_id = null;
delete data.changes.media;
await writeFile(out, JSON.stringify({ accounts, pull: data }));
console.log(`Wrote ${out}`);
await db.end();
