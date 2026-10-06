import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { get, post, session } from './api';
import { AppCtx, Me, Org, can } from './context';
import Assistant from './pages/Assistant';
import Billing from './pages/Billing';
import Clients from './pages/Clients';
import Dashboard from './pages/Dashboard';
import Imports from './pages/Imports';
import Invoices from './pages/Invoices';
import Login, { VerifyEmail } from './pages/Login';
import SessionDetail from './pages/SessionDetail';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';

export default function App() {
  const loc = useLocation();
  if (loc.pathname === '/login') return <Login />;
  if (loc.pathname === '/verify-email') return <VerifyEmail />;
  if (!session.get()?.token) return <Navigate to="/login" replace />;
  return <Shell />;
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await get<Me>('/api/v1/me');
      setMe(m);
      const s = session.get()!;
      if (!s.tenantId || !m.memberships.some((x) => x.tenant_id === s.tenantId)) session.set({ ...s, tenantId: m.memberships[0]?.tenant_id });
      if (!m.emailVerified) { setErr('unverified'); return; }
      setOrg(await get<Org>('/api/v1/organization'));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err === 'unverified') return (
    <div className="center"><div className="panel" style={{ maxWidth: 420 }}>
      <h1>Confirmez votre email</h1>
      <p>Un lien vous a été envoyé à <strong>{me?.email}</strong>. Cliquez dessus pour activer votre espace.</p>
      <button className="btn ghost" onClick={() => post('/api/v1/auth/resend-verification').then(() => alert('Email renvoyé.'))}>Renvoyer l’email</button>
    </div></div>
  );
  if (err) return <div className="center"><p className="alert">{err}</p></div>;
  if (!me || !org) return <div className="center"><p className="muted">Chargement…</p></div>;

  const switchTenant = (id: string) => { session.set({ ...session.get()!, tenantId: id }); location.href = '/'; };
  const logout = () => post('/api/v1/auth/logout').finally(() => { session.set(null); location.href = '/login'; });
  const e = org.entitlements;
  const links: [string, string, boolean][] = [
    ['/', 'Accueil', true], ['/sessions', 'Sessions', can(org, 'sessions.read')], ['/clients', 'Clients & apprenants', can(org, 'crm.read')],
    ['/invoices', 'Facturation', can(org, 'finance.read')], ['/assistant', 'Assistant IA', can(org, 'ai.use')],
    ['/imports', 'Reprise de données', can(org, 'imports.manage')], ['/billing', 'Mon abonnement', can(org, 'billing.manage')], ['/settings', 'Réglages', true],
  ];
  return (
    <AppCtx.Provider value={{ me, org, reload: load, switchTenant }}>
      <div className="layout">
        <nav className="side" aria-label="Navigation principale">
          <div className="brand">{org.legal_name}<div className="small muted">Offre {e.planCode}{e.status !== 'active' && e.status !== 'free' ? ` · ${e.status}` : ''}</div></div>
          {links.filter((l) => l[2]).map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
          <div className="spacer" />
          {me.memberships.length > 1 && (
            <select aria-label="Organisme" value={org.id} onChange={(ev) => switchTenant(ev.target.value)}>
              {me.memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.legal_name}</option>)}
            </select>
          )}
          <a href="#" onClick={(ev) => { ev.preventDefault(); logout(); }}>Se déconnecter</a>
        </nav>
        <main>
          {e.readOnly && <div className="banner err">Compte en <strong>lecture seule</strong> : votre volume dépasse l’offre Free. Lecture et export restent disponibles. <NavLink to="/billing">Choisir une offre</NavLink></div>}
          {e.planCode === 'free' && !e.readOnly && me.memberships.find((m) => m.tenant_id === org.id)?.signup_intent && can(org, 'billing.manage') && (
            <div className="banner">Vous avez choisi l’offre <strong>{me.memberships.find((m) => m.tenant_id === org.id)!.signup_intent.plan}</strong> sur notre site. <NavLink to="/billing?intent=1">Finaliser l’abonnement</NavLink></div>
          )}
          {e.status === 'past_due' && <div className="banner warn">Échec de paiement : mettez à jour votre moyen de paiement pour éviter la suspension. <NavLink to="/billing">Gérer</NavLink></div>}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/imports" element={<Imports />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/bank/callback" element={<BankCallback />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </AppCtx.Provider>
  );
}

/** Retour du parcours de consentement bancaire (code + state vérifiés côté serveur). */
function BankCallback() {
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    post('/api/v1/bank/connections/callback', { code: q.get('code'), state: q.get('state') }).then(() => nav('/settings'), (e) => setErr(e.message));
  }, [nav]);
  return err ? <p className="alert">{err}</p> : <p className="muted">Connexion bancaire en cours…</p>;
}
