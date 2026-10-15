import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LOCALES } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Field } from '../components';
import { LANGUAGE_NAMES, setLanguage } from '../i18n';
import { login } from '../session';
import { DEMO, DEMO_ACCOUNTS, demoLogin } from '../demo';
import icon from '../icon.svg';

export function LoginPage({ notice, email: initialEmail = '' }: { notice?: string; email?: string }) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  return (
    <div className="login">
      <img className="logo" src={icon} alt="" />
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
      {DEMO ? (
        <div className="card">
          <h2 style={{ marginBlockStart: 0 }}>{t('demo.title')}</h2>
          <p className="muted small">{t('demo.intro')}</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {DEMO_ACCOUNTS.map((a) => (
              <button key={a.key} className="block" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  await demoLogin(a.key);
                } finally {
                  setBusy(false);
                }
              }}>
                {t('demo.login_as', { role: t(`roles.${a.role}`) })}
              </button>
            ))}
          </div>
        </div>
      ) : forgot ? (
        <ForgotPassword email={email} onBack={() => setForgot(false)} />
      ) : (
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
        <button type="button" className="secondary block" style={{ marginBlockStart: 8, border: 0 }} onClick={() => setForgot(true)}>
          {t('auth.forgot')}
        </button>
      </form>
      )}
      <p className="muted small center">{DEMO ? t('demo.note') : t('auth.first_login_online')}</p>
      <p className="center">
        <Link to="/public">{t('public.link')} ›</Link>
      </p>
    </div>
  );
}

/** Asks for a reset link by email. The answer is the same whether or not the address exists. */
function ForgotPassword({ email: initial, onBack }: { email: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(initial);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('/auth/forgot', { method: 'POST', json: { email } });
          setSent(true);
        } catch (err) {
          setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 style={{ marginBlockStart: 0 }}>{t('auth.forgot_title')}</h2>
      {sent ? (
        <p className="notice">{t('auth.forgot_sent')}</p>
      ) : (
        <>
          <p className="muted small">{t('auth.forgot_intro')}</p>
          <Field label={t('auth.email')}>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
          </Field>
          {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
          <button className="block" disabled={busy}>
            {t('auth.send_link')}
          </button>
        </>
      )}
      <button type="button" className="secondary block" style={{ marginBlockStart: 8 }} onClick={onBack}>
        {t('auth.to_login')}
      </button>
    </form>
  );
}
