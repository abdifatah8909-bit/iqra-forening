import {
  initialTransferStatus,
  LOCALES,
  LOCKED_REPORT_STATUSES,
  transferActions,
  uuidv7,
  scoreFromEvents,
  type MutationResult,
  type PublicData,
  type PullResponse,
  type ReportStatus,
  type Locale,
  type Role,
  type TransferStatus,
} from '@fotboll/shared';
import type { PlayerSearchHit } from './pages/Transfers';
import { db } from './db';
import { startSession, type Me } from './session';
import type { Transport } from './sync';

/**
 * Demo mode (VITE_DEMO=1): the whole app runs in the browser without a
 * server. A snapshot of the seed data stands in for the first pull, and
 * pushes are accepted locally with the server's side effects imitated.
 * Server-side permission checks and per-role data scoping do not run here;
 * the UI's own permission rules still apply.
 */
export const DEMO = import.meta.env.VITE_DEMO === '1';

interface Snapshot {
  accounts: Record<DemoKey, Me>;
  pull: PullResponse;
}
export type DemoKey = 'admin' | 'club' | 'referee';
export const DEMO_ACCOUNTS: { key: DemoKey; role: Role }[] = [
  { key: 'admin', role: 'federation_admin' },
  { key: 'club', role: 'club_admin' },
  { key: 'referee', role: 'referee' },
];

let snapshot: Snapshot | null = null;
async function loadSnapshot() {
  snapshot ??= (await import('../demo/snapshots.json')).default as unknown as Snapshot;
  return snapshot;
}

/** All roles share one local copy, so switching role keeps what was done in another. */
export async function demoLogin(key: DemoKey) {
  const s = await loadSnapshot();
  // Roles have different saved languages; in the demo the one on screen applies to all of them.
  const onScreen = document.documentElement.lang;
  const locale = (LOCALES as readonly string[]).includes(onScreen) ? (onScreen as Locale) : s.accounts[key].locale;
  await startSession(`demo-${key}`, { ...s.accounts[key], locale }, { keepData: true });
}

const WEEK = 7 * 86400000;

/** Move the fixtures so the last played round was within the past week, whenever the demo is opened. */
function shiftDates(pull: PullResponse): PullResponse {
  const reports = new Map((pull.changes.match_reports ?? []).map((r) => [r.id, r]));
  const matches = pull.changes.matches ?? [];
  const played = matches.filter((m) => reports.has(m.id as string)).map((m) => Date.parse(m.kickoff_at as string));
  if (!played.length) return pull;
  const offset = Math.floor((Date.now() - Math.max(...played)) / WEEK) * WEEK;
  return {
    ...pull,
    changes: {
      ...pull.changes,
      matches: matches.map((m) => ({ ...m, kickoff_at: new Date(Date.parse(m.kickoff_at as string) + offset).toISOString() })),
    },
  };
}

let seq = Date.now();

export const demoTransport: Transport = {
  async pull(since, scope) {
    if (scope === 'demo') return { cursor: since, scope: 'demo', reset: false, has_more: false, changes: {} };
    const pull = shiftDates((await loadSnapshot()).pull);
    return { ...pull, scope: 'demo', reset: true, has_more: false };
  },

  async push(mutations) {
    const me = await db.getMeta<Me>('me');
    const now = new Date().toISOString();
    const results: MutationResult[] = [];
    for (const m of mutations) {
      const local = (await db.data(m.table).get(m.row_id)) as Record<string, unknown> | undefined;
      if (m.op === 'delete') {
        results.push({ id: m.id, status: 'ok', row: { ...(local ?? { id: m.row_id }), deleted_at: now } });
        continue;
      }
      const row: Record<string, unknown> = { ...local, ...m.data, id: m.row_id, server_seq: ++seq, updated_at: now, updated_by: me?.id };

      if (m.table === 'match_reports' && (row.status === 'submitted' || row.status === 'approved')) {
        const match = await db.data('matches').get(m.row_id);
        const events = await db.data('match_events').where('match_id').equals(m.row_id).toArray();
        if (match) {
          const score = scoreFromEvents(events, match.home_team_id, match.away_team_id);
          row.home_score = score.home;
          row.away_score = score.away;
          await db.data('matches').update(match.id, { status: 'played' });
        }
        if (row.status === 'submitted' && !row.submitted_at) Object.assign(row, { submitted_at: now, submitted_by: me?.id });
        if (row.status === 'approved') Object.assign(row, { approved_at: now, approved_by: me?.id });
      }
      if (m.table === 'registrations' && m.data.status && m.data.status !== 'pending') {
        Object.assign(row, { decided_by: me?.id, decided_at: now });
        if (m.data.status === 'approved') await db.data('players').update(row.player_id as string, { club_id: row.club_id as string });
      }
      if (m.table === 'transfers') {
        const rejection = await demoTransfer(m.data, row, local, me, now);
        if (rejection) {
          results.push({ id: m.id, status: 'rejected', reason: rejection, row: local?.server_seq ? local : null });
          continue;
        }
      }
      if (m.table === 'media') row.upload_status = 'done';
      results.push({ id: m.id, status: 'ok', row });
    }
    return results;
  },
};

/**
 * The public pages in the demo: built from this browser's copy of the data
 * (so a report submitted in the demo shows up), or from the snapshot before
 * anyone has signed in.
 */
export async function demoPublicData(): Promise<PublicData> {
  type Rows = Record<string, Record<string, unknown>[]>;
  let src: Rows;
  if (await db.data('federations').count()) {
    const tables = ['federations', 'seasons', 'competitions', 'clubs', 'teams', 'venues', 'matches', 'match_reports'] as const;
    src = Object.fromEntries(
      await Promise.all(tables.map(async (t) => [t, (await db.data(t).toArray()) as unknown as Record<string, unknown>[]])),
    );
  } else {
    src = shiftDates((await loadSnapshot()).pull).changes as Rows;
  }
  const live = (t: string) => (src[t] ?? []).filter((r) => !r.deleted_at);
  const f = live('federations')[0];
  return {
    federation: { id: f.id, name: f.name, country: f.country ?? null, default_locale: f.default_locale } as PublicData['federation'],
    seasons: live('seasons') as unknown as PublicData['seasons'],
    competitions: live('competitions') as unknown as PublicData['competitions'],
    clubs: live('clubs').filter((c) => c.status === 'active') as unknown as PublicData['clubs'],
    teams: live('teams') as unknown as PublicData['teams'],
    venues: live('venues') as unknown as PublicData['venues'],
    matches: live('matches') as unknown as PublicData['matches'],
    results: live('match_reports')
      .filter((r) => LOCKED_REPORT_STATUSES.includes(r.status as ReportStatus))
      .map((r) => ({ id: r.id as string, home_score: r.home_score as number, away_score: r.away_score as number })),
  };
}

/** The server's transfer rules and side effects, imitated for the demo. */
async function demoTransfer(
  patch: Record<string, unknown>,
  row: Record<string, unknown>,
  local: Record<string, unknown> | undefined,
  me: Me | undefined,
  now: string,
): Promise<string | null> {
  const actor = {
    isFedAdmin: !!me?.roles.some((r) => r.role === 'federation_admin'),
    clubIds: me?.roles.filter((r) => r.role === 'club_admin').map((r) => r.club_id!) ?? [],
  };
  const player = await db.data('players').get(row.player_id as string);
  if ('player_id' in patch) {
    // New request: the starting point follows the player's current club.
    const from = player?.club_id ?? null;
    if (from === row.to_club_id) return 'already_in_club';
    Object.assign(row, { from_club_id: from, status: initialTransferStatus(from), requested_by: me?.id });
    return null;
  }
  const target = patch.status as TransferStatus | undefined;
  if (!target || !local) return null;
  // The local row already shows the new status (optimistic), so work out the step it came from.
  const previous: TransferStatus =
    target === 'approved' || local.released_at || !local.from_club_id ? 'pending_federation' : 'pending_club';
  if (row.decided_at || (target === 'pending_federation' && row.released_at)) return null; // already applied
  const state = { status: previous, from_club_id: (local.from_club_id as string) ?? null, to_club_id: row.to_club_id as string };
  if (!transferActions(state, actor).includes(target)) return 'forbidden';
  if (target === 'pending_federation') Object.assign(row, { released_by: me?.id, released_at: now });
  if (target === 'approved' || target === 'rejected') Object.assign(row, { decided_by: me?.id, decided_at: now });
  if (target === 'approved' && player) {
    const to = row.to_club_id as string;
    await db.data('players').update(player.id, { club_id: to });
    const teams = new Map((await db.data('teams').toArray()).map((x) => [x.id, x.club_id]));
    for (const sm of await db.data('squad_members').where('player_id').equals(player.id).toArray()) {
      if (teams.get(sm.team_id) !== to) await db.data('squad_members').delete(sm.id);
    }
    const today = now.slice(0, 10);
    const seasons = await db.data('seasons').orderBy('starts_on').reverse().toArray();
    const season = seasons.find((x) => x.starts_on <= today && today <= x.ends_on) ?? seasons[0];
    if (season) {
      await db.data('registrations').put({
        id: uuidv7(), player_id: player.id, club_id: to, season_id: season.id, status: 'approved', note: 'transfer',
        decided_by: me?.id ?? null, decided_at: now, federation_id: player.federation_id, created_at: now,
        updated_at: now, updated_by: me?.id ?? null, deleted_at: null, server_seq: ++seq,
      });
    }
  }
  return null;
}

/** Player search for transfer requests, against this browser's copy of the data. */
export async function demoSearchPlayers(q: Record<string, string>): Promise<PlayerSearchHit[]> {
  const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const clubs = new Map((await db.data('clubs').toArray()).map((c) => [c.id, c.name]));
  const open = new Set(
    (await db.data('transfers').toArray()).filter((x) => x.status === 'pending_club' || x.status === 'pending_federation').map((x) => x.player_id),
  );
  const players = (await db.data('players').toArray()).filter((p) =>
    q.license_no
      ? lower(p.license_no) === lower(q.license_no)
      : lower(p.first_name) === lower(q.first_name) && lower(p.last_name) === lower(q.last_name) && p.birth_date === q.birth_date,
  );
  return players.slice(0, 10).map((p) => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    birth_year: Number(p.birth_date.slice(0, 4)),
    club_id: p.club_id ?? null,
    club_name: p.club_id ? (clubs.get(p.club_id) ?? null) : null,
    open_transfer: open.has(p.id),
  }));
}
