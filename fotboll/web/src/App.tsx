import { useEffect } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BottomNav, ConfirmHost } from './components';
import { DEMO } from './demo';
import { setLanguage } from './i18n';
import { useSession } from './session';
import { syncEngine } from './sync';
import { AdminPage } from './pages/Admin';
import { ClubPage, ClubsPage } from './pages/Clubs';
import { CompetitionPage, CompetitionsPage } from './pages/Competitions';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { MatchPage } from './pages/Match';
import { MatchesPage } from './pages/Matches';
import { MorePage } from './pages/More';
import { PlayerPage } from './pages/Player';
import { SetPasswordPage } from './pages/SetPassword';
import { TeamPage } from './pages/Team';
import { PublicSite } from './public/PublicSite';

export function App() {
  // The demo runs inside an embedded frame, so routing stays in memory.
  const Router = DEMO ? MemoryRouter : BrowserRouter;
  return (
    <Router>
      <Routes>
        {/* Open to everyone: results for supporters, and invitation/reset links. */}
        <Route path="/public/*" element={<PublicSite />} />
        <Route path="/set-password/:token" element={<SetPasswordPage />} />
        <Route path="*" element={<MemberApp />} />
      </Routes>
      <ConfirmHost />
    </Router>
  );
}

function MemberApp() {
  const { me, expired } = useSession();
  const { t } = useTranslation();

  useEffect(() => {
    if (me) setLanguage(me.locale);
  }, [me?.locale]);

  useEffect(() => {
    if (me && !expired) return syncEngine.start();
  }, [me?.id, expired]);

  if (!me) return <LoginPage />;
  if (expired) return <LoginPage notice={t('auth.session_expired')} email={me.email} />;

  return (
    <div className="app">
      {DEMO && <div className="demo-banner">{t('demo.banner')}</div>}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/matches/:id" element={<MatchPage />} />
        <Route path="/competitions" element={<CompetitionsPage />} />
        <Route path="/competitions/:id" element={<CompetitionPage />} />
        <Route path="/clubs" element={<ClubsPage />} />
        <Route path="/clubs/:id" element={<ClubPage />} />
        <Route path="/teams/:id" element={<TeamPage />} />
        <Route path="/players/:id" element={<PlayerPage />} />
        <Route path="/more" element={<MorePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <BottomNav />
    </div>
  );
}
