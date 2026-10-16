import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { ageOn, isActiveBan, isMinor, type Ban, type Player } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { ask, Avatar, Empty, Field, PhotoPicker, TopBar, useToast } from '../components';
import { db } from '../db';
import {
  can,
  isReportLocked,
  playerName,
  useBanLabel,
  useBans,
  useCompetitionName,
  useCurrentSeason,
  useLookups,
  useMe,
  useOnline,
} from '../hooks';
import { formatDate, formatDateTime } from '../i18n';
import { remove, save } from '../mutate';
import { isFedAdmin } from '../session';
import { DEMO } from '../demo';
import { TransferCard } from './Transfers';

export function PlayerPage() {
  const { id } = useParams() as { id: string };
  const [params] = useSearchParams();
  const isNew = id === 'new';
  const { t } = useTranslation();
  const me = useMe();
  const player = useLiveQuery(async () => (isNew ? null : ((await db.data('players').get(id)) ?? null)), [id]);
  const [editing, setEditing] = useState(false);

  if (player === undefined && !isNew) return <TopBar title={t('club.players')} back />;
  if (isNew || editing)
    return (
      <>
        <TopBar title={isNew ? t('player.new') : playerName(player!)} back />
        <main>
          <PlayerForm player={player ?? undefined} clubId={player?.club_id ?? params.get('club') ?? undefined} onDone={() => setEditing(false)} />
        </main>
      </>
    );
  if (!player)
    return (
      <>
        <TopBar title={t('club.players')} back />
        <main>
          <Empty />
        </main>
      </>
    );
  return <PlayerView player={player} onEdit={can.editPlayer(me, player) ? () => setEditing(true) : undefined} />;
}

function PlayerView({ player, onEdit }: { player: Player; onEdit?: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const { clubs } = useLookups();
  const online = useOnline();
  const toast = useToast();
  const navigate = useNavigate();
  const registrations = useLiveQuery(() => db.data('registrations').where('player_id').equals(player.id).toArray(), [player.id], []);
  const seasons = useLiveQuery(async () => new Map((await db.data('seasons').toArray()).map((s) => [s.id, s])), [], new Map());
  const name = playerName(player);

  return (
    <>
      <TopBar title={name} back />
      <main>
        <div className="card center">
          <Avatar mediaId={player.photo_media_id} name={name} large />
          <h1 style={{ marginBlockStart: 10 }}>{name}</h1>
          {player.name_alt && (
            <div dir="auto" className="muted">
              {player.name_alt}
            </div>
          )}
          <p className="muted small" style={{ marginBlockStart: 6 }}>
            {player.club_id ? clubs.get(player.club_id)?.name : t('player.no_club')} · {t(`player.gender.${player.gender}`)} ·{' '}
            {t('player.age', { age: ageOn(player.birth_date) })}
          </p>
          <p className="small">
            {t('player.license_no')}: {player.license_no ?? '–'}
          </p>
          {player.status === 'inactive' && <span className="chip grey">{t('player.status.inactive')}</span>}
          {onEdit && (
            <div>
              <button className="secondary small" onClick={onEdit}>
                {t('common.edit')}
              </button>
            </div>
          )}
        </div>

        <h2>{t('registration.title')}</h2>
        <div className="list">
          {registrations.length === 0 && <Empty />}
          {registrations.map((r) => (
            <div key={r.id}>
              <span className="grow">
                <div>
                  {clubs.get(r.club_id)?.name} · {seasons.get(r.season_id)?.name}
                </div>
                {r.decided_at && <div className="sub">{formatDateTime(r.decided_at, { dateStyle: 'medium' })}</div>}
              </span>
              <span className={`chip ${r.status === 'pending' ? 'warn' : r.status === 'rejected' ? 'red' : ''}`}>
                {t(`registration.status.${r.status}`)}
              </span>
              {isFedAdmin(me) && r.status === 'pending' && (
                <>
                  <button className="small" onClick={() => save('registrations', { id: r.id, status: 'approved' })}>
                    {t('registration.approve')}
                  </button>
                  <button className="danger small" onClick={() => save('registrations', { id: r.id, status: 'rejected' })}>
                    {t('registration.reject')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <PlayerTransfers playerId={player.id} />

        <Discipline player={player} />

        {isFedAdmin(me) && (
          <>
            <h2>{t('settings.privacy')}</h2>
            <button
              className="danger block"
              disabled={!online || DEMO}
              title={online ? undefined : t('common.online_only')}
              onClick={async () => {
                if (!(await ask(t('player.erase_confirm'), { confirmLabel: t('player.erase'), danger: true }))) return;
                try {
                  await api(`/admin/players/${player.id}/erase`, { method: 'POST' });
                  await db.data('players').delete(player.id);
                  toast.show(t('player.erased'));
                  navigate(-1);
                } catch (err) {
                  toast.show(t(`errors.${err instanceof ApiError ? err.code : 'unknown'}`));
                }
              }}
            >
              {t('player.erase')}
            </button>
            {!online && <p className="muted small">{t('common.online_only')}</p>}
          </>
        )}
        {toast.node}
      </main>
    </>
  );
}

function PlayerForm({ player, clubId, onDone }: { player?: Player; clubId?: string; onDone: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const season = useCurrentSeason();
  const { clubs } = useLookups();
  const fedAdmin = isFedAdmin(me);
  const [photo, setPhoto] = useState<string | null>(player?.photo_media_id ?? null);
  const [birthDate, setBirthDate] = useState(player?.birth_date ?? '');
  const [consent, setConsent] = useState(player?.photo_consent ?? false);
  const [error, setError] = useState<string | null>(null);
  const minor = birthDate ? isMinor(birthDate) : false;

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (photo && minor && !consent) {
          setError('photo_consent_required');
          return;
        }
        const f = new FormData(e.currentTarget);
        const club = (f.get('club_id') as string | null) ?? clubId ?? null;
        const fields = {
          first_name: f.get('first_name') as string,
          last_name: f.get('last_name') as string,
          name_alt: (f.get('name_alt') as string) || null,
          birth_date: birthDate,
          gender: f.get('gender') as Player['gender'],
          license_no: (f.get('license_no') as string) || null,
          photo_media_id: photo,
          photo_consent: consent,
          status: (f.get('status') as Player['status']) ?? 'active',
          ...(fedAdmin || !player ? { club_id: club || null } : {}),
        };
        if (player) {
          await save('players', { id: player.id, ...fields });
          onDone();
          return;
        }
        const id = await save('players', fields);
        // New players are registered for the current season; club registrations need federation approval.
        if (club && season) {
          await save('registrations', {
            player_id: id,
            club_id: club,
            season_id: season.id,
            status: fedAdmin ? 'approved' : 'pending',
            note: null,
          });
        }
        navigate(`/players/${id}`, { replace: true });
      }}
    >
      <PhotoPicker mediaId={photo} name={player ? playerName(player) : '?'} kind="player_photo" onChange={setPhoto} />
      {minor && (
        <>
          <div className="notice">{t('player.minor_notice')}</div>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            {t('player.photo_consent')}
          </label>
        </>
      )}
      <div className="grid2">
        <Field label={t('player.first_name')}>
          <input name="first_name" required defaultValue={player?.first_name} autoComplete="off" />
        </Field>
        <Field label={t('player.last_name')}>
          <input name="last_name" required defaultValue={player?.last_name} autoComplete="off" />
        </Field>
      </div>
      <Field label={`${t('player.name_alt')}`}>
        <input name="name_alt" dir="auto" defaultValue={player?.name_alt ?? ''} placeholder="محمد علي" />
      </Field>
      <div className="grid2">
        <Field label={t('player.birth_date')}>
          <input type="date" required value={birthDate} onChange={(e) => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
        </Field>
        <Field label=" ">
          <select name="gender" defaultValue={player?.gender ?? 'male'}>
            <option value="male">{t('player.gender.male')}</option>
            <option value="female">{t('player.gender.female')}</option>
          </select>
        </Field>
      </div>
      <Field label={t('player.license_no')}>
        <input name="license_no" defaultValue={player?.license_no ?? ''} dir="ltr" />
      </Field>
      {fedAdmin && (
        <Field label={t('player.club')}>
          <select name="club_id" defaultValue={player?.club_id ?? clubId ?? ''}>
            <option value="">{t('player.no_club')}</option>
            {[...clubs.values()].map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {player && (
        <Field label={t('match.status_label')}>
          <select name="status" defaultValue={player.status}>
            <option value="active">{t('player.status.active')}</option>
            <option value="inactive">{t('player.status.inactive')}</option>
          </select>
        </Field>
      )}
      {!player && !fedAdmin && <p className="muted small">{t('registration.auto_note')}</p>}
      {error && <p className="error-text">{t(`errors.${error}`)}</p>}
      <div className="row">
        <button>{t('common.save')}</button>
        <button type="button" className="secondary" onClick={() => (player ? onDone() : navigate(-1))}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Cards per competition, suspensions (automatic and manual), and the federation's tools. */
function Discipline({ player }: { player: Player }) {
  const { t } = useTranslation();
  const me = useMe();
  const compName = useCompetitionName();
  const banLabel = useBanLabel();
  const allBans = useBans();
  const [adding, setAdding] = useState(false);
  const data = useLiveQuery(async () => {
    const events = (await db.data('match_events').toArray()).filter(
      (e) => e.player_id === player.id && (e.type === 'yellow' || e.type === 'second_yellow' || e.type === 'red'),
    );
    const matches = new Map((await db.data('matches').toArray()).map((m) => [m.id, m]));
    const reportIds = [...new Set(events.map((e) => e.match_id))];
    const reports = new Map((await db.data('match_reports').bulkGet(reportIds)).filter((r) => !!r).map((r) => [r!.id, r!]));
    const competitions = new Map((await db.data('competitions').toArray()).map((c) => [c.id, c]));
    // Count cards only from submitted and approved reports, like the suspensions do.
    const perCompetition = new Map<string, { yellow: number; red: number }>();
    for (const e of events) {
      const m = matches.get(e.match_id);
      if (!m || !isReportLocked(reports.get(m.id))) continue;
      const c = perCompetition.get(m.competition_id) ?? { yellow: 0, red: 0 };
      if (e.type === 'yellow') c.yellow++;
      else c.red++;
      perCompetition.set(m.competition_id, c);
    }
    return { perCompetition, competitions, matches };
  }, [player.id]);
  if (!data) return null;

  const bans = allBans
    .filter((b) => b.player_id === player.id)
    .sort((a, b) => Number(isActiveBan(b)) - Number(isActiveBan(a)));
  const fedAdmin = isFedAdmin(me);
  const kickoff = (b: Ban) => (b.source_match_id ? data.matches.get(b.source_match_id)?.kickoff_at : undefined);

  return (
    <>
      <h2>{t('discipline.title')}</h2>
      {data.perCompetition.size > 0 && (
        <div className="list">
          {[...data.perCompetition].map(([competitionId, c]) => (
            <div key={competitionId}>
              <span className="grow">{compName(data.competitions.get(competitionId))}</span>
              <span className="cards-count" title={t('match.event.yellow')}>
                <span className="card-icon yellow" aria-hidden /> {c.yellow}
              </span>
              <span className="cards-count" title={t('match.event.red')}>
                <span className="card-icon red" aria-hidden /> {c.red}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="list">
        {bans.length === 0 && <div className="empty">{t('discipline.no_bans')}</div>}
        {bans.map((b) => {
          const when = kickoff(b);
          return (
            <div key={b.key}>
              <span className="grow">
                <div>{b.reasons.map((r) => t(`discipline.reason.${r}`)).join(' + ')}</div>
                <div className="sub">
                  {b.competition_id ? compName(data.competitions.get(b.competition_id)) : t('discipline.all_competitions')}
                  {b.source_match_id && when && (
                    <>
                      {' · '}
                      <Link to={`/matches/${b.source_match_id}`}>{formatDateTime(when, { dateStyle: 'medium' })}</Link>
                    </>
                  )}
                  {b.ends_on && ` · ${formatDate(b.starts_on!)} – ${formatDate(b.ends_on)}`}
                  {b.note && ` · ${b.note}`}
                </div>
                {b.matches !== null && (
                  <div className="sub">{t('discipline.served', { served: b.served, total: b.matches })}</div>
                )}
              </span>
              {isActiveBan(b) ? <span className="chip ban">{banLabel(b)}</span> : <span className="chip grey">{t('discipline.done')}</span>}
              {fedAdmin && b.suspension_id && (
                <button
                  className="icon-btn"
                  aria-label={t('common.delete')}
                  onClick={async () => (await ask(t('discipline.delete_confirm'), { confirmLabel: t('common.delete'), danger: true })) && remove('suspensions', b.suspension_id!)}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">{t('discipline.rules_note')}</p>
      {fedAdmin &&
        (adding ? (
          <SuspensionForm player={player} onDone={() => setAdding(false)} />
        ) : (
          <button className="secondary block" onClick={() => setAdding(true)} style={{ marginBlockEnd: 12 }}>
            + {t('discipline.add')}
          </button>
        ))}
    </>
  );
}

function SuspensionForm({ player, onDone }: { player: Player; onDone: () => void }) {
  const { t } = useTranslation();
  const compName = useCompetitionName();
  const [kind, setKind] = useState<'matches' | 'dates'>('matches');
  const today = new Date().toISOString().slice(0, 10);
  // Competitions the player has a team in come first.
  const competitions = useLiveQuery(async () => {
    const squads = await db.data('squad_members').where('player_id').equals(player.id).toArray();
    const teams = await db.data('teams').bulkGet(squads.map((s) => s.team_id));
    const mine = new Set(teams.filter((x) => !!x).map((x) => x!.competition_id));
    const all = await db.data('competitions').toArray();
    return all.sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
  }, [player.id], []);

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const reason = (f.get('reason') as string) || null;
        if (kind === 'matches') {
          await save('suspensions', {
            player_id: player.id,
            competition_id: f.get('competition_id') as string,
            matches: Number(f.get('matches')),
            starts_on: f.get('starts_on') as string,
            ends_on: null,
            reason,
          });
        } else {
          await save('suspensions', {
            player_id: player.id,
            competition_id: null,
            matches: null,
            starts_on: f.get('starts_on') as string,
            ends_on: f.get('ends_on') as string,
            reason,
          });
        }
        onDone();
      }}
    >
      <h3 style={{ marginBlockEnd: 10 }}>{t('discipline.add')}</h3>
      <div className="segmented">
        <button type="button" className={kind === 'matches' ? 'active' : ''} onClick={() => setKind('matches')}>
          {t('discipline.by_matches')}
        </button>
        <button type="button" className={kind === 'dates' ? 'active' : ''} onClick={() => setKind('dates')}>
          {t('discipline.by_dates')}
        </button>
      </div>
      {kind === 'matches' ? (
        <>
          <Field label={t('discipline.competition')}>
            <select name="competition_id" required>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {compName(c)}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid2">
            <Field label={t('discipline.matches')}>
              <input name="matches" type="number" min={1} max={50} defaultValue={1} required />
            </Field>
            <Field label={t('discipline.from')}>
              <input name="starts_on" type="date" defaultValue={today} required />
            </Field>
          </div>
        </>
      ) : (
        <div className="grid2">
          <Field label={t('discipline.from')}>
            <input name="starts_on" type="date" defaultValue={today} required />
          </Field>
          <Field label={t('discipline.to')}>
            <input name="ends_on" type="date" min={today} required />
          </Field>
        </div>
      )}
      <Field label={t('discipline.reason_label')}>
        <input name="reason" maxLength={500} />
      </Field>
      <div className="row">
        <button>{t('common.save')}</button>
        <button type="button" className="secondary" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function PlayerTransfers({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const transfers = useLiveQuery(
    async () =>
      (await db.data('transfers').where('player_id').equals(playerId).toArray()).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [playerId],
    [],
  );
  if (!transfers.length) return null;
  return (
    <>
      <h2>{t('transfer.title')}</h2>
      {transfers.map((x) => (
        <TransferCard key={x.id} transfer={x} compact />
      ))}
    </>
  );
}
