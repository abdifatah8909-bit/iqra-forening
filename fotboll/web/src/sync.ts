import {
  SYNC_TABLES,
  type Mutation,
  type MutationResult,
  type PullResponse,
  type SyncTable,
} from '@fotboll/shared';
import { api, ApiError } from './api';
import { db } from './db';
import { uploadPendingMedia } from './media';
import { applyPatch, onLocalWrite } from './mutate';

type Row = Record<string, unknown>;

export interface Transport {
  push(mutations: Mutation[]): Promise<MutationResult[]>;
  pull(since: number, scope: string | undefined): Promise<PullResponse>;
}

export const httpTransport: Transport = {
  push: async (mutations) => (await api<{ results: MutationResult[] }>('/sync/push', { method: 'POST', json: { mutations } })).results,
  pull: (since, scope) => api<PullResponse>(`/sync/pull?since=${since}${scope ? `&scope=${scope}` : ''}`),
};

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: string | null;
  error: string | null;
}

const PUSH_BATCH = 100;

/**
 * Write a server row locally, then replay this row's still-pending outbox
 * mutations on top so the user's unsynced edits stay visible ("rebase").
 */
async function applyServerRow(table: SyncTable, row: Row) {
  const pending = await db.outbox.where('row_id').equals(row.id as string).sortBy('seq');
  let local: Row | null = row.deleted_at ? null : row;
  // Edits to a row the server has deleted would be rejected anyway; drop them locally.
  if (local) for (const p of pending) if (p.table === table) local = applyPatch(local ?? undefined, p.mutation);
  if (local) await db.data(table).put(local as never);
  else await db.data(table).delete(row.id as string);
}

/** Re-apply every pending mutation (after a reset wiped the local copy). */
async function replayOutbox() {
  for (const entry of await db.outbox.orderBy('seq').toArray()) {
    const table = db.data(entry.table);
    const next = applyPatch((await table.get(entry.row_id)) as Row | undefined, entry.mutation);
    if (next) await table.put(next as never);
    else await table.delete(entry.row_id);
  }
}

const dataTables = () => SYNC_TABLES.map((t) => db.table(t));

export class SyncEngine {
  state: SyncState = { status: 'idle', lastSyncAt: null, error: null };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private transport: Transport = httpTransport) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /** Debounced sync after local edits. */
  schedule(delayMs = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), delayMs);
  }

  /** Runs one full cycle; concurrent calls coalesce into one extra run. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async cycle() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ status: 'offline' });
      return;
    }
    this.set({ status: 'syncing' });
    try {
      await this.push();
      await this.pull();
      await uploadPendingMedia();
      const now = new Date().toISOString();
      await db.setMeta('last_sync_at', now);
      this.set({ status: 'idle', lastSyncAt: now, error: null });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      this.set({ status: code === 'network' ? 'offline' : 'error', error: code });
    }
  }

  async push() {
    for (;;) {
      const batch = await db.outbox.orderBy('seq').limit(PUSH_BATCH).toArray();
      if (!batch.length) return;
      const results = await this.transport.push(batch.map((b) => b.mutation));
      const byId = new Map(results.map((r) => [r.id, r]));
      await db.transaction('rw', [...dataTables(), db.outbox, db.sync_errors], async () => {
        for (const entry of batch) {
          const result = byId.get(entry.mutation.id);
          if (!result) continue;
          await db.outbox.delete(entry.seq!);
          if (result.status === 'rejected') {
            await db.sync_errors.add({
              table: entry.table,
              row_id: entry.row_id,
              reason: result.reason ?? 'unknown',
              at: new Date().toISOString(),
            });
          }
          // On success this is the canonical row; on rejection it rolls the optimistic change back.
          if (result.row) await applyServerRow(entry.table, result.row);
          else if (result.status === 'rejected') await applyServerRow(entry.table, { id: entry.row_id, deleted_at: 'rejected' });
        }
      });
    }
  }

  async pull() {
    let cursor = (await db.getMeta<number>('cursor')) ?? 0;
    let scope = await db.getMeta<string>('scope');
    for (;;) {
      const res = await this.transport.pull(cursor, scope);
      await db.transaction('rw', [...dataTables(), db.outbox, db.meta], async () => {
        if (res.reset) {
          // Visibility changed: start from a clean copy, keeping unsynced edits.
          for (const t of dataTables()) await t.clear();
        }
        for (const [table, rows] of Object.entries(res.changes) as [SyncTable, Row[]][]) {
          for (const row of rows) await applyServerRow(table, row);
        }
        if (res.reset) await replayOutbox();
        await db.setMeta('cursor', res.cursor);
        await db.setMeta('scope', res.scope);
      });
      cursor = res.cursor;
      scope = res.scope;
      if (!res.has_more) return;
    }
  }

  /** Wire up automatic syncing: after edits, when the network returns, and periodically. */
  start() {
    onLocalWrite(() => this.schedule());
    const goOnline = () => void this.syncNow();
    const goOffline = () => this.set({ status: 'offline' });
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const visible = () => document.visibilityState === 'visible' && void this.syncNow();
    document.addEventListener('visibilitychange', visible);
    const interval = setInterval(() => void this.syncNow(), 60_000);
    void db.getMeta<string>('last_sync_at').then((at) => this.set({ lastSyncAt: at ?? null }));
    void this.syncNow();
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', visible);
      clearInterval(interval);
      clearTimeout(this.timer);
    };
  }
}

export const syncEngine = new SyncEngine();
