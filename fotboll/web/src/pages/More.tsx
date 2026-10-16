import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { LOCALES } from '@fotboll/shared';
import { ask, TopBar } from '../components';
import { db } from '../db';
import { useMe, useSyncState } from '../hooks';
import { formatDateTime, LANGUAGE_NAMES, setLanguage } from '../i18n';
import { adminClubIds, isFedAdmin, logout, updateMe } from '../session';
import { syncEngine } from '../sync';

export function MorePage() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const sync = useSyncState();
  const navigate = useNavigate();
  const errors = useLiveQuery(() => db.sync_errors.reverse().toArray(), [], []);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);

  return (
    <>
      <TopBar title={t('nav.more')} />
      <main>
        {(isFedAdmin(me) || adminClubIds(me).length > 0) && (
          <div className="list">
            {isFedAdmin(me) && (
              <Link to="/admin">
                <span className="grow">{t('admin.title')}</span>
                <span aria-hidden>›</span>
              </Link>
            )}
            <Link to="/transfers">
              <span className="grow">{t('transfer.title')}</span>
              <span aria-hidden>›</span>
            </Link>
          </div>
        )}

        <h2>{t('public.share_title')}</h2>
        <div className="list">
          <Link to={`/public/${me.federation_id}`}>
            <span className="grow">
              <div>{t('public.link')}</div>
              <div className="sub">{t('public.share_text')}</div>
            </span>
            <span aria-hidden>›</span>
          </Link>
        </div>

        <h2>{t('settings.language')}</h2>
        <div className="segmented">
          {LOCALES.map((l) => (
            <button
              key={l}
              className={i18n.language === l ? 'active' : ''}
              onClick={() => {
                setLanguage(l);
                void updateMe({ locale: l });
              }}
            >
              {LANGUAGE_NAMES[l]}
            </button>
          ))}
        </div>

        <h2>{t('settings.sync')}</h2>
        <div className="card">
          <div className="spread">
            <span>
              {sync.lastSyncAt ? t('sync.last', { time: formatDateTime(sync.lastSyncAt) }) : t('sync.never')}
              {sync.pending > 0 && (
                <>
                  <br />
                  <span className="chip warn">{t('sync.pending', { count: sync.pending })}</span>
                </>
              )}
              {sync.error && (
                <div className="error-text">{t(`errors.${sync.error}`, { defaultValue: t('errors.unknown') })}</div>
              )}
            </span>
            <button className="secondary small" disabled={sync.status === 'syncing'} onClick={() => void syncEngine.syncNow()}>
              {t('sync.now')}
            </button>
          </div>
          {persisted !== null && (
            <p className="muted small" style={{ marginBlockStart: 10 }}>
              {persisted ? t('settings.storage_persisted') : t('settings.storage_not_persisted')}
            </p>
          )}
        </div>

        {errors.length > 0 && (
          <>
            <h2>{t('sync.rejected_title')}</h2>
            <div className="list">
              {errors.map((e) => (
                <div key={e.id}>
                  <span className="grow">
                    <div>{t(`errors.${e.reason}`, { defaultValue: t('errors.unknown') })}</div>
                    <div className="sub">{formatDateTime(e.at)}</div>
                  </span>
                </div>
              ))}
            </div>
            <button className="secondary small" onClick={() => db.sync_errors.clear()} style={{ marginBlockEnd: 12 }}>
              {t('sync.dismiss')}
            </button>
          </>
        )}

        <h2>{t('settings.account')}</h2>
        <div className="card">
          <strong>{me.display_name}</strong>
          <div className="muted small" dir="ltr" style={{ textAlign: 'start' }}>
            {me.email}
          </div>
          <div className="row" style={{ marginBlock: 8 }}>
            {me.roles.map((r, i) => (
              <span key={i} className="chip">
                {t(`roles.${r.role}`)}
              </span>
            ))}
          </div>
          <button
            className="danger"
            onClick={async () => {
              if (sync.pending && !(await ask(t('auth.logout_pending', { count: sync.pending }), { confirmLabel: t('auth.logout'), danger: true }))) return;
              // The next person to sign in starts on the home page.
              navigate('/', { replace: true });
              void logout();
            }}
          >
            {t('auth.logout')}
          </button>
        </div>

        <h2>{t('settings.privacy')}</h2>
        <p className="muted small">{t('settings.privacy_text')}</p>
      </main>
    </>
  );
}
