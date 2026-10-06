import { useEffect, useRef, useState } from 'react';
import { post, session } from '../api';

export default function Login() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await post<{ token: string }>('/api/v1/auth/login', { email, password });
      session.set({ token: r.token });
      location.href = '/';
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="center">
      <form className="panel stack" onSubmit={submit} style={{ width: 360 }}>
        <h1>Connexion</h1>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Mot de passe<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p className="alert" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>Se connecter</button>
        <p className="small muted">Pas encore de compte ? Créez votre espace gratuit depuis notre site.</p>
      </form>
    </div>
  );
}

/** Confirmation d'email ; si une offre payante a été choisie sur le site, propose directement le paiement. */
export function VerifyEmail() {
  const [state, setState] = useState<{ ok?: boolean; err?: string; intent?: any }>({});
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return; // jeton à usage unique : un seul appel
    done.current = true;
    const token = new URLSearchParams(location.search).get('token') ?? '';
    post<{ tenantId: string; intent: any }>('/api/v1/auth/verify-email', { token })
      .then((r) => { const s = session.get(); if (s) session.set({ ...s, tenantId: r.tenantId }); setState({ ok: true, intent: r.intent }); })
      .catch((e) => setState({ err: e.message }));
  }, []);
  return (
    <div className="center"><div className="panel" style={{ maxWidth: 440 }}>
      {state.err && <><h1>Lien invalide</h1><p className="alert">{state.err}</p></>}
      {state.ok && <>
        <h1>Email confirmé</h1>
        <p>Votre espace est actif en offre <strong>Free</strong>.</p>
        {state.intent && <p>Vous aviez choisi l’offre <strong>{state.intent.plan}</strong> : connectez-vous pour finaliser le paiement sécurisé depuis « Mon abonnement ».</p>}
        <a className="btn" href={session.get()?.token ? (state.intent ? '/billing?intent=1' : '/') : '/login'}>Continuer</a>
      </>}
      {!state.ok && !state.err && <p className="muted">Vérification…</p>}
    </div></div>
  );
}
