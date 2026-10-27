import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, date, download, fmtDayT, post } from '../api';
import { can, has, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import Planning from '../components/Planning';
import SessionBilling, { ClosureBox } from '../components/SessionBilling';
import { SESSION_STATUS } from './Sessions';
import { Help } from '../help';
import { RecordForm } from '../components/RecordForm';

const SLOT_STATUS: Record<string, string> = { draft: 'Brouillon', pending: 'À valider', published: 'Publié', done: 'Réalisé', cancelled: 'Annulé' };
const NEXT: Record<string, string[]> = { draft: ['planned'], planned: ['confirmed', 'draft'], confirmed: ['in_progress', 'planned'], in_progress: ['completed'], completed: ['archived'] };

export default function SessionDetail() {
  const { id } = useParams();
  const { org } = useApp();
  const s = useFetch(`/api/v1/sessions/${id}`);
  const docs = useFetch<any[]>(`/api/v1/documents?ownerType=session&ownerId=${id}`);
  const learners = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/persons?role=learner&limit=200' : null);
  const trainers = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/persons?role=trainer&limit=200' : null);
  const resources = useFetch<any[]>('/api/v1/resources');
  const clients = useFetch<any[]>(can(org, 'crm.read') ? '/api/v1/clients?limit=200' : null);
  const sheet = useFetch<any[]>(`/api/v1/sessions/${id}/attendance`);
  const act = useAction();
  const [enroll, setEnroll] = useState({ personId: '', firstName: '', lastName: '', email: '', groupLabel: '' });
  const [enrollInfo, setEnrollInfo] = useState<string | null>(null);
  const [sign, setSign] = useState<{ docId: string; name: string; email: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [attInfo, setAttInfo] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const programs = useFetch<any[]>(can(org, 'catalog.read') ? '/api/v1/programs?limit=200' : null);
  if (s.error) return <p className="alert">{s.error.message}</p>;
  if (!s.data) return <p className="muted">Chargement…</p>;
  const d = s.data;
  const reload = () => { s.reload(); docs.reload(); sheet.reload(); };
  const active = d.slots.filter((sl: any) => sl.status !== 'cancelled');
  const att = (enrollmentId: string, slotId: string) => sheet.data?.find((a) => a.enrollment_id === enrollmentId && a.slot_id === slotId);

  return (
    <>
      <h1>{d.title} <span className="pill">{SESSION_STATUS[d.status]}</span> <Help k="session.fiche" /></h1>
      <p className="muted">{d.program_title} v{d.program_version} · {date(d.starts_on)} → {date(d.ends_on)} · {d.kind === 'intra' ? 'Intra' : 'Inter'}{d.capacity ? ` · ${d.capacity} places` : ''}</p>
      {d.missing?.length > 0 && <div className="banner warn"><strong>À compléter :</strong> {d.missing.join(' · ')}</div>}
      {can(org, 'sessions.write') && (
        <div className="toolbar">
          {!['archived', 'cancelled'].includes(d.status) && <button className="btn sm" onClick={() => setEditing(true)}>Modifier la session</button>}
          {(NEXT[d.status] ?? []).map((n) => <button key={n} className="btn ghost sm" onClick={() => n === 'completed' ? setClosing(true) : act.run(() => post(`/api/v1/sessions/${id}/status`, { status: n }), reload)}>→ {SESSION_STATUS[n]}</button>)}
          {!['completed', 'archived', 'cancelled'].includes(d.status) && <button className="btn danger sm" onClick={() => { const reason = prompt('Motif d’annulation ?'); if (reason) act.run(() => post(`/api/v1/sessions/${id}/status`, { status: 'cancelled', reason }), reload); }}>Annuler</button>}
          <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'convention', sessionId: id }), reload)}>Générer la convention</button>
          <button className="btn ghost sm" onClick={() => act.run(() => post('/api/v1/documents/generate', { template: 'attendance_sheet', sessionId: id }), reload)}>Feuille d’émargement</button>
        </div>
      )}
      {act.error && <p className="alert">{act.error}</p>}
      {closing && <ClosureBox sessionId={id!} onDone={() => { setClosing(false); reload(); }} onCancel={() => setClosing(false)} />}

      {can(org, 'sessions.write') && <PlanningSettings d={d} resources={resources.data ?? []} onSaved={reload} onError={act.setError} />}
      <Planning session={d} canWrite={can(org, 'sessions.write')} trainers={trainers.data ?? []} resources={resources.data ?? []} onChange={reload} onError={act.setError} />

      <div className="grid2">
        <div className="panel">
          <strong>Documents</strong> <Help k="session.documents" />
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

      <h2>Inscrits et présences <Help k="session.inscrits" /></h2>
      <div className="panel">
        <table><thead><tr><th>Apprenant</th><th>Statut</th>{can(org, 'sessions.write') && <th>Client payeur</th>}{active.map((sl: any) => <th key={sl.id}>{fmtDayT(sl.starts_at, d.timezone)}
              <div className="small" style={{ fontWeight: 400 }}><span className={`pill ${sl.status === 'done' ? 'ok' : ''}`}>{SLOT_STATUS[sl.status]}</span> {sl.attendance_count}/{sl.expected} émargé(s)</div>
              {can(org, 'attendance.write') && new Date(sl.ends_at) <= new Date() && sl.attendance_count < sl.expected && <button className="linklike small" onClick={() => act.run(async () => {
                const done = new Set((sheet.data ?? []).filter((a: any) => a.slot_id === sl.id).map((a: any) => a.enrollment_id));
                let last: any;
                for (const e of d.enrollments.filter((e: any) => e.status !== 'cancelled' && !done.has(e.id))) last = await post('/api/v1/attendance', { enrollmentId: e.id, slotId: sl.id, status: 'present' });
                return last;
              }, (r: any) => { if (r?.slotDone) setAttInfo('Émargement complet : séance marquée Réalisé.'); reload(); })}>Compléter : présents</button>}</th>)}<th /></tr></thead>
          <tbody>{d.enrollments.map((e: any) => (
            <tr key={e.id}><td>{e.last_name} {e.first_name}{e.group_label && <span className="small muted"> · groupe {e.group_label}</span>}</td><td>{e.status}</td>
              {can(org, 'sessions.write') && <td><select aria-label={`Client payeur de ${e.last_name}`} value={e.client_id ?? ''} onChange={(ev) => act.run(() => api('PATCH', `/api/v1/enrollments/${e.id}`, { clientId: ev.target.value || null }), reload)}>
                <option value="">—</option>{clients.data?.filter((c: any) => !c.archived_at).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>}
              {active.map((sl: any) => { const a = att(e.id, sl.id); return (
                <td key={sl.id}>{can(org, 'attendance.write') && e.status !== 'cancelled'
                  ? <select aria-label={`Présence ${e.last_name}`} value={a?.status ?? ''} onChange={(ev) => act.run(() => post('/api/v1/attendance', { enrollmentId: e.id, slotId: sl.id, status: ev.target.value }), (r: any) => { if (r?.slotDone) { setAttInfo(`Émargement complet : séance du ${fmtDayT(sl.starts_at, d.timezone)} marquée Réalisé.`); s.reload(); } sheet.reload(); s.reload(); })}>
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
            return post(`/api/v1/sessions/${id}/enrollments`, { personId, status: 'confirmed', groupLabel: enroll.groupLabel || null });
          }, (r: any) => { setEnrollInfo(r?.toResolve?.length ? `Inscription enregistrée ; ${r.toResolve.length} séance(s) à résoudre : ${r.toResolve.map((x: any) => x.reason).join(' ; ')}` : null);
            setEnroll({ personId: '', firstName: '', lastName: '', email: '', groupLabel: '' }); reload(); learners.reload(); }); }}>
            <label>Apprenant existant<select value={enroll.personId} onChange={(e) => setEnroll({ ...enroll, personId: e.target.value })}><option value="">— nouveau —</option>{learners.data?.map((p) => <option key={p.id} value={p.id}>{p.last_name} {p.first_name}</option>)}</select></label>
            {!enroll.personId && <><label>Prénom<input required value={enroll.firstName} onChange={(e) => setEnroll({ ...enroll, firstName: e.target.value })} /></label>
              <label>Nom<input required value={enroll.lastName} onChange={(e) => setEnroll({ ...enroll, lastName: e.target.value })} /></label>
              <label>Email<input type="email" value={enroll.email} onChange={(e) => setEnroll({ ...enroll, email: e.target.value })} /></label></>}
            <label>Groupe<input size={8} value={enroll.groupLabel} onChange={(e) => setEnroll({ ...enroll, groupLabel: e.target.value })} placeholder="A" /></label>
            <button className="btn sm">Inscrire</button>
          </form>
        )}
        {enrollInfo && <p className="banner warn small">{enrollInfo}</p>}
        {attInfo && <p className="success small" role="status">{attInfo}</p>}
      </div>
      <SessionBilling sessionId={id!} onChange={reload} />
      {editing && <RecordForm title="Modifier la session" onClose={() => setEditing(false)}
        initial={{ title: d.title, kind: d.kind, clientId: d.client_id ?? '', startsOn: d.starts_on?.slice(0, 10) ?? '', endsOn: d.ends_on?.slice(0, 10) ?? '', capacity: d.capacity ?? '', location: d.location ?? '', programVersionId: d.program_version_id, internalNotes: d.internal_notes ?? '' }}
        fields={[
          { key: 'title', label: 'Intitulé', required: true, full: true },
          { key: 'programVersionId', label: 'Formation (modifiable en brouillon)', type: 'select', required: true, full: true, options: [[d.program_version_id, `${d.program_title} v${d.program_version}`], ...(d.status === 'draft' ? (programs.data ?? []).filter((p) => p.current_version_id !== d.program_version_id).map((p) => [p.current_version_id, `${p.title} v${p.current_version}`] as [string, string]) : [])] },
          { key: 'kind', label: 'Type', type: 'select', required: true, options: [['inter', 'Inter-entreprises'], ['intra', 'Intra (un client)']] },
          { key: 'clientId', label: 'Client (intra)', type: 'select', options: (clients.data ?? []).map((c) => [c.id, c.name] as [string, string]) },
          { key: 'startsOn', label: 'Début', type: 'date' }, { key: 'endsOn', label: 'Fin', type: 'date' },
          { key: 'capacity', label: 'Places', type: 'number' }, { key: 'location', label: 'Lieu (texte libre)' },
          { key: 'internalNotes', label: 'Notes internes', type: 'textarea' },
        ]}
        onSave={(v) => api('PATCH', `/api/v1/sessions/${d.id}`, {
          version: d.version, title: v.title, kind: v.kind, clientId: v.clientId || null, startsOn: v.startsOn || null, endsOn: v.endsOn || v.startsOn || null,
          capacity: v.capacity === '' || v.capacity == null ? null : Number(v.capacity), location: v.location || null, internalNotes: v.internalNotes || null,
          ...(v.programVersionId !== d.program_version_id ? { programVersionId: v.programVersionId } : {}),
        }).then(reload)} />}
    </>
  );
}

/** Paramètres de planning de la session : référence, effectifs, site, durée cible, besoins, couleur. */
function PlanningSettings({ d, resources, onSaved, onError }: { d: any; resources: any[]; onSaved: () => void; onError: (m: string | null) => void }) {
  const init = () => ({ reference: d.reference ?? '', minParticipants: d.min_participants ?? '', capacity: d.capacity ?? '', siteId: d.site_id ?? '', responsible: d.responsible ?? '',
    targetHours: d.target_minutes ? String(d.target_minutes / 60) : '', priceHt: d.price_ht ?? '', priceBasis: d.price_basis ?? '', skills: (d.required_skills ?? []).join(', '), equipment: (d.required_equipment ?? []).join(', '), color: d.color ?? '#2457d6', useColor: !!d.color });
  const [f, setF] = useState(init);
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <details className="panel" style={{ marginBottom: 16 }}>
      <summary>Paramètres de planning{d.reference ? ` · ${d.reference}` : ''} <Help k="session.parametres" /></summary>
      <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); onError(null); api('PATCH', `/api/v1/sessions/${d.id}`, {
        version: d.version, reference: f.reference || null, minParticipants: f.minParticipants === '' ? null : Number(f.minParticipants), capacity: f.capacity === '' ? undefined : Number(f.capacity),
        siteId: f.siteId || null, responsible: f.responsible || null, targetMinutes: f.targetHours ? Math.round(Number(String(f.targetHours).replace(',', '.')) * 60) : null,
        requiredSkills: list(f.skills), requiredEquipment: list(f.equipment), color: f.useColor ? f.color : null,
        priceHt: f.priceHt === '' ? null : Number(String(f.priceHt).replace(',', '.')).toFixed(2), priceBasis: f.priceBasis || null,
      }).then(onSaved, (err) => onError(err.message)); }}>
        <label>Référence<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="CACES-2027-03" /></label>
        <label>Effectif min.<input size={4} value={f.minParticipants} onChange={(e) => setF({ ...f, minParticipants: e.target.value.replace(/\D/g, '') })} /></label>
        <label>Effectif max.<input size={4} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value.replace(/\D/g, '') })} /></label>
        <label>Site<select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}><option value="">—</option>{resources.filter((r) => r.kind === 'site').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>Responsable<input value={f.responsible} onChange={(e) => setF({ ...f, responsible: e.target.value })} /></label>
        <label>Durée cible (h)<input size={5} value={f.targetHours} placeholder={String(d.duration_minutes / 60)} onChange={(e) => setF({ ...f, targetHours: e.target.value })} /></label>
        <label>Prix HT (sinon programme)<input size={8} value={f.priceHt} placeholder={d.price_ht ?? 'programme'} onChange={(e) => setF({ ...f, priceHt: e.target.value.replace(/[^\d.,]/g, '') })} /></label>
        <label>Base de prix<select value={f.priceBasis} onChange={(e) => setF({ ...f, priceBasis: e.target.value })}><option value="">{d.kind === 'intra' ? 'forfait (intra)' : 'par apprenant (inter)'}</option><option value="per_learner">par apprenant</option><option value="per_session">forfait de session</option></select></label>
        <label>Compétences exigées<input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder="CACES R489" /></label>
        <label>Équipements requis<input value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value })} placeholder="vidéoprojecteur" /></label>
        <label className="row"><input type="checkbox" checked={f.useColor} onChange={(e) => setF({ ...f, useColor: e.target.checked })} />Couleur<input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value, useColor: true })} /></label>
        <button className="btn sm">Enregistrer</button>
      </form>
    </details>
  );
}
