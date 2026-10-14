import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES } from '@fotboll/shared';
import { ApiError } from '../api';
import { Field } from '../components';
import { LANGUAGE_NAMES, setLanguage } from '../i18n';
import { login } from '../session';

export function LoginPage({ notice, email: initialEmail = '' }: { notice?: string; email?: string }) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <img className="logo" src="/icon.svg" alt="" />
      <h1 className="center" style={{ marginBlockEnd: 16 }}>
        {t('app.name')}
      </h1>
      <div className="lang-switch">
        {LOCALES.map((l) => (
          <button key={l} className={i18n.language === l ? 'small' : 'secondary small'} onClick={() => setLanguage(l)}>
            {LANGUAGE_NAMES[l]}
          </button>
        ))}
      </div>
      {notice && <div className="notice">{notice}</div>}
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(email, password);
          } catch (err) {
            setError(err instanceof ApiError ? err.code : 'unknown');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 style={{ marginBlockStart: 0 }}>{t('auth.title')}</h2>
        <Field label={t('auth.email')}>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
        </Field>
        <Field label={t('auth.password')}>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
        </Field>
        {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
        <button className="block" disabled={busy}>
          {t('auth.submit')}
        </button>
      </form>
      <p className="muted small center">{t('auth.first_login_online')}</p>
    </div>
  );
}
