import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Avatar, Empty, Field, PhotoPicker, TopBar } from '../components';
import { db } from '../db';
import { can, playerName, useCompetitionName, useMe } from '../hooks';
import { save } from '../mutate';
import { isFedAdmin } from '../session';

export function ClubsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const clubs = useLiveQuery(() => db.data('clubs').orderBy('name').toArray(), [], []);
  const q = query.trim().toLowerCase();
  const shown = clubs.filter((c) => !q || c.name.toLowerCase().includes(q) || c.city?.toLowerCase().includes(q));

  return (
    <>
      <TopBar title={t('nav.clubs')} />
      <main>
        <input type="search" placeholder={t('common.search')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBlockEnd: 12 }} />
        {isFedAdmin(me) &&
          (adding ? (
            <ClubForm onDone={() => setAdding(false)} />
          ) : (
            <div className="fab-row">
              <button className="secondary" onClick={() => setAdding(true)}>
                + {t('club.new')}
              </button>
            </div>
          ))}
        <div className="list">
          {shown.length === 0 && <Empty />}
          {shown.map((c) => (
            <Link key={c.id} to={`/clubs/${c.id}`}>
              <Avatar mediaId={c.logo_media_id} name={c.short_name || c.name} />
              <span className="grow">
                <div>{c.name}</div>
                <div className="sub">{c.city}</div>
              </span>
              {c.status === 'inactive' && <span className="chip grey">{t('club.status.inactive')}</span>}
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}

function ClubForm({ id, onDone }: { id?: string; onDone: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const club = useLiveQuery(() => (id ? db.data('clubs').get(id) : undefined), [id]);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  if (id && !club) return null;
  const logoId = logo === undefined ? (club?.logo_media_id ?? null) : logo;

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save('clubs', {
          ...(id ? { id } : { status: 'active' as const }),
          name: f.get('name') as string,
          short_name: (f.get('short_name') as string) || null,
          city: (f.get('city') as string) || null,
          logo_media_id: logoId,
          ...(isFedAdmin(me) && f.get('status') ? { status: f.get('status') as 'active' | 'inactive' } : {}),
        });
        onDone();
      }}
    >
      <PhotoPicker mediaId={logoId} name={club?.name ?? '?'} kind="club_logo" onChange={setLogo} />
      <Field label={t('club.name')}>
        <input name="name" required defaultValue={club?.name} />
      </Field>
      <div className="grid2">
        <Field label={t('club.short_name')}>
          <input name="short_name" maxLength={20} defaultValue={club?.short_name ?? ''} />
        </Field>
        <Field label={t('club.city')}>
          <input name="city" defaultValue={club?.city ?? ''} />
        </Field>
      </div>
      {id && isFedAdmin(me) && (
        <Field label={t('match.status_label')}>
          <select name="status" defaultValue={club?.status}>
            <option value="active">{t('club.status.active')}</option>
            <option value="inactive">{t('club.status.inactive')}</option>
          </select>
        </Field>
      )}
      <div className="row">
        <button>{t('common.save')}</button>
        <button type="button" className="secondary" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

export function ClubPage() {
  const { id } = useParams() as { id: string };
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const compName = useCompetitionName();
  const [editing, setEditing] = useState(false);

  const data = useLiveQuery(async () => {
    const club = await db.data('clubs').get(id);
    if (!club) return null;
    const teams = await db.data('teams').where('club_id').equals(id).toArray();
    const competitions = new Map((await db.data('competitions').toArray()).map((c) => [c.id, c]));
    const players = (await db.data('players').where('club_id').equals(id).toArray()).sort((a, b) =>
      a.last_name.localeCompare(b.last_name),
    );
    const pending = await db.data('registrations').where('club_id').equals(id).filter((r) => r.status === 'pending').toArray();
    return { club, teams, competitions, players, pending };
  }, [id]);

  if (!data) return <TopBar title={t('nav.clubs')} back />;
  const { club, teams, competitions, players, pending } = data;
  const editable = can.editClub(me, club.id);

  return (
    <>
      <TopBar title={club.name} back />
      <main>
        {editing ? (
          <ClubForm id={club.id} onDone={() => setEditing(false)} />
        ) : (
          <div className="card row">
            <Avatar mediaId={club.logo_media_id} name={club.short_name || club.name} large />
            <div className="grow">
              <h1>{club.name}</h1>
              <div className="muted">{club.city}</div>
              {club.status === 'inactive' && <span className="chip grey">{t('club.status.inactive')}</span>}
            </div>
            {editable && (
              <button className="secondary small" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </button>
            )}
          </div>
        )}

        <h2>{t('club.teams')}</h2>
        <div className="list">
          {teams.length === 0 && <Empty />}
          {teams.map((tm) => (
            <Link key={tm.id} to={`/teams/${tm.id}`}>
              <span className="grow">
                <div>{tm.name}</div>
                <div className="sub">{compName(competitions.get(tm.competition_id))}</div>
              </span>
              <span aria-hidden>›</span>
            </Link>
          ))}
        </div>

        <div className="spread">
          <h2>
            {t('club.players')} {players.length > 0 && <span className="muted">({players.length})</span>}
          </h2>
          {can.createPlayer(me, club.id) && (
            <button className="secondary small" onClick={() => navigate(`/players/new?club=${club.id}`)}>
              + {t('player.new')}
            </button>
          )}
        </div>
        {players.length === 0 && !editable ? (
          <p className="muted small">{t('club.not_visible')}</p>
        ) : (
          <div className="list">
            {players.length === 0 && <Empty />}
            {players.map((p) => (
              <Link key={p.id} to={`/players/${p.id}`}>
                <Avatar mediaId={p.photo_media_id} name={playerName(p)} />
                <span className="grow">
                  <div className="ellipsis">{playerName(p)}</div>
                  <div className="sub">
                    {p.name_alt && <span dir="auto">{p.name_alt} · </span>}
                    {p.license_no}
                  </div>
                </span>
                {pending.some((r) => r.player_id === p.id) && <span className="chip warn">{t('registration.status.pending')}</span>}
                {p.status === 'inactive' && <span className="chip grey">{t('player.status.inactive')}</span>}
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
