import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import {
  OPEN_TRANSFER_STATUSES,
  transferActions,
  transferAwaits,
  type Transfer,
  type TransferStatus,
} from '@fotboll/shared';
import { api, ApiError } from '../api';
import { ask, Empty, Field, Tabs, TopBar } from '../components';
import { db } from '../db';
import { DEMO, demoSearchPlayers } from '../demo';
import { can, playerName, transferActor, useLookups, useMe, useOnline } from '../hooks';
import { formatDateTime } from '../i18n';
import { save } from '../mutate';
import { adminClubIds, isFedAdmin } from '../session';

/** Server answer of GET /api/players/search. */
export interface PlayerSearchHit {
  id: string;
  first_name: string;
  last_name: string;
  birth_year: number;
  club_id: string | null;
  club_name: string | null;
  open_transfer: boolean;
}

/**
 * Transfers between clubs: the receiving club applies, the current club
 * releases the player, then the federation approves.
 */
export function TransfersPage() {
  const { t } = useTranslation();
  const me = useMe();
  const [params] = useSearchParams();
  const actor = transferActor(me);
  const [tab, setTab] = useState<'todo' | 'open' | 'done'>('todo');
  const [adding, setAdding] = useState(false);
  const transfers = useLiveQuery(
    async () => (await db.data('transfers').toArray()).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [],
    [],
  );
  const club = params.get('club');
  const shown = transfers.filter((x) => !club || x.from_club_id === club || x.to_club_id === club);
  const isOpen = (x: Transfer) => OPEN_TRANSFER_STATUSES.includes(x.status);
  const lists = {
    todo: shown.filter((x) => transferAwaits(x, actor)),
    open: shown.filter(isOpen),
    done: shown.filter((x) => !isOpen(x)),
  };

  return (
    <>
      <TopBar title={t('transfer.title')} back />
      <main>
        <p className="muted small">{t('transfer.intro')}</p>
        {can.requestTransfer(me) &&
          (adding ? (
            <NewTransfer
              onDone={(sent) => {
                setAdding(false);
                if (sent) setTab('open');
              }}
            />
          ) : (
            <button className="block" onClick={() => setAdding(true)} style={{ marginBlockEnd: 12 }}>
              + {t('transfer.new')}
            </button>
          ))}
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            ['todo', `${t('transfer.tab_todo')}${lists.todo.length ? ` (${lists.todo.length})` : ''}`],
            ['open', t('transfer.tab_open')],
            ['done', t('transfer.tab_done')],
          ]}
        />
        {lists[tab].length === 0 && (
          <div className="list">
            <Empty />
          </div>
        )}
        {lists[tab].map((x) => (
          <TransferCard key={x.id} transfer={x} />
        ))}
      </main>
    </>
  );
}

const STEPS: { key: string; done: (x: Transfer) => boolean }[] = [
  { key: 'requested', done: () => true },
  // A player without a club needs no release.
  { key: 'released', done: (x) => !!x.released_at || !x.from_club_id },
  { key: 'approved', done: (x) => x.status === 'approved' },
];

function statusChip(status: TransferStatus) {
  return { pending_club: 'warn', pending_federation: 'warn', approved: '', rejected: 'red', cancelled: 'grey' }[status];
}

export function TransferCard({ transfer: x, compact }: { transfer: Transfer; compact?: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const { players, clubs } = useLookups();
  const [note, setNote] = useState('');
  const actions = transferActions(x, transferActor(me));
  const player = players.get(x.player_id);
  const from = x.from_club_id ? clubs.get(x.from_club_id)?.name : t('player.no_club');
  const to = clubs.get(x.to_club_id)?.name;
  const stopped = x.status === 'rejected' || x.status === 'cancelled';

  const act = async (status: TransferStatus) => {
    const danger = status === 'rejected' || status === 'cancelled';
    const question = t(`transfer.confirm.${status}`, { player: playerName(player) || t('match.unknown_player'), club: to });
    if (!(await ask(question, { confirmLabel: t(`transfer.action.${status}`), danger }))) return;
    // Each party's comment is added after the earlier ones.
    const response = [x.response_note, note.trim()].filter(Boolean).join(' · ').slice(0, 500);
    await save('transfers', { id: x.id, status, ...(note.trim() ? { response_note: response } : {}) });
    setNote('');
  };

  return (
    <div className="card">
      <div className="spread">
        <strong className="ellipsis">
          {player ? <Link to={`/players/${player.id}`}>{playerName(player)}</Link> : t('match.unknown_player')}
        </strong>
        <span className={`chip ${statusChip(x.status)}`}>{t(`transfer.status.${x.status}`)}</span>
      </div>
      <div className="small" style={{ marginBlock: 6 }}>
        {from} <span aria-hidden>→</span> <strong>{to}</strong>
      </div>
      {!compact && (
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.key} className={s.done(x) ? 'done' : stopped ? 'stopped' : ''}>
              {t(`transfer.step.${s.key}`, { club: s.key === 'released' ? from : to })}
            </li>
          ))}
        </ol>
      )}
      {x.note && (
        <p className="small">
          <span className="muted">{t('transfer.note')}:</span> {x.note}
        </p>
      )}
      {x.response_note && (
        <p className="small">
          <span className="muted">{t('transfer.response_note')}:</span> {x.response_note}
        </p>
      )}
      <p className="muted small">{formatDateTime(x.created_at, { dateStyle: 'medium' })}</p>
      {actions.length > 0 && (
        <>
          {actions.some((a) => a !== 'cancelled') && (
            <Field label={t('transfer.response_label')}>
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
          <div className="row">
            {actions
              .sort((a, b) => Number(a === 'rejected' || a === 'cancelled') - Number(b === 'rejected' || b === 'cancelled'))
              .map((a) => (
                <button key={a} className={a === 'rejected' || a === 'cancelled' ? 'danger small' : 'small'} onClick={() => act(a)}>
                  {t(`transfer.action.${a}`)}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The receiving club finds the player (online) and applies. */
function NewTransfer({ onDone }: { onDone: (sent?: boolean) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const online = useOnline();
  const { clubs } = useLookups();
  const myClubs = isFedAdmin(me) ? [...clubs.values()].filter((c) => c.status === 'active') : adminClubIds(me).map((id) => clubs.get(id)!).filter(Boolean);
  const [toClub, setToClub] = useState('');
  const [mode, setMode] = useState<'license' | 'name'>('license');
  const [hits, setHits] = useState<PlayerSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const target = toClub || myClubs[0]?.id || '';

  const search = async (form: FormData) => {
    const q: Record<string, string> =
      mode === 'license'
        ? { license_no: String(form.get('license_no') ?? '') }
        : {
            first_name: String(form.get('first_name') ?? ''),
            last_name: String(form.get('last_name') ?? ''),
            birth_date: String(form.get('birth_date') ?? ''),
          };
    setError(null);
    try {
      setHits(DEMO ? await demoSearchPlayers(q) : await api<PlayerSearchHit[]>(`/players/search?${new URLSearchParams(q)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'unknown');
    }
  };

  const apply = async (hit: PlayerSearchHit) => {
    await save('transfers', {
      player_id: hit.id,
      to_club_id: target,
      // The server sets the real starting point from the player's current club.
      status: hit.club_id ? 'pending_club' : 'pending_federation',
      from_club_id: hit.club_id,
      note: note.trim() || null,
      response_note: null,
    });
    onDone(true);
  };

  return (
    <div className="card">
      <h3 style={{ marginBlockEnd: 10 }}>{t('transfer.new')}</h3>
      {myClubs.length > 1 && (
        <Field label={t('transfer.to_club')}>
          <select value={target} onChange={(e) => setToClub(e.target.value)}>
            {myClubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="muted small">{t('transfer.search_intro')}</p>
      <div className="segmented">
        <button type="button" className={mode === 'license' ? 'active' : ''} onClick={() => setMode('license')}>
          {t('player.license_no')}
        </button>
        <button type="button" className={mode === 'name' ? 'active' : ''} onClick={() => setMode('name')}>
          {t('transfer.by_name')}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search(new FormData(e.currentTarget));
        }}
      >
        {mode === 'license' ? (
          <Field label={t('player.license_no')}>
            <input name="license_no" required minLength={2} dir="ltr" />
          </Field>
        ) : (
          <>
            <div className="grid2">
              <Field label={t('player.first_name')}>
                <input name="first_name" required />
              </Field>
              <Field label={t('player.last_name')}>
                <input name="last_name" required />
              </Field>
            </div>
            <Field label={t('player.birth_date')}>
              <input name="birth_date" type="date" required />
            </Field>
          </>
        )}
        <div className="row">
          <button className="secondary" disabled={!online && !DEMO}>
            {t('common.search')}
          </button>
          <button type="button" className="secondary" onClick={() => onDone()}>
            {t('common.cancel')}
          </button>
        </div>
        {!online && !DEMO && <p className="muted small">{t('common.online_only')}</p>}
      </form>
      {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
      {hits && (
        <>
          <div className="list" style={{ marginBlockStart: 12 }}>
            {hits.length === 0 && <div className="empty">{t('transfer.no_hits')}</div>}
            {hits.map((h) => {
              const blocked = h.club_id === target ? 'transfer.already_in_club' : h.open_transfer ? 'transfer.has_open' : null;
              return (
                <div key={h.id}>
                  <span className="grow">
                    <div>
                      {h.first_name} {h.last_name}
                    </div>
                    <div className="sub">
                      {h.club_name ?? t('player.no_club')} · {h.birth_year}
                    </div>
                    {blocked && <div className="sub">{t(blocked)}</div>}
                  </span>
                  <button className="small" disabled={!!blocked} onClick={() => apply(h)}>
                    {t('transfer.apply')}
                  </button>
                </div>
              );
            })}
          </div>
          {hits.length > 0 && (
            <Field label={t('transfer.note_label')}>
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
        </>
      )}
    </div>
  );
}
