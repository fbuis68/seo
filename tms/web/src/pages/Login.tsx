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
        {new URLSearchParams(location.search).get('reset') && <p className="pill ok">Mot de passe modifié : connectez-vous avec le nouveau.</p>}
        {err && <p className="alert" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>Se connecter</button>
        <a className="small" href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Mot de passe oublié ?</a>
        <p className="small muted">Pas encore de compte ? Créez votre espace gratuit depuis notre site.</p>
      </form>
    </div>
  );
}

/** Confirmation d'email ; si une offre payante a été choisie sur le site, propose directement le paiement. */
export function VerifyEmail() {
  const [state, setState] = useState<{ ok?: boolean; err?: string; intent?: any; trialEndsAt?: string | null }>({});
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return; // jeton à usage unique : un seul appel
    done.current = true;
    const token = new URLSearchParams(location.search).get('token') ?? '';
    post<{ tenantId: string; intent: any; trialEndsAt?: string | null }>('/api/v1/auth/verify-email', { token })
      .then((r) => { const s = session.get(); if (s) session.set({ ...s, tenantId: r.tenantId }); setState({ ok: true, intent: r.intent, trialEndsAt: r.trialEndsAt }); })
      .catch((e) => setState({ err: e.message }));
  }, []);
  return (
    <div className="center"><div className="panel" style={{ maxWidth: 440 }}>
      {state.err && <><h1>Lien invalide</h1><p className="alert">{state.err}</p></>}
      {state.ok && <>
        <h1>Email confirmé</h1>
        {state.trialEndsAt
          ? <p>Votre essai de l’offre <strong>{state.intent.plan}</strong> est actif jusqu’au {new Date(state.trialEndsAt).toLocaleDateString('fr-FR')}, sans carte bancaire. Vous choisirez votre abonnement quand vous le souhaitez depuis « Mon abonnement ».</p>
          : <p>Votre espace est actif en offre <strong>Free</strong>.</p>}
        {state.intent && !state.trialEndsAt && <p>Vous aviez choisi l’offre <strong>{state.intent.plan}</strong> : « Continuer » ouvre le paiement sécurisé pour l’activer.</p>}
        <a className="btn" href={session.get()?.token ? (state.intent && !state.trialEndsAt ? '/billing?intent=1&pay=1' : '/') : '/login'}>Continuer</a>
      </>}
      {!state.ok && !state.err && <p className="muted">Vérification…</p>}
    </div></div>
  );
}

/** Mot de passe oublié : demande du lien (réponse identique que le compte existe ou non). */
export function ForgotPassword() {
  const [email, setEmail] = useState(new URLSearchParams(location.search).get('email') ?? '');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/api/v1/auth/forgot-password', { email }); setSent(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="center">
      {sent ? <div className="panel stack" style={{ width: 380 }}>
        <h1>Vérifiez vos emails</h1>
        <p>Si un compte existe pour <strong>{email}</strong>, un lien de réinitialisation vient d’être envoyé. Il est valable <strong>1 heure</strong> et ne sert qu’une fois.</p>
        <p className="small muted">Rien reçu après quelques minutes ? Regardez dans les indésirables, vérifiez l’adresse, puis refaites une demande (3 par heure au maximum).</p>
        <a className="btn ghost" href="/login">Retour à la connexion</a>
      </div> : <form className="panel stack" onSubmit={submit} style={{ width: 380 }}>
        <h1>Mot de passe oublié</h1>
        <p className="small">Saisissez l’email de votre compte : vous recevrez un lien pour choisir un nouveau mot de passe.</p>
        <label>Email<input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {err && <p className="alert" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>Recevoir le lien</button>
        <a className="small" href="/login">Retour à la connexion</a>
      </form>}
    </div>
  );
}

/** Choix du nouveau mot de passe depuis le lien reçu par email. */
export function ResetPassword() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [check, setCheck] = useState<{ email?: string; err?: string } | null>(null);
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { post<{ email: string }>('/api/v1/auth/reset-password/check', { token }).then((r) => setCheck({ email: r.email }), (e) => setCheck({ err: e.message })); }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw.length < 10) return setErr('10 caractères minimum.');
    if (pw !== pw2) return setErr('Les deux mots de passe ne sont pas identiques.');
    setBusy(true);
    try { await post('/api/v1/auth/reset-password', { token, password: pw }); session.set(null); location.href = '/login?reset=1'; }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (!check) return <div className="center"><p className="muted">Vérification du lien…</p></div>;
  if (check.err) return <div className="center"><div className="panel stack" style={{ width: 380 }}><h1>Lien invalide</h1><p className="alert">{check.err}</p><a className="btn" href="/forgot-password">Refaire une demande</a></div></div>;
  return (
    <div className="center">
      <form className="panel stack" onSubmit={submit} style={{ width: 380 }}>
        <h1>Nouveau mot de passe</h1>
        <p className="small">Compte {check.email}</p>
        <label>Nouveau mot de passe<input type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label>Confirmer<input type={show ? 'text' : 'password'} autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />Afficher</label>
        <p className="small muted">10 caractères minimum. Toutes vos sessions ouvertes seront fermées.</p>
        {err && <p className="alert" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>Enregistrer</button>
      </form>
    </div>
  );
}
