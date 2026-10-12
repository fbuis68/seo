import { useState } from 'react';
import { api, fmtDT, fmtT, post, zonedIso } from '../api';

const KIND_LABEL: Record<string, string> = { site: 'Lieu', room: 'Salle', equipment: 'Matériel' };
const h = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;

/** Envoi avec gestion du chevauchement : demande un motif de dérogation puis réessaie. */
async function withOverride<T>(send: (overrideReason?: string) => Promise<T>): Promise<T | undefined> {
  try { return await send(); }
  catch (e: any) {
    if (e.code !== 'slot_overlap') throw e;
    const reason = prompt(`${e.message}\nMotif de dérogation pour forcer (5 caractères min.), ou Annuler :`);
    if (!reason) return undefined;
    return send(reason);
  }
}

function Checks({ items, value, onChange, label }: { items: { id: string; label: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  if (!items.length) return <span className="small muted">{label} : aucun disponible</span>;
  return (
    <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', margin: 0 }}>
      <legend className="small" style={{ fontWeight: 600 }}>{label}</legend>
      {items.map((it) => (
        <label key={it.id} className="row small">
          <input type="checkbox" checked={value.includes(it.id)} onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))} />
          {it.label}{it.hint && <span className="muted"> — {it.hint}</span>}
        </label>
      ))}
    </fieldset>
  );
}

interface Props { session: any; canWrite: boolean; trainers: any[]; resources: any[]; onChange: () => void; onError: (m: string | null) => void }

/** Déroulé (parties) et planning (créneaux, formateurs, lieux, salles, matériel) d'une session. */
export default function Planning({ session: d, canWrite, trainers, resources, onChange, onError }: Props) {
  const [part, setPart] = useState({ title: '', hours: '' });
  const [slot, setSlot] = useState({ day: d.starts_on ?? '', start: '09:00', end: '12:30', partId: '', trainerIds: [] as string[], resourceIds: [] as string[] });
  const [editSlot, setEditSlot] = useState<any>(null);
  const [partTrainers, setPartTrainers] = useState<{ partId: string; ids: string[] } | null>(null);
  const trainerItems = trainers.map((t) => ({ id: t.id, label: `${t.first_name} ${t.last_name}` }));
  const resourceItems = (kinds: string[]) => resources.filter((r) => kinds.includes(r.kind)).map((r) => ({
    id: r.id, label: r.name, hint: [r.category, r.inspection_overdue ? 'vérification échue' : null].filter(Boolean).join(' · ') || undefined,
  }));
  const run = async (fn: () => Promise<unknown>) => { onError(null); try { await fn(); onChange(); } catch (e: any) { onError(e.message); } };
  const planned = d.parts.reduce((a: number, p: any) => a + p.planned_minutes, 0);
  const scheduled = d.slots.reduce((a: number, s: any) => a + s.duration_minutes, 0);
  const partTitle = (id: string | null) => d.parts.find((p: any) => p.id === id)?.title;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <strong>Déroulé et planning</strong>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        Programme : {h(d.duration_minutes)} · Réparti en parties : {h(planned)} · Planifié : <span style={{ color: scheduled !== d.duration_minutes ? 'var(--warn)' : 'var(--ok)' }}>{h(scheduled)}</span>
      </p>

      {/* Parties */}
      <table>
        <thead><tr><th>Partie</th><th className="num">Prévu</th><th className="num">Planifié</th><th>Formateur(s)</th><th /></tr></thead>
        <tbody>
          {d.parts.map((p: any) => (
            <tr key={p.id}>
              <td>{p.title}</td><td className="num">{h(p.planned_minutes)}</td>
              <td className="num" style={{ color: p.scheduled_minutes < p.planned_minutes ? 'var(--warn)' : undefined }}>{h(p.scheduled_minutes)}</td>
              <td>{p.trainers.map((t: any) => t.name).join(', ') || <span className="muted">—</span>}
                {partTrainers && partTrainers.partId === p.id && (
                  <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
                    <Checks label="Formateurs de la partie (tous ses créneaux)" items={trainerItems} value={partTrainers.ids} onChange={(ids) => setPartTrainers({ partId: p.id, ids })} />
                    <div className="toolbar">
                      <button className="btn sm" onClick={() => run(async () => { await withOverride((overrideReason) => post(`/api/v1/sessions/${d.id}/trainer`, { partId: p.id, trainerIds: partTrainers.ids, mode: 'replace', overrideReason })); setPartTrainers(null); })}>Appliquer</button>
                      <button className="btn ghost sm" onClick={() => setPartTrainers(null)}>Annuler</button>
                    </div>
                  </div>
                )}
              </td>
              <td>{canWrite && <>
                <button className="btn ghost sm" disabled={!p.scheduled_minutes} title={p.scheduled_minutes ? '' : 'Ajoutez d’abord des créneaux à cette partie'} onClick={() => setPartTrainers({ partId: p.id, ids: p.trainers.map((t: any) => t.id) })}>Formateurs</button>{' '}
                <button className="btn ghost sm" onClick={() => confirm(`Supprimer la partie « ${p.title} » ? Ses créneaux sont conservés.`) && run(() => api('DELETE', `/api/v1/session-parts/${p.id}`))}>Supprimer</button>
              </>}</td>
            </tr>
          ))}
          {!d.parts.length && <tr><td colSpan={5} className="muted small">Pas de découpage : la session est d’un seul tenant. Ajoutez des parties pour répartir les heures entre formateurs (ex. théorie / pratique).</td></tr>}
        </tbody>
      </table>
      {canWrite && (
        <form className="inline" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); run(async () => {
          await post(`/api/v1/sessions/${d.id}/parts`, { title: part.title, plannedMinutes: Math.round(Number(part.hours.replace(',', '.')) * 60) });
          setPart({ title: '', hours: '' });
        }); }}>
          <label>Nouvelle partie<input required placeholder="ex. Pratique sur engin" value={part.title} onChange={(e) => setPart({ ...part, title: e.target.value })} /></label>
          <label>Durée (h)<input required size={5} placeholder="7" value={part.hours} onChange={(e) => setPart({ ...part, hours: e.target.value })} /></label>
          <button className="btn ghost sm">Ajouter la partie</button>
        </form>
      )}

      {/* Créneaux */}
      <h2 style={{ fontSize: '1rem' }}>Créneaux</h2>
      <table>
        <thead><tr><th>Date</th><th className="num">Durée</th><th>Partie</th><th>Formateur(s)</th><th>Lieu / salle</th><th>Matériel</th><th /></tr></thead>
        <tbody>
          {d.slots.map((sl: any) => editSlot?.id === sl.id ? (
            <tr key={sl.id}><td colSpan={7}>
              <div style={{ display: 'grid', gap: 8 }}>
                <strong className="small">{fmtDT(sl.starts_at, d.timezone)} → {fmtT(sl.ends_at, d.timezone)}</strong>
                {d.parts.length > 0 && <label>Partie<select value={editSlot.partId} onChange={(e) => setEditSlot({ ...editSlot, partId: e.target.value })}><option value="">— aucune —</option>{d.parts.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
                <Checks label="Formateur(s)" items={trainerItems} value={editSlot.trainerIds} onChange={(v) => setEditSlot({ ...editSlot, trainerIds: v })} />
                <Checks label="Lieu / salle" items={resourceItems(['site', 'room'])} value={editSlot.resourceIds} onChange={(v) => setEditSlot({ ...editSlot, resourceIds: v })} />
                <Checks label="Matériel" items={resourceItems(['equipment'])} value={editSlot.resourceIds} onChange={(v) => setEditSlot({ ...editSlot, resourceIds: v })} />
                <div className="toolbar">
                  <button className="btn sm" onClick={() => run(async () => {
                    await withOverride((overrideReason) => api('PATCH', `/api/v1/slots/${sl.id}`, { partId: editSlot.partId || null, trainerIds: editSlot.trainerIds, resourceIds: editSlot.resourceIds, overrideReason }));
                    setEditSlot(null);
                  })}>Enregistrer</button>
                  <button className="btn ghost sm" onClick={() => setEditSlot(null)}>Annuler</button>
                </div>
              </div>
            </td></tr>
          ) : (
            <tr key={sl.id}>
              <td>{fmtDT(sl.starts_at, d.timezone)} → {fmtT(sl.ends_at, d.timezone)}
                {sl.overlap_override_reason && <> <span className="pill warn" title={sl.overlap_override_reason}>dérogation</span></>}</td>
              <td className="num">{h(sl.duration_minutes)}</td>
              <td>{partTitle(sl.part_id) ?? <span className="muted">—</span>}</td>
              <td>{sl.trainers.map((t: any) => t.name).join(', ') || <span className="pill warn">aucun</span>}</td>
              <td>{sl.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', ') || <span className="muted">—</span>}</td>
              <td>{sl.resources.filter((r: any) => r.kind === 'equipment').map((r: any) => r.name).join(', ') || <span className="muted">—</span>}</td>
              <td>{canWrite && <>
                <button className="btn ghost sm" onClick={() => setEditSlot({ id: sl.id, partId: sl.part_id ?? '', trainerIds: sl.trainers.map((t: any) => t.id), resourceIds: sl.resources.map((r: any) => r.id) })}>Modifier</button>{' '}
                <button className="btn ghost sm" onClick={() => confirm('Supprimer ce créneau ?') && run(() => api('DELETE', `/api/v1/slots/${sl.id}`))}>Supprimer</button>
              </>}</td>
            </tr>
          ))}
          {!d.slots.length && <tr><td colSpan={7} className="muted small">Aucun créneau planifié.</td></tr>}
        </tbody>
      </table>

      {canWrite && (
        <form style={{ display: 'grid', gap: 8, marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(async () => {
          const r = await withOverride((overrideReason) => post(`/api/v1/sessions/${d.id}/slots`, {
            startsAt: zonedIso(slot.day, slot.start, d.timezone), endsAt: zonedIso(slot.day, slot.end, d.timezone), partId: slot.partId || null,
            trainerIds: slot.trainerIds, resourceIds: slot.resourceIds, overrideReason,
          }));
          // Garde formateurs et ressources pour enchaîner les créneaux suivants.
          if (r) setSlot({ ...slot, start: slot.end, end: slot.end < '13:00' ? '17:00' : slot.end });
        }); }}>
          <strong className="small">Ajouter un créneau</strong>
          <div className="toolbar">
            <label>Jour<input type="date" required value={slot.day} onChange={(e) => setSlot({ ...slot, day: e.target.value })} /></label>
            <label>Début<input type="time" required value={slot.start} onChange={(e) => setSlot({ ...slot, start: e.target.value })} /></label>
            <label>Fin<input type="time" required value={slot.end} onChange={(e) => setSlot({ ...slot, end: e.target.value })} /></label>
            {d.parts.length > 0 && <label>Partie<select value={slot.partId} onChange={(e) => setSlot({ ...slot, partId: e.target.value })}><option value="">— aucune —</option>{d.parts.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
          </div>
          <div className="grid2" style={{ gap: 8 }}>
            <Checks label="Formateur(s)" items={trainerItems} value={slot.trainerIds} onChange={(v) => setSlot({ ...slot, trainerIds: v })} />
            <Checks label="Lieu / salle" items={resourceItems(['site', 'room'])} value={slot.resourceIds} onChange={(v) => setSlot({ ...slot, resourceIds: v })} />
            <Checks label="Matériel" items={resourceItems(['equipment'])} value={slot.resourceIds} onChange={(v) => setSlot({ ...slot, resourceIds: v })} />
          </div>
          <div><button className="btn sm">Ajouter le créneau</button> <span className="small muted">Lieux, salles et matériel se créent dans « Lieux & matériel » ; formateurs dans « Clients & apprenants ».</span></div>
        </form>
      )}
    </div>
  );
}

export { KIND_LABEL };
