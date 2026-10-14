import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { SquadMember } from '@fotboll/shared';
import { Avatar, Empty, TopBar } from '../components';
import { db } from '../db';
import { can, playerName, useCompetitionName, useLookups, useMe } from '../hooks';
import { remove, save } from '../mutate';

const POSITIONS = ['GK', 'DF', 'MF', 'FW'] as const;

/** A team's squad: who may be picked for match lineups, with shirt numbers. */
export function TeamPage() {
  const { id } = useParams() as { id: string };
  const { t } = useTranslation();
  const me = useMe();
  const { players, clubs } = useLookups();
  const compName = useCompetitionName();
  const [adding, setAdding] = useState(false);

  const data = useLiveQuery(async () => {
    const team = await db.data('teams').get(id);
    if (!team) return null;
    const squad = await db.data('squad_members').where('team_id').equals(id).toArray();
    const competition = await db.data('competitions').get(team.competition_id);
    const clubPlayers = await db.data('players').where('club_id').equals(team.club_id).toArray();
    return { team, squad, competition, clubPlayers };
  }, [id]);
  if (!data) return <TopBar title={t('club.squad')} back />;

  const { team, squad, competition, clubPlayers } = data;
  const editable = can.editClub(me, team.club_id);
  const inSquad = new Set(squad.map((s) => s.player_id));
  const sorted = [...squad].sort(
    (a, b) => POSITIONS.indexOf(a.position ?? 'FW') - POSITIONS.indexOf(b.position ?? 'FW') || (a.shirt_number ?? 99) - (b.shirt_number ?? 99),
  );
  const update = (s: SquadMember, patch: Partial<SquadMember>) => save('squad_members', { id: s.id, ...patch });

  return (
    <>
      <TopBar title={team.name} back />
      <main>
        <p className="muted">
          <Link to={`/clubs/${team.club_id}`}>{clubs.get(team.club_id)?.name}</Link> · {compName(competition)}
        </p>
        <h2>
          {t('club.squad')} <span className="muted">({squad.length})</span>
        </h2>
        <div className="list">
          {sorted.length === 0 && <Empty />}
          {sorted.map((s) => {
            const p = players.get(s.player_id);
            return (
              <div key={s.id}>
                {editable ? (
                  <input
                    aria-label={t('player.shirt')}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={99}
                    defaultValue={s.shirt_number ?? ''}
                    style={{ inlineSize: 64, flex: 'none' }}
                    onBlur={(e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      if (v !== (s.shirt_number ?? null)) void update(s, { shirt_number: v });
                    }}
                  />
                ) : (
                  <span className="minute">{s.shirt_number ?? ''}</span>
                )}
                <Avatar mediaId={p?.photo_media_id} name={playerName(p) || '?'} />
                <span className="grow ellipsis">{p ? <Link to={`/players/${p.id}`}>{playerName(p)}</Link> : t('match.unknown_player')}</span>
                {editable ? (
                  <>
                    <select
                      aria-label={t('player.position.GK')}
                      value={s.position ?? ''}
                      onChange={(e) => update(s, { position: (e.target.value || null) as SquadMember['position'] })}
                      style={{ inlineSize: 76, flex: 'none' }}
                    >
                      <option value="" />
                      {POSITIONS.map((pos) => (
                        <option key={pos} value={pos}>
                          {t(`player.position_short.${pos}`)}
                        </option>
                      ))}
                    </select>
                    <button className="icon-btn" aria-label={t('common.remove')} onClick={() => remove('squad_members', s.id)}>
                      ✕
                    </button>
                  </>
                ) : (
                  s.position && <span className="chip">{t(`player.position_short.${s.position}`)}</span>
                )}
              </div>
            );
          })}
        </div>

        {editable && (
          <>
            <button className="secondary block" onClick={() => setAdding(!adding)} style={{ marginBlockEnd: 12 }}>
              + {t('club.add_to_squad')}
            </button>
            {adding && (
              <div className="list">
                {clubPlayers.filter((p) => !inSquad.has(p.id) && p.status === 'active').length === 0 && <Empty />}
                {clubPlayers
                  .filter((p) => !inSquad.has(p.id) && p.status === 'active')
                  .map((p) => (
                    <button
                      key={p.id}
                      className="secondary"
                      style={{ borderRadius: 0, border: 0, justifyContent: 'flex-start', fontWeight: 400 }}
                      onClick={() => save('squad_members', { team_id: team.id, player_id: p.id, shirt_number: null, position: null })}
                    >
                      + {playerName(p)}
                    </button>
                  ))}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
