import { useState } from 'react';
import { download, patch, post } from '../api';
import { can, has, useApp } from '../context';
import { useAction, useFetch } from '../hooks';

export default function Settings() {
  const { org, reload } = useApp();
  const t = useFetch('/api/v1/organization');
  const members = useFetch<any[]>(can(org, 'users.manage') ? '/api/v1/members' : null);
  const ai = useFetch<any[]>(can(org, 'ai.use') ? '/api/v1/ai/connections' : null);
  const providers = useFetch<any[]>(can(org, 'ai.use') ? '/api/v1/ai/providers' : null);
  const smtp = useFetch<any[]>(can(org, 'mail.configure') ? '/api/v1/mail/connections' : null);
  const bank = useFetch<any[]>(can(org, 'bank.read') ? '/api/v1/bank/connections' : null);
  const exportsList = useFetch(can(org, 'exports.full') ? '/api/v1/exports' : null);
  const act = useAction();
  const [inv, setInv] = useState({ email: '', role: 'manager' });
  const [aiForm, setAiForm] = useState({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', scope: 'user', budget: '' });
  const [mail, setMail] = useState({ host: '', port: '587', username: '', secret: '', fromEmail: '', fromName: '' });
  const [orgForm, setOrgForm] = useState<any>(null);
  const o = orgForm ?? t.data;

  return (
    <>
      <h1>Réglages</h1>
      {act.error && <p className="alert">{act.error}</p>}
      {o && can(org, 'org.manage') && (
        <form className="panel inline" onSubmit={(e) => { e.preventDefault(); act.run(() => patch('/api/v1/organization', { legal_name: o.legal_name, siret: o.siret || null, nda: o.nda || null, vat_regime: o.vat_regime }), () => { reload(); alert('Enregistré'); }); }}>
          <strong style={{ width: '100%' }}>Organisme</strong>
          <label>Raison sociale<input value={o.legal_name} onChange={(e) => setOrgForm({ ...o, legal_name: e.target.value })} /></label>
          <label>SIRET<input value={o.siret ?? ''} onChange={(e) => setOrgForm({ ...o, siret: e.target.value })} /></label>
          <label>N° déclaration d’activité<input value={o.nda ?? ''} onChange={(e) => setOrgForm({ ...o, nda: e.target.value })} /></label>
          <label>Régime TVA<select value={o.vat_regime} onChange={(e) => setOrgForm({ ...o, vat_regime: e.target.value })}><option value="to_confirm">À confirmer</option><option value="subject">Assujetti</option><option value="exempt_261_4_4">Exonéré (art. 261-4-4° CGI)</option></select></label>
          <button className="btn">Enregistrer</button>
        </form>
      )}

      {members.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Équipe</strong>
          <table><tbody>{members.data.map((m) => <tr key={m.id}><td>{m.full_name}</td><td>{m.email}</td><td>{m.role}</td></tr>)}</tbody></table>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/invitations', inv), () => { setInv({ ...inv, email: '' }); alert('Invitation envoyée'); }); }}>
            <label>Email<input type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></label>
            <label>Rôle<select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}><option value="manager">Gestionnaire</option><option value="trainer">Formateur</option><option value="learner">Apprenant</option></select></label>
            <button className="btn sm">Inviter</button>
          </form>
        </div>
      )}

      {ai.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Assistant IA — fournisseurs</strong>
          <ul className="small">{providers.data?.map((p) => <li key={p.id}>{p.name} — <span className={`pill ${p.status === 'available' ? 'ok' : 'warn'}`}>{p.status === 'available' ? 'disponible' : p.status === 'unavailable' ? 'indisponible' : 'bientôt'}</span> {p.note}</li>)}</ul>
          <table><tbody>{ai.data.map((c) => <tr key={c.id}><td>{c.provider} / {c.model}</td><td>clé {c.key_hint}</td><td>{c.scope === 'tenant' ? 'organisme' : 'personnelle'}</td><td><span className={`pill ${c.status === 'active' ? 'ok' : 'err'}`}>{c.status}</span></td>
            <td><button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/ai/connections/${c.id}/revoke`), () => ai.reload())}>Déconnecter</button></td></tr>)}</tbody></table>
          <form className="inline" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/ai/connections', { ...aiForm, monthlyBudgetCents: aiForm.budget ? Math.round(Number(aiForm.budget) * 100) : undefined, test: true }), () => { setAiForm({ ...aiForm, apiKey: '' }); ai.reload(); }); }}>
            <label>Fournisseur<select value={aiForm.provider} onChange={(e) => setAiForm({ ...aiForm, provider: e.target.value, model: e.target.value === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini' })}><option value="openai">OpenAI (clé API)</option><option value="gemini">Google Gemini (clé API)</option></select></label>
            <label>Modèle<input value={aiForm.model} onChange={(e) => setAiForm({ ...aiForm, model: e.target.value })} /></label>
            <label>Clé API<input type="password" autoComplete="off" required value={aiForm.apiKey} onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })} /></label>
            {can(org, 'ai.configure') && <label>Portée<select value={aiForm.scope} onChange={(e) => setAiForm({ ...aiForm, scope: e.target.value })}><option value="user">Personnelle</option><option value="tenant">Organisme</option></select></label>}
            <label>Budget mensuel (€)<input size={6} value={aiForm.budget} onChange={(e) => setAiForm({ ...aiForm, budget: e.target.value })} /></label>
            <button className="btn sm">Tester et connecter</button>
          </form>
          <p className="small muted">Le test effectue un appel minimal, éventuellement facturé par le fournisseur. La clé est chiffrée, masquée et jamais transmise au modèle.</p>
        </div>
      )}

      {smtp.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Envoi depuis votre messagerie (SMTP)</strong> {!has(org, 'smtp.custom') && <span className="pill warn">offres payantes</span>}
          <table><tbody>{smtp.data.map((c) => <tr key={c.id}><td>{c.from_email}</td><td>{c.host}:{c.port}</td><td><span className={`pill ${c.status === 'ok' ? 'ok' : c.status === 'error' ? 'err' : ''}`}>{c.status}</span> {c.last_error}</td>
            <td><button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/mail/connections/${c.id}/test`), () => smtp.reload())}>Tester</button></td></tr>)}</tbody></table>
          {has(org, 'smtp.custom') && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/mail/connections', { host: mail.host, port: Number(mail.port), security: mail.port === '465' ? 'tls' : 'starttls', authMode: 'password', username: mail.username, secret: mail.secret, fromEmail: mail.fromEmail, fromName: mail.fromName || undefined }), () => smtp.reload()); }}>
              <label>Serveur<input required value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} placeholder="smtp.exemple.fr" /></label>
              <label>Port<select value={mail.port} onChange={(e) => setMail({ ...mail, port: e.target.value })}><option value="587">587 (STARTTLS)</option><option value="465">465 (TLS)</option></select></label>
              <label>Identifiant<input required value={mail.username} onChange={(e) => setMail({ ...mail, username: e.target.value })} /></label>
              <label>Mot de passe d’application<input type="password" required value={mail.secret} onChange={(e) => setMail({ ...mail, secret: e.target.value })} /></label>
              <label>Expéditeur<input type="email" required value={mail.fromEmail} onChange={(e) => setMail({ ...mail, fromEmail: e.target.value })} /></label>
              <button className="btn sm">Ajouter</button>
            </form>
          )}
        </div>
      )}

      {bank.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Banque connectée (lecture seule)</strong> {!has(org, 'bank') && <span className="pill warn">option payante</span>}
          <table><tbody>{bank.data.map((c) => <tr key={c.id}><td>{c.institution}</td><td>{c.status}</td><td>dernière synchro {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString('fr-FR') : '—'}</td>
            <td>{(c.accounts ?? []).map((a: any) => `${a.name} ${a.iban_masked ?? ''} : ${a.balance ?? '—'} ${a.currency}`).join(' · ')}</td></tr>)}</tbody></table>
          {has(org, 'bank') && can(org, 'bank.connect') && <button className="btn sm" onClick={() => act.run(() => post('/api/v1/bank/connections'), (r: any) => { location.href = r.url; })}>Connecter une banque</button>}
        </div>
      )}

      {exportsList.data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <strong>Réversibilité — export complet</strong>
          <p className="small muted">Données, documents, preuves de signature et manifeste (empreintes SHA-256). Inclus dans toutes les offres.</p>
          <button className="btn sm" onClick={() => act.run(() => post('/api/v1/exports'), () => setTimeout(exportsList.reload, 2500))}>Lancer un export</button>
          <ul className="small">{exportsList.data.exports.map((x: any) => <li key={x.id}><a href="#" onClick={(e) => { e.preventDefault(); download(`/api/v1/documents/${x.id}/download`, x.filename); }}>{x.filename}</a> — {(x.size_bytes / 1024).toFixed(0)} Ko</li>)}
            {exportsList.data.pending.map((p: any) => <li key={p.id} className="muted">Export {p.status}…</li>)}</ul>
        </div>
      )}
    </>
  );
}
