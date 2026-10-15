import { useEffect, useRef, useState } from 'react';
import { api, fmtDT, fmtT, post, zonedIso } from '../api';
import { Help } from '../help';
import { HmInput } from '../planning/SlotPanel';
import { addDays, parts } from '../planning/lib';

const KIND_LABEL: Record<string, string> = { site: 'Lieu', room: 'Salle', equipment: 'Matériel' };
const h = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;

/** Envoi avec contrôle du planning : conflit dérogeable → motif demandé puis nouvel essai ; sinon message. */
async function withOverride<T>(send: (overrideReason?: string) => Promise<T>): Promise<T | undefined> {
  try { return await send(); }
  catch (e: any) {
    const blocking = e.details?.report?.flatMap((r: any) => r.blocking) ?? [];
    if (e.code !== 'planning_conflict' || !blocking.length || !blocking.every((i: any) => i.derogable)) throw e;
    const reason = prompt(`${blocking.map((i: any) => i.message).join('\n')}\n\nMotif de dérogation (responsable habilité, 5 caractères min.), ou Annuler :`);
    if (!reason) return undefined;
    return send(reason);
  }
}
const STATUS: Record<string, [string, string]> = { draft: ['Brouillon', ''], pending: ['À valider', 'warn'], published: ['Publié', 'ok'], done: ['Réalisé', 'ok'], cancelled: ['Annulé', 'err'] };

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

/** Sélection multiple compacte (liste déroulante à cases) pour tenir sur une ligne. */
function Pick({ items, value, onChange, label }: { items: { id: string; label: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  const sel = items.filter((i) => value.includes(i.id));
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { // fermeture au clic extérieur
    const out = (e: MouseEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('mousedown', out); return () => document.removeEventListener('mousedown', out);
  }, []);
  return (
    <label>{label}
      <details className="pick" ref={ref}>
        <summary aria-label={label}>{sel.length ? sel.map((i) => i.label).join(', ') : <span className="muted">{items.length ? '— aucun —' : 'aucun disponible'}</span>}</summary>
        <div className="pick-list">{items.map((it) => (
          <label key={it.id} className="row small"><input type="checkbox" checked={value.includes(it.id)} onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))} />
            {it.label}{it.hint && <span className="muted"> — {it.hint}</span>}</label>))}
          {!items.length && <span className="small muted">Aucun : à créer dans {label === 'Formateur(s)' ? '« Clients & apprenants »' : '« Lieux & matériel »'}.</span>}
        </div>
      </details>
    </label>
  );
}

/** Horaires modifiables : séance non validée (brouillon, à valider) ou pas encore commencée, sans présence saisie. */
const timesEditable = (sl: any) => !['cancelled', 'done'].includes(sl.status) && !sl.attendance_count && (['draft', 'pending'].includes(sl.status) || new Date(sl.starts_at) > new Date());

/** Date et horaires modifiables directement dans la ligne du créneau. */
function InlineTimes({ sl, tz, onSave }: { sl: any; tz: string; onSave: (startsAt: string, endsAt: string) => Promise<unknown> }) {
  const init = () => ({ day: parts(sl.starts_at, tz).date, start: parts(sl.starts_at, tz).hm, end: parts(sl.ends_at, tz).hm });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const i = init();
  const dirty = f.day !== i.day || f.start !== i.start || f.end !== i.end;
  const save = async () => {
    setBusy(true);
    try { await onSave(zonedIso(f.day, f.start, tz), zonedIso(f.end <= f.start ? addDays(f.day, 1) : f.day, f.end, tz)); } finally { setBusy(false); }
  };
  return (
    <span className="inline-times">
      <input type="date" aria-label="Date du créneau" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
      <HmInput label="Début" value={f.start} onChange={(v) => setF({ ...f, start: v })} />→<HmInput label="Fin" value={f.end} onChange={(v) => setF({ ...f, end: v })} />
      {dirty && <><button type="button" className="btn sm" disabled={busy} onClick={save}>OK</button><button type="button" className="btn ghost sm" onClick={() => setF(init())}>Annuler</button></>}
    </span>
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
  const active = d.slots.filter((s: any) => s.status !== 'cancelled');
  const scheduled = active.reduce((a: number, s: any) => a + s.pedagogical_minutes, 0);
  const target = d.target ?? d.duration_minutes;
  const unpublished = active.filter((s: any) => ['draft', 'pending'].includes(s.status)).length;
  const partTitle = (id: string | null) => d.parts.find((p: any) => p.id === id)?.title;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <strong>Déroulé et planning</strong> <Help k="session.deroule" />
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        Durée cible : {h(target)} · Réparti en parties : {h(planned)} · Planifié (hors pauses et annulations) : <span style={{ color: scheduled !== target ? 'var(--warn)' : 'var(--ok)' }}>{h(scheduled)}</span>
        {' '}· <a href={`/planning`} onClick={() => { try { const k = 'tms.planning.prefs'; const p = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...p, filters: { ...(p.filters ?? {}), sessionId: d.id }, view: 'list' })); } catch { /* */ } }}>Ouvrir dans le planning</a>
      </p>
      {canWrite && unpublished > 0 && <div className="toolbar"><span className="small">{unpublished} séance(s) non publiée(s) : invisibles des formateurs et stagiaires.</span>
        <button className="btn sm" onClick={() => run(() => post('/api/v1/planning/transition', { sessionId: d.id, status: 'published' }))}>Publier les séances</button></div>}

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
      <h2 style={{ fontSize: '1rem' }}>Créneaux <Help k="session.creneaux" /></h2>
      <table>
        <thead><tr><th>Date</th><th className="num">Durée</th><th>Partie</th><th>Formateur(s)</th><th>Lieu / salle</th><th>Matériel</th><th>Statut</th><th /></tr></thead>
        <tbody>
          {d.slots.map((sl: any) => editSlot?.id === sl.id ? (
            <tr key={sl.id}><td colSpan={8}>
              <div style={{ display: 'grid', gap: 8 }}>
                <strong className="small">{fmtDT(sl.starts_at, d.timezone)} → {fmtT(sl.ends_at, d.timezone)}</strong>
                <div className="toolbar" style={{ margin: 0 }}>
                  <label>Date<input type="date" required value={editSlot.day} disabled={editSlot.locked} onChange={(e) => setEditSlot({ ...editSlot, day: e.target.value })} /></label>
                  <label>Début<HmInput required value={editSlot.start} disabled={editSlot.locked} onChange={(v) => setEditSlot({ ...editSlot, start: v })} /></label>
                  <label>Fin<HmInput required value={editSlot.end} disabled={editSlot.locked} onChange={(v) => setEditSlot({ ...editSlot, end: v })} /></label>
                  <span className="small muted">{editSlot.locked ? 'Séance commencée ou émargée : horaires figés.' : `Fuseau ${d.timezone}${editSlot.end <= editSlot.start ? ' · fin le lendemain' : ''}`}</span>
                </div>
                {d.parts.length > 0 && <label>Partie<select value={editSlot.partId} onChange={(e) => setEditSlot({ ...editSlot, partId: e.target.value })}><option value="">— aucune —</option>{d.parts.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
                <Checks label="Formateur(s)" items={trainerItems} value={editSlot.trainerIds} onChange={(v) => setEditSlot({ ...editSlot, trainerIds: v })} />
                <Checks label="Lieu / salle" items={resourceItems(['site', 'room'])} value={editSlot.resourceIds} onChange={(v) => setEditSlot({ ...editSlot, resourceIds: v })} />
                <Checks label="Matériel" items={resourceItems(['equipment'])} value={editSlot.resourceIds} onChange={(v) => setEditSlot({ ...editSlot, resourceIds: v })} />
                <div className="toolbar">
                  <button className="btn sm" onClick={() => run(async () => {
                    const startsAt = zonedIso(editSlot.day, editSlot.start, d.timezone);
                    const endsAt = zonedIso(editSlot.end <= editSlot.start ? addDays(editSlot.day, 1) : editSlot.day, editSlot.end, d.timezone);
                    const moved = +new Date(startsAt) !== +new Date(sl.starts_at) || +new Date(endsAt) !== +new Date(sl.ends_at);
                    await withOverride((overrideReason) => api('PATCH', `/api/v1/slots/${sl.id}`, { version: editSlot.version, partId: editSlot.partId || null, trainerIds: editSlot.trainerIds, resourceIds: editSlot.resourceIds, overrideReason,
                      ...(moved ? { startsAt, endsAt } : {}) }));
                    setEditSlot(null);
                  })}>Enregistrer</button>
                  <button className="btn ghost sm" onClick={() => setEditSlot(null)}>Annuler</button>
                </div>
              </div>
            </td></tr>
          ) : (
            <tr key={sl.id}>
              <td>{canWrite && timesEditable(sl)
                  ? <InlineTimes key={sl.version} sl={sl} tz={d.timezone} onSave={(startsAt, endsAt) => run(() => withOverride((overrideReason) => api('PATCH', `/api/v1/slots/${sl.id}`, { version: sl.version, startsAt, endsAt, overrideReason })))} />
                  : <>{fmtDT(sl.starts_at, d.timezone)} → {fmtT(sl.ends_at, d.timezone)}</>}
                {sl.derogation && <> <span className="pill warn" title={sl.derogation.reason}>dérogation</span></>}</td>
              <td className="num">{h(sl.pedagogical_minutes)}{sl.pedagogical_minutes !== sl.duration_minutes && <div className="small muted">pauses {h(sl.duration_minutes - sl.pedagogical_minutes)}</div>}</td>
              <td>{partTitle(sl.part_id) ?? <span className="muted">—</span>}</td>
              <td>{sl.trainers.map((t: any) => t.name).join(', ') || <span className="pill warn">aucun</span>}</td>
              <td>{sl.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', ') || <span className="muted">—</span>}</td>
              <td>{sl.resources.filter((r: any) => r.kind === 'equipment').map((r: any) => r.name).join(', ') || <span className="muted">—</span>}</td>
              <td><span className={`pill ${STATUS[sl.status][1]}`} title={sl.cancel_reason ?? ''}>{STATUS[sl.status][0]}</span>{sl.to_resolve > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{sl.to_resolve} à résoudre</div>}</td>
              <td>{canWrite && !['cancelled', 'done'].includes(sl.status) && <>
                <button className="btn ghost sm" onClick={() => setEditSlot({ id: sl.id, version: sl.version, day: parts(sl.starts_at, d.timezone).date, start: parts(sl.starts_at, d.timezone).hm, end: parts(sl.ends_at, d.timezone).hm, locked: !timesEditable(sl), partId: sl.part_id ?? '', trainerIds: sl.trainers.map((t: any) => t.id), resourceIds: sl.resources.map((r: any) => r.id) })}>Modifier</button>{' '}
                {sl.status === 'draft' && !sl.published_at
                  ? <button className="btn ghost sm" onClick={() => confirm('Supprimer ce brouillon ?') && run(() => api('DELETE', `/api/v1/slots/${sl.id}`))}>Supprimer</button>
                  : <button className="btn ghost sm" onClick={() => { const reason = prompt('Annuler la séance (les personnes concernées seront prévenues). Motif :'); if (reason) run(() => post(`/api/v1/planning/slots/${sl.id}/cancel`, { reason })); }}>Annuler</button>}
              </>}</td>
            </tr>
          ))}
          {!d.slots.length && <tr><td colSpan={8} className="muted small">Aucun créneau planifié.</td></tr>}
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
          <div className="slot-line">
            <label>Jour<input type="date" required value={slot.day} onChange={(e) => setSlot({ ...slot, day: e.target.value })} /></label>
            <label>Début<HmInput required value={slot.start} onChange={(v) => setSlot({ ...slot, start: v })} /></label>
            <label>Fin<HmInput required value={slot.end} onChange={(v) => setSlot({ ...slot, end: v })} /></label>
            {d.parts.length > 0 && <label>Partie<select value={slot.partId} onChange={(e) => setSlot({ ...slot, partId: e.target.value })}><option value="">— aucune —</option>{d.parts.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
            <Pick label="Formateur(s)" items={trainerItems} value={slot.trainerIds} onChange={(v) => setSlot({ ...slot, trainerIds: v })} />
            <Pick label="Lieu / salle" items={resourceItems(['site', 'room'])} value={slot.resourceIds} onChange={(v) => setSlot({ ...slot, resourceIds: v })} />
            {resourceItems(['equipment']).length > 0 && <Pick label="Matériel" items={resourceItems(['equipment'])} value={slot.resourceIds} onChange={(v) => setSlot({ ...slot, resourceIds: v })} />}
            <button className="btn sm">Ajouter</button>
          </div>
          <span className="small muted">Créé en brouillon (ressources réservées), à publier ensuite. Horaires modifiables directement dans la liste tant que le créneau n’est pas validé ou pas commencé. Pauses, récurrences, distanciel : écran Planning.</span>
        </form>
      )}
    </div>
  );
}

export { KIND_LABEL };
