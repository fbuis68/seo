import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { ErrorBox, useAction } from '../components/ui';
import { useSession } from '../session';

/** Connexion ou création de profil simplifiée (prénom, nom, email, mot de passe), réutilisée par le parcours QR Code. */
export function AuthForm({ onDone, organizer, intro }: { onDone?: () => void; organizer?: boolean; intro?: string }) {
  const { login } = useSession();
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [f, setF] = useState({ email: '', password: '', firstName: '', lastName: '', orgName: '', isOrganizer: !!organizer, acceptTerms: false, birthYear: '', guardianConsent: false });
  const { busy, error, run } = useAction();
  const minor = f.birthYear && new Date().getFullYear() - Number(f.birthYear) < 15;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = mode === 'login'
        ? await post('/api/auth/login', { email: f.email, password: f.password })
        : await post('/api/auth/signup', {
          email: f.email, password: f.password, firstName: f.firstName, lastName: f.lastName, acceptTerms: f.acceptTerms || undefined,
          birthYear: f.birthYear ? Number(f.birthYear) : undefined, guardianConsent: f.guardianConsent || undefined,
          organization: f.isOrganizer && f.orgName ? { name: f.orgName } : undefined,
        });
      await login(r.token);
      onDone?.();
    });
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form onSubmit={submit} className="card form" aria-label={mode === 'login' ? 'Connexion' : 'Création de compte'}>
      {intro && <p>{intro}</p>}
      <div className="tabs small" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Nouveau compte</button>
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>J’ai un compte</button>
      </div>
      {mode === 'signup' && (
        <div className="grid2">
          <label>Prénom<input required autoComplete="given-name" value={f.firstName} onChange={set('firstName')} /></label>
          <label>Nom<input required autoComplete="family-name" value={f.lastName} onChange={set('lastName')} /></label>
        </div>
      )}
      <label>Email<input required type="email" autoComplete="email" value={f.email} onChange={set('email')} /></label>
      <label>Mot de passe<input required type="password" minLength={mode === 'signup' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={set('password')} />
        {mode === 'signup' && <small className="muted">10 caractères minimum</small>}</label>
      {mode === 'signup' && (
        <>
          <label>Année de naissance <small className="muted">(facultatif)</small><input inputMode="numeric" value={f.birthYear} onChange={set('birthYear')} maxLength={4} /></label>
          {minor && <label className="check"><input type="checkbox" checked={f.guardianConsent} onChange={set('guardianConsent')} /> Un parent ou tuteur autorise cette inscription</label>}
          <label className="check"><input type="checkbox" checked={f.isOrganizer} onChange={set('isOrganizer')} /> J’organise des tournois (club, association…)</label>
          {f.isOrganizer && <label>Nom du club ou de l’organisateur<input required value={f.orgName} onChange={set('orgName')} /></label>}
          <label className="check"><input type="checkbox" required checked={f.acceptTerms} onChange={set('acceptTerms')} /> J’accepte la <a href="/confidentialite" target="_blank">politique de confidentialité</a></label>
        </>
      )}
      <ErrorBox error={error} />
      <button className="primary block" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
    </form>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  return (
    <div className="narrow">
      <h1>Bienvenue</h1>
      <AuthForm organizer={q.get('organizer') === '1'} onDone={() => nav(q.get('next') ?? '/')} />
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="narrow prose">
      <h1>Politique de confidentialité</h1>
      <p>Les données collectées (identité, coordonnées facultatives, niveau de jeu, résultats) servent uniquement à l’organisation des tournois auxquels vous participez.</p>
      <ul>
        <li>Responsable de traitement : le club organisateur de chaque tournoi ; la plateforme agit en sous-traitant.</li>
        <li>Les pages publiques n’affichent que le nom (ou pseudonyme) des participants, leur club et leurs résultats : jamais d’email ni de téléphone.</li>
        <li>Conservation : durée définie par chaque club (36 mois par défaut après le tournoi), puis anonymisation.</li>
        <li>Mineurs de moins de 15 ans : inscription avec l’accord d’un parent ou tuteur.</li>
        <li>Vos droits : depuis « Compte », exportez vos données ou supprimez votre compte (les résultats sportifs sont conservés sous forme anonymisée pour l’intégrité des classements).</li>
      </ul>
    </div>
  );
}
