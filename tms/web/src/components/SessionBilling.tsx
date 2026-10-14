import { useState } from 'react';
import { Link } from 'react-router-dom';
import { eur, post } from '../api';
import { can, useApp } from '../context';
import { useFetch } from '../hooks';
import { Help } from '../help';

export const BILLING_STATE: Record<string, [string, string]> = {
  not_billed: ['Non facturée', 'warn'], partial: ['Facturation partielle', 'warn'], drafts: ['Brouillons à émettre', 'warn'],
  billed: ['Facturée', 'ok'], paid: ['Réglée', 'ok'], nothing_to_bill: ['Rien à facturer', ''], not_configured: ['Prix ou client à renseigner', 'err'],
};

/** Facturation depuis la session : aperçu par payeur, brouillons créés sur confirmation, suivi. */
export default function SessionBilling({ sessionId, onChange }: { sessionId: string; onChange: () => void }) {
  const { org } = useApp();
  const [basis, setBasis] = useState<'flat' | 'hours'>('flat');
  const [absenceToClient, setAbsence] = useState(false);
  const b = useFetch<any>(`/api/v1/sessions/${sessionId}/billing?basis=${basis}&absenceToClient=${absenceToClient}`, [basis, absenceToClient]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  if (!can(org, 'finance.read')) return null;
  const x = b.data;
  const generate = async () => {
    setBusy(true); setMsg({});
    try {
      const r = await post(`/api/v1/sessions/${sessionId}/billing`, { basis, absenceToClient });
      setMsg({ ok: `${r.created.length} brouillon(s) de facture créé(s). Vérifiez-les puis émettez-les dans Facturation.` });
      b.reload(); onChange();
    } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="toolbar" style={{ marginBottom: 6 }}>
        <strong>Facturation de la session</strong> <Help k="session.facturation" />
        {x && <span className={`pill ${BILLING_STATE[x.state]?.[1] ?? ''}`}>{BILLING_STATE[x.state]?.[0] ?? x.state}</span>}
      </div>
      {b.error && <p className="alert">{b.error.message}</p>}
      {x?.state === 'not_configured' && <p className="banner warn small">{x.message}</p>}
      {x && x.state !== 'not_configured' && <>
        <div className="toolbar">
          <label className="row small"><input type="radio" name="basis" checked={basis === 'flat'} onChange={() => setBasis('flat')} />Forfait (prix {x.priceBasis === 'per_session' ? 'de la session' : 'par apprenant'} : {eur(x.price)} HT)</label>
          <label className="row small"><input type="radio" name="basis" checked={basis === 'hours'} onChange={() => setBasis('hours')} disabled={x.priceBasis === 'per_session'} />Au prorata des heures émargées</label>
          {basis === 'hours' && <label className="row small"><input type="checkbox" checked={absenceToClient} onChange={(e) => setAbsence(e.target.checked)} />Absences non prises en charge refacturées au client</label>}
        </div>
        {x.warnings.map((w: string, i: number) => <p key={i} className="small" style={{ color: 'var(--warn)', margin: '4px 0' }}>{w}</p>)}
        {x.skipped.length > 0 && <div className="banner warn small"><strong>Non facturable en l’état :</strong><ul style={{ margin: '4px 0 0' }}>{x.skipped.map((s: any, i: number) => <li key={i}>{s.name} : {s.reason}</li>)}</ul></div>}
        {x.invoices.length > 0 ? <>
          <p className="small muted">Aperçu des brouillons à créer (une facture par client ou financeur, TVA {Number(x.vatRate)} %) :</p>
          <table><thead><tr><th>Payeur</th><th>Lignes</th><th className="num">Total HT</th></tr></thead>
            <tbody>{x.invoices.map((inv: any) => <tr key={inv.clientId}><td>{inv.clientName}{inv.role === 'funder' && <span className="pill" style={{ marginLeft: 6 }}>financeur</span>}</td>
              <td className="small">{inv.lines.map((l: any, i: number) => <div key={i}>{l.label} — {eur(l.amountHt)}</div>)}</td><td className="num">{eur(inv.totalHt)}</td></tr>)}</tbody></table>
          {can(org, 'finance.write') && <div className="toolbar" style={{ marginTop: 8 }}><button className="btn sm" disabled={busy} onClick={generate}>Créer {x.invoices.length} brouillon(s) de facture</button>
            <span className="small muted">Aucune émission automatique ; ce qui est déjà facturé n’est jamais refacturé.</span></div>}
        </> : <p className="small muted">{x.billed.length ? 'Tout est facturé.' : 'Aucun montant à facturer.'}</p>}
        {x.billed.length > 0 && <>
          <h3 style={{ fontSize: '.95rem', margin: '12px 0 4px' }}>Déjà facturé</h3>
          <table><tbody>{[...new Map(x.billed.map((i: any) => [i.invoiceId, i])).values()].map((i: any) => {
            const total = x.billed.filter((y: any) => y.invoiceId === i.invoiceId).reduce((a: number, y: any) => a + Number(y.amountHt), 0);
            return <tr key={i.invoiceId}><td>{i.payer}</td><td><Link to="/invoices">{i.invoiceNumber ?? 'Brouillon'}</Link></td><td className="num">{eur(total)} HT</td>
              <td>{i.invoiceStatus === 'draft' ? <span className="pill warn">à émettre</span> : Number(i.balance) <= 0 ? <span className="pill ok">réglée</span> : <span className="pill">reste {eur(i.balance)} TTC</span>}</td></tr>;
          })}</tbody></table>
        </>}
      </>}
      {msg.ok && <p className="success small">{msg.ok}</p>}
      {msg.err && <p className="alert small">{msg.err}</p>}
    </div>
  );
}

/** Clôture : contrôle préalable (séances réalisées, émargement), forçage motivé pour un responsable. */
export function ClosureBox({ sessionId, onDone, onCancel }: { sessionId: string; onDone: () => void; onCancel: () => void }) {
  const { org } = useApp();
  const c = useFetch<any>(`/api/v1/sessions/${sessionId}/closure`);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const close = async (force: boolean) => {
    setErr(null);
    try { await post(`/api/v1/sessions/${sessionId}/status`, { status: 'completed', ...(force ? { force: true, reason } : {}) }); onDone(); }
    catch (e: any) { setErr(e.message); }
  };
  if (!c.data) return <p className="muted small">Contrôle de clôture…</p>;
  return (
    <div className="panel" style={{ margin: '8px 0 12px', display: 'grid', gap: 8 }}>
      <div><strong>Clôturer la session</strong> <Help k="session.cloture" /></div>
      {c.data.ok ? <p className="success small" style={{ margin: 0 }}>Toutes les séances sont réalisées et l’émargement est complet.</p> : <>
        <ul className="pl-issues">{c.data.issues.map((i: any) => <li key={i.code} className="err">{i.message}
          {i.details && <div className="small">{i.details.slice(0, 8).map((d: any) => `${d.name} (${new Date(d.starts_at).toLocaleDateString('fr-FR')})`).join(', ')}{i.details.length > 8 ? '…' : ''}</div>}</li>)}</ul>
        <p className="small muted" style={{ margin: 0 }}>Saisissez les présences dans « Inscrits et présences » : une séance passe en Réalisé dès que son émargement est complet.</p>
      </>}
      <div className="toolbar">
        {c.data.ok && <button className="btn sm" onClick={() => close(false)}>Clôturer</button>}
        {!c.data.ok && can(org, 'planning.derogate') && <>
          <input aria-label="Motif du forçage" placeholder="Motif (ex. émargement papier archivé)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 280 }} />
          <button className="btn danger sm" disabled={reason.trim().length < 5} onClick={() => close(true)}>Forcer la clôture</button></>}
        <button className="btn ghost sm" onClick={onCancel}>Fermer</button>
      </div>
      {err && <p className="alert small">{err}</p>}
    </div>
  );
}
