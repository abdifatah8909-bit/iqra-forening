import { useSyncExternalStore } from 'react';
import type { Locale, Role } from '@fotboll/shared';
import { api, setToken, setUnauthorizedHandler } from './api';
import { db } from './db';
import { chosenLanguage } from './i18n/chosen';

export interface Me {
  id: string;
  email: string;
  display_name: string;
  locale: Locale;
  federation_id: string;
  roles: { role: Role; club_id: string | null }[];
}

interface SessionState {
  ready: boolean;
  me: Me | null;
  /** The server rejected our token; local data is kept until the same user signs in again. */
  expired: boolean;
}

let state: SessionState = { ready: false, me: null, expired: false };
const listeners = new Set<() => void>();
const set = (next: Partial<SessionState>) => {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
};

export function useSession() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/** Restore the saved session; works without a network connection. */
export async function restoreSession() {
  setUnauthorizedHandler(() => set({ expired: true }));
  try {
    const token = await db.getMeta<string>('token');
    const me = await db.getMeta<Me>('me');
    setToken(token ?? null);
    set({ ready: true, me: token && me ? me : null });
  } catch {
    // Storage blocked (e.g. some private modes): show the sign-in screen.
    set({ ready: true, me: null });
  }
}

export async function login(email: string, password: string) {
  const res = await api<{ token: string; user: Me }>('/auth/login', {
    method: 'POST',
    json: { email, password },
  });
  await startSession(res.token, res.user);
  return res.user;
}

/** Uses an invitation or reset link: the server sets the password and signs the user in. */
export async function setPasswordWithLink(linkToken: string, password: string) {
  const res = await api<{ token: string; user: Me }>('/auth/set-password', {
    method: 'POST',
    json: { token: linkToken, password },
  });
  await startSession(res.token, res.user);
  return res.user;
}

export async function startSession(token: string, me: Me, opts: { keepData?: boolean } = {}) {
  // A language picked before signing in replaces the one saved on the account.
  const picked = chosenLanguage({ consume: true });
  const changeLocale = picked !== null && picked !== me.locale;
  if (changeLocale) me = { ...me, locale: picked };
  const previous = await db.getMeta<Me>('me');
  // A different person on the same phone must not see the previous user's data.
  if (previous && previous.id !== me.id && !opts.keepData) await wipeLocalData();
  await db.setMeta('token', token);
  await db.setMeta('me', me);
  await db.setMeta('federation_id', me.federation_id);
  setToken(token);
  if (changeLocale && !token.startsWith('demo-')) api('/me', { method: 'PATCH', json: { locale: me.locale } }).catch(() => {});
  // Ask the browser not to evict our offline data under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
  set({ me, expired: false });
}

export async function updateMe(patch: Partial<Pick<Me, 'locale' | 'display_name'>>) {
  if (!state.me) return;
  const me = { ...state.me, ...patch };
  await db.setMeta('me', me);
  set({ me });
  // Best effort: the preference also applies offline. The demo has no server.
  if (!(await db.getMeta<string>('token'))?.startsWith('demo-')) api('/me', { method: 'PATCH', json: patch }).catch(() => {});
}

async function wipeLocalData() {
  await Promise.all(db.tables.map((t) => t.clear()));
}

export async function logout() {
  const token = await db.getMeta<string>('token');
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  // Demo: keep the shared example data so the next role continues from it.
  if (token?.startsWith('demo-')) await db.meta.bulkDelete(['token', 'me']);
  else await wipeLocalData();
  setToken(null);
  set({ me: null, expired: false });
}

export const hasRole = (me: Me | null, role: Role, clubId?: string) =>
  !!me?.roles.some((r) => r.role === role && (clubId === undefined || r.club_id === clubId));

export const isFedAdmin = (me: Me | null) => hasRole(me, 'federation_admin');
export const adminClubIds = (me: Me | null) =>
  me?.roles.filter((r) => r.role === 'club_admin').map((r) => r.club_id!) ?? [];
