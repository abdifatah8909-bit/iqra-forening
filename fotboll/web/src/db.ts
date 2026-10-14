import Dexie, { type Table } from 'dexie';
import type { Mutation, RowTypes, SyncTable } from '@fotboll/shared';

export interface OutboxEntry {
  seq?: number;
  table: Mutation['table'];
  row_id: string;
  mutation: Mutation;
}

export interface BlobEntry {
  id: string;
  blob: Blob;
  /** 1 while the bytes still need to be uploaded (IndexedDB cannot index booleans). */
  pending: 0 | 1;
}

export interface SyncError {
  id?: number;
  table: string;
  row_id: string;
  reason: string;
  at: string;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

type DataTables = { [K in SyncTable]: Table<RowTypes[K], string> };

/**
 * The device's database. The UI reads and writes only here; the sync
 * engine moves changes to and from the server in the background.
 */
export class LocalDb extends Dexie {
  outbox!: Table<OutboxEntry, number>;
  blobs!: Table<BlobEntry, string>;
  sync_errors!: Table<SyncError, number>;
  meta!: Table<MetaEntry, string>;

  constructor(name = 'fotboll') {
    super(name);
    this.version(1).stores({
      federations: 'id',
      clubs: 'id, name',
      players: 'id, club_id, last_name',
      registrations: 'id, player_id, club_id, status',
      media: 'id',
      seasons: 'id, starts_on',
      competitions: 'id, season_id',
      teams: 'id, club_id, competition_id',
      squad_members: 'id, team_id, player_id',
      venues: 'id, name',
      matches: 'id, competition_id, kickoff_at, referee_user_id',
      match_reports: 'id, status',
      match_lineups: 'id, match_id',
      match_events: 'id, match_id',
      user_profiles: 'id',
      outbox: '++seq, row_id',
      blobs: 'id, pending',
      sync_errors: '++id',
      meta: 'key',
    });
  }

  data<K extends SyncTable>(table: K): DataTables[K] {
    return this.table(table) as DataTables[K];
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  setMeta(key: string, value: unknown) {
    return this.meta.put({ key, value });
  }
}

export let db = new LocalDb();

/** For tests: point the app at a fresh database. */
export function useDatabase(next: LocalDb) {
  db = next;
}
