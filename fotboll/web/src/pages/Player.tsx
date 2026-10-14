import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { ageOn, isMinor, type Player } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Avatar, Empty, Field, PhotoPicker, TopBar, useToast } from '../components';
import { db } from '../db';
import { can, playerName, useCurrentSeason, useLookups, useMe, useOnline } from '../hooks';
import { formatDateTime } from '../i18n';
import { save } from '../mutate';
import { isFedAdmin } from '../session';

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

        {isFedAdmin(me) && (
          <>
            <h2>{t('settings.privacy')}</h2>
            <button
              className="danger block"
              disabled={!online}
              title={online ? undefined : t('common.online_only')}
              onClick={async () => {
                if (!confirm(t('player.erase_confirm'))) return;
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
