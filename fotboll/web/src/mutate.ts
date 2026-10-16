import { uuidv7, type Mutation, type RowTypes, type WritableTable } from '@fotboll/shared';
import { db } from './db';

type Row = Record<string, unknown>;
let afterWrite: () => void = () => {};

/** The sync engine registers itself here to be woken up after local writes. */
export function onLocalWrite(fn: () => void) {
  afterWrite = fn;
}

export function applyPatch(existing: Row | undefined, m: Mutation): Row | null {
  if (m.op === 'delete') return null;
  return { ...(existing ?? {}), ...m.data, id: m.row_id };
}

/**
 * Optimistic local write: the row changes in IndexedDB immediately and the
 * change is queued in the outbox. For a new row pass every field; for an
 * existing row pass only the changed fields (the server merges per field).
 */
export async function save<K extends WritableTable>(
  table: K,
  data: Partial<RowTypes[K]> & { id?: string },
): Promise<string> {
  const id = data.id ?? uuidv7();
  await db.transaction('rw', db.data(table), db.outbox, db.meta, async () => {
    const existing = (await db.data(table).get(id)) as Row | undefined;
    const now = new Date().toISOString();
    const patch: Row = { ...data, id };
    const m: Mutation = {
      id: uuidv7(),
      table,
      op: 'upsert',
      row_id: id,
      data: patch,
      base_seq: (existing?.server_seq as number | undefined) ?? null,
    };
    const base = existing ?? {
      federation_id: await db.getMeta<string>('federation_id'),
      created_at: now,
      updated_by: null,
      deleted_at: null,
      server_seq: 0,
    };
    await db.data(table).put({ ...applyPatch(base, m), updated_at: now } as never);
    await db.outbox.add({ table, row_id: id, mutation: m });
  });
  afterWrite();
  return id;
}

export async function remove(table: WritableTable, id: string) {
  await db.transaction('rw', db.data(table), db.outbox, async () => {
    const existing = (await db.data(table).get(id)) as Row | undefined;
    await db.data(table).delete(id);
    await db.outbox.add({
      table,
      row_id: id,
      mutation: {
        id: uuidv7(),
        table,
        op: 'delete',
        row_id: id,
        data: {},
        base_seq: (existing?.server_seq as number | undefined) ?? null,
      },
    });
  });
  afterWrite();
}
