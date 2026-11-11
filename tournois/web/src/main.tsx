import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout, Loading, Notifications } from './components/ui';
import { LoginPage, PrivacyPage } from './pages/Auth';
import { Home } from './pages/Home';
import { AccountPage, JoinPage, PublicPage } from './pages/Join';
import { MatchPage } from './pages/Match';
import { PrintPage, TournamentPage } from './pages/Tournament';
import { Wizard } from './pages/Wizard';
import { SessionProvider, useSession } from './session';
import './styles.css';

function Private({ children }: { children: JSX.Element }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  return me ? children : <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
}

function App() {
  const { loading } = useSession();
  if (loading) return <Loading />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/confidentialite" element={<PrivacyPage />} />
        <Route path="/new" element={<Private><Wizard /></Private>} />
        <Route path="/t/:id" element={<TournamentPage />} />
        <Route path="/print/:id" element={<Private><PrintPage /></Private>} />
        <Route path="/matches/:id" element={<MatchPage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route path="/p/:slug" element={<PublicPage />} />
        <Route path="/notifications" element={<Private><Notifications /></Private>} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<p>Page introuvable. <a href="/">Accueil</a></p>} />
      </Routes>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><SessionProvider><BrowserRouter><App /></BrowserRouter></SessionProvider></StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
