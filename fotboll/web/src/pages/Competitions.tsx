import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { computeStandings, roundRobin, type Competition, type MatchReport, type Team } from '@fotboll/shared';
import { Empty, Field, MatchCard, Tabs, TopBar, useToast } from '../components';
import { db } from '../db';
import { isReportLocked, useCompetitionName, useLookups, useMe } from '../hooks';
import { save } from '../mutate';
import { isFedAdmin } from '../session';

export function CompetitionsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const compName = useCompetitionName();
  const [adding, setAdding] = useState<'season' | 'competition' | null>(null);
  const data = useLiveQuery(async () => {
    const seasons = await db.data('seasons').orderBy('starts_on').reverse().toArray();
    const competitions = await db.data('competitions').toArray();
    return { seasons, competitions };
  }, []);
  if (!data) return <TopBar title={t('nav.tables')} />;

  return (
    <>
      <TopBar title={t('nav.tables')} />
      <main>
        {isFedAdmin(me) && (
          <div className="fab-row">
            <button className="secondary" onClick={() => setAdding('competition')} disabled={!data.seasons.length}>
              + {t('competition.new')}
            </button>
            <button className="secondary" onClick={() => setAdding('season')}>
              + {t('competition.new_season')}
            </button>
          </div>
        )}
        {adding === 'season' && <SeasonForm onDone={() => setAdding(null)} />}
        {adding === 'competition' && <CompetitionForm seasons={data.seasons} onDone={() => setAdding(null)} />}
        {data.seasons.length === 0 && <Empty />}
        {data.seasons.map((s) => (
          <section key={s.id}>
            <h2>
              {t('competition.season')} {s.name}
            </h2>
            <div className="list">
              {data.competitions.filter((c) => c.season_id === s.id).length === 0 && <Empty />}
              {data.competitions
                .filter((c) => c.season_id === s.id)
                .map((c) => (
                  <Link key={c.id} to={`/competitions/${c.id}`}>
                    <span className="grow">
                      <div>{compName(c)}</div>
                      <div className="sub">
                        {t(`competition.gender.${c.gender}`)}
                        {c.age_group ? ` · ${c.age_group}` : ''}
                      </div>
                    </span>
                    <span aria-hidden>›</span>
                  </Link>
                ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}

function SeasonForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save('seasons', {
          name: f.get('name') as string,
          starts_on: f.get('starts_on') as string,
          ends_on: f.get('ends_on') as string,
        });
        onDone();
      }}
    >
      <Field label={t('competition.name')}>
        <input name="name" required defaultValue={String(year)} />
      </Field>
      <div className="grid2">
        <Field label={t('competition.starts_on')}>
          <input name="starts_on" type="date" required defaultValue={`${year}-04-01`} />
        </Field>
        <Field label={t('competition.ends_on')}>
          <input name="ends_on" type="date" required defaultValue={`${year}-10-31`} />
        </Field>
      </div>
      <FormButtons onCancel={onDone} />
    </form>
  );
}

function CompetitionForm({ seasons, onDone }: { seasons: { id: string; name: string }[]; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save('competitions', {
          season_id: f.get('season_id') as string,
          name: f.get('name') as string,
          name_i18n: null,
          age_group: (f.get('age_group') as string) || null,
          gender: f.get('gender') as Competition['gender'],
          points_win: Number(f.get('points_win')),
          points_draw: Number(f.get('points_draw')),
          points_loss: 0,
        });
        onDone();
      }}
    >
      <Field label={t('competition.season')}>
        <select name="season_id">
          {seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('competition.name')}>
        <input name="name" required />
      </Field>
      <div className="grid2">
        <Field label={t('competition.age_group')}>
          <input name="age_group" placeholder="U17" />
        </Field>
        <Field label=" ">
          <select name="gender">
            {(['male', 'female', 'mixed'] as const).map((g) => (
              <option key={g} value={g}>
                {t(`competition.gender.${g}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('competition.points_win')}>
          <input name="points_win" type="number" min={0} max={10} defaultValue={3} />
        </Field>
        <Field label={t('competition.points_draw')}>
          <input name="points_draw" type="number" min={0} max={10} defaultValue={1} />
        </Field>
      </div>
      <FormButtons onCancel={onDone} />
    </form>
  );
}

function FormButtons({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="row">
      <button>{t('common.save')}</button>
      <button type="button" className="secondary" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}

export function CompetitionPage() {
  const { id } = useParams() as { id: string };
  const { t } = useTranslation();
  const me = useMe();
  const compName = useCompetitionName();
  const [tab, setTab] = useState<'table' | 'fixtures' | 'teams'>('table');

  const data = useLiveQuery(async () => {
    const competition = await db.data('competitions').get(id);
    if (!competition) return null;
    const teams = await db.data('teams').where('competition_id').equals(id).toArray();
    const matches = (await db.data('matches').where('competition_id').equals(id).toArray()).sort(
      (a, b) => a.round - b.round || a.kickoff_at.localeCompare(b.kickoff_at),
    );
    const reports = new Map((await db.data('match_reports').bulkGet(matches.map((m) => m.id))).filter((r) => !!r).map((r) => [r!.id, r!]));
    return { competition, teams, matches, reports };
  }, [id]);

  if (!data) return <TopBar title={t('nav.tables')} back />;
  const { competition, teams, matches, reports } = data;

  return (
    <>
      <TopBar title={compName(competition)} back />
      <main>
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            ['table', t('competition.standings')],
            ['fixtures', t('competition.schedule')],
            ['teams', t('competition.teams')],
          ]}
        />
        {tab === 'table' && <Standings competition={competition} teams={teams} matches={matches} reports={reports} />}
        {tab === 'fixtures' && (
          <>
            {matches.length === 0 && <Empty />}
            {[...new Set(matches.map((m) => m.round))].map((round) => (
              <section key={round}>
                <h2>{t('match.round', { n: round })}</h2>
                <div className="list">
                  {matches
                    .filter((m) => m.round === round)
                    .map((m) => (
                      <div key={m.id}>
                        <MatchCard match={m} report={reports.get(m.id)} home={teams.find((x) => x.id === m.home_team_id)} away={teams.find((x) => x.id === m.away_team_id)} />
                      </div>
                    ))}
                </div>
              </section>
            ))}
            {isFedAdmin(me) && teams.length >= 2 && <AddMatch competitionId={id} teams={teams} nextRound={(matches.at(-1)?.round ?? 0) + 1} />}
          </>
        )}
        {tab === 'teams' && <TeamsTab competition={competition} teams={teams} hasMatches={matches.length > 0} />}
      </main>
    </>
  );
}

function Standings({
  competition,
  teams,
  matches,
  reports,
}: {
  competition: Competition;
  teams: Team[];
  matches: { id: string; home_team_id: string; away_team_id: string; kickoff_at: string }[];
  reports: Map<string, MatchReport>;
}) {
  const { t } = useTranslation();
  // Computed on the device from synced results, so the table works offline.
  const counted = matches
    .filter((m) => isReportLocked(reports.get(m.id)))
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))
    .map((m) => ({ ...m, home_score: reports.get(m.id)!.home_score, away_score: reports.get(m.id)!.away_score }));
  const rows = computeStandings(teams, counted, competition);
  if (!teams.length) return <Empty />;
  return (
    <>
      <div className="table-wrap">
        <table className="standings">
          <thead>
            <tr>
              <th>{t('table.pos')}</th>
              <th className="team">{t('table.team')}</th>
              <th>{t('table.p')}</th>
              <th className="wide">{t('table.w')}</th>
              <th className="wide">{t('table.d')}</th>
              <th className="wide">{t('table.l')}</th>
              <th className="wide">{t('table.goals')}</th>
              <th>{t('table.gd')}</th>
              <th>{t('table.pts')}</th>
              <th>{t('table.form')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team_id}>
                <td>{r.position}</td>
                <td className="team">{r.name}</td>
                <td>{r.played}</td>
                <td className="wide">{r.won}</td>
                <td className="wide">{r.drawn}</td>
                <td className="wide">{r.lost}</td>
                <td className="wide" dir="ltr">
                  {r.goals_for}–{r.goals_against}
                </td>
                <td dir="ltr">{r.goal_diff > 0 ? `+${r.goal_diff}` : r.goal_diff}</td>
                <td className="pts">{r.points}</td>
                <td>
                  <span className="form">
                    {r.form.map((f, i) => (
                      <span key={i} className={f}>
                        {t(`table.form_letter.${f}`)}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginBlockStart: 8 }}>
        {t('table.counted')}
      </p>
    </>
  );
}

function TeamsTab({ competition, teams, hasMatches }: { competition: Competition; teams: Team[]; hasMatches: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const { clubs } = useLookups();
  const fedAdmin = isFedAdmin(me);
  const [clubId, setClubId] = useState('');
  const available = [...clubs.values()].filter((c) => c.status === 'active');

  return (
    <>
      <div className="list">
        {teams.length === 0 && <Empty />}
        {teams
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((tm) => (
            <Link key={tm.id} to={`/teams/${tm.id}`}>
              <span className="grow">
                <div>{tm.name}</div>
                <div className="sub">{clubs.get(tm.club_id)?.name}</div>
              </span>
              <span aria-hidden>›</span>
            </Link>
          ))}
      </div>
      {fedAdmin && (
        <div className="card">
          <Field label={t('competition.add_team')}>
            <select value={clubId} onChange={(e) => setClubId(e.target.value)}>
              <option value="">{t('competition.club')}</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            disabled={!clubId}
            onClick={async () => {
              await save('teams', { club_id: clubId, competition_id: competition.id, name: clubs.get(clubId)!.name });
              setClubId('');
            }}
          >
            {t('common.add')}
          </button>
        </div>
      )}
      {fedAdmin && !hasMatches && teams.length >= 2 && <GenerateFixtures competitionId={competition.id} teams={teams} />}
    </>
  );
}

function GenerateFixtures({ competitionId, teams }: { competitionId: string; teams: Team[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const venues = useLiveQuery(() => db.data('venues').toArray(), [], []);
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const first = new Date(`${f.get('first_day')}T${f.get('time')}`);
        const days = Number(f.get('days'));
        const fixtures = roundRobin(
          teams.map((x) => x.id),
          f.get('double') === 'on',
        );
        for (const fx of fixtures) {
          const kickoff = new Date(first.getTime() + (fx.round - 1) * days * 86400000);
          await save('matches', {
            competition_id: competitionId,
            round: fx.round,
            home_team_id: fx.home_team_id,
            away_team_id: fx.away_team_id,
            venue_id: (f.get('venue') as string) || null,
            kickoff_at: kickoff.toISOString(),
            status: 'scheduled',
            referee_user_id: null,
          });
        }
        toast.show(t('competition.generated', { count: fixtures.length }));
      }}
    >
      <h3 style={{ marginBlockEnd: 10 }}>{t('competition.generate')}</h3>
      <div className="grid2">
        <Field label={t('competition.first_day')}>
          <input name="first_day" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
        </Field>
        <Field label={t('competition.kickoff_time')}>
          <input name="time" type="time" required defaultValue="14:00" />
        </Field>
        <Field label={t('competition.days_between')}>
          <input name="days" type="number" min={1} max={60} defaultValue={7} />
        </Field>
        <Field label={t('match.venue')}>
          <select name="venue">
            <option value="" />
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input name="double" type="checkbox" defaultChecked />
        {t('competition.double_round')}
      </label>
      <button>{t('competition.generate')}</button>
      {toast.node}
    </form>
  );
}

function AddMatch({ competitionId, teams, nextRound }: { competitionId: string; teams: Team[]; nextRound: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="secondary block" onClick={() => setOpen(true)}>
        + {t('competition.add_match')}
      </button>
    );
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await save('matches', {
          competition_id: competitionId,
          round: Number(f.get('round')),
          home_team_id: f.get('home') as string,
          away_team_id: f.get('away') as string,
          kickoff_at: new Date(f.get('kickoff') as string).toISOString(),
          status: 'scheduled',
          venue_id: null,
          referee_user_id: null,
        });
        setOpen(false);
      }}
    >
      <div className="grid2">
        <Field label={t('competition.home')}>
          <select name="home">
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('competition.away')}>
          <select name="away" defaultValue={teams[1]?.id}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('match.kickoff')}>
          <input name="kickoff" type="datetime-local" required />
        </Field>
        <Field label={t('match.round', { n: '' })}>
          <input name="round" type="number" min={1} defaultValue={nextRound} />
        </Field>
      </div>
      <FormButtons onCancel={() => setOpen(false)} />
    </form>
  );
}
