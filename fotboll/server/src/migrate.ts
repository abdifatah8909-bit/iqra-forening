import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool, withTx, type Db } from './db.js';
import { config } from './config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  return withTx(db, async (tx) => {
    // Serialise concurrent migrators (e.g. several app instances starting at once).
    await tx.query('select pg_advisory_xact_lock(4712)');
    await tx.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await tx.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(path.join(dir, file), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(config.databaseUrl);
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  await db.end();
}
