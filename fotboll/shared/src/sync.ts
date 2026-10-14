import { z } from 'zod';
import { WRITABLE_TABLES, type SyncTable, type WritableTable } from './tables.js';

/**
 * Sync protocol.
 *
 * Push: the client sends its outbox in order. Every mutation carries a
 * client-generated UUID so retries after a network failure are idempotent.
 * An "upsert" carries only the fields the user changed (a patch); the server
 * merges it onto the current row, which gives field-level last-writer-wins.
 *
 * Pull: the client asks for everything with server_seq > cursor. server_seq
 * comes from one global sequence that is only advanced while holding a
 * write lock, so sequence order equals commit order and no row is skipped.
 */

export const mutationSchema = z.object({
  id: z.string().uuid(),
  table: z.enum(WRITABLE_TABLES as [WritableTable, ...WritableTable[]]),
  op: z.enum(['upsert', 'delete']),
  row_id: z.string().uuid(),
  data: z.record(z.unknown()).default({}),
  /** server_seq of the row the client edited, for conflict logging. */
  base_seq: z.number().int().nonnegative().nullable().optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;

export const pushRequestSchema = z.object({
  mutations: z.array(mutationSchema).max(200),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export type MutationStatus = 'ok' | 'rejected';

export interface MutationResult {
  id: string;
  status: MutationStatus;
  /** Machine-readable reason, translated on the client (errors.<reason>). */
  reason?: string;
  /** Canonical row after the mutation (or the unchanged row on rejection; null if it does not exist). */
  row?: Record<string, unknown> | null;
}

export interface PushResponse {
  results: MutationResult[];
}

export interface PullResponse {
  /** Pass back as `since` on the next pull. */
  cursor: number;
  /** Fingerprint of what this user may see. When it changes the client must resync from 0. */
  scope: string;
  /** True when the client's scope was stale: it must clear local data and apply this as a fresh copy. */
  reset: boolean;
  has_more: boolean;
  changes: Partial<Record<SyncTable, Record<string, unknown>[]>>;
}

export const PULL_PAGE_SIZE = 1000;
