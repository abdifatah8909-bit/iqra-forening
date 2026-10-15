import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { computeStandings, LOCALES, type PublicData } from '@fotboll/shared';
import { api, ApiError } from '../api';
import { Empty, StandingsTable, Tabs } from '../components';
import { DEMO, demoPublicData } from '../demo';
import { chooseLanguage, formatDateTime, LANGUAGE_NAMES } from '../i18n';
import emblem from '../emblem.svg';

/**
 * Public pages for supporters and parents: fixtures, results, league tables
 * and clubs, without signing in. Read-only and free of personal data.
 */
export function PublicSite() {
  return (
    <Routes>
      <Route index element={<FederationPicker />} />
      <Route path=":fed/*" element={<FederationSite />} />
    </Routes>
  );
}

function FederationPicker() {
  const { t } = useTranslation();
  const [feds, setFeds] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = DEMO
      ? demoPublicData().then((d) => [d.federation])
      : api<{ id: string; name: string }[]>('/public/federations');
    load.then(setFeds).catch((e) => setError(e instanceof ApiError ? e.code : 'unknown'));
  }, []);
  if (feds?.length === 1) return <Navigate to={`/public/${feds[0].id}`} replace />;
  return (
    <div className="public">
      <PublicHeader title={t('app.name')} />
      <main>
        {error && <p className="error-text">{t(`errors.${error}`, { defaultValue: t('errors.unknown') })}</p>}
        {feds && (
          <div className="list">
            {feds.length === 0 && <Empty />}
            {feds.map((f) => (
              <Link key={f.id} to={`/public/${f.id}`}>
                <span className="grow">{f.name}</span>
                <span aria-hidden>›</span>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/** Fetches the federation's public data and refreshes it every minute while the page is open. */
function usePublicData(fed: string) {
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(DEMO ? await demoPublicData() : await api<PublicData>(`/public/federations/${fed}`));
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'unknown');
    }
  }, [fed]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);
  return { data, error, loadedAt, reload: load };
}

function FederationSite() {
  const { fed } = useParams() as { fed: string };
  const { t } = useTranslation();
  const { data, error, loadedAt, reload } = usePublicData(fed);

  return (
    <div className="public">
      <PublicHeader title={data?.federation.name ?? t('app.name')} />
      <nav className="public-nav">
        <NavLink to={`/public/${fed}`} end>
          {t('public.overview')}
        </NavLink>
        <NavLink to={`/public/${fed}/matches`}>{t('nav.matches')}</NavLink>
        <NavLink to={`/public/${fed}/clubs`}>{t('nav.clubs')}</NavLink>
      </nav>
      <main>
        {error && (
          <div className="notice">
            {t(`errors.${error}`, { defaultValue: t('errors.unknown') })}{' '}
            <button className="secondary small" onClick={() => void reload()}>
              {t('public.retry')}
            </button>
          </div>
        )}
        {!data && !error && <p className="muted center">…</p>}
        {data && (
          <Routes>
            <Route index element={<Overview data={data} />} />
            <Route path="matches" element={<AllMatches data={data} />} />
            <Route path="c/:comp" element={<CompetitionView data={data} />} />
            <Route path="clubs" element={<ClubList data={data} />} />
            <Route path="clubs/:club" element={<ClubView data={data} />} />
          </Routes>
        )}
        {loadedAt && (
          <p className="muted small center" style={{ marginBlockStart: 24 }}>
            {t('public.updated', { time: formatDateTime(loadedAt, { timeStyle: 'short' }) })} ·{' '}
            {t('table.counted')}
          </p>
        )}
      </main>
    </div>
  );
}

function PublicHeader({ title }: { title: string }) {
  const { t, i18n } = useTranslation();
  return (
    <header className="topbar public-top">
      <img src={emblem} alt="" className="public-logo" />
      <h1>{title}</h1>
      <select
        aria-label={t('settings.language')}
        value={i18n.language}
        onChange={(e) => chooseLanguage(e.target.value as (typeof LOCALES)[number])}
        className="public-lang"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
      <Link to="/" className="public-login">
        {t('auth.submit')}
      </Link>
    </header>
  );
}

/** Lookups and helpers derived from one PublicData payload. */
function usePublic(data: PublicData) {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const teams = new Map(data.teams.map((x) => [x.id, x]));
    const clubs = new Map(data.clubs.map((x) => [x.id, x]));
    const competitions = new Map(data.competitions.map((x) => [x.id, x]));
    const venues = new Map(data.venues.map((x) => [x.id, x]));
    const results = new Map(data.results.map((r) => [r.id, r]));
    const today = new Date().toISOString().slice(0, 10);
    const season =
      data.seasons.find((s) => s.starts_on <= today && today <= s.ends_on) ?? data.seasons[0] ?? null;
    const compName = (id: string) => {
      const c = competitions.get(id);
      return c ? c.name_i18n?.[i18n.language as 'so' | 'en' | 'ar'] || c.name : '';
    };
    return { teams, clubs, competitions, venues, results, season, compName };
  }, [data, i18n.language]);
}

type PublicMatch = PublicData['matches'][number];

function MatchRow({ data, match, showCompetition = true }: { data: PublicData; match: PublicMatch; showCompetition?: boolean }) {
  const { t } = useTranslation();
  const p = usePublic(data);
  const result = p.results.get(match.id);
  const venue = match.venue_id ? p.venues.get(match.venue_id) : undefined;
  return (
    <div style={{ display: 'block' }}>
      <div className="spread small muted" style={{ marginBlockEnd: 4 }}>
        <span>
          {formatDateTime(match.kickoff_at, { weekday: 'short', day: 'numeric', month: 'short' })}
          {venue && ` · ${venue.name}`}
        </span>
        <span className="row">
          {showCompetition && (
            <Link to={`/public/${data.federation.id}/c/${match.competition_id}`} className="chip">
              {p.compName(match.competition_id)}
            </Link>
          )}
          {(match.status === 'postponed' || match.status === 'cancelled') && (
            <span className="chip warn">{t(`match.status.${match.status}`)}</span>
          )}
        </span>
      </div>
      <div className="match-card">
        <span className="team">{p.teams.get(match.home_team_id)?.name}</span>
        <span className="mid">
          {result ? (
            <span className="score">
              {result.home_score} – {result.away_score}
            </span>
          ) : (
            <span className="small">{formatDateTime(match.kickoff_at, { timeStyle: 'short' })}</span>
          )}
        </span>
        <span className="team away">{p.teams.get(match.away_team_id)?.name}</span>
      </div>
    </div>
  );
}

function MatchList({ data, matches, showCompetition }: { data: PublicData; matches: PublicMatch[]; showCompetition?: boolean }) {
  return (
    <div className="list">
      {matches.length === 0 && <Empty />}
      {matches.map((m) => (
        <MatchRow key={m.id} data={data} match={m} showCompetition={showCompetition} />
      ))}
    </div>
  );
}

/** Played = has a counted result; upcoming = scheduled and not yet kicked off. */
function splitMatches(data: PublicData, results: Map<string, unknown>, matches = data.matches) {
  const now = new Date().toISOString();
  return {
    played: matches.filter((m) => results.has(m.id)).sort((a, b) => b.kickoff_at.localeCompare(a.kickoff_at)),
    upcoming: matches
      .filter((m) => !results.has(m.id) && m.status !== 'cancelled' && m.kickoff_at >= now.slice(0, 10))
      .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at)),
  };
}

function Overview({ data }: { data: PublicData }) {
  const { t } = useTranslation();
  const p = usePublic(data);
  const { played, upcoming } = splitMatches(data, p.results);
  const bySeason = data.seasons.map((s) => ({ season: s, competitions: data.competitions.filter((c) => c.season_id === s.id) }));

  return (
    <>
      <h2>{t('public.leagues')}</h2>
      {bySeason.length === 0 && <Empty />}
      {bySeason.map(({ season, competitions }) => (
        <section key={season.id}>
          {data.seasons.length > 1 && (
            <h3 className="muted" style={{ marginBlock: '4px 8px' }}>
              {t('competition.season')} {season.name}
            </h3>
          )}
          <div className="list">
            {competitions.length === 0 && <Empty />}
            {competitions.map((c) => (
              <Link key={c.id} to={`/public/${data.federation.id}/c/${c.id}`}>
                <span className="grow">
                  <div>{p.compName(c.id)}</div>
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

      <h2>{t('home.recent')}</h2>
      <MatchList data={data} matches={played.slice(0, 6)} />
      <h2>{t('home.upcoming')}</h2>
      <MatchList data={data} matches={upcoming.slice(0, 6)} />
    </>
  );
}

function AllMatches({ data }: { data: PublicData }) {
  const { t } = useTranslation();
  const p = usePublic(data);
  const [tab, setTab] = useState<'upcoming' | 'played'>('upcoming');
  const { played, upcoming } = splitMatches(data, p.results);
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          ['upcoming', t('match.upcoming')],
          ['played', t('public.results')],
        ]}
      />
      <MatchList data={data} matches={tab === 'played' ? played : upcoming} />
    </>
  );
}

function CompetitionView({ data }: { data: PublicData }) {
  const { comp } = useParams() as { comp: string };
  const { t } = useTranslation();
  const p = usePublic(data);
  const [tab, setTab] = useState<'table' | 'fixtures'>('table');
  const competition = p.competitions.get(comp);
  if (!competition) return <Empty />;

  const teams = data.teams.filter((x) => x.competition_id === comp);
  const matches = data.matches
    .filter((m) => m.competition_id === comp)
    .sort((a, b) => a.round - b.round || a.kickoff_at.localeCompare(b.kickoff_at));
  const counted = matches
    .filter((m) => p.results.has(m.id))
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))
    .map((m) => ({ ...m, ...p.results.get(m.id)! }));
  const rows = computeStandings(teams, counted, competition);
  const rounds = [...new Set(matches.map((m) => m.round))];

  return (
    <>
      <h1 style={{ marginBlockEnd: 12 }}>{p.compName(comp)}</h1>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          ['table', t('competition.standings')],
          ['fixtures', t('competition.schedule')],
        ]}
      />
      {tab === 'table' ? (
        teams.length ? <StandingsTable rows={rows} /> : <Empty />
      ) : (
        <>
          {rounds.length === 0 && <Empty />}
          {rounds.map((round) => (
            <section key={round}>
              <h2>{t('match.round', { n: round })}</h2>
              <MatchList data={data} matches={matches.filter((m) => m.round === round)} showCompetition={false} />
            </section>
          ))}
        </>
      )}
    </>
  );
}

function ClubLogo({ id, name }: { id: string | null; name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  if (id && !DEMO) return <img className="avatar" src={`/api/public/media/${id}`} alt="" loading="lazy" />;
  return (
    <span className="avatar" aria-hidden>
      {initials}
    </span>
  );
}

function ClubList({ data }: { data: PublicData }) {
  return (
    <div className="list" style={{ marginBlockStart: 16 }}>
      {data.clubs.length === 0 && <Empty />}
      {data.clubs.map((c) => (
        <Link key={c.id} to={`/public/${data.federation.id}/clubs/${c.id}`}>
          <ClubLogo id={c.logo_media_id} name={c.name} />
          <span className="grow">
            <div>{c.name}</div>
            {c.city && <div className="sub">{c.city}</div>}
          </span>
          <span aria-hidden>›</span>
        </Link>
      ))}
    </div>
  );
}

function ClubView({ data }: { data: PublicData }) {
  const { club: clubId } = useParams() as { club: string };
  const { t } = useTranslation();
  const p = usePublic(data);
  const club = p.clubs.get(clubId);
  if (!club) return <Empty />;
  const teams = data.teams.filter((x) => x.club_id === clubId);
  const teamIds = new Set(teams.map((x) => x.id));
  const { played, upcoming } = splitMatches(
    data,
    p.results,
    data.matches.filter((m) => teamIds.has(m.home_team_id) || teamIds.has(m.away_team_id)),
  );
  return (
    <>
      <div className="card center" style={{ marginBlockStart: 16 }}>
        <ClubLogo id={club.logo_media_id} name={club.name} />
        <h1 style={{ marginBlockStart: 8 }}>{club.name}</h1>
        {club.city && <p className="muted small">{club.city}</p>}
      </div>
      <h2>{t('club.teams')}</h2>
      <div className="list">
        {teams.length === 0 && <Empty />}
        {teams.map((x) => (
          <Link key={x.id} to={`/public/${data.federation.id}/c/${x.competition_id}`}>
            <span className="grow">
              <div>{x.name}</div>
              <div className="sub">{p.compName(x.competition_id)}</div>
            </span>
            <span aria-hidden>›</span>
          </Link>
        ))}
      </div>
      <h2>{t('home.upcoming')}</h2>
      <MatchList data={data} matches={upcoming.slice(0, 10)} />
      <h2>{t('home.recent')}</h2>
      <MatchList data={data} matches={played.slice(0, 10)} />
    </>
  );
}
