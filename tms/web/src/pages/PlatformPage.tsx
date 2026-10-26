import { useState } from 'react';
import { api, eur } from '../api';
import { useFetch } from '../hooks';
import { BarChart } from '../components/Charts';
import { Help } from '../help';
import { QUOTA_LABELS, fmtQuota } from './Billing';

const STATUS: Record<string, [string, string]> = {
  free: ['Free', ''], trialing: ['Essai', 'warn'], active: ['Actif', 'ok'], past_due: ['Impayé', 'err'], read_only: ['Lecture seule', 'err'], cancelled: ['Résilié', ''],
};
const PLAN: Record<string, string> = { free: 'Free', solo: 'Solo', equipe: 'Equipe', centre: 'Centre' };
const ACTIONS: Record<string, string> = {
  'account.signup': 'Inscription', 'billing.checkout_started': 'Paiement commencé', 'billing.upgraded': 'Montée d’offre', 'billing.downgrade_scheduled': 'Baisse programmée',
  'billing.paid_ended': 'Fin d’abonnement payant', 'billing.back_to_free': 'Retour Free', 'billing.grace_expired': 'Fin du délai de grâce', 'billing.signature_pack_purchased': 'Pack signatures',
  'platform.trial': 'Essai accordé', 'platform.comp': 'Offre offerte', 'platform.free': 'Retour Free (éditeur)', 'platform.suspend': 'Suspension', 'platform.reactivate': 'Réactivation',
  'platform.comp_ended': 'Fin d’offre offerte', 'support.access_granted': 'Accès support accordé',
};
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');

/** Back-office éditeur : organismes, abonnements, indicateurs, actions commerciales tracées. */
export default function PlatformPage() {
  const [f, setF] = useState({ q: '', status: '', plan: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const ov = useFetch<any>('/api/v1/platform/overview');
  const list = useFetch<any[]>(`/api/v1/platform/tenants?${qs}`, [qs]);
  const [sel, setSel] = useState<string | null>(null);
  if (ov.error) return <p className="alert">{ov.error.status === 404 ? 'Accès réservé aux comptes éditeur.' : ov.error.message}</p>;
  const o = ov.data;
  return (
    <>
      <h1>Back-office éditeur <Help k="platform" /></h1>
      {o && <>
        <p className="small muted">Paiement : {o.stripeMode === 'live' ? 'Stripe (réel)' : o.stripeMode === 'test' ? 'Stripe (mode test)' : 'simulation (aucun paiement réel)'}</p>
        <div className="cards">
          <div className="panel card"><div className="label">Revenu mensuel récurrent HT</div><div className="value">{eur(o.mrr_cents / 100)}</div></div>
          <div className="panel card"><div className="label">Organismes</div><div className="value">{o.open}</div><div className="small muted">{o.suspended} suspendu(s)</div></div>
          <div className="panel card"><div className="label">Payants</div><div className="value">{o.paying}</div><div className="small muted">{o.comped} offert(s) · {o.trialing} en essai</div></div>
          <div className="panel card"><div className="label">À surveiller</div><div className="value" style={{ color: o.past_due + o.read_only ? 'var(--err)' : undefined }}>{o.past_due + o.read_only}</div><div className="small muted">{o.past_due} impayé(s) · {o.read_only} lecture seule</div></div>
        </div>
        <div className="grid2" style={{ marginTop: 16 }}>
          <div className="panel"><strong>Par offre</strong><BarChart title="Organismes par offre" rows={o.byPlan.map((p: any) => ({ label: PLAN[p.plan] ?? p.plan, value: p.n }))} /></div>
          <div className="panel"><strong>12 derniers mois</strong>
            <table><thead><tr><th>Mois</th><th className="num">Inscriptions</th><th className="num">Passages payants</th><th className="num">Résiliations</th></tr></thead>
              <tbody>{[...o.months].reverse().map((m: any) => <tr key={m.month}><td>{m.month.slice(5)}/{m.month.slice(0, 4)}</td><td className="num">{m.signups}</td><td className="num">{m.upgrades}</td><td className="num">{m.churn}</td></tr>)}</tbody></table></div>
        </div>
      </>}
      <h2>Organismes</h2>
      <div className="toolbar">
        <input type="search" aria-label="Rechercher" placeholder="Nom, SIRET, email d’un utilisateur…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ minWidth: 280 }} />
        <label className="row small">Statut<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Tous</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}<option value="suspended">Suspendu</option></select></label>
        <label className="row small">Offre<select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}><option value="">Toutes</option>{Object.entries(PLAN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <span className="small muted">{list.data?.length ?? 0} résultat(s)</span>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Organisme</th><th>Propriétaire</th><th>Offre</th><th>Statut</th><th className="num">MRR HT</th><th className="num">Utilisateurs</th><th>Inscrit le</th><th>Dernière connexion</th></tr></thead>
          <tbody>{(list.data ?? []).map((t) => (
            <tr key={t.id} className={sel === t.id ? 'row-sel' : ''}>
              <td><button className="linklike" onClick={() => setSel(t.id)}>{t.legal_name}</button>{t.signup_source && <div className="small muted">via {t.signup_source}</div>}</td>
              <td className="small">{t.owner_email ?? '—'}</td>
              <td>{PLAN[t.plan_code] ?? t.plan_code}{t.billing_interval && <span className="small muted"> · {t.billing_interval === 'year' ? 'annuel' : 'mensuel'}</span>}{t.provider === 'manual' && t.status === 'active' && <span className="pill" style={{ marginLeft: 4 }}>offert</span>}</td>
              <td>{t.closed_at ? <span className="pill err">Suspendu</span> : <span className={`pill ${STATUS[t.status]?.[1] ?? ''}`}>{STATUS[t.status]?.[0] ?? t.status}</span>}</td>
              <td className="num">{t.mrr_cents ? eur(t.mrr_cents / 100) : '—'}</td>
              <td className="num">{t.users}</td><td className="small">{fmtDate(t.created_at)}</td><td className="small">{fmtDate(t.last_login)}</td>
            </tr>))}
            {list.data && !list.data.length && <tr><td colSpan={8} className="muted">Aucun organisme.</td></tr>}</tbody>
        </table>
      </div>
      <UserPurge />
      {sel && <TenantPanel id={sel} onClose={() => setSel(null)} onChange={() => { list.reload(); ov.reload(); }} onDeleted={() => { setSel(null); list.reload(); ov.reload(); }} />}
    </>
  );
}

/** Suppression d'un compte utilisateur sans organisme (email de test à réutiliser). */
function UserPurge() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  return (
    <details className="panel" style={{ marginTop: 16 }}>
      <summary><strong>Supprimer un compte utilisateur</strong> <span className="small muted">(sans organisme : ex. email de test à réutiliser)</span></summary>
      <form className="toolbar" style={{ marginTop: 8 }} onSubmit={async (e) => {
        e.preventDefault(); setMsg({});
        if (!confirm(`Supprimer définitivement le compte ${email} ? Action irréversible.`)) return;
        try { const r = await api('POST', '/api/v1/platform/users/delete', { email }); setMsg({ ok: `Compte ${r.email} supprimé.` }); setEmail(''); }
        catch (err: any) { setMsg({ err: err.message }); }
      }}>
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <button className="btn sm danger">Supprimer le compte</button>
      </form>
      {msg.ok && <p className="success small">{msg.ok}</p>}
      {msg.err && <p className="alert small">{msg.err}</p>}
    </details>
  );
}

function TenantPanel({ id, onClose, onChange, onDeleted }: { id: string; onClose: () => void; onChange: () => void; onDeleted: () => void }) {
  const [confirmName, setConfirmName] = useState('');
  const [delMsg, setDelMsg] = useState<string | null>(null);
  const d = useFetch<any>(`/api/v1/platform/tenants/${id}`, [id]);
  const [a, setA] = useState({ action: 'comp', plan: 'equipe', until: '', reason: '' });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const t = d.data;
  const stripeManaged = !!(t && t.provider_subscription_id && t.provider === 'stripe');
  const action = stripeManaged && ['comp', 'trial', 'free'].includes(a.action) ? (t.closed_at ? 'reactivate' : 'suspend') : t?.closed_at && a.action === 'suspend' ? 'reactivate' : a.action;
  const run = async () => {
    setMsg({});
    try {
      const r = await api('POST', `/api/v1/platform/tenants/${id}/actions`, { action, plan: ['trial', 'comp'].includes(action) ? a.plan : undefined, until: a.until || null, reason: a.reason });
      d.setData(r); onChange(); setMsg({ ok: 'Action enregistrée et tracée.' }); setA({ ...a, reason: '' });
    } catch (e: any) { setMsg({ err: e.message }); }
  };
  return (
    <aside className="pl-panel bo-panel" aria-label="Fiche organisme" tabIndex={-1}>
      <div className="pl-panel-h"><strong>{t?.legal_name ?? 'Organisme'}</strong><button className="btn ghost sm" onClick={onClose}>Fermer</button></div>
      {d.error && <p className="alert">{d.error.message}</p>}
      {t && <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <table className="small"><tbody>
          <tr><th>Offre</th><td>{PLAN[t.plan_code]} {t.billing_interval ? `(${t.billing_interval === 'year' ? 'annuel' : 'mensuel'})` : ''} · {t.closed_at ? 'Suspendu' : STATUS[t.status]?.[0]}{t.provider === 'manual' ? ' · géré par l’éditeur' : t.provider === 'fake' ? ' · paiement simulé' : t.provider === 'stripe' ? ' · Stripe' : ''}</td></tr>
          {t.current_period_end && <tr><th>Échéance</th><td>{fmtDate(t.current_period_end)}{t.cancel_at_period_end ? ' (résiliation programmée)' : ''}</td></tr>}
          {t.trial_ends_at && <tr><th>Fin d’essai</th><td>{fmtDate(t.trial_ends_at)}</td></tr>}
          {t.grace_until && <tr><th>Délai de grâce</th><td>{fmtDate(t.grace_until)}</td></tr>}
          <tr><th>MRR HT</th><td>{eur(t.mrr_cents / 100)}</td></tr>
          <tr><th>SIRET</th><td>{t.siret ?? '—'}</td></tr>
          <tr><th>Inscrit le</th><td>{fmtDate(t.created_at)}{t.signup_source ? ` · via ${t.signup_source}` : ''}</td></tr>
          {t.stripeUrl && <tr><th>Stripe</th><td><a href={t.stripeUrl} target="_blank" rel="noreferrer">Ouvrir le client dans Stripe</a></td></tr>}
        </tbody></table>
        <div><strong className="small">Utilisation</strong>
          {Object.entries(t.quotas).filter(([, q]: any) => q.limit !== 0 || q.used > 0).map(([k, q]: any) => (
            <div key={k} className="small" style={{ display: 'flex', justifyContent: 'space-between' }}><span>{QUOTA_LABELS[k] ?? k}</span><span>{fmtQuota(k, q.used)} / {q.limit == null ? '∞' : fmtQuota(k, q.limit)}</span></div>))}
        </div>
        <div><strong className="small">Utilisateurs</strong>
          <table className="small"><tbody>{t.members.map((m: any) => <tr key={m.email}><td>{m.full_name}<div className="muted">{m.email}</div></td><td>{m.role}{m.expires_at ? ` (jusqu’au ${fmtDate(m.expires_at)})` : ''}</td><td>{fmtDate(m.last_login)}</td></tr>)}</tbody></table>
        </div>
        {t.addons.length > 0 && <div className="small"><strong>Options :</strong> {t.addons.map((x: any) => `${x.addon_code} × ${x.quantity} (${x.status})`).join(', ')}</div>}
        <div className="panel" style={{ display: 'grid', gap: 8 }}>
          <strong className="small">Action éditeur</strong>
          {stripeManaged && <p className="small banner warn" style={{ margin: 0 }}>Abonnement payé via Stripe : changement d’offre, essai et retour Free se font dans Stripe. Ici : suspension ou réactivation.</p>}
          <label>Action<select value={action} onChange={(e) => setA({ ...a, action: e.target.value })}>
            {!stripeManaged && <><option value="comp">Offrir une offre (sans paiement)</option><option value="trial">Accorder un essai</option><option value="free">Remettre en Free</option></>}
            {t.closed_at ? <option value="reactivate">Réactiver l’organisme</option> : <option value="suspend">Suspendre l’organisme (accès coupé)</option>}
          </select></label>
          {['comp', 'trial'].includes(action) && <div className="toolbar" style={{ margin: 0 }}>
            <label>Offre<select value={a.plan} onChange={(e) => setA({ ...a, plan: e.target.value })}><option value="solo">Solo</option><option value="equipe">Equipe</option><option value="centre">Centre</option></select></label>
            <label>{action === 'trial' ? 'Fin d’essai' : 'Jusqu’au (vide = sans limite)'}<input type="date" value={a.until} onChange={(e) => setA({ ...a, until: e.target.value })} required={action === 'trial'} /></label>
          </div>}
          <label>Motif (tracé)<input value={a.reason} onChange={(e) => setA({ ...a, reason: e.target.value })} placeholder="ex. partenaire pilote, geste commercial" /></label>
          <div><button className={`btn sm ${action === 'suspend' ? 'danger' : ''}`} disabled={a.reason.trim().length < 5 || (action === 'trial' && !a.until)} onClick={() => (action !== 'suspend' || confirm('Suspendre : tous les utilisateurs de cet organisme perdent l’accès. Confirmer ?')) && run()}>Appliquer</button></div>
          {msg.ok && <p className="success small" style={{ margin: 0 }}>{msg.ok}</p>}
          {msg.err && <p className="alert small" style={{ margin: 0 }}>{msg.err}</p>}
        </div>
        <div><strong className="small">Historique</strong>
          <ul className="small" style={{ paddingLeft: 18 }}>{t.events.map((e: any, i: number) => <li key={i}>{new Date(e.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {ACTIONS[e.action] ?? e.action}
            {e.data?.plan ? ` · ${PLAN[e.data.plan] ?? e.data.plan}` : ''}{e.data?.reason ? ` · « ${e.data.reason} »` : ''}{e.actor ? ` · ${e.actor}` : ''}</li>)}</ul>
        </div>
        <div className="panel" style={{ display: 'grid', gap: 8, borderColor: 'var(--danger, #b42318)' }}>
          <strong className="small">Supprimer définitivement l’organisme</strong>
          <p className="small muted" style={{ margin: 0 }}>Efface toutes ses données et ses fichiers, ainsi que les comptes utilisateurs qui n’appartiennent à aucun autre organisme. Irréversible : réservé aux comptes de test et aux demandes d’effacement. Exportez d’abord si nécessaire.</p>
          <label>Saisissez le nom exact « {t.legal_name} »<input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" /></label>
          <div><button className="btn sm danger" disabled={confirmName.trim() !== t.legal_name} onClick={async () => {
            if (!confirm(`Supprimer définitivement « ${t.legal_name} » et toutes ses données ? Action irréversible.`)) return;
            setDelMsg(null);
            try { const r = await api('POST', `/api/v1/platform/tenants/${id}/delete`, { confirmName }); alert(`« ${r.legalName} » supprimé.${r.deletedUsers.length ? ` Comptes supprimés : ${r.deletedUsers.join(', ')}.` : ''}`); onDeleted(); }
            catch (e: any) { setDelMsg(e.message); }
          }}>Supprimer définitivement</button></div>
          {delMsg && <p className="alert small" style={{ margin: 0 }}>{delMsg}</p>}
        </div>
        <p className="small muted">Les données des organismes (apprenants, factures, documents) ne sont pas visibles ici : seuls l’abonnement et des compteurs. Pour intervenir dans un compte, le client accorde un accès support temporaire depuis ses Réglages.</p>
      </div>}
    </aside>
  );
}

