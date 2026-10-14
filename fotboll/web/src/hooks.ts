import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useSyncExternalStore, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LOCKED_REPORT_STATUSES,
  type Club,
  type Competition,
  type Match,
  type MatchReport,
  type Player,
  type Team,
} from '@fotboll/shared';
import { db } from './db';
import { adminClubIds, isFedAdmin, useSession, type Me } from './session';
import { syncEngine } from './sync';

export function useMe(): Me {
  return useSession().me!;
}

export function useSyncState() {
  const state = useSyncExternalStore(
    (fn) => syncEngine.subscribe(fn),
    () => syncEngine.state,
  );
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  return { ...state, pending };
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Id → row maps for the small reference tables used on most screens. */
export function useLookups() {
  return (
    useLiveQuery(async () => {
      const [teams, clubs, players, users] = await Promise.all([
        db.data('teams').toArray(),
        db.data('clubs').toArray(),
        db.data('players').toArray(),
        db.data('user_profiles').toArray(),
      ]);
      return {
        teams: new Map(teams.map((t) => [t.id, t])),
        clubs: new Map(clubs.map((c) => [c.id, c])),
        players: new Map(players.map((p) => [p.id, p])),
        users: new Map(users.map((u) => [u.id, u])),
      };
    }, []) ?? {
      teams: new Map<string, Team>(),
      clubs: new Map<string, Club>(),
      players: new Map<string, Player>(),
      users: new Map(),
    }
  );
}

export function useCompetitionName() {
  const { i18n } = useTranslation();
  return (c: Competition | undefined) =>
    c ? (c.name_i18n?.[i18n.language as 'so' | 'en' | 'ar'] || c.name) : '';
}

export const playerName = (p: Player | undefined) => (p ? `${p.first_name} ${p.last_name}` : '');

export const isReportLocked = (r: MatchReport | undefined) =>
  !!r && LOCKED_REPORT_STATUSES.includes(r.status);

/** UI-side mirror of the server rules (the server always has the final say). */
export const can = {
  editClub: (me: Me, clubId: string) => isFedAdmin(me) || adminClubIds(me).includes(clubId),
  createPlayer: (me: Me, clubId?: string) =>
    isFedAdmin(me) || (clubId ? adminClubIds(me).includes(clubId) : adminClubIds(me).length > 0),
  editPlayer: (me: Me, p: Player) => isFedAdmin(me) || (!!p.club_id && adminClubIds(me).includes(p.club_id)),
  editLineup: (me: Me, match: Match, team: Team | undefined, report: MatchReport | undefined) =>
    isFedAdmin(me) ||
    (!isReportLocked(report) &&
      (match.referee_user_id === me.id || (!!team && adminClubIds(me).includes(team.club_id)))),
  editEvents: (me: Me, match: Match, report: MatchReport | undefined) =>
    isFedAdmin(me) || (!isReportLocked(report) && match.referee_user_id === me.id),
  submitReport: (me: Me, match: Match, report: MatchReport | undefined) =>
    match.referee_user_id === me.id && !isReportLocked(report),
};

/** The season that contains today, else the most recent one. */
export function useCurrentSeason() {
  return useLiveQuery(async () => {
    const seasons = await db.data('seasons').orderBy('starts_on').reverse().toArray();
    const today = new Date().toISOString().slice(0, 10);
    return seasons.find((s) => s.starts_on <= today && today <= s.ends_on) ?? seasons[0];
  }, []);
}
