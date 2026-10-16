import { schemas, type Mutation, type MutationResult, type WritableTable } from '@fotboll/shared';
import type { UserContext } from '../auth.js';
import { withWriteLock, type Db, type Tx } from '../db.js';
import { INSERT_DEFAULTS, REFERENCES, RULES } from './rules.js';

type Row = Record<string, any>;

/** Tables are scoped by federation_id, except `federations` itself, which is scoped by id. */
function scopeColumn(table: WritableTable) {
  return table === 'federations' ? 'id' : 'federation_id';
}

async function loadRow(tx: Tx, table: WritableTable, id: string, ctx: UserContext, lock = false) {
  const res = await tx.query(
    `select * from ${table} where id = $1 and ${scopeColumn(table)} = $2${lock ? ' for update' : ''}`,
    [id, ctx.federationId],
  );
  return (res.rows[0] as Row | undefined) ?? null;
}

class Rejection extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

async function checkReferences(tx: Tx, table: WritableTable, ctx: UserContext, before: Row | null, after: Row) {
  for (const [column, target] of Object.entries(REFERENCES[table] ?? {})) {
    const value = after[column];
    // Unchanged references were valid when written; don't fail edits because a target was later deleted.
    if (!value || (before && before[column] === value)) continue;
    const found = await tx.query(
      `select 1 from ${target} where id = $1 and federation_id = $2 and deleted_at is null`,
      [value, ctx.federationId],
    );
    if (found.rowCount === 0) throw new Rejection('invalid_reference');
  }
}

async function applyMutation(tx: Tx, ctx: UserContext, m: Mutation): Promise<Row | null> {
  const table = m.table;
  const schema = schemas[table];
  const rules = RULES[table];
  const before = await loadRow(tx, table, m.row_id, ctx, true);

  if (!before) {
    // Rows from another federation look exactly like missing rows.
    const elsewhere = await tx.query(`select 1 from ${table} where id = $1`, [m.row_id]);
    if (elsewhere.rowCount) throw new Rejection('forbidden');
  }

  if (m.op === 'delete') {
    if (!before || before.deleted_at) return before; // already gone: idempotent
    const args = { tx, ctx, before, after: before, op: 'delete' as const };
    const reason = await rules.check(args);
    if (reason) throw new Rejection(reason);
    await tx.query(`update ${table} set deleted_at = now(), updated_by = $2 where id = $1`, [m.row_id, ctx.userId]);
    await rules.afterWrite?.(args);
    return loadRow(tx, table, m.row_id, ctx);
  }

  if (before?.deleted_at) throw new Rejection('deleted');

  // Only client-writable columns are taken from the patch.
  const keys = Object.keys(schema.shape);
  const patch: Row = {};
  for (const k of keys) if (k !== 'id' && k in m.data) patch[k] = m.data[k];

  const base: Row = before
    ? Object.fromEntries(keys.map((k) => [k, before[k]]))
    : { ...(INSERT_DEFAULTS[table] ?? {}) };
  const parsed = schema.safeParse({ ...base, ...patch, id: m.row_id });
  if (!parsed.success) throw new Rejection('invalid');
  const after: Row = parsed.data;

  const op = before ? ('update' as const) : ('insert' as const);
  await checkReferences(tx, table, ctx, before, after);
  const args = { tx, ctx, before, after, op };
  const reason = await rules.check(args);
  if (reason) throw new Rejection(reason);
  const values: Row = { ...after, ...(await rules.serverFields?.(args)), updated_by: ctx.userId };

  // JSON columns must be passed as text to node-postgres.
  const toDb = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

  if (op === 'insert') {
    if (table !== 'federations') values.federation_id = ctx.federationId;
    const cols = Object.keys(values);
    await tx.query(
      `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => toDb(values[c])),
    );
  } else {
    const cols = Object.keys(values).filter((c) => c !== 'id');
    await tx.query(
      `update ${table} set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
      [m.row_id, ...cols.map((c) => toDb(values[c]))],
    );
    // Someone else changed the row since this client last saw it: their
    // fields not in this patch survive, overlapping fields are overwritten.
    // Keep the overwritten version so an admin can review it.
    if (m.base_seq != null && before!.server_seq > m.base_seq) {
      await tx.query(
        `insert into conflict_log (table_name, row_id, user_id, base_seq, current_seq, previous, patch)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [table, m.row_id, ctx.userId, m.base_seq, before!.server_seq, JSON.stringify(before), JSON.stringify(patch)],
      );
    }
  }
  await rules.afterWrite?.(args);
  return loadRow(tx, table, m.row_id, ctx);
}

const PG_UNIQUE_VIOLATION = '23505';

export async function push(db: Db, ctx: UserContext, mutations: Mutation[]): Promise<MutationResult[]> {
  return withWriteLock(db, async (tx) => {
    const results: MutationResult[] = [];
    for (const m of mutations) {
      const seen = await tx.query('select result from applied_mutations where id = $1 and user_id = $2', [
        m.id,
        ctx.userId,
      ]);
      if (seen.rowCount) {
        results.push(seen.rows[0].result);
        continue;
      }

      let result: MutationResult;
      await tx.query('savepoint m');
      try {
        const row = await applyMutation(tx, ctx, m);
        await tx.query('release savepoint m');
        result = { id: m.id, status: 'ok', row };
      } catch (err) {
        await tx.query('rollback to savepoint m');
        let reason: string;
        if (err instanceof Rejection) reason = err.reason;
        else if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) reason = 'duplicate';
        else throw err;
        // Hand back the server's version so the client can roll its optimistic change back.
        result = { id: m.id, status: 'rejected', reason, row: await loadRow(tx, m.table, m.row_id, ctx) };
      }
      await tx.query('insert into applied_mutations (id, user_id, result) values ($1, $2, $3)', [
        m.id,
        ctx.userId,
        JSON.stringify(result),
      ]);
      results.push(result);
    }
    return results;
  });
}
