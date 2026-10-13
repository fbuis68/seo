import { useEffect, useState } from 'react';
import { api, download, post } from '../api';
import { useAction, useFetch } from '../hooks';
import { HistoryList, HmInput, Issues } from './SlotPanel';
import { STATUS, at, fmtH, parts } from './lib';
import { Help } from '../help';

const fmtDT = (d: string, tz: string) => new Date(d).toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
const RULES: Record<string, string> = {
  trainer_overlap: 'Formateur déjà réservé', resource_overlap: 'Ressource déjà réservée', learner_overlap: 'Stagiaire déjà attendu', setup_time: 'Temps de préparation',
  travel_time: 'Temps de déplacement', unavailable: 'Indisponibilité', outside_hours: 'Hors ouverture', closure: 'Fermeture', capacity: 'Capacité', breaks: 'Pauses',
  inactive_trainer: 'Formateur inactif', inactive_resource: 'Ressource désactivée', skill: 'Compétence', equipment_required: 'Équipement requis', site_not_allowed: 'Site non autorisé',
  inspection_overdue: 'Vérification périodique', enrollment_dates: 'Dates d’inscription', missing_trainer: 'Formateur manquant', missing_video: 'Lien visio manquant', missing_place: 'Lieu manquant',
  participant_to_resolve: 'Participants à résoudre', min_participants: 'Effectif minimum', trainer_load: 'Charge formateur', trainer_hours: 'Hors horaires habituels',
  unusual_hours: 'Horaires inhabituels', short_notice: 'Délai court', target_duration: 'Durée cible',
};

/** Liste des conflits à résoudre sur la période affichée (mêmes règles que l'enregistrement). */
export function ConflictsTab({ from, to, label, tz, onOpen }: { from: string; to: string; label: string; tz: string; onOpen: (slotId: string) => void }) {
  const c = useFetch<any>(`/api/v1/planning/conflicts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, [from, to]);
  if (c.error) return <p className="alert">{c.error.message}</p>;
  if (!c.data) return <p className="muted">Contrôle de la période…</p>;
  const row = (i: any, k: number) => (
    <tr key={k}><td><span className={`pill ${i.severity === 'blocking' ? 'err' : 'warn'}`}>{i.severity === 'blocking' ? 'Bloquant' : 'Alerte'}</span></td><td>{RULES[i.rule] ?? i.rule}</td>
      <td>{i.message}</td><td><button className="linklike" onClick={() => onOpen(i.slotId)}>{i.slot?.title} · {i.slot && fmtDT(i.slot.startsAt, tz)}</button>
        {i.other && <div className="small muted">avec <button className="linklike small" onClick={() => onOpen(i.other.slotId)}>{i.other.sessionTitle} · {fmtDT(i.other.startsAt, tz)}</button></div>}</td></tr>
  );
  return (
    <div className="panel">
      <p className="small muted">{label} · {c.data.checked} séance(s) active(s) contrôlée(s), toutes réservations comprises, même hors filtres. <button className="linklike small" onClick={c.reload}>Relancer</button></p>
      <h2>À résoudre ({c.data.blocking.length})</h2>
      {c.data.blocking.length ? <table><tbody>{c.data.blocking.map(row)}</tbody></table> : <p className="success">Aucun conflit bloquant.</p>}
      <h2>Alertes ({c.data.warnings.length})</h2>
      {c.data.warnings.length ? <table><tbody>{c.data.warnings.map(row)}</tbody></table> : <p className="muted small">Aucune alerte.</p>}
      <h2>Dérogations accordées ({c.data.derogations.length})</h2>
      {c.data.derogations.length ? <table><tbody>{c.data.derogations.map((d: any) => <tr key={d.id}><td><button className="linklike" onClick={() => onOpen(d.id)}>{d.session_title} · {fmtDT(d.starts_at, tz)}</button></td>
        <td>{d.derogation.reason}</td><td className="small">{(d.derogation.rules ?? []).map((r: string) => RULES[r] ?? r).join(', ')}</td></tr>)}</tbody></table> : <p className="muted small">Aucune.</p>}
    </div>
  );
}

/** Aperçu avant publication : complétude, conflits et écarts ; publication des séances retenues. */
export function PublishTab({ from, to, label, tz, perms, onOpen, onChange }: { from: string; to: string; label: string; tz: string; perms: any; onOpen: (id: string) => void; onChange: () => void }) {
  const list = useFetch<any>(`/api/v1/planning/slots?status=draft,pending&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, [from, to]);
  const [sel, setSel] = useState<string[]>([]);
  const [report, setReport] = useState<any>(null);
  const act = useAction();
  useEffect(() => { setSel([]); setReport(null); }, [from, to]);
  const items = list.data?.items ?? [];
  const blockedIds = new Set<string>((report?.report ?? []).filter((r: any) => r.blocking?.length).map((r: any) => r.slotId));
  const canPublish = perms.publish || perms.directPublish;
  const run = (status: string, dry: boolean) => act.run(() => post('/api/v1/planning/transition', { slotIds: sel, status, preview: dry }), (r: any) => {
    if (dry) setReport(r); else { setReport(null); setSel([]); list.reload(); onChange(); }
  });
  return (
    <div className="panel">
      <p className="small muted">{label} · séances en brouillon ou à valider. Le contrôle de publication exige formateur, lieu ou lien visio, durée positive et aucun conflit bloquant.
        {!perms.publish && perms.directPublish ? ' Publication directe autorisée par les paramètres du centre.' : ''}{!canPublish ? ' Vous pouvez demander la validation ; la publication revient au responsable.' : ''}</p>
      {!items.length && <p className="muted">Rien à publier sur la période.</p>}
      {!!items.length && <table>
        <thead><tr><th><input type="checkbox" aria-label="Tout sélectionner" checked={sel.length === items.length} onChange={(e) => setSel(e.target.checked ? items.map((x: any) => x.id) : [])} /></th><th>Séance</th><th>Formateur(s)</th><th>Lieu</th><th>Statut</th><th>Contrôle</th></tr></thead>
        <tbody>{items.map((s: any) => (
          <tr key={s.id}><td><input type="checkbox" aria-label={`Sélectionner ${s.session_title}`} checked={sel.includes(s.id)} onChange={(e) => { setReport(null); setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id)); }} /></td>
            <td><button className="linklike" onClick={() => onOpen(s.id)}>{s.title || s.session_title}</button><div className="small muted">{fmtDT(s.starts_at, tz)} · {fmtH(s.pedagogical_minutes)}</div></td>
            <td className="small">{s.trainers.map((t: any) => t.name).join(', ') || <span className="pill warn">aucun</span>}</td>
            <td className="small">{s.modality === 'remote' ? 'Distanciel' : s.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', ') || <span className="pill warn">aucun</span>}</td>
            <td><span className={`pill st-${s.status}`}>{STATUS[s.status].label}</span></td>
            <td>{report && sel.includes(s.id) && (blockedIds.has(s.id) ? <span className="pill err">bloquée</span> : <span className="pill ok">prête</span>)}</td></tr>))}</tbody>
      </table>}
      {sel.length > 0 && <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="btn ghost sm" onClick={() => run('published', true)}>Contrôler la publication</button>
        {canPublish ? <button className="btn sm" disabled={!report?.ok} onClick={() => run('published', false)}>Publier {sel.length} séance(s)</button>
          : <button className="btn sm" onClick={() => run('pending', false)}>Demander la validation</button>}
      </div>}
      {report && <Issues report={report.report} />}
      {act.error && <p className="alert">{act.error}</p>}
    </div>
  );
}

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
/** Horaires hebdomadaires (ouverture de salle, horaires habituels formateur) : une plage par jour. */
export function WeeklyEditor({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? {};
  return (
    <table className="small"><tbody>{DAYS.map((d, i) => {
      const k = String(i + 1); const r = v[k]?.[0];
      return <tr key={k}><td>{d}</td><td><label className="row"><input type="checkbox" checked={!!r} onChange={(e) => onChange({ ...v, [k]: e.target.checked ? [['08:30', '17:30']] : [] })} />ouvert</label></td>
        <td>{r && <><HmInput label={`${d} début`} value={r[0]} onChange={(x) => onChange({ ...v, [k]: [[x, r[1]]] })} /> – <HmInput label={`${d} fin`} value={r[1]} onChange={(x) => onChange({ ...v, [k]: [[r[0], x]] })} /></>}</td></tr>;
    })}</tbody></table>
  );
}

/** Disponibilités : périodes datées (prioritaires), profil formateur (horaires habituels, sites, charge, déplacement). */
export function AvailabilityTab({ lookups, tz, perms }: { lookups: any; tz: string; perms: any }) {
  const [owner, setOwner] = useState<{ type: 'person' | 'resource'; id: string }>({ type: 'person', id: lookups.trainers[0]?.id ?? '' });
  const list = useFetch<any[]>(`/api/v1/planning/availabilities${owner.id ? `?ownerId=${owner.id}` : ''}`, [owner.id]);
  const pending = useFetch<any[]>(perms.write ? '/api/v1/planning/availabilities?status=pending' : null);
  const act = useAction();
  const [f, setF] = useState({ kind: 'unavailable', startDate: '', startTime: '00:00', endDate: '', endTime: '23:59', reason: '' });
  const [impacted, setImpacted] = useState<any[] | null>(null);
  const profile = useFetch<any>(owner.type === 'person' && owner.id ? `/api/v1/planning/trainers/${owner.id}/profile` : null, [owner.id]);
  const [pf, setPf] = useState<any>(null);
  useEffect(() => { if (profile.data) setPf({ ...profile.data, skills: (profile.data.skills ?? []).join(', '), maxWeeklyHours: profile.data.max_weekly_minutes ? String(profile.data.max_weekly_minutes / 60) : '' }); }, [profile.data]);
  const ownerName = owner.type === 'person' ? lookups.trainers.find((t: any) => t.id === owner.id)?.name : lookups.resources.find((r: any) => r.id === owner.id)?.name;
  const sites = lookups.resources.filter((r: any) => r.kind === 'site');
  return (
    <div className="grid2">
      <div className="panel">
        <label>Formateur ou ressource<select value={`${owner.type}:${owner.id}`} onChange={(e) => { const [type, id] = e.target.value.split(':'); setOwner({ type: type as any, id }); setImpacted(null); }}>
          <optgroup label="Formateurs">{lookups.trainers.map((t: any) => <option key={t.id} value={`person:${t.id}`}>{t.name}</option>)}</optgroup>
          <optgroup label="Salles, matériel, lieux">{lookups.resources.map((r: any) => <option key={r.id} value={`resource:${r.id}`}>{r.name}</option>)}</optgroup></select></label>
        <h2>Périodes de {ownerName ?? '—'} <Help k="planning.disponibilites" /></h2>
        <table><tbody>{(list.data ?? []).map((a) => (
          <tr key={a.id}><td><span className={`pill ${a.kind === 'unavailable' ? 'err' : 'ok'}`}>{a.kind === 'unavailable' ? 'Indisponible' : 'Disponible (exception)'}</span></td>
            <td className="small">{fmtDT(a.starts_at, tz)} → {fmtDT(a.ends_at, tz)}</td><td className="small">{a.reason}</td>
            <td><span className={`pill ${a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warn' : 'err'}`}>{({ approved: 'validée', pending: 'à valider', rejected: 'refusée' } as any)[a.status]}</span></td>
            <td>{perms.write && <button className="btn ghost sm" onClick={() => act.run(() => api('DELETE', `/api/v1/planning/availabilities/${a.id}`), list.reload)}>Supprimer</button>}</td></tr>))}
          {!list.data?.length && <tr><td className="muted small">Aucune période.</td></tr>}</tbody></table>
        {owner.id && <form className="pl-form" onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/planning/availabilities', {
          ownerType: owner.type, ownerId: owner.id, kind: f.kind, startsAt: at(f.startDate, f.startTime, tz), endsAt: at(f.endDate || f.startDate, f.endTime, tz), reason: f.reason || null,
        }), (r: any) => { setImpacted(r.impacted ?? []); list.reload(); pending.reload(); }); }}>
          <strong className="small">Ajouter une période</strong>
          <div className="pl-row">
            <label>Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="unavailable">Indisponibilité (congé, maintenance…)</option><option value="available">Disponibilité exceptionnelle</option></select></label>
            <label>Motif<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Congé, maintenance…" /></label>
          </div>
          <div className="pl-row">
            <label>Du<input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label><label>à<HmInput value={f.startTime} onChange={(v) => setF({ ...f, startTime: v })} /></label>
            <label>Au<input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label><label>à<HmInput value={f.endTime} onChange={(v) => setF({ ...f, endTime: v })} /></label>
          </div>
          <div><button className="btn sm">Enregistrer</button> <span className="small muted">{perms.write ? 'Validée immédiatement.' : 'Soumise à validation du responsable.'}</span></div>
        </form>}
        {impacted && impacted.length > 0 && <div className="banner warn small"><strong>{impacted.length} séance(s) concernée(s)</strong>, à réaffecter ou déplacer :
          <ul>{impacted.map((s) => <li key={s.id}>{s.session_title} · {fmtDT(s.starts_at, tz)}</li>)}</ul></div>}
        {act.error && <p className="alert">{act.error}</p>}
        {perms.write && (pending.data?.length ?? 0) > 0 && <>
          <h2>Demandes à valider</h2>
          <table><tbody>{pending.data!.map((a) => <tr key={a.id}><td>{a.owner_name}</td><td className="small">{fmtDT(a.starts_at, tz)} → {fmtDT(a.ends_at, tz)}</td><td className="small">{a.reason}</td>
            <td><button className="btn sm" onClick={() => act.run(() => post(`/api/v1/planning/availabilities/${a.id}/decision`, { status: 'approved' }), (r: any) => { setImpacted(r.impacted); pending.reload(); list.reload(); })}>Valider</button>{' '}
              <button className="btn ghost sm" onClick={() => act.run(() => post(`/api/v1/planning/availabilities/${a.id}/decision`, { status: 'rejected' }), () => pending.reload())}>Refuser</button></td></tr>)}</tbody></table>
        </>}
      </div>
      {owner.type === 'person' && pf && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Profil formateur <Help k="planning.profil" /></h2>
          <form className="pl-form" onSubmit={(e) => { e.preventDefault(); act.run(() => api('PUT', `/api/v1/planning/trainers/${owner.id}/profile`, {
            status: pf.status, active: pf.active, travelMinutes: Number(pf.travel_minutes) || 0, maxWeeklyMinutes: pf.maxWeeklyHours ? Math.round(Number(pf.maxWeeklyHours.replace(',', '.')) * 60) : null,
            allowedSiteIds: pf.allowed_site_ids, workingHours: pf.working_hours && Object.values(pf.working_hours).some((x: any) => x?.length) ? pf.working_hours : null,
            skills: pf.skills.split(',').map((s: string) => s.trim()).filter(Boolean),
          }), () => profile.reload()); }}>
            <fieldset disabled={!perms.write} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              <div className="pl-row">
                <label>Statut<select value={pf.status} onChange={(e) => setPf({ ...pf, status: e.target.value })}><option value="internal">Interne</option><option value="external">Externe</option></select></label>
                <label className="row"><input type="checkbox" checked={pf.active} onChange={(e) => setPf({ ...pf, active: e.target.checked })} />Actif</label>
                <label>Déplacement (min)<input type="number" min={0} value={pf.travel_minutes} onChange={(e) => setPf({ ...pf, travel_minutes: e.target.value })} style={{ width: 90 }} /></label>
                <label>Charge max. / semaine (h)<input value={pf.maxWeeklyHours} onChange={(e) => setPf({ ...pf, maxWeeklyHours: e.target.value })} style={{ width: 80 }} /></label>
              </div>
              <label>Compétences (séparées par des virgules)<input value={pf.skills} onChange={(e) => setPf({ ...pf, skills: e.target.value })} placeholder="CACES R489, SST" /></label>
              {sites.length > 0 && <fieldset className="pl-fs"><legend>Sites autorisés (aucun coché = tous)</legend>{sites.map((s: any) => <label key={s.id} className="row"><input type="checkbox" checked={pf.allowed_site_ids.includes(s.id)}
                onChange={(e) => setPf({ ...pf, allowed_site_ids: e.target.checked ? [...pf.allowed_site_ids, s.id] : pf.allowed_site_ids.filter((x: string) => x !== s.id) })} />{s.name}</label>)}</fieldset>}
              <strong className="small">Horaires habituels</strong>
              <WeeklyEditor value={pf.working_hours} onChange={(v) => setPf({ ...pf, working_hours: v })} />
              {perms.write && <div><button className="btn sm">Enregistrer le profil</button></div>}
            </fieldset>
          </form>
        </div>
      )}
    </div>
  );
}

export function ClosuresTab({ lookups, perms }: { lookups: any; perms: any }) {
  const list = useFetch<any[]>('/api/v1/planning/closures');
  const act = useAction();
  const [f, setF] = useState({ siteId: '', startsOn: '', endsOn: '', label: '' });
  const [impacted, setImpacted] = useState<any[] | null>(null);
  return (
    <div className="panel">
      <p className="small muted">Jours fériés, fermetures du centre ou d’un site. Les séances concernées sont signalées : report explicite par le planificateur, jamais automatique.</p>
      <table><tbody>{(list.data ?? []).map((c) => <tr key={c.id}><td>{c.label}</td><td>{c.starts_on.split('-').reverse().join('/')}{c.ends_on !== c.starts_on ? ` → ${c.ends_on.split('-').reverse().join('/')}` : ''}</td><td>{c.site_name ?? 'Tout le centre'}</td>
        <td>{perms.write && <button className="btn ghost sm" onClick={() => act.run(() => api('DELETE', `/api/v1/planning/closures/${c.id}`), list.reload)}>Supprimer</button>}</td></tr>)}
        {!list.data?.length && <tr><td className="muted small">Aucune fermeture.</td></tr>}</tbody></table>
      {perms.write && <form className="inline" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); act.run(() => post('/api/v1/planning/closures', { ...f, siteId: f.siteId || null, endsOn: f.endsOn || f.startsOn }), (r: any) => { setImpacted(r.impacted); list.reload(); setF({ ...f, label: '', startsOn: '', endsOn: '' }); }); }}>
        <label>Libellé<input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Lundi de Pâques" /></label>
        <label>Du<input type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></label>
        <label>Au<input type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /></label>
        <label>Site<select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}><option value="">Tout le centre</option>{lookups.resources.filter((r: any) => r.kind === 'site').map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <button className="btn sm">Ajouter</button>
      </form>}
      {impacted && <p className={impacted.length ? 'banner warn small' : 'small success'}>{impacted.length ? `${impacted.length} séance(s) tombent sur cette fermeture : à déplacer ou annuler.` : 'Aucune séance concernée.'}</p>}
      {act.error && <p className="alert">{act.error}</p>}
    </div>
  );
}

const pct = (v: number | null) => v == null ? '—' : `${v.toLocaleString('fr-FR')} %`;
export function IndicatorsTab({ from, to, label }: { from: string; to: string; label: string }) {
  const d = useFetch<any>(`/api/v1/planning/indicators?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, [from, to]);
  if (d.error) return <p className="alert">{d.error.message}</p>;
  if (!d.data) return <p className="muted">Calcul…</p>;
  const x = d.data;
  return (
    <>
      <p className="small muted">{label} · {x.note}</p>
      <div className="cards">
        <div className="panel card"><div className="label">Heures pédagogiques planifiées</div><div className="value">{fmtH(x.planned_minutes)}</div></div>
        <div className="panel card"><div className="label">dont réalisées</div><div className="value">{fmtH(x.done_minutes)}</div></div>
        <div className="panel card"><div className="label">Séances sans formateur</div><div className="value">{x.without_trainer}</div></div>
        <div className="panel card"><div className="label">Séances incomplètes</div><div className="value">{x.incomplete}</div></div>
      </div>
      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="panel"><strong>Charge formateur</strong> <Help k="planning.indicateurs" />
          <table><thead><tr><th>Formateur</th><th className="num">Prévu</th><th className="num">Réalisé</th><th className="num">Disponible</th><th className="num">Charge</th></tr></thead>
            <tbody>{x.trainers.map((t: any) => <tr key={t.id}><td>{t.name}</td><td className="num">{fmtH(t.planned_minutes)}</td><td className="num">{fmtH(t.done_minutes)}</td><td className="num">{t.available_minutes == null ? '—' : fmtH(t.available_minutes)}</td>
              <td className="num"><span className={t.load > 100 ? 'pill err' : ''}>{pct(t.load)}</span></td></tr>)}</tbody></table></div>
        <div className="panel"><strong>Occupation des salles et du matériel</strong>
          <table><thead><tr><th>Ressource</th><th className="num">Réservé</th><th className="num">Ouverture</th><th className="num">Occupation</th></tr></thead>
            <tbody>{x.rooms.map((r: any) => <tr key={r.id}><td>{r.name}</td><td className="num">{fmtH(r.reserved_minutes)}</td><td className="num">{fmtH(r.open_minutes)}</td><td className="num">{pct(r.occupancy)}</td></tr>)}</tbody></table></div>
      </div>
    </>
  );
}

/** Import CSV / Excel avec aperçu ligne par ligne ; exports CSV, PDF, ICS des filtres courants. */
export function ImportExportTab({ query, label, perms, onChange }: { query: string; label: string; perms: any; onChange: () => void }) {
  const [file, setFile] = useState<{ csv?: string; fileBase64?: string; filename?: string } | null>(null);
  const [partial, setPartial] = useState(false);
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const [groupBy, setGroupBy] = useState('session');
  const pick = async (f: File) => {
    setRes(null);
    if (f.name.toLowerCase().endsWith('.xlsx')) { const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); setFile({ fileBase64: btoa(s), filename: f.name }); }
    else setFile({ csv: await f.text(), filename: f.name });
  };
  const run = (preview: boolean) => act.run(() => post('/api/v1/planning/import', { ...file, partial, preview }).catch((e: any) => { if (e.details?.lines) return { rejectedAll: true, result: { lines: e.details.lines }, message: e.message }; throw e; }),
    (r: any) => { setRes(r); if (!preview && !r.rejectedAll) onChange(); });
  const lines = res?.result?.lines ?? res?.lines;
  return (
    <div className="grid2">
      <div className="panel">
        <strong>Exporter ({label}, filtres appliqués)</strong> <Help k="planning.export" />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="btn ghost sm" onClick={() => download(`/api/v1/planning/export.csv?${query}`, 'planning.csv')}>CSV (Excel)</button>
          <label className="row small">PDF par<select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}><option value="session">session</option><option value="trainer">formateur</option><option value="room">salle</option><option value="group">groupe</option></select></label>
          <button className="btn ghost sm" onClick={() => download(`/api/v1/planning/export.pdf?${query}&groupBy=${groupBy}`, 'planning.pdf')}>PDF</button>
          <button className="btn ghost sm" onClick={() => download(`/api/v1/planning/export.ics?${query}`, 'planning.ics')}>Calendrier (ICS)</button>
        </div>
        <p className="small muted">Colonnes : début, fin, durée, durée pédagogique, session, lieu, salles, matériel, formateurs, modalité, statut. Seuls les champs autorisés sont exportés.</p>
      </div>
      {perms.write && <div className="panel">
        <strong>Importer des séances (CSV ou Excel)</strong> <Help k="planning.import" />
        <p className="small muted">Colonnes reconnues : Session (référence), Date, Début, Fin, Formateurs (email ou « Prénom Nom », séparés par |), Salles, Intitulé, Modalité, Lien. Mêmes contrôles que l’écran ; doublons ignorés.</p>
        <input type="file" accept=".csv,.txt,.xlsx" aria-label="Fichier à importer" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        <label className="row small"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Mode partiel : enregistrer les lignes valides et rejeter les autres (sinon tout ou rien)</label>
        <div className="toolbar"><button className="btn ghost sm" disabled={!file} onClick={() => run(true)}>Aperçu</button><button className="btn sm" disabled={!file} onClick={() => run(false)}>Importer</button></div>
        {res?.rejectedAll && <p className="alert">{res.message}</p>}
        {res && !res.preview && !res.rejectedAll && <p className="success">{res.created} séance(s) créée(s), {res.duplicates} doublon(s) ignoré(s), {res.rejected} ligne(s) rejetée(s).</p>}
        {lines && <table><thead><tr><th>Ligne</th><th>Résultat</th><th>Détail</th></tr></thead><tbody>{lines.map((l: any) => (
          <tr key={l.line}><td>{l.line}</td><td><span className={`pill ${l.status === 'ok' ? 'ok' : l.status === 'duplicate' ? '' : 'err'}`}>{({ ok: 'valide', duplicate: 'doublon', error: 'erreur', conflict: 'conflit' } as any)[l.status]}</span></td><td className="small">{l.errors.join(' ; ')}</td></tr>))}</tbody></table>}
        {act.error && <p className="alert">{act.error}</p>}
      </div>}
    </div>
  );
}

export function JournalTab({ lookups, tz }: { lookups: any; tz: string }) {
  const [sessionId, setSessionId] = useState(lookups.sessions[0]?.id ?? '');
  const h = useFetch<any[]>(sessionId ? `/api/v1/planning/history?sessionId=${sessionId}` : null, [sessionId]);
  return (
    <div className="panel">
      <label>Session<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>{lookups.sessions.map((s: any) => <option key={s.id} value={s.id}>{s.title}{s.reference ? ` (${s.reference})` : ''}</option>)}</select></label>
      <p className="small muted">Acteur, date, opération, motif, anciennes et nouvelles valeurs ; règles dérogées.</p>
      {h.data ? <HistoryList rows={h.data.map((x) => ({ ...x, actor: `${x.actor ?? '—'} · ${x.title ?? ''} ${x.starts_at ? new Date(x.starts_at).toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : ''}` }))} tz={tz} /> : <p className="muted">Chargement…</p>}
    </div>
  );
}

export function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const s = useFetch<any>('/api/v1/planning/settings');
  const [f, setF] = useState<any>(null);
  const act = useAction();
  useEffect(() => { if (s.data) setF(s.data); }, [s.data]);
  if (!f) return <p className="muted">Chargement…</p>;
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <form className="panel pl-form" onSubmit={(e) => { e.preventDefault(); act.run(() => api('PUT', '/api/v1/planning/settings', {
      grid_step: Number(f.grid_step), day_start: f.day_start, day_end: f.day_end, workdays: f.workdays, direct_publish: f.direct_publish, overlap_derogable: f.overlap_derogable,
      max_daily_minutes: f.max_daily_minutes, default_weekly_minutes: f.default_weekly_minutes, short_notice_hours: f.short_notice_hours, unusual_before: f.unusual_before, unusual_after: f.unusual_after,
    }), () => { s.reload(); onSaved(); }); }}>
      <div className="pl-row">
        <label>Pas de la grille<select value={f.grid_step} onChange={(e) => setF({ ...f, grid_step: Number(e.target.value) })}>{[5, 10, 15, 30, 60].map((x) => <option key={x} value={x}>{x} min</option>)}</select></label>
        <label>Plage visible de<HmInput value={f.day_start} onChange={(v) => setF({ ...f, day_start: v })} /></label>
        <label>à<HmInput value={f.day_end} onChange={(v) => setF({ ...f, day_end: v })} /></label>
      </div>
      <fieldset className="pl-fs"><legend>Jours ouvrés affichés</legend>{DAYS.map((d, i) => <label key={d} className="row"><input type="checkbox" checked={f.workdays.includes(i + 1)} onChange={(e) => setF({ ...f, workdays: e.target.checked ? [...f.workdays, i + 1].sort() : f.workdays.filter((x: number) => x !== i + 1) })} />{d}</label>)}</fieldset>
      <label className="row"><input type="checkbox" checked={f.direct_publish} onChange={(e) => setF({ ...f, direct_publish: e.target.checked })} />Publication directe par le planificateur (petits centres)</label>
      <label className="row"><input type="checkbox" checked={f.overlap_derogable} onChange={(e) => setF({ ...f, overlap_derogable: e.target.checked })} />Double réservation dérogeable par un responsable (déconseillé)</label>
      <div className="pl-row">
        <label>Charge max. / jour (min)<input type="number" value={f.max_daily_minutes} onChange={num('max_daily_minutes')} /></label>
        <label>Base hebdo. sans horaires (min)<input type="number" value={f.default_weekly_minutes} onChange={num('default_weekly_minutes')} /></label>
        <label>Délai court (h)<input type="number" value={f.short_notice_hours} onChange={num('short_notice_hours')} /></label>
      </div>
      <div className="pl-row">
        <label>Horaire inhabituel avant<HmInput value={f.unusual_before} onChange={(v) => setF({ ...f, unusual_before: v })} /></label>
        <label>ou après<HmInput value={f.unusual_after} onChange={(v) => setF({ ...f, unusual_after: v })} /></label>
      </div>
      <div><button className="btn">Enregistrer</button></div>
      {act.error && <p className="alert">{act.error}</p>}
    </form>
  );
}

/** Planning personnel publié (formateur ou stagiaire), consultable sur mobile, export ICS. */
export function MyPlanning({ tz }: { tz: string }) {
  const [week, setWeek] = useState(() => { const d = parts(new Date(), tz).date; return d; });
  const from = at(week, '00:00', tz); const to = at(addDaysLocal(week, 28), '00:00', tz);
  const d = useFetch<any>(`/api/v1/planning/me?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, [from, to]);
  return (
    <>
      <h1>Mon planning <Help k="planning.mon-planning" /></h1>
      <div className="toolbar">
        <button className="btn ghost sm" onClick={() => setWeek(addDaysLocal(week, -28))}>‹ 4 semaines</button>
        <button className="btn ghost sm" onClick={() => setWeek(parts(new Date(), tz).date)}>Aujourd’hui</button>
        <button className="btn ghost sm" onClick={() => setWeek(addDaysLocal(week, 28))}>4 semaines ›</button>
        <button className="btn ghost sm" onClick={() => download(`/api/v1/planning/me.ics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, 'mon-planning.ics')}>Ajouter à mon agenda (ICS)</button>
      </div>
      {d.error && <p className="alert">{d.error.message}</p>}
      {d.data && <>
        {!d.data.items.length && <p className="muted">Aucune séance publiée sur ces 4 semaines.</p>}
        <div className="pl-list">{d.data.items.map((s: any) => (
          <div key={s.id} className={`panel pl-me st-${s.status}`}>
            <div><strong>{new Date(s.starts_at).toLocaleDateString('fr-FR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' })}</strong> · {parts(s.starts_at, tz).hm}–{parts(s.ends_at, tz).hm}
              {s.status === 'cancelled' && <span className="pill err"> Annulée{s.cancel_reason ? ` : ${s.cancel_reason}` : ''}</span>}</div>
            <div>{s.title || s.part_title || s.session_title}{s.title || s.part_title ? <span className="muted"> · {s.session_title}</span> : null}</div>
            <div className="small muted">{s.modality === 'remote' ? 'À distance' : s.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name + (r.address ? ` (${r.address})` : '')).join(', ') || 'Lieu à confirmer'}
              {s.trainers.length ? ` · ${s.trainers.map((t: any) => t.name).join(', ')}` : ''}{d.data.role === 'trainer' ? ` · ${s.expected_onsite + s.expected_remote} participant(s)` : ''}</div>
            {s.video_url && s.status !== 'cancelled' && (s.modality !== 'onsite') && <a href={s.video_url} target="_blank" rel="noreferrer">Rejoindre la visioconférence</a>}
          </div>))}</div>
        {d.data.changes.length > 0 && <><h2>Derniers changements <Help k="planning.notifications" /></h2><ul className="small">{d.data.changes.map((c: any) => <li key={c.id}>{new Date(c.created_at).toLocaleDateString('fr-FR')} · {c.summary}</li>)}</ul></>}
      </>}
      {d.data?.role === 'trainer' && <TrainerAvailability tz={tz} personId={d.data.personId} />}
    </>
  );
}
const addDaysLocal = (date: string, n: number) => { const [y, m, dd] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };

/** Formateur : demande d'indisponibilité soumise à validation. */
function TrainerAvailability({ tz, personId }: { tz: string; personId: string }) {
  const list = useFetch<any[]>('/api/v1/planning/availabilities');
  const act = useAction();
  const [f, setF] = useState({ startDate: '', endDate: '', reason: '' });
  return (
    <>
      <h2>Mes indisponibilités <Help k="planning.disponibilites" /></h2>
      <table><tbody>{(list.data ?? []).map((a) => <tr key={a.id}><td className="small">{fmtDT(a.starts_at, tz)} → {fmtDT(a.ends_at, tz)}</td><td className="small">{a.reason}</td>
        <td><span className={`pill ${a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warn' : 'err'}`}>{({ approved: 'validée', pending: 'en attente', rejected: 'refusée' } as any)[a.status]}</span></td></tr>)}</tbody></table>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); act.run(async () => {
        return post('/api/v1/planning/availabilities', { ownerType: 'person', ownerId: personId, kind: 'unavailable', startsAt: at(f.startDate, '00:00', tz), endsAt: at(addDaysLocal(f.endDate || f.startDate, 1), '00:00', tz), reason: f.reason || null });
      }, () => { list.reload(); setF({ startDate: '', endDate: '', reason: '' }); }); }}>
        <label>Du<input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></label>
        <label>Au<input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        <label>Motif<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Congé" /></label>
        <button className="btn sm">Demander</button>
      </form>
      <p className="small muted">Soumis à validation du responsable de planning.</p>
      {act.error && <p className="alert">{act.error}</p>}
    </>
  );
}
