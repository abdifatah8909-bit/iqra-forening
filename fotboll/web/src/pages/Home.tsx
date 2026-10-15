import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { transferAwaits } from '@fotboll/shared';
import { Empty, MatchCard, TopBar } from '../components';
import { db } from '../db';
import { isReportLocked, transferActor, useLookups, useMe } from '../hooks';
import { adminClubIds, hasRole, isFedAdmin } from '../session';

export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const { teams, clubs } = useLookups();
  const clubIds = adminClubIds(me);
  const fedAdmin = isFedAdmin(me);

  const data = useLiveQuery(async () => {
    const matches = await db.data('matches').orderBy('kickoff_at').toArray();
    const reports = new Map((await db.data('match_reports').toArray()).map((r) => [r.id, r]));
    const myTeamIds = new Set(
      (await db.data('teams').toArray()).filter((tm) => clubIds.includes(tm.club_id)).map((tm) => tm.id),
    );
    const now = new Date().toISOString();
    const relevant = (m: (typeof matches)[number]) =>
      fedAdmin || m.referee_user_id === me.id || myTeamIds.has(m.home_team_id) || myTeamIds.has(m.away_team_id);
    return {
      reports,
      // Referee: assigned matches without a submitted report, oldest first.
      refereeDue: matches
        .filter((m) => m.referee_user_id === me.id && m.status !== 'cancelled' && !isReportLocked(reports.get(m.id)))
        .slice(0, 6),
      upcoming: matches.filter((m) => m.kickoff_at >= now && m.status === 'scheduled' && relevant(m)).slice(0, 5),
      recent: matches.filter((m) => reports.get(m.id) && isReportLocked(reports.get(m.id))).reverse().slice(0, 5),
      toApprove: fedAdmin ? matches.filter((m) => reports.get(m.id)?.status === 'submitted') : [],
      pendingRegs: await db.data('registrations').where('status').equals('pending').count(),
      transfersToHandle: (await db.data('transfers').toArray()).filter((x) => transferAwaits(x, transferActor(me))).length,
    };
  }, [me.id, fedAdmin, clubIds.join()]);

  if (!data) return <TopBar title={t('app.name')} />;
  const card = (m: (typeof data.upcoming)[number], extra?: React.ReactNode) => (
    <div key={m.id}>
      <MatchCard match={m} report={data.reports.get(m.id)} home={teams.get(m.home_team_id)} away={teams.get(m.away_team_id)} extra={extra} />
    </div>
  );

  return (
    <>
      <TopBar title={t('app.name')} />
      <main>
        <h1 style={{ marginBlockEnd: 4 }}>{t('home.hello', { name: me.display_name })}</h1>
        <p className="muted small">{me.roles.map((r) => t(`roles.${r.role}`)).join(' · ')}</p>

        {clubIds.length > 0 && (
          <div className="list">
            {clubIds.map((id) => (
              <Link key={id} to={`/clubs/${id}`}>
                <span className="grow">
                  <span className="sub">{t('home.my_club')}</span>
                  <div>{clubs.get(id)?.name}</div>
                </span>
                <span aria-hidden>›</span>
              </Link>
            ))}
          </div>
        )}

        {data.transfersToHandle > 0 && (
          <div className="list">
            <Link to="/transfers">
              <span className="grow">{t('transfer.to_handle')}</span>
              <span className="chip warn">{data.transfersToHandle}</span>
            </Link>
          </div>
        )}

        {fedAdmin && (data.toApprove.length > 0 || data.pendingRegs > 0) && (
          <div className="list">
            {data.toApprove.length > 0 && (
              <Link to="/admin">
                <span className="grow">{t('home.to_approve')}</span>
                <span className="chip warn">{data.toApprove.length}</span>
              </Link>
            )}
            {data.pendingRegs > 0 && (
              <Link to="/admin">
                <span className="grow">{t('home.pending_registrations')}</span>
                <span className="chip warn">{data.pendingRegs}</span>
              </Link>
            )}
          </div>
        )}

        {hasRole(me, 'referee') && (
          <>
            <h2>{t('home.my_matches')}</h2>
            <div className="list">
              {data.refereeDue.length ? (
                data.refereeDue.map((m) =>
                  card(m, m.kickoff_at < new Date().toISOString() ? <span className="chip warn">{t('home.report_due')}</span> : null),
                )
              ) : (
                <Empty />
              )}
            </div>
          </>
        )}

        <h2>{t('home.upcoming')}</h2>
        <div className="list">{data.upcoming.length ? data.upcoming.map((m) => card(m)) : <Empty />}</div>

        <h2>{t('home.recent')}</h2>
        <div className="list">{data.recent.length ? data.recent.map((m) => card(m)) : <Empty />}</div>
      </main>
    </>
  );
}
