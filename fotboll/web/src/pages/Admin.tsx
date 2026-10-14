import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { LOCALES, ROLES, type Role } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Empty, Field, MatchCard, TopBar, useToast } from '../components';
import { db } from '../db';
import { playerName, useLookups, useOnline } from '../hooks';
import { LANGUAGE_NAMES } from '../i18n';
import { save } from '../mutate';

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  roles: { role: Role; club_id: string | null }[];
}

export function AdminPage() {
  const { t } = useTranslation();
  const lookups = useLookups();

  const data = useLiveQuery(async () => {
    const reports = await db.data('match_reports').where('status').equals('submitted').toArray();
    const matches = (await db.data('matches').bulkGet(reports.map((r) => r.id))).filter((m) => !!m);
    const registrations = await db.data('registrations').where('status').equals('pending').toArray();
    const venues = await db.data('venues').orderBy('name').toArray();
    return { reports: new Map(reports.map((r) => [r.id, r])), matches, registrations, venues };
  }, []);
  if (!data) return <TopBar title={t('admin.title')} back />;

  return (
    <>
      <TopBar title={t('admin.title')} back />
      <main>
        <h2>{t('home.to_approve')}</h2>
        <div className="list">
          {data.matches.length === 0 && <Empty />}
          {data.matches.map((m) => (
            <div key={m!.id}>
              <MatchCard match={m!} report={data.reports.get(m!.id)} home={lookups.teams.get(m!.home_team_id)} away={lookups.teams.get(m!.away_team_id)} />
            </div>
          ))}
        </div>

        <h2>{t('home.pending_registrations')}</h2>
        <div className="list">
          {data.registrations.length === 0 && <Empty />}
          {data.registrations.map((r) => (
            <div key={r.id}>
              <span className="grow">
                <Link to={`/players/${r.player_id}`}>{playerName(lookups.players.get(r.player_id)) || '…'}</Link>
                <div className="sub">{lookups.clubs.get(r.club_id)?.name}</div>
              </span>
              <button className="small" onClick={() => save('registrations', { id: r.id, status: 'approved' })}>
                {t('registration.approve')}
              </button>
              <button className="danger small" onClick={() => save('registrations', { id: r.id, status: 'rejected' })}>
                {t('registration.reject')}
              </button>
            </div>
          ))}
        </div>

        <h2>{t('admin.venues')}</h2>
        <div className="list">
          {data.venues.map((v) => (
            <div key={v.id}>
              <span className="grow">
                <div>{v.name}</div>
                <div className="sub">{v.address}</div>
              </span>
            </div>
          ))}
        </div>
        <VenueForm />

        <Users />
      </main>
    </>
  );
}

function VenueForm() {
  const { t } = useTranslation();
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        await save('venues', { name: f.get('name') as string, address: (f.get('address') as string) || null, lat: null, lng: null });
        form.reset();
      }}
    >
      <div className="grid2">
        <Field label={t('admin.new_venue')}>
          <input name="name" required />
        </Field>
        <Field label={t('admin.address')}>
          <input name="address" />
        </Field>
      </div>
      <button className="secondary">{t('common.add')}</button>
    </form>
  );
}

/** Accounts live only on the server (passwords), so this section needs a connection. */
function Users() {
  const { t } = useTranslation();
  const online = useOnline();
  const toast = useToast();
  const { clubs } = useLookups();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('referee');

  const load = useCallback(() => {
    api<AdminUser[]>('/admin/users')
      .then(setUsers)
      .catch((e) => setError(e instanceof ApiError ? e.code : 'unknown'));
  }, []);
  useEffect(() => {
    if (online) load();
  }, [online, load]);

  return (
    <>
      <h2>{t('admin.users')}</h2>
      {!online && <p className="notice">{t('common.online_only')}</p>}
      {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
      {users && (
        <div className="list">
          {users.map((u) => (
            <div key={u.id}>
              <span className="grow">
                <div>{u.display_name}</div>
                <div className="sub" dir="ltr" style={{ textAlign: 'start' }}>
                  {u.email}
                </div>
                <div className="row">
                  {u.roles.map((r, i) => (
                    <span key={i} className="chip">
                      {t(`roles.${r.role}`)}
                      {r.club_id ? ` · ${clubs.get(r.club_id)?.name ?? ''}` : ''}
                    </span>
                  ))}
                  {!u.is_active && <span className="chip grey">{t('admin.inactive')}</span>}
                </div>
              </span>
              <button
                className="secondary small"
                disabled={!online}
                onClick={async () => {
                  await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { is_active: !u.is_active } });
                  load();
                }}
              >
                {u.is_active ? t('admin.deactivate') : t('admin.activate')}
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          try {
            await api('/admin/users', {
              method: 'POST',
              json: {
                email: f.get('email'),
                display_name: f.get('display_name'),
                password: f.get('password'),
                locale: f.get('locale'),
                roles: [{ role, club_id: role === 'club_admin' ? f.get('club_id') : null }],
              },
            });
            form.reset();
            toast.show(t('admin.user_created'));
            setError(null);
            load();
          } catch (err) {
            setError(err instanceof ApiError ? err.code : 'unknown');
          }
        }}
      >
        <h3 style={{ marginBlockEnd: 10 }}>{t('admin.new_user')}</h3>
        <Field label={t('admin.display_name')}>
          <input name="display_name" required />
        </Field>
        <Field label={t('auth.email')}>
          <input name="email" type="email" required dir="ltr" />
        </Field>
        <Field label={t('auth.password')}>
          <input name="password" type="password" minLength={8} required dir="ltr" autoComplete="new-password" />
        </Field>
        <div className="grid2">
          <Field label={t('admin.roles')}>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.language')}>
            <select name="locale">
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {role === 'club_admin' && (
          <Field label={t('competition.club')}>
            <select name="club_id" required>
              {[...clubs.values()].map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button disabled={!online}>{t('common.add')}</button>
      </form>
      {toast.node}
    </>
  );
}
