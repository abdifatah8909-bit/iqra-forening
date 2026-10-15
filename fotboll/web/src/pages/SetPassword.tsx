import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Locale } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Field } from '../components';
import { setLanguage } from '../i18n';
import { setPasswordWithLink } from '../session';
import icon from '../icon.svg';

interface LinkInfo {
  purpose: 'invite' | 'reset';
  email: string;
  display_name: string;
  locale: Locale;
}

/** Landing page for invitation and password-reset links: choose a password, then straight into the app. */
export function SetPasswordPage() {
  const { token } = useParams() as { token: string };
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<LinkInfo>(`/auth/token/${encodeURIComponent(token)}`)
      .then((i) => {
        setInfo(i);
        setLanguage(i.locale);
      })
      .catch((err) => setError(err instanceof ApiError ? err.code : 'unknown'));
  }, [token]);

  const mismatch = repeat !== '' && password !== repeat;

  return (
    <div className="login">
      <img className="logo" src={icon} alt="" />
      <h1 className="center" style={{ marginBlockEnd: 16 }}>
        {t('app.name')}
      </h1>
      {!info && !error && <p className="center muted">…</p>}
      {error && (
        <div className="card">
          <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>
          <Link to="/" className="button secondary" style={{ display: 'flex' }}>
            {t('auth.to_login')}
          </Link>
        </div>
      )}
      {info && (
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (password !== repeat) return;
            setBusy(true);
            setError(null);
            try {
              await setPasswordWithLink(token, password);
              navigate('/', { replace: true });
            } catch (err) {
              setError(err instanceof ApiError ? err.code : 'unknown');
              setBusy(false);
            }
          }}
        >
          <h2 style={{ marginBlockStart: 0 }}>
            {info.purpose === 'invite' ? t('auth.welcome', { name: info.display_name }) : t('auth.new_password_title')}
          </h2>
          <p className="muted small">{info.purpose === 'invite' ? t('auth.invite_intro') : t('auth.reset_intro')}</p>
          <Field label={t('auth.email')}>
            <input type="email" value={info.email} readOnly dir="ltr" autoComplete="username" />
          </Field>
          <Field label={t('auth.new_password')}>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label={t('auth.repeat_password')}>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              dir="ltr"
            />
          </Field>
          <p className="muted small">{t('auth.password_rules')}</p>
          {mismatch && <p className="error-text">{t('auth.passwords_differ')}</p>}
          <button className="block" disabled={busy || mismatch || password.length < 8}>
            {t('auth.save_password')}
          </button>
        </form>
      )}
    </div>
  );
}
