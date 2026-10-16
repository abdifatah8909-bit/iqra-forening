import pg from 'pg';

const { types } = pg;

// Return dates as 'YYYY-MM-DD', timestamps as ISO 8601 and bigints as numbers,
// so rows can go straight to JSON and through the shared zod schemas.
types.setTypeParser(types.builtins.DATE, (v) => v);
const parseTimestamptz = types.getTypeParser(types.builtins.TIMESTAMPTZ);
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => (parseTimestamptz(v) as Date).toISOString());
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const WRITE_LOCK_KEY = 4711;

/**
 * Every transaction that writes replicated rows must go through here.
 * Holding one advisory lock for the whole transaction serialises writers, so
 * server_seq values become visible in strictly increasing order and a pull
 * with `server_seq > cursor` can never miss a row committed late.
 * Grassroots traffic is low enough that a single writer is not a bottleneck.
 */
export function withWriteLock<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [WRITE_LOCK_KEY]);
    return fn(tx);
  });
}
