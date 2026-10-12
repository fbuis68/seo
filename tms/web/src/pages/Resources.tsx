import { useState } from 'react';
import { api, date, post } from '../api';
import { can, useApp } from '../context';
import { useAction, useFetch } from '../hooks';
import { WeeklyEditor } from '../planning/tabs';

const KINDS: [string, string, string][] = [
  ['site', 'Lieux de formation', 'Site, centre, adresse d’intervention (partageable entre sessions simultanées).'],
  ['room', 'Salles', 'Salle de cours : une seule session à la fois.'],
  ['equipment', 'Matériel', 'Engins et équipements (CACES…) : une seule session à la fois, suivi de la vérification périodique.'],
];

export default function Resources() {
  const { org } = useApp();
  const list = useFetch<any[]>('/api/v1/resources');
  const act = useAction();
  const empty = { kind: 'room', name: '', category: '', location: '', address: '', capacity: '', serialNumber: '', inspectionDueOn: '', notes: '', siteId: '', equipment: '', accessible: '', setup: '0', teardown: '0', hours: null as any };
  const [edit, setEdit] = useState<any>(null);
  const [f, setF] = useState(empty);
  const write = can(org, 'sessions.write');
  const nul = (v: string) => (v.trim() ? v.trim() : null);

  const submit = (e: React.FormEvent) => { e.preventDefault(); act.run(() => post('/api/v1/resources', {
    kind: f.kind, name: f.name, category: nul(f.category), location: nul(f.location), address: nul(f.address),
    capacity: f.capacity ? Number(f.capacity) : null,
    ...(f.kind === 'equipment' ? { serialNumber: nul(f.serialNumber), inspectionDueOn: f.inspectionDueOn || null } : {}), notes: nul(f.notes),
    ...(f.kind !== 'site' ? { siteId: f.siteId || null } : {}), equipment: f.equipment.split(',').map((x) => x.trim()).filter(Boolean),
    accessible: f.accessible === '' ? null : f.accessible === 'yes', setupMinutes: Number(f.setup) || 0, teardownMinutes: Number(f.teardown) || 0, openingHours: f.hours,
  }), () => { setF({ ...empty, kind: f.kind }); list.reload(); }); };
  const sites = list.data?.filter((r) => r.kind === 'site') ?? [];

  return (
    <>
      <h1>Lieux & matériel</h1>
      {write && (
        <form className="panel" onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
          <strong>Ajouter</strong>
          <div className="toolbar">
            <label>Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="site">Lieu de formation</option><option value="room">Salle</option><option value="equipment">Matériel / engin</option></select></label>
            <label>Nom<input required value={f.name} placeholder={f.kind === 'equipment' ? 'Chariot n°3' : f.kind === 'room' ? 'Salle A' : 'Centre de Lyon'} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label>Catégorie<input value={f.category} placeholder={f.kind === 'equipment' ? 'Chariot élévateur R489 cat. 3' : ''} onChange={(e) => setF({ ...f, category: e.target.value })} /></label>
            {f.kind !== 'site' && <label>Lieu de rattachement<input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>}
            {f.kind === 'site' && <label>Adresse<input size={34} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>}
            {f.kind !== 'equipment' && <label>Capacité<input size={4} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value.replace(/\D/g, '') })} /></label>}
            {f.kind === 'equipment' && <>
              <label>N° de série / immat.<input value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} /></label>
              <label>Prochaine vérification (VGP)<input type="date" value={f.inspectionDueOn} onChange={(e) => setF({ ...f, inspectionDueOn: e.target.value })} /></label>
            </>}
          </div>
          <div className="toolbar">
            {f.kind !== 'site' && sites.length > 0 && <label>Site<select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}><option value="">—</option>{sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
            {f.kind === 'room' && <label>Équipements (virgules)<input value={f.equipment} placeholder="vidéoprojecteur, paperboard" onChange={(e) => setF({ ...f, equipment: e.target.value })} /></label>}
            <label>Accessibilité PMR<select value={f.accessible} onChange={(e) => setF({ ...f, accessible: e.target.value })}><option value="">non renseignée</option><option value="yes">oui</option><option value="no">non</option></select></label>
            {f.kind !== 'site' && <><label>Préparation (min)<input size={4} value={f.setup} onChange={(e) => setF({ ...f, setup: e.target.value.replace(/\D/g, '') })} /></label>
              <label>Remise en état (min)<input size={4} value={f.teardown} onChange={(e) => setF({ ...f, teardown: e.target.value.replace(/\D/g, '') })} /></label></>}
          </div>
          <details><summary>Horaires d’ouverture (sinon sans contrainte)</summary><WeeklyEditor value={f.hours} onChange={(v) => setF({ ...f, hours: v })} /></details>
          <label>Notes<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <div><button className="btn">Ajouter</button></div>
        </form>
      )}
      {act.error && <p className="alert">{act.error}</p>}
      {KINDS.map(([kind, title, help]) => {
        const rows = list.data?.filter((r) => r.kind === kind) ?? [];
        return (
          <div key={kind}>
            <h2>{title}</h2>
            <p className="small muted" style={{ marginTop: -6 }}>{help}</p>
            <div className="panel">
              {!rows.length && <p className="muted small">Aucun.</p>}
              {!!rows.length && <table>
                <thead><tr><th>Nom</th><th>Catégorie</th>{kind === 'equipment' ? <><th>N° série</th><th>Vérification (VGP)</th></> : <th>{kind === 'site' ? 'Adresse' : 'Lieu'}</th>}{kind !== 'equipment' && <th className="num">Capacité</th>}<th /></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}{r.notes && <div className="small muted">{r.notes}</div>}
                      <div className="small muted">{[r.site_id && `site : ${sites.find((x) => x.id === r.site_id)?.name ?? '—'}`, r.equipment?.length && r.equipment.join(', '),
                        r.accessible != null && (r.accessible ? 'accessible PMR' : 'non accessible PMR'), (r.setup_minutes || r.teardown_minutes) && `tampons ${r.setup_minutes}+${r.teardown_minutes} min`, r.opening_hours && 'horaires d’ouverture'].filter(Boolean).join(' · ')}</div>
                      {edit?.id === r.id && <div className="panel" style={{ marginTop: 6 }}>
                        <div className="toolbar">
                          {kind !== 'site' && <label>Préparation (min)<input size={4} value={edit.setup} onChange={(e) => setEdit({ ...edit, setup: e.target.value.replace(/\D/g, '') })} /></label>}
                          {kind !== 'site' && <label>Remise en état (min)<input size={4} value={edit.teardown} onChange={(e) => setEdit({ ...edit, teardown: e.target.value.replace(/\D/g, '') })} /></label>}
                          {kind !== 'site' && sites.length > 0 && <label>Site<select value={edit.siteId} onChange={(e) => setEdit({ ...edit, siteId: e.target.value })}><option value="">—</option>{sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
                          {kind === 'room' && <label>Équipements<input value={edit.equipment} onChange={(e) => setEdit({ ...edit, equipment: e.target.value })} /></label>}
                        </div>
                        <WeeklyEditor value={edit.hours} onChange={(v) => setEdit({ ...edit, hours: v })} />
                        <div className="toolbar"><button className="btn sm" onClick={() => act.run(() => api('PATCH', `/api/v1/resources/${r.id}`, {
                          ...(kind !== 'site' ? { setupMinutes: Number(edit.setup) || 0, teardownMinutes: Number(edit.teardown) || 0, siteId: edit.siteId || null } : {}),
                          ...(kind === 'room' ? { equipment: edit.equipment.split(',').map((x: string) => x.trim()).filter(Boolean) } : {}),
                          openingHours: edit.hours && Object.values(edit.hours).some((x: any) => x?.length) ? edit.hours : null }), () => { setEdit(null); list.reload(); })}>Enregistrer</button>
                          <button className="btn ghost sm" onClick={() => setEdit(null)}>Annuler</button></div>
                      </div>}</td>
                    <td>{r.category ?? '—'}</td>
                    {kind === 'equipment' ? <>
                      <td>{r.serial_number ?? '—'}</td>
                      <td>{r.inspection_due_on ? (() => {
                        const soon = !r.inspection_overdue && new Date(r.inspection_due_on).getTime() - Date.now() < 30 * 86400e3;
                        return <span className={`pill ${r.inspection_overdue ? 'err' : soon ? 'warn' : 'ok'}`}>{r.inspection_overdue ? 'échue le ' : soon ? 'à renouveler avant le ' : 'jusqu’au '}{date(r.inspection_due_on)}</span>;
                      })() : <span className="muted">non renseignée</span>}
                        {write && <> <button className="btn ghost sm" onClick={() => { const v = prompt('Nouvelle date de vérification (AAAA-MM-JJ) :', r.inspection_due_on ?? ''); if (v) act.run(() => api('PATCH', `/api/v1/resources/${r.id}`, { inspectionDueOn: v }), () => list.reload()); }}>Mettre à jour</button></>}</td>
                    </> : <td>{(kind === 'site' ? r.address : r.location) ?? '—'}</td>}
                    {kind !== 'equipment' && <td className="num">{r.capacity ?? '—'}</td>}
                    <td>{write && <button className="btn ghost sm" onClick={() => setEdit({ id: r.id, setup: String(r.setup_minutes ?? 0), teardown: String(r.teardown_minutes ?? 0), siteId: r.site_id ?? '', equipment: (r.equipment ?? []).join(', '), hours: r.opening_hours })}>Planning</button>}{' '}
                      {write && <button className="btn ghost sm" onClick={() => confirm(`Archiver « ${r.name} » ? Il ne sera plus proposé pour les nouveaux créneaux.`) && act.run(() => post(`/api/v1/resources/${r.id}/archive`, { archived: true }), () => list.reload())}>Archiver</button>}</td>
                  </tr>))}</tbody>
              </table>}
            </div>
          </div>
        );
      })}
    </>
  );
}
