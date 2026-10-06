import { useEffect, useState } from 'react';
import { eur, date, get, post } from '../api';
import { useApp } from '../context';
import { useAction, useFetch } from '../hooks';

const QUOTA_LABELS: Record<string, string> = {
  billedClients: 'Clients facturés', crmProspects: 'Prospects', learnersPerYear: 'Apprenants (année civile)', activeSessions: 'Sessions actives',
  draftSessions: 'Sessions brouillon', managers: 'Gestionnaires', storageBytes: 'Stockage', emailsPerMonth: 'Emails (mois)', aiRequestsPerMonth: 'Requêtes IA (mois)',
  opendataSearchesPerDay: 'Recherches OpenData (jour)', smtpMailboxes: 'Boîtes SMTP', bankAccounts: 'Comptes bancaires', bankInstitutions: 'Établissements bancaires',
};
const STATUS: Record<string, string> = { free: 'Free', trialing: 'Essai', active: 'Actif', past_due: 'Paiement en échec', read_only: 'Lecture seule', cancelled: 'Résilié' };

function fmtQuota(k: string, v: number) { return k === 'storageBytes' ? `${(v / 1024 ** 3).toFixed(2)} Go` : v.toLocaleString('fr-FR'); }

export default function Billing() {
  const { me, reload } = useApp();
  const st = useFetch('/api/v1/billing');
  const cat = useFetch('/api/v1/public/catalog');
  const act = useAction();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [plan, setPlan] = useState<string | null>(null);
  const [addons, setAddons] = useState<Record<string, number>>({});
  const [trial, setTrial] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const params = new URLSearchParams(location.search);

  // Offre choisie sur le site au moment de l'inscription → présélection.
  useEffect(() => {
    const intent = me.memberships.find((m) => m.signup_intent)?.signup_intent;
    if (intent && params.get('intent') && st.data?.status === 'free') {
      setPlan(intent.plan); setInterval(intent.interval); setTrial(!!intent.trial);
      setAddons(Object.fromEntries((intent.addons ?? []).map((a: any) => [a.code, a.quantity])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.data?.status]);

  if (st.error) return <p className="alert">{st.error.message}</p>;
  if (!st.data || !cat.data) return <p className="muted">Chargement…</p>;
  const s = st.data; const c = cat.data;
  const hasSub = s.hasPaymentMethod && ['active', 'trialing', 'past_due'].includes(s.status);
  const choice = plan ? { plan, interval, addons: Object.entries(addons).map(([code, quantity]) => ({ code, quantity })) } : null;

  const go = () => choice && act.run(async () => {
    if (!hasSub) { const r = await post('/api/v1/billing/checkout', { ...choice, trial }); location.href = r.url; return; }
    setPreview(await post('/api/v1/billing/preview-change', choice));
  });
  const confirmChange = () => choice && act.run(() => post('/api/v1/billing/change', { ...choice, confirm: { direction: preview.direction, newAmountCents: preview.newAmountCents } }), () => { setPreview(null); setPlan(null); st.reload(); reload(); });

  return (
    <>
      <h1>Mon abonnement</h1>
      {params.get('checkout') === 'success' && <div className="banner">Paiement transmis. L’offre s’active dès la confirmation par notre prestataire (quelques secondes).</div>}
      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Offre {c.plans.find((p: any) => p.code === s.plan)?.name ?? s.plan} <span className="pill">{STATUS[s.status] ?? s.status}</span></h2>
          {s.interval && <p>Facturation {s.interval === 'year' ? 'annuelle' : 'mensuelle'} · prochaine échéance {date(s.currentPeriodEnd)}</p>}
          {s.trialEndsAt && s.status === 'trialing' && <p>Essai jusqu’au {date(s.trialEndsAt)}</p>}
          {s.graceUntil && <p className="alert">Délai de grâce jusqu’au {date(s.graceUntil)}</p>}
          {s.cancelAtPeriodEnd && <p className="muted">Résiliation programmée à l’échéance ; retour automatique en Free (ou lecture seule si le volume dépasse Free).</p>}
          {s.pendingChange && <p className="muted">Changement programmé à l’échéance : {s.pendingChange.plan}</p>}
          {s.addons.length > 0 && <p>Options : {s.addons.map((a: any) => `${a.addon_code} × ${a.quantity}`).join(', ')}</p>}
          <p className="small">Signatures ({s.signatureCredits.period}) : {s.signatureCredits.available} disponibles / {s.signatureCredits.included} incluses{s.signatureCredits.purchased ? ` + ${s.signatureCredits.purchased} achetées` : ''}</p>
          <div className="toolbar">
            {hasSub && !s.cancelAtPeriodEnd && <button className="btn ghost" disabled={act.busy} onClick={() => confirm('Résilier à l’échéance ? Vos données restent accessibles.') && act.run(() => post('/api/v1/billing/cancel'), () => st.reload())}>Résilier à l’échéance</button>}
            {hasSub && s.cancelAtPeriodEnd && <button className="btn ghost" onClick={() => act.run(() => post('/api/v1/billing/resume'), () => st.reload())}>Annuler la résiliation</button>}
            {hasSub && s.entitlements.features.includes('signatures') && <button className="btn ghost" onClick={() => act.run(() => post('/api/v1/billing/signature-pack'), (r: any) => { location.href = r.url; })}>Acheter 20 signatures (29 € HT)</button>}
            {s.providerStatus && <button className="btn ghost" onClick={() => act.run(() => post('/api/v1/billing/portal'), (r: any) => { location.href = r.url; })}>Factures et moyen de paiement</button>}
            {s.status === 'read_only' && <button className="btn" onClick={() => act.run(() => post('/api/v1/billing/reevaluate'), () => { st.reload(); reload(); })}>J’ai réduit mon volume : revenir en Free</button>}
          </div>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Utilisation</h2>
          {Object.entries(s.quotas).filter(([, q]: any) => q.limit !== 0 || q.used > 0).map(([k, q]: any) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <div className="small" style={{ display: 'flex', justifyContent: 'space-between' }}><span>{QUOTA_LABELS[k] ?? k}</span><span>{fmtQuota(k, q.used)} / {q.limit == null ? 'sans quota' : fmtQuota(k, q.limit)}</span></div>
              {q.limit != null && q.limit > 0 && <div className={`meter ${q.used >= q.limit ? 'full' : ''}`}><span style={{ width: `${Math.min(100, (q.used / q.limit) * 100)}%` }} /></div>}
            </div>
          ))}
        </div>
      </div>

      <h2>Changer d’offre</h2>
      <div className="toolbar">
        <button className={`btn ${interval === 'month' ? '' : 'ghost'} sm`} onClick={() => setInterval('month')}>Mensuel</button>
        <button className={`btn ${interval === 'year' ? '' : 'ghost'} sm`} onClick={() => setInterval('year')}>Annuel (10 mensualités)</button>
      </div>
      <div className="cards">
        {c.plans.filter((p: any) => p.code !== 'free').map((p: any) => (
          <div key={p.code} className="panel card" style={{ outline: plan === p.code ? '2px solid var(--accent)' : undefined }}>
            <div className="label">{p.name}</div>
            <div className="value">{eur((interval === 'year' ? p.yearlyPriceCents : p.monthlyPriceCents) / 100)}<span className="small muted"> HT/{interval === 'year' ? 'an' : 'mois'}</span></div>
            <p className="small muted">{p.limits.managers} gestionnaire(s) · {p.limits.learnersPerYear.toLocaleString('fr-FR')} apprenants/an · {p.limits.signatureEnvelopesPerMonth} signatures/mois</p>
            <button className={`btn ${plan === p.code ? '' : 'ghost'}`} disabled={s.plan === p.code && s.interval === interval && hasSub} onClick={() => { setPlan(p.code); setPreview(null); }}>{s.plan === p.code && hasSub ? 'Offre actuelle' : 'Choisir'}</button>
          </div>
        ))}
      </div>
      {plan && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>Options</h2>
          {c.addons.filter((a: any) => a.recurring).map((a: any) => (
            <label key={a.code} className="row">
              <input type="checkbox" disabled={a.availability === 'coming_soon'} checked={!!addons[a.code]} onChange={(e) => setAddons((x) => { const y = { ...x }; if (e.target.checked) y[a.code] = 1; else delete y[a.code]; return y; })} />
              {a.name} — {eur(a.priceCents / 100)} HT/mois {a.availability !== 'available' && <span className="pill warn">{a.availability === 'beta' ? 'bêta' : 'bientôt'}</span>}
            </label>
          ))}
          {!hasSub && !s.trialUsed && <label className="row"><input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} />Essai de {c.trialDays} jours (sans signature électronique pendant l’essai)</label>}
          {preview && (
            <div className="banner">
              {preview.direction === 'upgrade'
                ? <>Passage immédiat. Nouveau montant : <strong>{eur(preview.newAmountCents / 100)} HT</strong>. Prorata estimé : <strong>{eur(preview.estimatedProrataCents / 100)} HT</strong>.</>
                : <>Réduction appliquée le <strong>{date(preview.effectiveDate)}</strong>. Nouveau montant : <strong>{eur(preview.newAmountCents / 100)} HT</strong>.</>}
              <p className="small muted">{preview.note}</p>
              <button className="btn" disabled={act.busy} onClick={confirmChange}>Confirmer</button>
            </div>
          )}
          {!preview && <button className="btn" disabled={act.busy} onClick={go}>{hasSub ? 'Voir le changement' : 'Payer en ligne (paiement sécurisé)'}</button>}
          {act.error && <p className="alert">{act.error}</p>}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 16 }}>Prix HT. Aucune donnée de carte n’est stockée par l’application. En cas de résiliation : retour en Free si votre volume le permet, sinon lecture seule avec export pendant au moins 30 jours.</p>
    </>
  );
}
