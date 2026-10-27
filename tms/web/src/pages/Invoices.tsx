import { useState } from 'react';
import { api, date, download, eur, get, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import { Help } from '../help';

export default function Invoices() {
  const { org } = useApp();
  const inv = useFetch<any[]>('/api/v1/invoices?limit=200');
  const clients = useFetch<any[]>('/api/v1/clients?limit=200');
  const act = useAction();
  const [f, setF] = useState({ clientId: '', kind: 'invoice', label: '', quantity: '1', unit: '', vat: '20', credited: '' });
  const [pay, setPay] = useState<{ inv: any; amount: string; date: string } | null>(null);
  const [draft, setDraft] = useState<any>(null); // brouillon en cours de modification
  const reload = () => inv.reload();
  const pdf = (i: any) => act.run(() => post('/api/v1/documents/generate', { template: 'invoice', invoiceId: i.id }), (d: any) => download(`/api/v1/documents/${d.id}/download`, d.filename));
  return (
    <>
      <h1>Facturation <Help k="facturation" /></h1>
      {can(org, 'finance.write') && (
        <form className="panel inline" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/invoices', {
          clientId: f.clientId, kind: f.kind, creditedInvoiceId: f.kind === 'credit_note' ? f.credited : undefined,
          lines: [{ label: f.label, quantity: f.quantity.replace(',', '.'), unitPriceHt: f.unit.replace(',', '.'), vatRate: f.vat }],
        }), () => { setF({ ...f, label: '', unit: '' }); reload(); }); }}>
          <label>Client<select required value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="invoice">Facture</option><option value="deposit">Acompte</option><option value="credit_note">Avoir</option></select></label>
          {f.kind === 'credit_note' && <label>Facture d’origine<select required value={f.credited} onChange={(e) => setF({ ...f, credited: e.target.value })}><option value="">—</option>{inv.data?.filter((i) => i.status === 'issued' && i.kind !== 'credit_note' && i.client_id === f.clientId).map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}</select></label>}
          <label>Désignation<input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label>Qté<input size={4} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></label>
          <label>PU HT<input required size={8} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label>
          <label>TVA %<select value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })}><option>20</option><option>10</option><option>5.5</option><option value="0">0 (exonéré)</option></select></label>
          <button className="btn">Créer le brouillon</button>
        </form>
      )}
      {act.error && <p className="alert">{act.error}</p>}
      <div className="panel" style={{ marginTop: 16 }}>
        <table><thead><tr><th>Numéro</th><th>Client</th><th>Date</th><th className="num">HT</th><th className="num">TTC</th><th className="num">Reste dû</th><th /></tr></thead>
          <tbody>{inv.data?.map((i) => (
            <tr key={i.id}>
              <td>{i.number ?? <span className="pill">brouillon</span>} {i.kind === 'credit_note' && <span className="pill warn">avoir</span>} {i.kind === 'deposit' && <span className="pill">acompte</span>} {i.is_historical && <span className="pill">historique</span>}</td>
              <td>{i.client_name}</td><td>{date(i.issue_date)}</td><td className="num">{eur(i.total_ht, i.currency)}</td><td className="num">{eur(i.total_ttc, i.currency)}</td>
              <td className="num">{i.balance != null ? eur(i.balance, i.currency) : '—'}</td>
              <td>
                {i.status === 'draft' && can(org, 'finance.write') && <button className="btn sm" onClick={() => confirm('Émettre la facture ? Elle ne sera plus modifiable (correction par avoir).') && act.run(() => post(`/api/v1/invoices/${i.id}/issue`), reload)}>Émettre</button>}{' '}
                {i.status === 'draft' && can(org, 'finance.write') && <>
                  <button className="btn ghost sm" onClick={() => act.run(() => get(`/api/v1/invoices/${i.id}`), (x: any) => setDraft({ id: i.id, dueDate: x.due_date?.slice(0, 10) ?? '', lines: x.lines.map((l: any) => ({ label: l.label, quantity: String(Number(l.quantity)), unitPriceHt: String(Number(l.unit_price_ht)), vatRate: String(Number(l.vat_rate)) })) }))}>Modifier</button>{' '}
                  <button className="btn ghost sm" onClick={() => confirm('Supprimer ce brouillon ?') && act.run(() => api('DELETE', `/api/v1/invoices/${i.id}`), reload)}>Supprimer</button>{' '}
                </>}
                <button className="btn ghost sm" onClick={() => pdf(i)}>PDF</button>{' '}
                {i.status === 'issued' && Number(i.balance) > 0 && can(org, 'finance.write') && <button className="btn ghost sm" onClick={() => setPay({ inv: i, amount: i.balance, date: new Date().toISOString().slice(0, 10) })}>Règlement</button>}
              </td>
            </tr>))}</tbody></table>
      </div>
      {draft && (
        <div className="pl-modal" role="dialog" aria-modal="true" aria-label="Modifier le brouillon" onClick={() => setDraft(null)}>
          <form className="panel stack" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); act.run(() => api('PATCH', `/api/v1/invoices/${draft.id}`, {
            dueDate: draft.dueDate || null, lines: draft.lines.map((l: any) => ({ label: l.label, quantity: l.quantity.replace(',', '.'), unitPriceHt: l.unitPriceHt.replace(',', '.'), vatRate: l.vatRate.replace(',', '.') })),
          }), () => { setDraft(null); reload(); }); }}>
            <h2 style={{ margin: 0 }}>Modifier le brouillon</h2>
            <table className="small"><thead><tr><th>Désignation</th><th className="num">Qté</th><th className="num">PU HT</th><th className="num">TVA %</th><th /></tr></thead>
              <tbody>{draft.lines.map((l: any, k: number) => {
                const up = (f: string, v: string) => setDraft({ ...draft, lines: draft.lines.map((x: any, j: number) => (j === k ? { ...x, [f]: v } : x)) });
                return <tr key={k}><td><input required aria-label="Désignation" value={l.label} onChange={(e) => up('label', e.target.value)} /></td>
                  <td><input required size={5} aria-label="Quantité" value={l.quantity} onChange={(e) => up('quantity', e.target.value)} /></td>
                  <td><input required size={8} aria-label="Prix unitaire HT" value={l.unitPriceHt} onChange={(e) => up('unitPriceHt', e.target.value)} /></td>
                  <td><input required size={4} aria-label="TVA" value={l.vatRate} onChange={(e) => up('vatRate', e.target.value)} /></td>
                  <td>{draft.lines.length > 1 && <button type="button" className="btn ghost sm" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_: any, j: number) => j !== k) })}>Retirer</button>}</td></tr>;
              })}</tbody></table>
            <div className="toolbar" style={{ margin: 0 }}>
              <button type="button" className="btn ghost sm" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { label: '', quantity: '1', unitPriceHt: '', vatRate: draft.lines[0]?.vatRate ?? '20' }] })}>Ajouter une ligne</button>
              <label>Échéance<input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></label>
            </div>
            {act.error && <p className="alert">{act.error}</p>}
            <div className="toolbar" style={{ margin: 0 }}><button className="btn" disabled={act.busy}>Enregistrer</button><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Fermer</button></div>
            <p className="small muted" style={{ margin: 0 }}>Une facture émise n’est plus modifiable : corrigez-la par un avoir.</p>
          </form>
        </div>
      )}
      {pay && (
        <form className="panel inline" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/payments', { clientId: pay.inv.client_id, amount: Number(pay.amount.replace(',', '.')).toFixed(2), receivedOn: pay.date, allocations: [{ invoiceId: pay.inv.id, amount: Number(pay.amount.replace(',', '.')).toFixed(2) }] }), () => { setPay(null); reload(); }); }}>
          <strong>Règlement {pay.inv.number}</strong>
          <label>Montant<input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></label>
          <label>Date<input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></label>
          <button className="btn">Enregistrer</button><button type="button" className="btn ghost" onClick={() => setPay(null)}>Annuler</button>
        </form>
      )}
    </>
  );
}
