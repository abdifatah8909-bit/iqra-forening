import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match, MatchReport, Team } from '@fotboll/shared';
import { formatDateTime } from './i18n';
import { addPhoto, useMediaUrl } from './media';
import { useSyncState } from './hooks';
import { syncEngine } from './sync';

export function TopBar({ title, back }: { title: string; back?: boolean }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <header className="topbar">
      {back && (
        <button className="back" aria-label={t('common.back')} onClick={() => navigate(-1)}>
          ←
        </button>
      )}
      <h1>{title}</h1>
      <SyncBadge />
    </header>
  );
}

export function SyncBadge() {
  const { t } = useTranslation();
  const s = useSyncState();
  let cls: string = s.status;
  let label = t('sync.synced');
  if (s.status === 'syncing') label = t('sync.syncing');
  else if (s.status === 'offline') label = s.pending ? t('sync.pending', { count: s.pending }) : t('sync.offline');
  else if (s.status === 'error') label = t('sync.error');
  else if (s.pending) {
    cls = 'pending';
    label = t('sync.pending', { count: s.pending });
  }
  return (
    <button className={`sync-badge ${cls}`} onClick={() => void syncEngine.syncNow()} title={t('sync.now')}>
      <span className="dot" />
      {label}
    </button>
  );
}

export function BottomNav() {
  const { t } = useTranslation();
  const items: [string, string, string][] = [
    ['/', '⌂', t('nav.home')],
    ['/matches', '⚽', t('nav.matches')],
    ['/competitions', '☰', t('nav.tables')],
    ['/clubs', '⛨', t('nav.clubs')],
    ['/more', '⋯', t('nav.more')],
  ];
  return (
    <nav className="bottomnav">
      {items.map(([to, icon, label]) => (
        <NavLink key={to} to={to} end={to === '/'}>
          <span className="icon" aria-hidden>
            {icon}
          </span>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Avatar({ mediaId, name, large }: { mediaId?: string | null; name: string; large?: boolean }) {
  const url = useMediaUrl(mediaId);
  const cls = `avatar${large ? ' lg' : ''}`;
  if (url) return <img className={cls} src={url} alt={name} />;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <span className={cls} aria-hidden>
      {initials}
    </span>
  );
}

/** Camera or gallery picker; the photo is compressed on the device and stored offline. */
export function PhotoPicker({
  mediaId,
  name,
  kind,
  onChange,
}: {
  mediaId: string | null | undefined;
  name: string;
  kind: 'player_photo' | 'club_logo';
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ marginBlockEnd: 12 }}>
      <Avatar mediaId={mediaId} name={name || '?'} large />
      <div style={{ display: 'grid', gap: 6 }}>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              onChange(await addPhoto(file, kind));
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
        <button type="button" className="secondary small" disabled={busy} onClick={() => input.current?.click()}>
          📷 {kind === 'player_photo' ? t('player.choose_photo') : t('club.logo')}
        </button>
        {mediaId && (
          <button type="button" className="danger small" onClick={() => onChange(null)}>
            {t('player.remove_photo')}
          </button>
        )}
      </div>
    </div>
  );
}

export function Score({ report, match }: { report?: MatchReport; match: Match }) {
  const { t } = useTranslation();
  if (!report) {
    if (match.status === 'scheduled') return <span className="small">{formatDateTime(match.kickoff_at, { timeStyle: 'short' })}</span>;
    return <span className="chip grey">{t(`match.status.${match.status}`)}</span>;
  }
  return (
    <span className="score">
      {report.home_score} – {report.away_score}
    </span>
  );
}

export function MatchCard({
  match,
  report,
  home,
  away,
  extra,
}: {
  match: Match;
  report?: MatchReport;
  home?: Team;
  away?: Team;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Link to={`/matches/${match.id}`} style={{ display: 'block' }}>
      <div className="spread small muted" style={{ marginBlockEnd: 4 }}>
        <span>{formatDateTime(match.kickoff_at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        <span className="row">
          {extra}
          {report && <ReportChip report={report} />}
          {!report && match.status !== 'scheduled' && <span className="chip grey">{t(`match.status.${match.status}`)}</span>}
        </span>
      </div>
      <div className="match-card">
        <span className="team">{home?.name}</span>
        <span className="mid">
          <Score report={report} match={match} />
        </span>
        <span className="team away">{away?.name}</span>
      </div>
    </Link>
  );
}

export function ReportChip({ report }: { report?: MatchReport }) {
  const { t } = useTranslation();
  if (!report) return <span className="chip grey">{t('match.report.none')}</span>;
  const cls = { draft: 'warn', reopened: 'warn', submitted: '', approved: '' }[report.status];
  return <span className={`chip ${cls}`}>{t(`match.report.${report.status}`)}</span>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty() {
  const { t } = useTranslation();
  return <div className="empty">{t('common.none')}</div>;
}

let toastTimer: ReturnType<typeof setTimeout>;
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  return {
    show(msg: string) {
      setMessage(msg);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setMessage(null), 2500);
    },
    node: message ? (
      <div className="toast" role="status">
        {message}
      </div>
    ) : null,
  };
}

/**
 * In-app confirmation dialog. Used instead of window.confirm(), which some
 * embedded web views (and installed PWAs on some platforms) suppress.
 */
interface PendingQuestion {
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
let question: PendingQuestion | null = null;
const questionListeners = new Set<() => void>();
const setQuestion = (q: PendingQuestion | null) => {
  question = q;
  questionListeners.forEach((fn) => fn());
};

export function ask(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  question?.resolve(false);
  return new Promise((resolve) => setQuestion({ message, ...opts, resolve }));
}

export function ConfirmHost() {
  const { t } = useTranslation();
  const q = useSyncExternalStore(
    (fn) => {
      questionListeners.add(fn);
      return () => questionListeners.delete(fn);
    },
    () => question,
  );
  if (!q) return null;
  const answer = (ok: boolean) => {
    setQuestion(null);
    q.resolve(ok);
  };
  return (
    <div className="dialog-backdrop" onClick={() => answer(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p>{q.message}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={() => answer(false)}>
            {t('common.cancel')}
          </button>
          <button className={q.danger ? 'danger' : ''} onClick={() => answer(true)} autoFocus>
            {q.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
