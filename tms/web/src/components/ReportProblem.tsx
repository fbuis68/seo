import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RecentError, date, get, post, recentErrors } from '../api';

const CAT: [string, string][] = [['bug', 'Quelque chose ne fonctionne pas'], ['question', 'Je ne comprends pas comment faire'], ['evolution', 'Je souhaite une amélioration']];
const SEV: [string, string][] = [['blocking', 'Bloquant : je ne peux pas continuer'], ['normal', 'Gênant'], ['minor', 'Mineur']];
const STATUS: Record<string, [string, string]> = { new: ['Reçu', 'warn'], in_progress: ['En cours', 'warn'], fixed: ['Corrigé', 'ok'], wont_fix: ['Non retenu', ''], duplicate: ['Doublon', ''] };

/** Fonction concernée : titre de l'écran (h1) et fenêtre ouverte s'il y en a une. */
function currentFeature() {
  const h1 = document.querySelector('main h1')?.textContent?.trim();
  const dlg = document.querySelector('[role="dialog"]:not(.report-dialog)')?.getAttribute('aria-label');
  return [h1, dlg].filter(Boolean).join(' — ').slice(0, 200) || undefined;
}

/**
 * « Signaler un problème » : bouton présent sur chaque écran, et proposé automatiquement après une erreur.
 * Le ticket emporte l'écran, la fonction, le navigateur et les dernières erreurs serveur.
 */
export function ReportProblem() {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'new' | 'mine'>('new');
  const [f, setF] = useState({ category: 'bug', severity: 'normal', message: '', expected: '', tech: true });
  const [feature, setFeature] = useState<string | undefined>();
  const [errors, setErrors] = useState<RecentError[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<RecentError | null>(null);
  const [mine, setMine] = useState<any[] | null>(null);

  const start = (preset?: Partial<typeof f>) => {
    setFeature(currentFeature()); setErrors(recentErrors()); setDone(null); setErr(null); setTab('new');
    setF({ category: 'bug', severity: 'normal', message: '', expected: '', tech: true, ...preset }); setOpen(true); setToast(null);
  };
  // Après une erreur serveur (hors validation de saisie) : petite proposition de signalement pendant 12 s.
  useEffect(() => {
    let t: any;
    const on = (e: Event) => {
      const d = (e as CustomEvent<RecentError>).detail;
      if (d.status === 0 || d.status >= 500 || d.status === 409 || d.status === 404) { setToast(d); clearTimeout(t); t = setTimeout(() => setToast(null), 12000); }
    };
    window.addEventListener('tms:api-error', on);
    const ext = (e: Event) => start((e as CustomEvent).detail ?? {});
    window.addEventListener('tms:report', ext);
    return () => { window.removeEventListener('tms:api-error', on); window.removeEventListener('tms:report', ext); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (open && tab === 'mine') get<any[]>('/api/v1/support/tickets').then(setMine, () => setMine([])); }, [open, tab]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r: any = await post('/api/v1/support/tickets', {
        screen: loc.pathname, feature, category: f.category, severity: f.severity, message: f.message, expected: f.expected || undefined,
        context: f.tech ? { url: location.pathname + location.search, userAgent: navigator.userAgent.slice(0, 400), viewport: `${innerWidth}x${innerHeight}`, errors } : {},
      });
      setDone(r.ref);
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <>
      <button className="report-fab" onClick={() => start()} aria-label="Signaler un problème" title="Signaler un problème sur cet écran">? Signaler un problème</button>
      {toast && !open && <div className="report-toast" role="status">
        <span>Une erreur est survenue{toast.message ? ` : ${toast.message}` : ''}.</span>
        <button className="btn sm" onClick={() => start({ severity: toast.status >= 500 || toast.status === 0 ? 'blocking' : 'normal' })}>Signaler ce problème</button>
        <button className="btn ghost sm" onClick={() => setToast(null)} aria-label="Fermer">×</button>
      </div>}
      {open && <div className="pl-modal report-dialog" role="dialog" aria-modal="true" aria-label="Signaler un problème" onClick={() => setOpen(false)}>
        <div className="panel stack" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Signaler un problème</h2>
            <span className="row" style={{ gap: 6 }}>
              <button className={`btn sm ${tab === 'new' ? '' : 'ghost'}`} onClick={() => setTab('new')}>Nouveau</button>
              <button className={`btn sm ${tab === 'mine' ? '' : 'ghost'}`} onClick={() => setTab('mine')}>Mes signalements</button>
            </span>
          </div>
          {tab === 'mine' && (mine === null ? <p className="muted">Chargement…</p> : mine.length === 0 ? <p className="muted">Aucun signalement.</p> :
            <table className="small"><thead><tr><th>Réf.</th><th>Date</th><th>Écran</th><th>Description</th><th>État</th></tr></thead>
              <tbody>{mine.map((t) => <tr key={t.id}><td>{t.ref}</td><td>{date(t.created_at)}</td><td>{t.feature ?? t.screen}</td><td>{t.message.slice(0, 80)}{t.resolution && <div className="muted">→ {t.resolution}</div>}</td>
                <td><span className={`pill ${STATUS[t.status]?.[1] ?? ''}`}>{STATUS[t.status]?.[0] ?? t.status}</span></td></tr>)}</tbody></table>)}
          {tab === 'new' && (done ? <>
            <p className="pill ok">Signalement {done} envoyé. Merci !</p>
            <p>Nous l’analysons et vous prévenons par email dès qu’il est traité. Vous pouvez suivre son état dans « Mes signalements ».</p>
            <div><button className="btn" onClick={() => setOpen(false)}>Fermer</button></div>
          </> : <form className="stack" onSubmit={submit}>
            <p className="small muted" style={{ margin: 0 }}>Écran : <strong>{feature ?? loc.pathname}</strong></p>
            <label>Type<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CAT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            {f.category === 'bug' && <label>Gravité<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEV.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
            <label>Que s’est-il passé ? *<textarea required minLength={5} rows={4} autoFocus value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="Ce que vous faisiez, sur quelle fiche, le message affiché…" /></label>
            <label>Qu’attendiez-vous ?<textarea rows={2} value={f.expected} onChange={(e) => setF({ ...f, expected: e.target.value })} /></label>
            <label className="row small"><input type="checkbox" checked={f.tech} onChange={(e) => setF({ ...f, tech: e.target.checked })} />Joindre les informations techniques (navigateur, {errors.length} dernière(s) erreur(s) serveur)</label>
            {f.tech && errors.length > 0 && <details className="small"><summary>Voir les informations jointes</summary><ul>{errors.map((x, i) => <li key={i}>{x.method} {x.path} → {x.status} {x.code ?? ''} {x.message ?? ''}</li>)}</ul></details>}
            <p className="small muted" style={{ margin: 0 }}>N’indiquez pas de mot de passe ni de coordonnées bancaires.</p>
            {err && <p className="alert">{err}</p>}
            <div className="toolbar" style={{ margin: 0 }}><button className="btn" disabled={busy}>Envoyer</button><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Annuler</button></div>
          </form>)}
        </div>
      </div>}
    </>
  );
}

/** Ouvre le formulaire depuis n'importe quel bouton (ex. lien « Signaler » d'une fonction précise). */
export const reportProblem = (preset?: { category?: string; severity?: string; message?: string }) => window.dispatchEvent(new CustomEvent('tms:report', { detail: preset }));
