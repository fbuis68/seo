import { useState } from 'react';
import { get, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';

export default function Clients() {
  const { org } = useApp();
  const [q, setQ] = useState('');
  const clients = useFetch<any[]>(`/api/v1/clients?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q]);
  const persons = useFetch<any[]>('/api/v1/persons?limit=200');
  const act = useAction();
  const [c, setC] = useState({ name: '', siret: '', status: 'prospect', billingEmail: '' });
  const [sirene, setSirene] = useState<any[]>([]);
  const [p, setP] = useState({ firstName: '', lastName: '', email: '', role: 'learner' });

  const searchSirene = () => act.run(() => get(`/api/v1/opendata/search?source=sirene&q=${encodeURIComponent(c.name)}`), (r: any) => setSirene(r.results));
  return (
    <>
      <h1>Clients & apprenants</h1>
      <div className="grid2">
        {can(org, 'crm.write') && (
          <form className="panel stack" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/clients', { kind: 'company', name: c.name, siret: c.siret || null, status: c.status, billingEmail: c.billingEmail || null }), () => { setC({ name: '', siret: '', status: 'prospect', billingEmail: '' }); setSirene([]); clients.reload(); }); }}>
            <strong>Nouveau client</strong>
            <label>Raison sociale<input required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
            <button type="button" className="btn ghost sm" disabled={c.name.length < 3} onClick={searchSirene}>Rechercher dans Sirene (OpenData)</button>
            {sirene.length > 0 && <ul className="small">{sirene.slice(0, 5).map((r) => <li key={r.siret}><a href="#" onClick={(e) => { e.preventDefault(); setC({ ...c, name: r.name, siret: r.siret ?? '' }); setSirene([]); }}>{r.name}</a> — {r.siret} — {r.city} {!r.active && <span className="pill warn">fermé</span>}</li>)}<li className="muted">Source : Recherche d’entreprises (INSEE/DINUM), Licence Ouverte</li></ul>}
            <label>SIRET<input value={c.siret} onChange={(e) => setC({ ...c, siret: e.target.value })} pattern="\d{14}" /></label>
            <label>Email de facturation<input type="email" value={c.billingEmail} onChange={(e) => setC({ ...c, billingEmail: e.target.value })} /></label>
            <label>Statut<select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value })}><option value="prospect">Prospect (hors quota)</option><option value="customer">Client facturé</option></select></label>
            <button className="btn">Créer</button>
          </form>
        )}
        {can(org, 'crm.write') && (
          <form className="panel stack" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/persons', { firstName: p.firstName, lastName: p.lastName, email: p.email || null, roles: [p.role] }), (r: any) => { if (r.possibleDuplicates?.length) alert('Attention : homonyme ou email déjà utilisé (aucune fusion automatique).'); setP({ ...p, firstName: '', lastName: '', email: '' }); persons.reload(); }); }}>
            <strong>Nouvelle personne</strong>
            <label>Prénom<input required value={p.firstName} onChange={(e) => setP({ ...p, firstName: e.target.value })} /></label>
            <label>Nom<input required value={p.lastName} onChange={(e) => setP({ ...p, lastName: e.target.value })} /></label>
            <label>Email<input type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} /></label>
            <label>Rôle<select value={p.role} onChange={(e) => setP({ ...p, role: e.target.value })}><option value="learner">Apprenant</option><option value="trainer">Formateur</option><option value="contact">Contact client</option></select></label>
            <button className="btn">Créer</button>
          </form>
        )}
      </div>
      {act.error && <p className="alert">{act.error}</p>}
      <h2>Clients</h2>
      <div className="toolbar"><input placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un client" /></div>
      <div className="panel"><table><thead><tr><th>Nom</th><th>SIRET</th><th>Statut</th><th /></tr></thead>
        <tbody>{clients.data?.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.siret ?? '—'}</td><td><span className={`pill ${x.status === 'customer' ? 'ok' : ''}`}>{x.status === 'customer' ? 'client' : 'prospect'}</span></td>
          <td>{can(org, 'crm.write') && <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/clients/${x.id}/archive`, { archived: true }), () => clients.reload())}>Archiver</button>}</td></tr>)}</tbody></table>
        <p className="small muted">L’archivage masque la fiche sans libérer de place dans le quota Free des clients facturés.</p></div>
      <h2>Personnes</h2>
      <div className="panel"><table><thead><tr><th>Nom</th><th>Email</th><th>Rôles</th></tr></thead>
        <tbody>{persons.data?.map((x) => <tr key={x.id}><td>{x.last_name} {x.first_name}</td><td>{x.email ?? '—'}</td><td>{x.roles.join(', ')}</td></tr>)}</tbody></table></div>
    </>
  );
}
