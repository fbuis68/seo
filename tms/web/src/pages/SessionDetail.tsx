import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { date, download, fmtDayT, post } from '../api';
import { can, has, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import Planning from '../components/Planning';
import { SESSION_STATUS } from './Sessions';

const NEXT: Record<string, string[]> = { draft: ['planned'], planned: ['confirmed', 'draft'], confirmed: ['in_progress', 'planned'], in_progress: ['completed'], completed: ['archived'] };

export default function SessionDetail() {
  const { id } = useParams();
  const { org } = useApp();
  const s = useFetch(`/api/v1/sessions/${id}`);
  const docs = useFetch<any[]>(`/api/v1/documents?ownerType=session&ownerId=${id}`);
  const learners = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/persons?role=learner&limit=200' : null);
  const trainers = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/persons?role=trainer&limit=200' : null);
  const resources = useFetch<any[]>('/api/v1/resources');
  const sheet = useFetch<any[]>(`/api/v1/sessions/${id}/attendance`);
  const act = useAction();
  const [enroll, setEnroll] = useState({ personId: '', firstName: '', lastName: '', email: '' });
  const [sign, setSign] = useState<{ docId: string; name: string; email: string } | null>(null);
  if (s.error) return <p className="alert">{s.error.message}</p>;
  if (!s.data) return <p className="muted">Chargement…</p>;
  const d = s.data;
  const reload = () => { s.reload(); docs.reload(); sheet.reload(); };
  const att = (enrollmentId: string, slotId: string) => sheet.data?.find((a) => a.enrollment_id === enrollmentId && a.slot_id === slotId);

  return (
    <>
      <h1>{d.title} <span className="pill">{SESSION_STATUS[d.status]}</span></h1>
      <p className="muted">{d.program_title} v{d.program_version} · {date(d.starts_on)} → {date(d.ends_on)} · {d.kind === 'intra' ? 'Intra' : 'Inter'}{d.capacity ? ` · ${d.capacity} places` : ''}</p>
      {d.missing?.length > 0 && <div className="banner warn"><strong>À compléter :</strong> {d.missing.join(' · ')}</div>}
      {can(org, 'sessions.write') && (
        <div className="toolbar">
          {(NEXT[d.status] ?? []).map((n) => <button key={n} className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/sessions/${id}/status`, { status: n }), reload)}>→ {SESSION_STATUS[n]}</button>)}
          {!['completed', 'archived', 'cancelled'].includes(d.status) && <button className="btn danger sm" onClick={() => { const reason = prompt('Motif d’annulation ?'); if (reason) act.run(() => post(`/api/v1/sessions/${id}/status`, { status: 'cancelled', reason }), reload); }}>Annuler</button>}
          <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'convention', sessionId: id }), reload)}>Générer la convention</button>
          <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'attendance_sheet', sessionId: id }), reload)}>Feuille d’émargement</button>
        </div>
      )}
      {act.error && <p className="alert">{act.error}</p>}

      <Planning session={d} canWrite={can(org, 'sessions.write')} trainers={trainers.data ?? []} resources={resources.data ?? []} onChange={reload} onError={act.setError} />

      <div className="grid2">
        <div className="panel">
          <strong>Documents</strong>
          <table><tbody>{docs.data?.map((doc) => <tr key={doc.id}><td>{doc.filename}</td><td>{date(doc.created_at)}</td><td>
            <button className="btn ghost sm" onClick={() => download(`/api/v1/documents/${doc.id}/download`, doc.filename)}>Télécharger</button>{' '}
            {can(org, 'signatures.send') && doc.mime === 'application/pdf' && <button className="btn ghost sm" disabled={!has(org, 'signatures')} title={has(org, 'signatures') ? '' : 'Offres payantes'} onClick={() => setSign({ docId: doc.id, name: '', email: '' })}>Faire signer</button>}
          </td></tr>)}</tbody></table>
          {!has(org, 'signatures') && <p className="small muted">Offre Free : déposez la convention signée hors plateforme, ou passez à une offre payante pour la signature électronique.</p>}
          {sign && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/signatures', { documentId: sign.docId, title: d.title, signers: [{ fullName: sign.name, email: sign.email }] }), () => { setSign(null); alert('Demande de signature envoyée.'); }); }}>
              <label>Signataire<input required value={sign.name} onChange={(e) => setSign({ ...sign, name: e.target.value })} /></label>
              <label>Email<input type="email" required value={sign.email} onChange={(e) => setSign({ ...sign, email: e.target.value })} /></label>
              <button className="btn sm">Envoyer (1 crédit)</button>
            </form>
          )}
        </div>
      </div>

      <h2>Inscrits et présences</h2>
      <div className="panel">
        <table><thead><tr><th>Apprenant</th><th>Statut</th>{d.slots.map((sl: any) => <th key={sl.id}>{fmtDayT(sl.starts_at, d.timezone)}</th>)}<th /></tr></thead>
          <tbody>{d.enrollments.map((e: any) => (
            <tr key={e.id}><td>{e.last_name} {e.first_name}</td><td>{e.status}</td>
              {d.slots.map((sl: any) => { const a = att(e.id, sl.id); return (
                <td key={sl.id}>{can(org, 'attendance.write') && e.status !== 'cancelled'
                  ? <select aria-label={`Présence ${e.last_name}`} value={a?.status ?? ''} onChange={(ev) => act.run(() => post('/api/v1/attendance', { enrollmentId: e.id, slotId: sl.id, status: ev.target.value }), () => sheet.reload())}>
                      <option value="">—</option><option value="present">Présent</option><option value="absent">Absent</option></select>
                  : a?.status ?? '—'}</td>); })}
              <td>{can(org, 'documents.write') && <>
                <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'convocation', sessionId: id, enrollmentId: e.id }), reload)}>Convocation</button>{' '}
                <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'attestation', sessionId: id, enrollmentId: e.id }), reload)}>Attestation</button>
              </>}</td></tr>))}</tbody></table>
        {can(org, 'sessions.write') && (
          <form className="inline" style={{ marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); await act.run(async () => {
            let personId = enroll.personId;
            if (!personId) personId = (await post('/api/v1/persons', { firstName: enroll.firstName, lastName: enroll.lastName, email: enroll.email || null, roles: ['learner'] })).id;
            return post(`/api/v1/sessions/${id}/enrollments`, { personId, status: 'confirmed' });
          }, () => { setEnroll({ personId: '', firstName: '', lastName: '', email: '' }); reload(); learners.reload(); }); }}>
            <label>Apprenant existant<select value={enroll.personId} onChange={(e) => setEnroll({ ...enroll, personId: e.target.value })}><option value="">— nouveau —</option>{learners.data?.map((p) => <option key={p.id} value={p.id}>{p.last_name} {p.first_name}</option>)}</select></label>
            {!enroll.personId && <><label>Prénom<input required value={enroll.firstName} onChange={(e) => setEnroll({ ...enroll, firstName: e.target.value })} /></label>
              <label>Nom<input required value={enroll.lastName} onChange={(e) => setEnroll({ ...enroll, lastName: e.target.value })} /></label>
              <label>Email<input type="email" value={enroll.email} onChange={(e) => setEnroll({ ...enroll, email: e.target.value })} /></label></>}
            <button className="btn sm">Inscrire</button>
          </form>
        )}
      </div>
    </>
  );
}
