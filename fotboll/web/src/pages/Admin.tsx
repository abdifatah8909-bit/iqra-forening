import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { LOCALES, ROLES, type Role } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Empty, Field, MatchCard, TopBar, useToast } from '../components';
import { db } from '../db';
import { activeBansFor, playerName, useBanLabel, useBans, useLookups, useOnline } from '../hooks';
import { LANGUAGE_NAMES } from '../i18n';
import { save } from '../mutate';
import { DEMO } from '../demo';

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  /** Invited but has not chosen a password yet. */
  invited: boolean;
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

        <FederationSettings />

        <ActiveBans />

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

/** The federation's name, shown on the public pages and in emails. */
function FederationSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const federation = useLiveQuery(async () => (await db.data('federations').toArray())[0], []);
  if (!federation) return null;
  return (
    <>
      <h2>{t('admin.federation')}</h2>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get('name')).trim();
          if (name && name !== federation.name) {
            await save('federations', { id: federation.id, name });
            toast.show(t('common.saved'));
          }
        }}
      >
        <Field label={t('admin.federation_name')}>
          <input name="name" required maxLength={200} defaultValue={federation.name} key={federation.name} />
        </Field>
        <p className="muted small">{t('admin.federation_name_hint')}</p>
        <button className="secondary">{t('common.save')}</button>
        {toast.node}
      </form>
    </>
  );
}

/** Everyone currently suspended, so the federation can follow up before match day. */
function ActiveBans() {
  const { t } = useTranslation();
  const bans = useBans();
  const banLabel = useBanLabel();
  const { players, teams } = useLookups();
  const playerIds = [...new Set(bans.map((b) => b.player_id))];
  const rows = playerIds.flatMap((id) => activeBansFor(bans, id));
  return (
    <>
      <h2>{t('discipline.active_title')}</h2>
      <div className="list">
        {rows.length === 0 && <Empty />}
        {rows.map((b) => (
          <Link key={b.key} to={`/players/${b.player_id}`}>
            <span className="grow">
              <div>{playerName(players.get(b.player_id)) || t('match.unknown_player')}</div>
              <div className="sub">
                {b.team_id ? teams.get(b.team_id)?.name : t('discipline.all_competitions')} ·{' '}
                {b.reasons.map((r) => t(`discipline.reason.${r}`)).join(' + ')}
              </div>
            </span>
            <span className="chip ban">{banLabel(b)}</span>
          </Link>
        ))}
      </div>
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

interface IssuedLink {
  name: string;
  purpose: 'invite' | 'reset';
  token: string;
  emailed: boolean;
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
  const [ownPassword, setOwnPassword] = useState(false);
  const [issued, setIssued] = useState<IssuedLink | null>(null);

  const load = useCallback(() => {
    api<AdminUser[]>('/admin/users')
      .then(setUsers)
      .catch((e) => setError(e instanceof ApiError ? e.code : 'unknown'));
  }, []);
  useEffect(() => {
    if (online && !DEMO) load();
  }, [online, load]);

  if (DEMO)
    return (
      <>
        <h2>{t('admin.users')}</h2>
        <p className="notice">{t('demo.no_server')}</p>
      </>
    );

  const newLink = async (u: AdminUser) => {
    try {
      const link = await api<Omit<IssuedLink, 'name'>>(`/admin/users/${u.id}/link`, { method: 'POST' });
      setIssued({ ...link, name: u.display_name });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'unknown');
    }
  };

  return (
    <>
      <h2>{t('admin.users')}</h2>
      {!online && <p className="notice">{t('common.online_only')}</p>}
      {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
      {issued && <LinkCard link={issued} onClose={() => setIssued(null)} />}
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
                  {u.invited && <span className="chip warn">{t('admin.invited')}</span>}
                  {!u.is_active && <span className="chip grey">{t('admin.inactive')}</span>}
                </div>
              </span>
              <span style={{ display: 'grid', gap: 6 }}>
                {u.is_active && (
                  <button className="secondary small" disabled={!online} onClick={() => newLink(u)}>
                    {u.invited ? t('admin.new_invite') : t('admin.reset_link')}
                  </button>
                )}
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
              </span>
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
          const name = f.get('display_name') as string;
          try {
            const res = await api<{ id: string; link?: Omit<IssuedLink, 'name'> }>('/admin/users', {
              method: 'POST',
              json: {
                email: f.get('email'),
                display_name: name,
                ...(ownPassword ? { password: f.get('password') } : {}),
                locale: f.get('locale'),
                roles: [{ role, club_id: role === 'club_admin' ? f.get('club_id') : null }],
              },
            });
            form.reset();
            setOwnPassword(false);
            if (res.link) setIssued({ ...res.link, name });
            else toast.show(t('admin.user_created'));
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
        <label className="check">
          <input type="checkbox" checked={ownPassword} onChange={(e) => setOwnPassword(e.target.checked)} />
          {t('admin.set_password_myself')}
        </label>
        {ownPassword ? (
          <Field label={t('auth.password')}>
            <input name="password" type="password" minLength={8} required dir="ltr" autoComplete="new-password" />
          </Field>
        ) : (
          <p className="muted small">{t('admin.invite_note')}</p>
        )}
        <button disabled={!online}>{ownPassword ? t('common.add') : t('admin.invite')}</button>
      </form>
      {toast.node}
    </>
  );
}

/**
 * Shows a fresh invitation or reset link. It is emailed when the server can,
 * and can always be passed on by hand: many users are easier to reach on WhatsApp.
 */
function LinkCard({ link, onClose }: { link: IssuedLink; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/set-password/${link.token}`;
  const message = t(link.purpose === 'invite' ? 'admin.share_invite' : 'admin.share_reset', { name: link.name, link: url });
  return (
    <div className="card" style={{ borderColor: 'var(--brand)' }}>
      <h3 style={{ marginBlockEnd: 8 }}>{link.purpose === 'invite' ? t('admin.invite_ready', { name: link.name }) : t('admin.reset_ready', { name: link.name })}</h3>
      <p className="small">{link.emailed ? t('admin.link_emailed') : t('admin.link_not_emailed')}</p>
      <input readOnly value={url} dir="ltr" onFocus={(e) => e.target.select()} style={{ marginBlockEnd: 8 }} />
      <div className="row">
        <button
          type="button"
          className="small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              // Clipboard blocked: the field above can still be selected by hand.
            }
          }}
        >
          {copied ? t('admin.copied') : t('admin.copy')}
        </button>
        <a className="button secondary small" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
          WhatsApp
        </a>
        <a className="button secondary small" href={`sms:?&body=${encodeURIComponent(message)}`}>
          SMS
        </a>
        <button type="button" className="secondary small" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      <p className="muted small" style={{ marginBlockStart: 8 }}>
        {link.purpose === 'invite' ? t('admin.link_valid_invite') : t('admin.link_valid_reset')}
      </p>
    </div>
  );
}
