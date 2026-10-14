import { useState } from 'react';
import { useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import {
  EVENT_TYPES,
  MATCH_STATUSES,
  scoreFromEvents,
  type EventType,
  type Match,
  type MatchEvent,
  type MatchLineup,
  type MatchReport,
  type Player,
  type Team,
} from '@fotboll/shared';
import { ask, Empty, Field, ReportChip, Tabs, TopBar, useToast } from '../components';
import { db } from '../db';
import { can, isReportLocked, playerName, useCompetitionName, useLookups, useMe } from '../hooks';
import { formatDateTime } from '../i18n';
import { remove, save } from '../mutate';
import { isFedAdmin } from '../session';

export function MatchPage() {
  const { id } = useParams() as { id: string };
  const { t } = useTranslation();
  const me = useMe();
  const lookups = useLookups();
  const compName = useCompetitionName();

  const data = useLiveQuery(async () => {
    const match = await db.data('matches').get(id);
    if (!match) return null;
    const [report, lineups, events, competition, venue] = await Promise.all([
      db.data('match_reports').get(id),
      db.data('match_lineups').where('match_id').equals(id).toArray(),
      db.data('match_events').where('match_id').equals(id).toArray(),
      db.data('competitions').get(match.competition_id),
      match.venue_id ? db.data('venues').get(match.venue_id) : undefined,
    ]);
    return { match, report, lineups, events, competition, venue };
  }, [id]);

  const editEvents = data ? can.editEvents(me, data.match, data.report) : false;
  const [tab, setTab] = useState<'events' | 'lineups'>('events');

  if (data === undefined) return <TopBar title={t('nav.matches')} back />;
  if (data === null)
    return (
      <>
        <TopBar title={t('nav.matches')} back />
        <main>
          <Empty />
        </main>
      </>
    );

  const { match, report, lineups, events, competition, venue } = data;
  const home = lookups.teams.get(match.home_team_id);
  const away = lookups.teams.get(match.away_team_id);
  const locked = isReportLocked(report);
  // While the report is open, show the live score from the events.
  const live = scoreFromEvents(events, match.home_team_id, match.away_team_id);
  const score = locked ? { home: report!.home_score, away: report!.away_score } : live;
  const referee = match.referee_user_id ? lookups.users.get(match.referee_user_id) : undefined;

  return (
    <>
      <TopBar title={`${home?.name ?? ''} – ${away?.name ?? ''}`} back />
      <main>
        <div className="card scoreboard">
          <div className="small muted" style={{ marginBlockEnd: 8 }}>
            {compName(competition)} · {t('match.round', { n: match.round })}
          </div>
          <div className="teams">
            <strong>{home?.name}</strong>
            <span className="score">
              {report || events.length ? `${score.home} – ${score.away}` : '–'}
            </span>
            <strong>{away?.name}</strong>
          </div>
          <div className="row" style={{ justifyContent: 'center', marginBlockStart: 8 }}>
            <ReportChip report={report} />
            {match.status !== 'scheduled' && <span className="chip grey">{t(`match.status.${match.status}`)}</span>}
          </div>
          <div className="small muted" style={{ marginBlockStart: 10 }}>
            {formatDateTime(match.kickoff_at)}
            {venue && ` · ${venue.name}`}
            <br />
            {t('match.referee')}: {referee?.display_name ?? t('match.unassigned')}
          </div>
        </div>

        {locked && !isFedAdmin(me) && <div className="notice">{t('match.locked')}</div>}

        <Tabs value={tab} onChange={setTab} options={[['events', t('match.events')], ['lineups', t('match.lineups')]]} />

        {tab === 'events' ? (
          <>
            <Timeline events={events} match={match} editable={editEvents} />
            {editEvents && <EventForm match={match} home={home} away={away} lineups={lineups} />}
          </>
        ) : (
          <>
            {[home, away].map(
              (team) =>
                team && (
                  <LineupSection
                    key={team.id}
                    team={team}
                    match={match}
                    lineups={lineups.filter((l) => l.team_id === team.id)}
                    editable={can.editLineup(me, match, team, report)}
                  />
                ),
            )}
          </>
        )}

        <ReportActions match={match} report={report} score={live} />
        {isFedAdmin(me) && <MatchAdmin match={match} />}
      </main>
    </>
  );
}

function eventIcon(type: EventType) {
  if (type === 'yellow' || type === 'red' || type === 'second_yellow') return <span className={`card-icon ${type}`} aria-hidden />;
  if (type === 'sub') return <span aria-hidden>⇄</span>;
  return <span aria-hidden>⚽</span>;
}

function Timeline({ events, match, editable }: { events: MatchEvent[]; match: Match; editable: boolean }) {
  const { t } = useTranslation();
  const { players, teams } = useLookups();
  const sorted = [...events].sort((a, b) => a.minute - b.minute || (a.added_time ?? 0) - (b.added_time ?? 0));
  if (!sorted.length) return <div className="list"><div className="empty">{t('match.no_events')}</div></div>;
  const name = (id: string | null | undefined) => (id ? playerName(players.get(id)) || t('match.unknown_player') : t('match.unknown_player'));

  return (
    <div className="list timeline">
      {sorted.map((e) => (
        <div key={e.id} style={{ flexDirection: e.team_id === match.away_team_id ? 'row-reverse' : 'row' }}>
          <span className="minute">
            {e.minute}'{e.added_time ? `+${e.added_time}` : ''}
          </span>
          {eventIcon(e.type)}
          <span className="grow" style={{ textAlign: e.team_id === match.away_team_id ? 'end' : 'start' }}>
            <div>
              {e.type === 'sub' ? `${name(e.player_id)} ⇄ ${name(e.related_player_id)}` : name(e.player_id)}
            </div>
            <div className="sub">
              {t(`match.event.${e.type}`)} · {teams.get(e.team_id)?.name}
            </div>
          </span>
          {editable && (
            <button className="icon-btn" aria-label={t('common.delete')} onClick={async () => (await ask(t('common.confirm_delete'), { confirmLabel: t('common.delete'), danger: true })) && remove('match_events', e.id)}>
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function EventForm({ match, home, away, lineups }: { match: Match; home?: Team; away?: Team; lineups: MatchLineup[] }) {
  const { t } = useTranslation();
  const { players } = useLookups();
  const [type, setType] = useState<EventType>('goal');
  const [teamId, setTeamId] = useState(match.home_team_id);
  const [playerId, setPlayerId] = useState('');
  const [offId, setOffId] = useState('');
  const [minute, setMinute] = useState('');
  const [added, setAdded] = useState('');

  const teamLineup = lineups
    .filter((l) => l.team_id === teamId)
    .sort((a, b) => (a.shirt_number ?? 99) - (b.shirt_number ?? 99));
  const option = (l: MatchLineup) => (
    <option key={l.player_id} value={l.player_id}>
      {l.shirt_number != null ? `${l.shirt_number}. ` : ''}
      {playerName(players.get(l.player_id))}
    </option>
  );
  const valid = minute !== '' && (type !== 'sub' || (playerId && offId && playerId !== offId));

  return (
    <div className="card">
      <h3 style={{ marginBlockEnd: 10 }}>{t('match.add_event')}</h3>
      <div className="segmented">
        {EVENT_TYPES.map((et) => (
          <button key={et} type="button" className={type === et ? 'active' : ''} onClick={() => setType(et)}>
            {eventIcon(et)} {t(`match.event.${et}`)}
          </button>
        ))}
      </div>
      <div className="segmented">
        {[home, away].map(
          (tm) =>
            tm && (
              <button key={tm.id} type="button" className={teamId === tm.id ? 'active' : ''} onClick={() => { setTeamId(tm.id); setPlayerId(''); setOffId(''); }}>
                {tm.name}
              </button>
            ),
        )}
      </div>
      {teamLineup.length === 0 && <p className="notice">{t('match.no_lineup')}</p>}
      <Field label={type === 'sub' ? t('match.player_in') : t('match.player')}>
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
          <option value="">{t('match.unknown_player')}</option>
          {teamLineup.filter((l) => type !== 'sub' || !l.is_starter).map(option)}
        </select>
      </Field>
      {type === 'sub' && (
        <Field label={t('match.player_off')}>
          <select value={offId} onChange={(e) => setOffId(e.target.value)}>
            <option value="" />
            {teamLineup.filter((l) => l.player_id !== playerId).map(option)}
          </select>
        </Field>
      )}
      <div className="grid2">
        <Field label={t('match.minute')}>
          <input type="number" inputMode="numeric" min={0} max={130} value={minute} onChange={(e) => setMinute(e.target.value)} />
        </Field>
        <Field label={t('match.added_time')}>
          <input type="number" inputMode="numeric" min={0} max={30} value={added} onChange={(e) => setAdded(e.target.value)} />
        </Field>
      </div>
      <button
        className="block"
        disabled={!valid}
        onClick={async () => {
          await save('match_events', {
            match_id: match.id,
            team_id: teamId,
            type,
            minute: Number(minute),
            added_time: added ? Number(added) : null,
            player_id: playerId || null,
            related_player_id: type === 'sub' ? offId : null,
          });
          setPlayerId('');
          setOffId('');
          setMinute('');
          setAdded('');
        }}
      >
        {t('common.add')}
      </button>
    </div>
  );
}

function LineupSection({ team, match, lineups, editable }: { team: Team; match: Match; lineups: MatchLineup[]; editable: boolean }) {
  const { t } = useTranslation();
  const { players } = useLookups();
  const [picking, setPicking] = useState(false);
  const squad = useLiveQuery(() => db.data('squad_members').where('team_id').equals(team.id).toArray(), [team.id], []);
  const inLineup = new Set(lineups.map((l) => l.player_id));
  const sorted = [...lineups].sort((a, b) => Number(b.is_starter) - Number(a.is_starter) || (a.shirt_number ?? 99) - (b.shirt_number ?? 99));

  const toggle = (l: MatchLineup, field: 'is_starter' | 'is_captain' | 'is_goalkeeper') => save('match_lineups', { id: l.id, [field]: !l[field] });

  return (
    <section>
      <div className="spread">
        <h2>{team.name}</h2>
        <span className="small muted">
          {lineups.filter((l) => l.is_starter).length} + {lineups.filter((l) => !l.is_starter).length}
        </span>
      </div>
      <div className="list">
        {sorted.length === 0 && <div className="empty">{t('match.no_lineup')}</div>}
        {sorted.map((l) => {
          const p = players.get(l.player_id);
          return (
            <div key={l.id}>
              <span className="minute">{l.shirt_number ?? ''}</span>
              <span className="grow">
                <div className="ellipsis">{playerName(p) || t('match.unknown_player')}</div>
                <div className="row">
                  <span className={`chip ${l.is_starter ? '' : 'grey'}`}>{l.is_starter ? t('match.starter') : t('match.bench')}</span>
                  {l.is_captain && <span className="chip">{t('match.captain')}</span>}
                  {l.is_goalkeeper && <span className="chip">{t('match.goalkeeper')}</span>}
                </div>
              </span>
              {editable && (
                <span className="row">
                  <button className="secondary small" onClick={() => toggle(l, 'is_starter')} title={t('match.starter')}>
                    {l.is_starter ? '↓' : '↑'}
                  </button>
                  <button className="secondary small" onClick={() => toggle(l, 'is_captain')} title={t('match.captain')}>
                    C
                  </button>
                  <button className="secondary small" onClick={() => toggle(l, 'is_goalkeeper')} title={t('match.goalkeeper')}>
                    🧤
                  </button>
                  <button className="icon-btn" aria-label={t('common.remove')} onClick={() => remove('match_lineups', l.id)}>
                    ✕
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {editable && (
        <>
          <button className="secondary block" onClick={() => setPicking(!picking)} style={{ marginBlockEnd: 12 }}>
            {t('match.pick_players')}
          </button>
          {picking && (
            <div className="list">
              {squad.filter((s) => !inLineup.has(s.player_id)).length === 0 && <Empty />}
              {squad
                .filter((s) => !inLineup.has(s.player_id))
                .sort((a, b) => (a.shirt_number ?? 99) - (b.shirt_number ?? 99))
                .map((s) => (
                  <label key={s.id} className="check" style={{ marginBlockEnd: 0 }}>
                    <input
                      type="checkbox"
                      onChange={() =>
                        save('match_lineups', {
                          match_id: match.id,
                          team_id: team.id,
                          player_id: s.player_id,
                          shirt_number: s.shirt_number ?? null,
                          is_starter: lineups.filter((l) => l.is_starter).length < 11,
                          is_captain: false,
                          is_goalkeeper: s.position === 'GK',
                        })
                      }
                    />
                    <span className="minute">{s.shirt_number ?? ''}</span>
                    <span className="grow">{playerName(players.get(s.player_id) as Player | undefined) || t('match.unknown_player')}</span>
                  </label>
                ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ReportActions({ match, report, score }: { match: Match; report?: MatchReport; score: { home: number; away: number } }) {
  const { t } = useTranslation();
  const me = useMe();
  const fedAdmin = isFedAdmin(me);
  const isReferee = match.referee_user_id === me.id;
  const locked = isReportLocked(report);
  const [notes, setNotes] = useState<string | null>(null);

  const saveReport = (patch: Partial<MatchReport>) =>
    save('match_reports', report ? { id: match.id, ...patch } : {
      id: match.id,
      status: 'draft',
      home_score: score.home,
      away_score: score.away,
      notes: null,
      ...patch,
    });

  if (!isReferee && !fedAdmin) {
    return report?.notes ? (
      <div className="card">
        <h3>{t('match.notes')}</h3>
        <p>{report.notes}</p>
      </div>
    ) : null;
  }

  const notesEditable = fedAdmin || (isReferee && !locked);
  return (
    <div className="card">
      <Field label={t('match.notes')}>
        <textarea
          value={notes ?? report?.notes ?? ''}
          disabled={!notesEditable}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== null && notes !== (report?.notes ?? '') && saveReport({ notes: notes || null })}
        />
      </Field>
      <div className="row">
        {isReferee && !locked && (
          <button
            onClick={async () =>
              (await ask(t('match.submit_confirm', { score: `\u2066${score.home}–${score.away}\u2069` }), { confirmLabel: t('match.submit_report') })) &&
              saveReport({ status: 'submitted', home_score: score.home, away_score: score.away, ...(notes !== null ? { notes: notes || null } : {}) })
            }
          >
            {t('match.submit_report')}
          </button>
        )}
        {fedAdmin && report?.status === 'submitted' && <button onClick={() => saveReport({ status: 'approved' })}>{t('match.approve')}</button>}
        {fedAdmin && locked && (
          <button className="secondary" onClick={() => saveReport({ status: 'reopened' })}>
            {t('match.reopen')}
          </button>
        )}
      </div>
    </div>
  );
}

function MatchAdmin({ match }: { match: Match }) {
  const { t } = useTranslation();
  const toast = useToast();
  const venues = useLiveQuery(() => db.data('venues').orderBy('name').toArray(), [], []);
  const referees = useLiveQuery(() => db.data('user_profiles').filter((u) => !!u.is_referee).toArray(), [], []);
  const [open, setOpen] = useState(false);
  const toLocal = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  if (!open)
    return (
      <button className="secondary block" onClick={() => setOpen(true)}>
        {t('match.edit')}
      </button>
    );
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save('matches', {
          id: match.id,
          kickoff_at: new Date(f.get('kickoff') as string).toISOString(),
          venue_id: (f.get('venue') as string) || null,
          referee_user_id: (f.get('referee') as string) || null,
          status: f.get('status') as Match['status'],
        });
        toast.show(t('common.saved'));
        setOpen(false);
      }}
    >
      <h3 style={{ marginBlockEnd: 10 }}>{t('match.edit')}</h3>
      <Field label={t('match.kickoff')}>
        <input name="kickoff" type="datetime-local" defaultValue={toLocal(match.kickoff_at)} required />
      </Field>
      <Field label={t('match.venue')}>
        <select name="venue" defaultValue={match.venue_id ?? ''}>
          <option value="" />
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('match.referee')}>
        <select name="referee" defaultValue={match.referee_user_id ?? ''}>
          <option value="">{t('match.unassigned')}</option>
          {referees.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('match.status_label')}>
        <select name="status" defaultValue={match.status}>
          {MATCH_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`match.status.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <button>{t('common.save')}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
      {toast.node}
    </form>
  );
}
