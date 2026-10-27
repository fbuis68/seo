import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { get, post, session } from './api';
import { AppCtx, Me, Org, can } from './context';
import { Branding, applyBranding } from './branding';
import Assistant from './pages/Assistant';
import Billing from './pages/Billing';
import Onboarding from './pages/Onboarding';
import Clients from './pages/Clients';
import Persons from './pages/Persons';
import Programs from './pages/Programs';
import Dashboard from './pages/Dashboard';
import Imports from './pages/Imports';
import Invoices from './pages/Invoices';
import Resources from './pages/Resources';
import HelpPage from './pages/HelpPage';
import PlatformPage from './pages/PlatformPage';
import PlanningPage from './pages/PlanningPage';
import { MyPlanning } from './planning/tabs';
import Login, { ForgotPassword, ResetPassword, VerifyEmail } from './pages/Login';
import SessionDetail from './pages/SessionDetail';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';

export default function App() {
  const loc = useLocation();
  if (loc.pathname === '/login') return <Login />;
  if (loc.pathname === '/verify-email') return <VerifyEmail />;
  if (loc.pathname === '/forgot-password') return <ForgotPassword />;
  if (loc.pathname === '/reset-password') return <ResetPassword />;
  if (!session.get()?.token) return <Navigate to="/login" replace />;
  return <Shell />;
}

function Shell() {
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [branding, setBrandingState] = useState<Branding | null>(null);
  const setBranding = useCallback((b: Branding) => { setBrandingState(b); applyBranding(b); }, []);

  const load = useCallback(async () => {
    try {
      const m = await get<Me>('/api/v1/me');
      setMe(m);
      const s = session.get()!;
      if (!s.tenantId || !m.memberships.some((x) => x.tenant_id === s.tenantId)) session.set({ ...s, tenantId: m.memberships[0]?.tenant_id });
      if (!m.emailVerified) { setErr('unverified'); return; }
      setOrg(await get<Org>('/api/v1/organization'));
      get<Branding>('/api/v1/organization/branding').then(setBranding, () => applyBranding(null));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, [setBranding]);
  useEffect(() => { load(); }, [load]);

  const [upgrade, setUpgrade] = useState<{ message: string; details?: any } | null>(null);
  useEffect(() => {
    const on = (ev: Event) => setUpgrade((ev as CustomEvent).detail);
    window.addEventListener('tms:upgrade', on);
    return () => window.removeEventListener('tms:upgrade', on);
  }, []);
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
    ['/', 'Accueil', true], ['/onboarding', 'Mise en service', can(org, 'org.manage') || can(org, 'invoices.issue')], ['/planning', 'Planning', can(org, 'sessions.read') && org.role !== 'trainer'], ['/my-planning', 'Mon planning', ['trainer', 'learner'].includes(org.role)],
    ['/sessions', 'Sessions', can(org, 'sessions.read')], ['/formations', 'Formations', can(org, 'catalog.read')], ['/clients', 'Clients', can(org, 'crm.read')], ['/personnes', 'Apprenants & formateurs', can(org, 'crm.read')],
    ['/invoices', 'Facturation', can(org, 'finance.read')], ['/assistant', 'Assistant IA', can(org, 'ai.use')],
    ['/billing', 'Mon abonnement', can(org, 'billing.manage')], ['/settings', 'Réglages', true], ['/aide', 'Aide', true], ['/platform', 'Back-office éditeur', !!me.isPlatformAdmin],
  ];
  // Sous-menu Réglages : général, lieux & matériel, reprise de données.
  const settingsLinks: [string, string, boolean][] = [
    ['/settings', 'Général', true], ['/settings/lieux', 'Lieux & matériel', can(org, 'sessions.read') && org.role !== 'trainer'],
    ['/settings/reprise', 'Reprise de données', can(org, 'imports.manage')],
  ];
  const inSettings = loc.pathname.startsWith('/settings');
  return (
    <AppCtx.Provider value={{ me, org, reload: load, switchTenant, branding, setBranding }}>
      <div className="layout">
        <nav className="side" aria-label="Navigation principale">
          <div className="brand">{branding?.logoUrl && <img className="brand-logo" src={branding.logoUrl} alt={`Logo ${org.legal_name}`} />}{org.legal_name}<div className="small muted">Offre {e.planCode}{e.status !== 'active' && e.status !== 'free' ? ` · ${e.status}` : ''}</div></div>
          {links.filter((l) => l[2]).map(([to, label]) => to === '/settings' ? (
            <div key={to} className="nav-group">
              <NavLink to={to} aria-expanded={inSettings} className={({ isActive }) => (isActive || inSettings ? 'active' : '')}>{label} <span aria-hidden className="nav-caret">{inSettings ? '▾' : '▸'}</span></NavLink>
              {inSettings && <div className="nav-sub">{settingsLinks.filter((l) => l[2]).map(([sto, slabel]) => <NavLink key={sto} to={sto} end>{slabel}</NavLink>)}</div>}
            </div>
          ) : <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
          <div className="spacer" />
          {me.memberships.length > 1 && (
            <select aria-label="Organisme" value={org.id} onChange={(ev) => switchTenant(ev.target.value)}>
              {me.memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.legal_name}</option>)}
            </select>
          )}
          <a href="#" onClick={(ev) => { ev.preventDefault(); logout(); }}>Se déconnecter</a>
        </nav>
        <main>
          {upgrade && (
            <div className="pl-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title" onClick={() => setUpgrade(null)}>
              <div className="panel stack" onClick={(ev) => ev.stopPropagation()}>
                <strong id="upgrade-title">Limite de votre offre atteinte</strong>
                <p>{upgrade.message}</p>
                <div className="toolbar">
                  {can(org, 'billing.manage')
                    ? <NavLink className="btn" to={`/billing${upgrade.details?.upgradeTo ? `?plan=${upgrade.details.upgradeTo}` : ''}`} onClick={() => setUpgrade(null)}>Changer d’offre</NavLink>
                    : <span className="small muted">Demandez au responsable du compte de changer d’offre.</span>}
                  <button className="btn ghost" onClick={() => setUpgrade(null)}>Fermer</button>
                </div>
              </div>
            </div>
          )}
          {e.readOnly && <div className="banner err">Compte en <strong>lecture seule</strong> : votre volume dépasse l’offre Free. Lecture et export restent disponibles. <NavLink to="/billing">Choisir une offre</NavLink></div>}
          {e.planCode === 'free' && !e.readOnly && me.memberships.find((m) => m.tenant_id === org.id)?.signup_intent && can(org, 'billing.manage') && (
            <div className="banner">Vous avez choisi l’offre <strong>{me.memberships.find((m) => m.tenant_id === org.id)!.signup_intent.plan}</strong> sur notre site. <NavLink to="/billing?intent=1">Finaliser l’abonnement</NavLink></div>
          )}
          {e.status === 'past_due' && <div className="banner warn">Échec de paiement : mettez à jour votre moyen de paiement pour éviter la suspension. <NavLink to="/billing">Gérer</NavLink></div>}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/settings/lieux" element={<Resources />} />
            <Route path="/resources" element={<Navigate to="/settings/lieux" replace />} />
            <Route path="/planning" element={<PlanningPage />} />
            <Route path="/my-planning" element={<MyPlanning tz={(org as any).timezone ?? 'Europe/Paris'} />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/personnes" element={<Persons />} />
            <Route path="/formations" element={<Programs />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/settings/reprise" element={<Imports />} />
            <Route path="/imports" element={<Navigate to="/settings/reprise" replace />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/aide" element={<HelpPage />} />
            <Route path="/platform" element={<PlatformPage />} />
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
