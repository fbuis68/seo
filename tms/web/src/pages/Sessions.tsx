import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { date, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';

export const SESSION_STATUS: Record<string, string> = { draft: 'Brouillon', planned: 'Planifiée', confirmed: 'Confirmée', in_progress: 'En cours', completed: 'Terminée', archived: 'Archivée', cancelled: 'Annulée' };

export default function Sessions() {
  const { org } = useApp();
  const nav = useNavigate();
  const sessions = useFetch<any[]>('/api/v1/sessions?limit=200');
  const programs = useFetch<any[]>(can(org, 'catalog.read') ? '/api/v1/programs?limit=200' : null);
  const clients = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/clients?limit=200' : null);
  const act = useAction();
  const [prog, setProg] = useState({ title: '', durationHours: '7', modality: 'onsite', priceHt: '', objectives: '' });
  const [sess, setSess] = useState({ programVersionId: '', kind: 'inter', clientId: '', startsOn: '', endsOn: '', capacity: '' });

  const createProgram = (e: React.FormEvent) => { e.preventDefault(); act.run(() => post('/api/v1/programs', {
    title: prog.title, durationMinutes: Math.round(Number(prog.durationHours.replace(',', '.')) * 60), modality: prog.modality,
    priceHt: prog.priceHt ? Number(prog.priceHt.replace(',', '.')).toFixed(2) : null, vatRate: '20', objectives: prog.objectives,
  }), (p: any) => { programs.reload(); setSess((s) => ({ ...s, programVersionId: p.versions[0].id })); setProg({ ...prog, title: '' }); }); };
  const createSession = (e: React.FormEvent) => { e.preventDefault(); act.run(() => post('/api/v1/sessions', {
    programVersionId: sess.programVersionId, kind: sess.kind, clientId: sess.kind === 'intra' ? sess.clientId : null,
    startsOn: sess.startsOn || null, endsOn: sess.endsOn || sess.startsOn || null, capacity: sess.capacity ? Number(sess.capacity) : null,
  }), (s: any) => nav(`/sessions/${s.id}`)); };

  return (
    <>
      <h1>Sessions</h1>
      {can(org, 'sessions.write') && (
        <div className="grid2">
          <form className="panel stack" onSubmit={createProgram}>
            <strong>1. Programme</strong>
            <label>Intitulé<input required value={prog.title} onChange={(e) => setProg({ ...prog, title: e.target.value })} /></label>
            <div className="toolbar">
              <label>Durée (h)<input required size={5} value={prog.durationHours} onChange={(e) => setProg({ ...prog, durationHours: e.target.value })} /></label>
              <label>Modalité<select value={prog.modality} onChange={(e) => setProg({ ...prog, modality: e.target.value })}><option value="onsite">Présentiel</option><option value="remote">À distance</option><option value="blended">Mixte</option></select></label>
              <label>Prix HT<input size={7} value={prog.priceHt} onChange={(e) => setProg({ ...prog, priceHt: e.target.value })} /></label>
            </div>
            <label>Objectifs<textarea rows={2} value={prog.objectives} onChange={(e) => setProg({ ...prog, objectives: e.target.value })} /></label>
            <button className="btn ghost" disabled={act.busy}>Créer le programme</button>
          </form>
          <form className="panel stack" onSubmit={createSession}>
            <strong>2. Session</strong>
            <label>Programme<select required value={sess.programVersionId} onChange={(e) => setSess({ ...sess, programVersionId: e.target.value })}>
              <option value="">— choisir —</option>{programs.data?.map((p) => <option key={p.id} value={p.current_version_id}>{p.title} (v{p.current_version})</option>)}</select></label>
            <div className="toolbar">
              <label>Type<select value={sess.kind} onChange={(e) => setSess({ ...sess, kind: e.target.value })}><option value="inter">Inter</option><option value="intra">Intra</option></select></label>
              {sess.kind === 'intra' && <label>Client<select required value={sess.clientId} onChange={(e) => setSess({ ...sess, clientId: e.target.value })}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
              <label>Places<input size={4} value={sess.capacity} onChange={(e) => setSess({ ...sess, capacity: e.target.value })} /></label>
            </div>
            <div className="toolbar">
              <label>Début<input type="date" value={sess.startsOn} onChange={(e) => setSess({ ...sess, startsOn: e.target.value })} /></label>
              <label>Fin<input type="date" value={sess.endsOn} onChange={(e) => setSess({ ...sess, endsOn: e.target.value })} /></label>
            </div>
            <button className="btn" disabled={act.busy}>Créer la session</button>
          </form>
        </div>
      )}
      {act.error && <p className="alert">{act.error}</p>}
      <h2>Toutes les sessions</h2>
      <div className="panel">
        {sessions.data?.length === 0 && <p className="muted">Aucune session pour l’instant.</p>}
        {!!sessions.data?.length && <table><thead><tr><th>Session</th><th>Programme</th><th>Dates</th><th>Statut</th><th className="num">Inscrits</th></tr></thead>
          <tbody>{sessions.data.map((s) => <tr key={s.id}><td><Link to={`/sessions/${s.id}`}>{s.title}</Link>{s.is_historical && <span className="pill">historique</span>}</td><td>{s.program_title} v{s.program_version}</td><td>{date(s.starts_on)} → {date(s.ends_on)}</td><td>{SESSION_STATUS[s.status]}</td><td className="num">{s.enrolled}{s.capacity ? ` / ${s.capacity}` : ''}</td></tr>)}</tbody></table>}
      </div>
    </>
  );
}
