import { useEffect, useMemo, useRef, useState } from 'react';
import { api, get, post } from '../api';
import { MODALITY, STATUS, addDays, at, fmtH, parts } from './lib';
import { Help } from '../help';

export interface Draft { startsAt: string; endsAt: string; key?: { by: string; id: string }; sessionId?: string }
interface Props {
  slotId?: string; draft?: Draft; lookups: any; tz: string; perms: { write: boolean; publish: boolean; derogate: boolean; directPublish: boolean };
  onClose: () => void; onSaved: (focusDate?: string) => void;
}

/** Liste des contrôles : règle, ressource, créneau, séance concernée ; bloquant / alerte. */
export function Issues({ report }: { report?: any[] }) {
  if (!report) return null;
  const blocking = report.flatMap((r) => r.blocking ?? []); const warnings = report.flatMap((r) => r.warnings ?? []); const derogated = report.flatMap((r) => r.derogated ?? []);
  if (!blocking.length && !warnings.length && !derogated.length) return <p className="success small" role="status">Aucun conflit.</p>;
  const uniq = (l: any[]) => [...new Map(l.map((i) => [i.message, i])).values()];
  return (
    <ul className="pl-issues" role="status">
      {uniq(blocking).map((i, k) => <li key={'b' + k} className="err"><strong>Bloquant</strong>{i.derogable ? ' (dérogeable)' : ''} : {i.message}</li>)}
      {uniq(derogated).map((i, k) => <li key={'d' + k} className="warn"><strong>Dérogation</strong> : {i.message}</li>)}
      {uniq(warnings).map((i, k) => <li key={'w' + k} className="warn"><strong>Alerte</strong> : {i.message}</li>)}
    </ul>
  );
}

/**
 * Envoi avec gestion des conflits : bloquant non dérogeable → message ; dérogeable et rôle
 * habilité → motif demandé dans le formulaire (valeurs saisies conservées).
 */
export function useSubmit(derogate: boolean) {
  const [state, setState] = useState<{ error?: string; report?: any[]; derogable?: boolean; busy?: boolean; versionConflict?: boolean }>({});
  const send = async (fn: (extra: { derogation?: string }) => Promise<any>, derogation?: string) => {
    setState({ busy: true });
    try { const r = await fn(derogation ? { derogation } : {}); setState({ report: r?.report }); return r; }
    catch (e: any) {
      const report = e.details?.report;
      const blocking = report?.flatMap((r: any) => r.blocking) ?? [];
      setState({ error: e.message, report, derogable: e.code === 'planning_conflict' && derogate && blocking.length > 0 && blocking.every((i: any) => i.derogable), versionConflict: e.code === 'version_conflict' });
      return undefined;
    }
  };
  return { state, send, reset: () => setState({}) };
}

export function DerogationBox({ onSubmit }: { onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="pl-derog">
      <span className="small">Dérogation <Help k="planning.derogation" /></span>
      <label>Motif de dérogation (tracé dans l’historique)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex. accord du responsable de site" /></label>
      <button type="button" className="btn sm danger" disabled={reason.trim().length < 5} onClick={() => onSubmit(reason.trim())}>Enregistrer avec dérogation</button>
    </div>
  );
}

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

/** Saisie d'heure au format 24 h (indépendant de la langue du navigateur). */
export function HmInput({ value, onChange, label, disabled, required }: { value: string; onChange: (v: string) => void; label?: string; disabled?: boolean; required?: boolean }) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  const commit = (v: string) => {
    const m = /^(\d{1,2})\s*[:hH.]?\s*(\d{2})?$/.exec(v.trim());
    if (m && +m[1] < 24 && +(m[2] ?? 0) < 60) { const hm = `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`; setTxt(hm); if (hm !== value) onChange(hm); } else setTxt(value);
  };
  return <input className="hm" inputMode="numeric" aria-label={label} placeholder="HH:MM" value={txt} disabled={disabled} required={required} size={5}
    onChange={(e) => { setTxt(e.target.value); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) onChange(e.target.value); }} onBlur={(e) => commit(e.target.value)} />;
}

/** Panneau latéral : création / modification sans perdre date, filtres ni position du planning. */
export default function SlotPanel({ slotId, draft, lookups, tz, perms, onClose, onSaved }: Props) {
  const [slot, setSlot] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [check, setCheck] = useState<any>(null);
  const [suggest, setSuggest] = useState<{ kind: string; list: any[] } | null>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [repeat, setRepeat] = useState<{ on: boolean; days: number[]; until: string; exclusions: string; preview?: any }>({ on: false, days: [], until: '', exclusions: '' });
  const [dupDates, setDupDates] = useState('');
  const sub = useSubmit(perms.derogate);
  const panelRef = useRef<HTMLElement>(null);

  // Chargement : séance existante ou brouillon prérempli depuis le créneau / la ressource sélectionnés.
  useEffect(() => {
    sub.reset(); setSuggest(null); setHistory(null); setCheck(null);
    if (slotId) {
      get(`/api/v1/planning/slots/${slotId}`).then((s) => {
        setSlot(s);
        const a = parts(s.starts_at, tz); const b = parts(s.ends_at, tz);
        setF({ sessionId: s.session_id, partId: s.part_id ?? '', title: s.title ?? '', date: a.date, start: a.hm, end: b.hm, endDate: b.date,
          breaks: (s.breaks ?? []).map((x: any) => ({ start: parts(x.startsAt, tz).hm, end: parts(x.endsAt, tz).hm })), modality: s.modality, videoUrl: s.video_url ?? '',
          groupLabel: s.group_label ?? '', notes: s.notes ?? '', trainers: s.trainers.map((t: any) => ({ id: t.id, role: t.role })), resourceIds: s.resources.map((r: any) => r.id),
          participants: Object.fromEntries((s.participants ?? []).filter((p: any) => p.explicit).map((p: any) => [p.enrollment_id, p.mode])), version: s.version, scope: 'this' });
      }, (e) => sub.state.error ?? alert(e.message));
    } else if (draft) {
      setSlot(null);
      const a = parts(draft.startsAt, tz); const b = parts(draft.endsAt, tz);
      const session = lookups.sessions.find((x: any) => x.id === draft.sessionId) ?? null;
      const key = draft.key;
      setF({ sessionId: session?.id ?? '', partId: '', title: '', date: a.date, start: a.hm, end: b.hm, endDate: b.date, breaks: [], modality: session?.modality === 'remote' ? 'remote' : 'onsite',
        videoUrl: '', groupLabel: '', notes: '', trainers: key?.by === 'trainer' ? [{ id: key.id, role: 'lead' }] : [],
        resourceIds: key && ['room', 'equipment', 'site'].includes(key.by) ? [key.id] : session?.site_id ? [session.site_id] : [], participants: {}, version: undefined, scope: 'this' });
      setRepeat({ on: false, days: [], until: '', exclusions: '' });
    }
  }, [slotId, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { panelRef.current?.focus(); }, [slotId, draft]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const session = useMemo(() => lookups.sessions.find((x: any) => x.id === f?.sessionId), [f?.sessionId, lookups.sessions]);
  const sTz = session?.timezone ?? slot?.timezone ?? tz;
  const endDate = f ? (f.end <= f.start ? addDays(f.date, 1) : f.date) : '';
  const body = useMemo(() => {
    if (!f?.sessionId || !f.date || !f.start || !f.end) return null;
    const startsAt = at(f.date, f.start, sTz); const endsAt = at(endDate, f.end, sTz);
    return {
      startsAt, endsAt, title: f.title || null, partId: f.partId || null, modality: f.modality, videoUrl: f.videoUrl || null, groupLabel: f.groupLabel || null, notes: f.notes || null,
      breaks: f.breaks.filter((x: any) => x.start && x.end).map((x: any) => ({ startsAt: at(x.start < f.start ? addDays(f.date, 1) : f.date, x.start, sTz), endsAt: at(x.end <= f.start ? addDays(f.date, 1) : f.date, x.end, sTz) })),
      trainers: f.trainers, resourceIds: f.resourceIds,
      ...(slot ? { participants: (slot.participants ?? []).filter((p: any) => (f.participants[p.enrollment_id] ?? 'default') !== 'to_resolve').map((p: any) => ({ enrollmentId: p.enrollment_id, mode: f.participants[p.enrollment_id] ?? 'default' })) } : {}),
    };
  }, [f, sTz, endDate, slot]);

  // Contrôle en direct (sans écriture) à chaque modification.
  useEffect(() => {
    if (!body || !perms.write) return;
    const t = setTimeout(() => {
      post('/api/v1/planning/check', { ...body, ...(slot ? { slotId: slot.id } : { sessionId: f.sessionId }) }).then(setCheck, (e) => setCheck({ error: e.message }));
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(body)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!f) return <aside className="pl-panel" ref={panelRef} tabIndex={-1}><p className="muted">Chargement…</p></aside>;
  const set = (patch: any) => setF({ ...f, ...patch });
  const readOnly = !perms.write || (slot && ['cancelled'].includes(slot.status));
  const duration = body ? Math.round((+new Date(body.endsAt) - +new Date(body.startsAt)) / 60000) : 0;
  const breakMin = body ? body.breaks.reduce((a: number, x: any) => a + (+new Date(x.endsAt) - +new Date(x.startsAt)) / 60000, 0) : 0;
  const res = (kind: string) => lookups.resources.filter((r: any) => r.kind === kind);
  const toggleRes = (id: string) => set({ resourceIds: f.resourceIds.includes(id) ? f.resourceIds.filter((x: string) => x !== id) : [...f.resourceIds, id] });
  const toggleTrainer = (id: string) => set({ trainers: f.trainers.some((t: any) => t.id === id) ? f.trainers.filter((t: any) => t.id !== id) : [...f.trainers, { id, role: f.trainers.length ? 'co' : 'lead' }] });
  const reload = () => get(`/api/v1/planning/slots/${slot.id}`).then((s) => { setSlot(s); set({ version: s.version }); });

  const save = (derogation?: string) => sub.send(async (extra) => {
    if (!slot && repeat.on) {
      const r = await post(`/api/v1/planning/sessions/${f.sessionId}/series`, {
        startDate: f.date, days: repeat.days.length ? repeat.days : [parts(body!.startsAt, sTz).dow], until: repeat.until || undefined, count: repeat.until ? undefined : 10,
        startTime: f.start, endTime: f.end, exclusions: repeat.exclusions.split(/[\s,;]+/).filter(Boolean).map(frDate),
        breaks: f.breaks.filter((x: any) => x.start && x.end), title: body!.title, partId: body!.partId, modality: body!.modality, videoUrl: body!.videoUrl, groupLabel: body!.groupLabel,
        trainers: body!.trainers, resourceIds: body!.resourceIds, ...extra,
      });
      onSaved(f.date); return r;
    }
    const r = slot ? await api('PATCH', `/api/v1/planning/slots/${slot.id}`, { ...body, version: f.version, scope: slot.series_id ? f.scope : undefined, ...extra })
      : await post('/api/v1/planning/slots', { ...body, sessionId: f.sessionId, ...extra });
    onSaved(f.date);
    return r;
  }, derogation);
  const seriesPreview = () => sub.send(async () => {
    const r = await post(`/api/v1/planning/sessions/${f.sessionId}/series`, {
      startDate: f.date, days: repeat.days.length ? repeat.days : [parts(body!.startsAt, sTz).dow], until: repeat.until || undefined, count: repeat.until ? undefined : 10,
      startTime: f.start, endTime: f.end, exclusions: repeat.exclusions.split(/[\s,;]+/).filter(Boolean).map(frDate), trainers: body!.trainers, resourceIds: body!.resourceIds,
      modality: body!.modality, videoUrl: body!.videoUrl, preview: true,
    });
    setRepeat({ ...repeat, preview: r.result }); return r;
  });
  const action = (label: string, fn: () => Promise<any>) => sub.send(async () => { const r = await fn(); onSaved(f.date); if (slot) await reload(); return r; });
  const loadSuggest = (kind: string) => body && post('/api/v1/planning/suggest', { ...body, kind, ...(slot ? { slotId: slot.id } : {}), sessionId: f.sessionId })
    .then((list) => setSuggest({ kind, list }), (e) => setSuggest({ kind, list: [{ error: e.message }] }));

  return (
    <aside className="pl-panel" ref={panelRef} tabIndex={-1} aria-label={slot ? 'Fiche séance' : 'Nouvelle séance'}>
      <div className="pl-panel-h">
        <strong>{slot ? 'Séance' : 'Nouvelle séance'} <Help k="planning.fiche" /></strong>
        {slot && <span className={`pill st-${slot.status}`}>{STATUS[slot.status].mark} {STATUS[slot.status].label} · v{slot.version}</span>}
        <button className="btn ghost sm" onClick={onClose} aria-label="Fermer le panneau">Fermer</button>
      </div>
      {slot?.status === 'cancelled' && <p className="banner err small">Annulée : {slot.cancel_reason}</p>}
      {slot?.derogation && <p className="banner warn small">Dérogation : {slot.derogation.reason} ({(slot.derogation.rules ?? []).join(', ')})</p>}
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="pl-form">
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
          <label>Session<select required value={f.sessionId} disabled={!!slot} onChange={(e) => { const s = lookups.sessions.find((x: any) => x.id === e.target.value); set({ sessionId: e.target.value, partId: '', resourceIds: f.resourceIds.length ? f.resourceIds : s?.site_id ? [s.site_id] : [] }); }}>
            <option value="">— choisir —</option>{lookups.sessions.map((s: any) => <option key={s.id} value={s.id}>{s.title}{s.reference ? ` (${s.reference})` : ''}</option>)}</select></label>
          {session && <p className="small muted" style={{ margin: 0 }}>{session.program_title} · cible {fmtH(session.target_minutes)}{session.capacity ? ` · ${session.capacity} places` : ''}</p>}
          <div className="pl-row">
            {session?.parts?.length > 0 && <label>Module<select value={f.partId} onChange={(e) => set({ partId: e.target.value })}><option value="">—</option>{session.parts.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
            <label style={{ flex: 1 }}>Intitulé court<input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="ex. Théorie" /></label>
          </div>
          <div className="pl-row">
            <label>Date<input type="date" required value={f.date} onChange={(e) => set({ date: e.target.value })} disabled={slot?.status === 'done'} /></label>
            <label>Début<HmInput required value={f.start} onChange={(v) => set({ start: v })} disabled={slot?.status === 'done'} /></label>
            <label>Fin<HmInput required value={f.end} onChange={(v) => set({ end: v })} disabled={slot?.status === 'done'} /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Durée {fmtH(Math.max(0, duration))}{breakMin ? ` · pauses ${fmtH(breakMin)} · pédagogique ${fmtH(Math.max(0, duration - breakMin))}` : ''}{endDate !== f.date ? ' · se termine le lendemain' : ''} · fuseau {sTz}</p>
          <div>
            <span className="small" style={{ fontWeight: 600 }}>Pauses non pédagogiques</span> <Help k="planning.pauses" />
            {f.breaks.map((b: any, i: number) => (
              <div key={i} className="pl-row">
                <HmInput label="Début de pause" value={b.start} onChange={(v) => set({ breaks: f.breaks.map((x: any, j: number) => j === i ? { ...x, start: v } : x) })} />
                <HmInput label="Fin de pause" value={b.end} onChange={(v) => set({ breaks: f.breaks.map((x: any, j: number) => j === i ? { ...x, end: v } : x) })} />
                <button type="button" className="btn ghost sm" onClick={() => set({ breaks: f.breaks.filter((_: any, j: number) => j !== i) })}>Retirer</button>
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => set({ breaks: [...f.breaks, { start: f.start < '12:00' && f.end > '13:00' ? '12:00' : f.start, end: f.start < '12:00' && f.end > '13:00' ? '13:00' : f.start }] })}>+ Pause</button>
          </div>
          <div className="pl-row">
            <Help k="planning.modalite" /><label>Modalité<select value={f.modality} onChange={(e) => set({ modality: e.target.value })}>{Object.entries(MODALITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {f.modality !== 'onsite' && <label style={{ flex: 1 }}>Lien de visioconférence<input type="url" value={f.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} placeholder="https://…" /></label>}
            {session?.groups?.length > 0 && <label>Groupe<select value={f.groupLabel} onChange={(e) => set({ groupLabel: e.target.value })}><option value="">Tous</option>{session.groups.map((g: string) => <option key={g}>{g}</option>)}</select></label>}
          </div>

          <fieldset className="pl-fs"><legend>Formateurs <button type="button" className="linklike small" onClick={() => loadSuggest('trainer')}>disponibilités</button></legend>
            {suggest?.kind === 'trainer' ? <SuggestList list={suggest.list} selected={f.trainers.map((t: any) => t.id)} onPick={toggleTrainer} onClose={() => setSuggest(null)} />
              : lookups.trainers.filter((t: any) => t.active || f.trainers.some((x: any) => x.id === t.id)).map((t: any) => {
                const sel = f.trainers.find((x: any) => x.id === t.id);
                return <div key={t.id} className="pl-row"><label className="row"><input type="checkbox" checked={!!sel} onChange={() => toggleTrainer(t.id)} />{t.name}</label>
                  {sel && <select aria-label={`Rôle de ${t.name}`} value={sel.role} onChange={(e) => set({ trainers: f.trainers.map((x: any) => x.id === t.id ? { ...x, role: e.target.value } : x) })}><option value="lead">principal</option><option value="co">coanimateur</option></select>}</div>;
              })}
            {!lookups.trainers.length && <span className="small muted">Aucun formateur : créez-en dans « Clients & apprenants ».</span>}
          </fieldset>
          {f.modality !== 'remote' && ['site', 'room', 'equipment'].map((kind) => res(kind).length > 0 && (
            <fieldset key={kind} className="pl-fs"><legend>{({ site: 'Lieu', room: 'Salles', equipment: 'Matériel' } as any)[kind]} {kind !== 'site' && <button type="button" className="linklike small" onClick={() => loadSuggest(kind)}>disponibilités</button>}</legend>
              {suggest?.kind === kind ? <SuggestList list={suggest.list} selected={f.resourceIds} onPick={toggleRes} onClose={() => setSuggest(null)} />
                : res(kind).map((r: any) => <label key={r.id} className="row"><input type="checkbox" checked={f.resourceIds.includes(r.id)} onChange={() => toggleRes(r.id)} />{r.name}
                  <span className="small muted">{[r.capacity && `${r.capacity} pl.`, r.category, r.equipment?.length && r.equipment.join(', '), r.accessible ? 'accessible' : null].filter(Boolean).join(' · ')}</span></label>)}
            </fieldset>
          ))}
          {slot && slot.participants?.length > 0 && (
            <details className="pl-fs"><summary><Help k="planning.participants" /> Participants : {slot.expected_onsite} présent(s), {slot.expected_remote} à distance{slot.to_resolve ? `, ${slot.to_resolve} à résoudre` : ''}</summary>
              <table><tbody>{slot.participants.map((p: any) => (
                <tr key={p.enrollment_id}><td>{p.name}{p.group_label ? <span className="small muted"> · {p.group_label}</span> : null}{!p.dates_ok && <span className="pill warn">hors dates</span>}{p.mode === 'to_resolve' && <div className="small" style={{ color: 'var(--warn)' }}>{p.reason}</div>}</td>
                  <td><select aria-label={`Participation de ${p.name}`} value={f.participants[p.enrollment_id] ?? 'default'} onChange={(e) => set({ participants: { ...f.participants, [p.enrollment_id]: e.target.value } })}>
                    <option value="default">selon la modalité</option><option value="onsite">présentiel</option><option value="remote">à distance</option><option value="excluded">non attendu</option>
                    {f.participants[p.enrollment_id] === 'to_resolve' && <option value="to_resolve">à résoudre</option>}</select></td></tr>))}</tbody></table>
            </details>
          )}
          <label>Notes internes<textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>

          {!slot && (
            <fieldset className="pl-fs"><legend><label className="row"><input type="checkbox" checked={repeat.on} onChange={(e) => setRepeat({ ...repeat, on: e.target.checked, preview: undefined })} />Répéter (heure locale conservée)</label> <Help k="planning.recurrence" /></legend>
              {repeat.on && <>
                <div className="pl-row" role="group" aria-label="Jours">{WEEKDAYS.map((d, i) => <label key={i} className="row"><input type="checkbox" checked={repeat.days.includes(i + 1)} onChange={(e) => setRepeat({ ...repeat, preview: undefined, days: e.target.checked ? [...repeat.days, i + 1] : repeat.days.filter((x) => x !== i + 1) })} />{d}</label>)}</div>
                <div className="pl-row"><label>Jusqu’au<input type="date" value={repeat.until} onChange={(e) => setRepeat({ ...repeat, until: e.target.value, preview: undefined })} /></label>
                  <label style={{ flex: 1 }}>Exclusions (JJ/MM/AAAA)<input value={repeat.exclusions} onChange={(e) => setRepeat({ ...repeat, exclusions: e.target.value, preview: undefined })} placeholder="01/05/2027 08/05/2027" /></label></div>
                {!repeat.until && <p className="small muted" style={{ margin: 0 }}>Sans date de fin : 10 occurrences.</p>}
                <button type="button" className="btn ghost sm" onClick={seriesPreview}>Aperçu des occurrences</button>
                {repeat.preview && <table><tbody>{repeat.preview.occurrences.map((o: any) => <tr key={o.date}><td>{o.date.split('-').reverse().join('/')}</td>
                  <td><span className={`pill ${o.status === 'create' ? 'ok' : o.status === 'excluded' ? '' : 'err'}`}>{({ create: 'créée', excluded: 'exclue', conflict: 'en conflit', invalid_time: 'horaire invalide' } as any)[o.status]}</span></td>
                  <td className="small">{o.issues?.join(' ; ')}</td></tr>)}</tbody></table>}
              </>}
            </fieldset>
          )}
          {slot?.series_id && (
            <div className="pl-row" role="radiogroup" aria-label="Portée de la modification"><Help k="planning.recurrence" label="portée dans une série" />
              {[['this', 'Cette séance'], ['following', 'Celle-ci et les suivantes'], ['all', 'Toute la série']].map(([v, l]) => <label key={v} className="row"><input type="radio" name="scope" checked={f.scope === v} onChange={() => set({ scope: v })} />{l}</label>)}
            </div>
          )}
        </fieldset>

        <div className="pl-check" aria-live="polite">{check?.error ? <p className="alert small">{check.error}</p> : check && <Issues report={[check]} />}</div>
        {sub.state.error && <p className="alert">{sub.state.error}{sub.state.versionConflict && <> <button type="button" className="btn ghost sm" onClick={reload}>Recharger</button></>}</p>}
        {sub.state.error && <Issues report={sub.state.report} />}
        {sub.state.error && <Help k="planning.controles" label="contrôles" />}
        {sub.state.derogable && <DerogationBox onSubmit={(r) => save(r)} />}
        {!readOnly && <div className="toolbar"><button className="btn" disabled={sub.state.busy || !body}>{slot ? 'Enregistrer' : repeat.on ? 'Créer la série' : 'Créer en brouillon'}</button>
          {!slot && <span className="small muted">Le brouillon réserve les ressources sans apparaître dans les portails.</span>}</div>}
      </form>

      {slot && perms.write && (
        <div className="pl-actions">
          <Help k="planning.statuts" label="statuts et actions" />
          {slot.status === 'draft' && <button className="btn ghost sm" onClick={() => action('submit', () => post('/api/v1/planning/transition', { slotIds: [slot.id], status: 'pending' }))}>Demander la validation</button>}
          {slot.status === 'pending' && <button className="btn ghost sm" onClick={() => action('back', () => post('/api/v1/planning/transition', { slotIds: [slot.id], status: 'draft' }))}>Renvoyer en brouillon</button>}
          {['draft', 'pending'].includes(slot.status) && (perms.publish || perms.directPublish) && <button className="btn sm" onClick={() => action('publish', () => post('/api/v1/planning/transition', { slotIds: [slot.id], status: 'published' }))}>Publier</button>}
          {slot.status === 'published' && new Date(slot.ends_at) < new Date() && <button className="btn ghost sm" onClick={() => action('done', () => post('/api/v1/planning/transition', { slotIds: [slot.id], status: 'done' }))}>Marquer réalisée</button>}
          {slot.status !== 'cancelled' && <details><summary>Dupliquer <Help k="planning.duplication" /></summary>
            <div className="pl-row"><input aria-label="Dates de duplication" value={dupDates} onChange={(e) => setDupDates(e.target.value)} placeholder="JJ/MM/AAAA, …" />
              <button className="btn ghost sm" onClick={() => action('dup', () => post(`/api/v1/planning/slots/${slot.id}/duplicate`, { dates: dupDates.split(/[\s,;]+/).filter(Boolean).map(frDate) }))}>Dupliquer</button></div>
            <p className="small muted">Copie pédagogique et affectations ; ni émargement ni historique.</p></details>}
          {!['cancelled', 'done'].includes(slot.status) && <button className="btn ghost sm" onClick={() => { const reason = prompt(`Annuler la séance ?${slot.status === 'published' ? '\nLes personnes concernées seront prévenues ; les convocations déjà générées restent à reprendre.' : ''}\nMotif :`); if (reason) action('cancel', () => post(`/api/v1/planning/slots/${slot.id}/cancel`, { reason })); }}>Annuler la séance</button>}
          {slot.status === 'draft' && !slot.published_at && <button className="btn ghost sm danger-text" onClick={() => confirm('Supprimer définitivement ce brouillon ?') && sub.send(async () => { await api('DELETE', `/api/v1/planning/slots/${slot.id}`); onSaved(); onClose(); })}>Supprimer</button>}
          <button className="btn ghost sm" onClick={() => history ? setHistory(null) : get(`/api/v1/planning/history?slotId=${slot.id}`).then(setHistory)}>Historique</button>
        </div>
      )}
      {history && <HistoryList rows={history} tz={tz} />}
    </aside>
  );
}

function SuggestList({ list, selected, onPick, onClose }: { list: any[]; selected: string[]; onPick: (id: string) => void; onClose: () => void }) {
  if (list[0]?.error) return <p className="alert small">{list[0].error}</p>;
  return (
    <div>
      {list.map((x) => (
        <label key={x.id} className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={selected.includes(x.id)} onChange={() => onPick(x.id)} />
          <span><span className={`pill ${x.available ? 'ok' : 'err'}`}>{x.available ? 'libre' : 'indisponible'}</span> {x.name}
            {x.reasons?.length > 0 && <span className="small muted"> — {x.reasons.map((r: any) => r.message).join(' ; ')}</span>}</span>
        </label>
      ))}
      <button type="button" className="linklike small" onClick={onClose}>Revenir à la liste simple</button>
    </div>
  );
}

const ACTION: Record<string, string> = { created: 'Création', updated: 'Modification', moved: 'Déplacement', published: 'Publication', submitted: 'Demande de validation', returned: 'Retour en brouillon', done: 'Réalisée', cancelled: 'Annulation', deleted: 'Suppression' };
export function HistoryList({ rows, tz }: { rows: any[]; tz: string }) {
  if (!rows.length) return <p className="muted small">Aucune modification.</p>;
  return (
    <ol className="pl-history">
      {rows.map((h) => (
        <li key={h.id}><strong>{ACTION[h.action] ?? h.action}</strong> · v{h.version} · {new Date(h.at).toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })} · {h.actor ?? '—'}
          {h.reason && <div className="small">Motif : {h.reason}</div>}
          {h.changes?.length > 0 && <ul className="small">{h.changes.map((c: any, i: number) => <li key={i}>{c.label} : {fmtVal(c.field, c.from, tz)} → {fmtVal(c.field, c.to, tz)}</li>)}</ul>}
          {h.rules?.length > 0 && <div className="small" style={{ color: 'var(--warn)' }}>Règles dérogées : {h.rules.map((r: any) => r.message).join(' ; ')}</div>}
        </li>
      ))}
    </ol>
  );
}
const fmtVal = (field: string, v: any, tz: string) => v == null || v === '' ? '—' : ['starts_at', 'ends_at'].includes(field) ? new Date(v).toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })
  : field === 'status' ? STATUS[v]?.label ?? v : field === 'modality' ? MODALITY[v] ?? v : String(v);
export const frDate = (s: string) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s; };
