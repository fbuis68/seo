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
      location.href = safeNext(new URLSearchParams(location.search).get('next'));
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

/** Retour après connexion : chemin interne uniquement (pas de redirection vers un autre site). */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

/** Confirmation d'email ; offre payante choisie sur le site : propose directement le paiement. Rejouable sans erreur. */
export function VerifyEmail() {
  const [state, setState] = useState<{ ok?: boolean; err?: string; code?: string; intent?: any; trialEndsAt?: string | null; already?: boolean }>({});
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return; // un seul appel
    done.current = true;
    const token = new URLSearchParams(location.search).get('token') ?? '';
    post<{ tenantId: string; intent: any; trialEndsAt?: string | null; already?: boolean }>('/api/v1/auth/verify-email', { token })
      .then((r) => { const s = session.get(); if (s && r.tenantId) session.set({ ...s, tenantId: r.tenantId }); setState({ ok: true, intent: r.intent, trialEndsAt: r.trialEndsAt, already: r.already }); })
      .catch((e) => setState({ err: e.message, code: e.code }));
  }, []);
  const plan = state.intent?.plan ? String(state.intent.plan).replace(/^./, (c: string) => c.toUpperCase()) : null;
  const toPay = !!state.intent && state.intent.plan !== 'free' && !state.trialEndsAt;
  const target = toPay ? '/billing?intent=1&pay=1' : '/';
  const href = session.get()?.token ? target : `/login?next=${encodeURIComponent(target)}`;
  return (
    <div className="center"><div className="panel stack" style={{ maxWidth: 460 }}>
      {state.err && <>
        <h1>{state.code === 'expired_token' ? 'Lien expiré' : 'Lien invalide'}</h1>
        <p className="alert">{state.err}</p>
        {sent ? <p>Si un compte en attente d’activation existe pour <strong>{email}</strong>, un nouveau lien vient d’être envoyé (valable 48 heures).</p>
          : <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/api/v1/auth/verify-email/resend', { email }).then(() => setSent(true), (er) => setState({ ...state, err: er.message })); }}>
            <label>Email du compte<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <button className="btn">Recevoir un nouveau lien</button>
          </form>}
        <a className="small" href="/login">Déjà activé ? Se connecter</a>
      </>}
      {state.ok && <>
        <h1>{state.already ? 'Adresse déjà confirmée' : 'Email confirmé'}</h1>
        {state.trialEndsAt
          ? <p>Votre essai de l’offre <strong>{plan}</strong> est actif jusqu’au {new Date(state.trialEndsAt).toLocaleDateString('fr-FR')}, sans carte bancaire. Vous choisirez votre abonnement quand vous le souhaitez depuis « Mon abonnement ».</p>
          : toPay
            ? <><p>Dernière étape : le <strong>paiement sécurisé</strong> de l’offre <strong>{plan}</strong>. Elle est activée dès le paiement validé.</p>
                <p className="small muted">En attendant, votre espace est utilisable avec les limites de l’offre gratuite.</p></>
            : <p>Votre espace est actif en offre <strong>Free</strong>.</p>}
        {!session.get()?.token && <p className="small muted">Connectez-vous avec l’email et le mot de passe choisis à l’inscription{toPay ? ' : le paiement s’ouvrira ensuite' : ''}.</p>}
        <a className="btn" href={href}>{toPay ? 'Payer et activer l’offre' : session.get()?.token ? 'Continuer' : 'Se connecter'}</a>
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
