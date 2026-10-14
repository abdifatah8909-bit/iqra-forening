import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Empty, MatchCard, Tabs, TopBar } from '../components';
import { db } from '../db';
import { isReportLocked, useCompetitionName, useLookups } from '../hooks';
import { formatDateTime } from '../i18n';

export function MatchesPage() {
  const { t } = useTranslation();
  const { teams } = useLookups();
  const compName = useCompetitionName();
  const [view, setView] = useState<'upcoming' | 'played'>('upcoming');
  const [competitionId, setCompetitionId] = useState('');

  const data = useLiveQuery(async () => {
    const [matches, reports, competitions] = await Promise.all([
      db.data('matches').orderBy('kickoff_at').toArray(),
      db.data('match_reports').toArray(),
      db.data('competitions').toArray(),
    ]);
    return { matches, reports: new Map(reports.map((r) => [r.id, r])), competitions };
  }, []);
  if (!data) return <TopBar title={t('nav.matches')} />;

  const played = (id: string) => isReportLocked(data.reports.get(id));
  let list = data.matches.filter((m) => (!competitionId || m.competition_id === competitionId) && (view === 'played') === played(m.id));
  if (view === 'played') list = list.reverse();

  // Group by calendar day.
  const groups = new Map<string, typeof list>();
  for (const m of list) {
    const day = formatDateTime(m.kickoff_at, { weekday: 'long', day: 'numeric', month: 'long' });
    groups.set(day, [...(groups.get(day) ?? []), m]);
  }

  return (
    <>
      <TopBar title={t('nav.matches')} />
      <main>
        <Tabs value={view} onChange={setView} options={[['upcoming', t('match.upcoming')], ['played', t('match.played')]]} />
        {data.competitions.length > 1 && (
          <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)} style={{ marginBlockEnd: 12 }}>
            <option value="">{t('common.all')}</option>
            {data.competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {compName(c)}
              </option>
            ))}
          </select>
        )}
        {groups.size === 0 && <Empty />}
        {[...groups].map(([day, matches]) => (
          <section key={day}>
            <h2>{day}</h2>
            <div className="list">
              {matches.map((m) => (
                <div key={m.id}>
                  <MatchCard match={m} report={data.reports.get(m.id)} home={teams.get(m.home_team_id)} away={teams.get(m.away_team_id)} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
