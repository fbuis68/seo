import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, get, post } from '../api';
import { can, useApp } from '../context';
import { useFetch } from '../hooks';
import { ColorBy, GROUP_LABEL, GroupBy, MODALITY, STATUS, View, Zoom, addDays, at, daysBetween, dayLabel, fmtH, legendOf, loadPrefs, longDay, monthLabel, parts, rangeOf, savePrefs, step, today } from '../planning/lib';
import SlotPanel, { DerogationBox, Draft, Issues } from '../planning/SlotPanel';
import { AvailabilityTab, ClosuresTab, ConflictsTab, ImportExportTab, IndicatorsTab, JournalTab, PublishTab, SettingsTab } from '../planning/tabs';
import { GroupedGrid, ListView, MonthView, TimeGrid, Timeline, describe } from '../planning/views';
import { Help } from '../help';

const KEY = 'tms.planning.prefs';
interface Filters { q: string; siteId: string; programId: string; sessionId: string; groupLabel: string; modality: string; status: string; trainerId: string; resourceId: string; learnerId: string; incomplete: boolean }
const NO_FILTERS: Filters = { q: '', siteId: '', programId: '', sessionId: '', groupLabel: '', modality: '', status: '', trainerId: '', resourceId: '', learnerId: '', incomplete: false };
type Subject = { by: 'all' | GroupBy; id: string };
interface Prefs { view: View; zoom: Zoom; date: string; groupBy: GroupBy; subject: Subject; colorBy: ColorBy; rowHeight: number; allDays: boolean; filters: Filters; favorites: { name: string; filters: Filters; view: View; groupBy: GroupBy; subject?: Subject }[] }

function useNarrow() {
  const q = '(max-width: 760px)';
  const [n, setN] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => setN(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return n;
}

const TAB_HELP: Record<string, string> = { planning: 'planning', conflicts: 'planning.conflits', publish: 'planning.publication', availability: 'planning.disponibilites',
  closures: 'planning.fermetures', indicators: 'planning.indicateurs', import: 'planning.import', journal: 'planning.journal', settings: 'planning.parametres' };
const SUBJECT_LABEL: Record<'all' | GroupBy, string> = { all: 'Tout', trainer: 'Formateurs', session: 'Sessions', room: 'Salles', equipment: 'Matériel', site: 'Sites', group: 'Groupes', learner: 'Stagiaires' };
const ALL_LABEL: Record<GroupBy, string> = { trainer: 'Tous les formateurs', session: 'Toutes les sessions', room: 'Toutes les salles', equipment: 'Tout le matériel', site: 'Tous les sites', group: 'Tous les groupes', learner: 'Tous les stagiaires' };
const SUBJECT_FILTER: Record<GroupBy, keyof Filters> = { trainer: 'trainerId', room: 'resourceId', equipment: 'resourceId', site: 'siteId', session: 'sessionId', group: 'groupLabel', learner: 'learnerId' };
function subjectOptions(by: GroupBy, lk: any): [string, string][] {
  if (by === 'trainer') return lk.trainers.map((t: any) => [t.id, t.name]);
  if (by === 'session') return lk.sessions.map((s: any) => [s.id, s.title + (s.reference ? ` (${s.reference})` : '')]);
  if (by === 'group') return lk.groups.map((g: string) => [g, g]);
  if (by === 'learner') return lk.learners.map((l: any) => [l.id, l.name]);
  return lk.resources.filter((r: any) => r.kind === by).map((r: any) => [r.id, r.name]);
}
const TABS: [string, string, string?][] = [['planning', 'Planning'], ['conflicts', 'Conflits', 'sessions.write'], ['publish', 'Publication', 'sessions.write'], ['availability', 'Disponibilités'],
  ['closures', 'Fermetures'], ['indicators', 'Indicateurs'], ['import', 'Import / export'], ['journal', 'Journal'], ['settings', 'Paramètres', 'org.manage']];

/** Planning principal : sessions, formateurs, salles et stagiaires ; mêmes données et règles sur toutes les vues. */
export default function PlanningPage() {
  const { org } = useApp();
  const tz: string = (org as any).timezone ?? 'Europe/Paris';
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs<Prefs>(KEY, { view: 'week', zoom: 'week', date: today(tz), groupBy: 'trainer', subject: { by: 'all', id: '' }, colorBy: 'session', rowHeight: 46, allDays: false, filters: NO_FILTERS, favorites: [] }));
  useEffect(() => savePrefs(KEY, { ...prefs, date: undefined }), [prefs]);
  const set = (p: Partial<Prefs>) => setPrefs((x) => ({ ...x, ...p }));
  const setFilter = (p: Partial<Filters>) => setPrefs((x) => ({ ...x, filters: { ...x.filters, ...p } }));
  const [tab, setTab] = useState('planning');
  const narrow = useNarrow();
  const view: View = narrow && ['day', 'week', 'month'].includes(prefs.view) ? 'list' : prefs.view;
  const lookups = useFetch<any>('/api/v1/planning/lookups');
  const lk = lookups.data;
  const settings = lk?.settings;
  const r = rangeOf(view, prefs.zoom, prefs.date);
  const visibleDays = useMemo(() => {
    const all = Array.from({ length: r.days }, (_, i) => addDays(r.start, i));
    return view === 'week' && !prefs.allDays && settings ? all.filter((d) => settings.workdays.includes(((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1)) : all;
  }, [r.start, r.days, view, prefs.allDays, settings]);
  const from = at(r.start, '00:00', tz); const to = at(addDays(r.start, r.days), '00:00', tz);
  // « Planning de » : formateur, salle, session… — une ressource précise (filtre) ou toutes (regroupement), dans toutes les vues.
  const subject: Subject = prefs.subject ?? { by: 'all', id: '' };
  const groupBy: GroupBy | null = subject.by === 'all' ? null : subject.by;
  const effectiveFilters = useMemo(() => subject.by !== 'all' && subject.id ? { ...prefs.filters, [SUBJECT_FILTER[subject.by]]: subject.id } : prefs.filters, [prefs.filters, subject.by, subject.id]);
  const query = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    for (const [k, v] of Object.entries(effectiveFilters)) if (v) q.set(k, String(v));
    if (groupBy === 'learner' || (view === 'timeline' && prefs.groupBy === 'learner')) q.set('withLearners', 'true');
    return q.toString();
  }, [from, to, effectiveFilters, view, groupBy, prefs.groupBy]);
  const [data, setData] = useState<{ items: any[]; truncated: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    get(`/api/v1/planning/slots?${query}`).then((d) => { setData(d); setLoadErr(null); }, (e) => setLoadErr(e.message)).finally(() => setLoading(false));
  }, [query]);
  useEffect(load, [load]);
  const unav = useFetch<any[]>(['day', 'timeline'].includes(view) ? `/api/v1/planning/availabilities?status=approved&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null, [from, to, view]);
  const closures = useFetch<any[]>('/api/v1/planning/closures');
  const [panel, setPanel] = useState<{ slotId?: string; draft?: Draft } | null>(null);
  const [proposal, setProposal] = useState<{ s: any; change: any } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const subjectKey = subject.id && ['trainer', 'room', 'equipment', 'site'].includes(subject.by) ? { by: subject.by as GroupBy, id: subject.id } : undefined;
  const perms = { write: can(org, 'sessions.write'), publish: can(org, 'planning.publish'), derogate: can(org, 'planning.derogate'), directPublish: !!settings?.direct_publish && can(org, 'sessions.write') };
  const items = data?.items ?? [];
  const vp = {
    items, tz, colorBy: prefs.colorBy, settings, canWrite: perms.write,
    onOpen: (s: any) => setPanel({ slotId: s.id }),
    onCreate: (startsAt: string, endsAt: string, key?: { by: GroupBy; id: string }) => setPanel({ draft: { startsAt, endsAt, key: key ?? subjectKey, sessionId: effectiveFilters.sessionId || undefined } }),
    onPropose: (s: any, change: any) => setProposal({ s, change }),
  };
  const anchorLabel = view === 'day' || (view === 'timeline' && prefs.zoom === 'day') ? longDay(prefs.date)
    : view === 'month' || (view === 'timeline' && prefs.zoom === 'month') ? monthLabel(prefs.date) : `Semaine du ${dayLabel(r.start)} au ${dayLabel(addDays(r.start, 6))}`;
  const total = items.filter((s) => s.status !== 'cancelled').reduce((a, s) => a + s.pedagogical_minutes, 0);
  const activeFilters = Object.entries(prefs.filters).filter(([, v]) => v).length;

  if (lookups.error) return <p className="alert">{lookups.error.message}</p>;
  if (!lk) return <p className="muted">Chargement du planning…</p>;

  return (
    <div className={`pl-wide${panel ? ' pl-with-panel' : ''}`}>
      <h1>Planning <Help k={TAB_HELP[tab]} /></h1>
      <nav className="pl-tabs" aria-label="Sections du planning">
        {TABS.filter(([, , perm]) => !perm || can(org, perm)).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      {tab === 'planning' && <>
        <div className="pl-toolbar" role="toolbar" aria-label="Navigation du planning">
          <button className="btn ghost sm" onClick={() => set({ date: today(tz) })}>Aujourd’hui</button>
          <button className="btn ghost sm" aria-label="Période précédente" onClick={() => set({ date: step(view, prefs.zoom, prefs.date, -1) })}>‹</button>
          <button className="btn ghost sm" aria-label="Période suivante" onClick={() => set({ date: step(view, prefs.zoom, prefs.date, 1) })}>›</button>
          <input type="date" aria-label="Date" value={prefs.date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
          <strong className="pl-anchor">{anchorLabel}</strong>
          <Help k="planning.vues" />
          <div className="pl-seg" role="group" aria-label="Vue">
            {(['day', 'week', 'month', 'timeline', 'list'] as View[]).map((v) => <button key={v} className={prefs.view === v ? 'active' : ''} aria-pressed={prefs.view === v} onClick={() => set({ view: v })}>{({ day: 'Jour', week: 'Semaine', month: 'Mois', timeline: 'Timeline', list: 'Liste' })[v]}</button>)}
          </div>
          {view === 'timeline' && subject.by === 'all' && <label className="row small">Lignes par<select value={prefs.groupBy} onChange={(e) => set({ groupBy: e.target.value as GroupBy })}>
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}</select></label>}
          {view === 'timeline' && <label className="row small">Zoom<select value={prefs.zoom} onChange={(e) => set({ zoom: e.target.value as Zoom })}><option value="day">jour (heures)</option><option value="week">semaine (jours)</option><option value="month">mois (jours)</option></select></label>}
          {view === 'week' && <label className="row small"><input type="checkbox" checked={prefs.allDays} onChange={(e) => set({ allDays: e.target.checked })} />7 jours</label>}
          {perms.write && <button className="btn sm" onClick={() => setPanel({ draft: { startsAt: at(prefs.date, '09:00', tz), endsAt: at(prefs.date, '12:00', tz), key: subjectKey, sessionId: effectiveFilters.sessionId || undefined } })}>Nouvelle séance</button>}
        </div>
        <div className="pl-toolbar pl-subject" role="group" aria-label="Planning de">
          <strong className="small">Planning :</strong>
          <div className="pl-seg">
            {(['all', 'trainer', 'session', 'room', 'equipment', 'site', 'group', 'learner'] as const).map((b) => (
              <button key={b} className={subject.by === b ? 'active' : ''} aria-pressed={subject.by === b} onClick={() => set({ subject: { by: b, id: '' } })}>{SUBJECT_LABEL[b]}</button>))}
          </div>
          {subject.by !== 'all' && <select aria-label={`Choisir : ${SUBJECT_LABEL[subject.by]}`} value={subject.id} onChange={(e) => set({ subject: { ...subject, id: e.target.value } })}>
            <option value="">{ALL_LABEL[subject.by]} (une ligne par {GROUP_LABEL[subject.by].toLowerCase()})</option>
            {subjectOptions(subject.by, lk).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>}
          <Help k="planning.vues" label="planning par formateur, salle, session…" />
        </div>
        <details className="pl-filters" open={activeFilters > 0}>
          <summary>Filtres et affichage{activeFilters ? ` (${activeFilters} actif${activeFilters > 1 ? 's' : ''})` : ''} <Help k="planning.filtres" /></summary>
          <div className="pl-toolbar">
            <input type="search" aria-label="Rechercher" placeholder="Intitulé, référence, formateur, salle, stagiaire…" value={prefs.filters.q} onChange={(e) => setFilter({ q: e.target.value })} style={{ minWidth: 260 }} />
            <Sel label="Site" value={prefs.filters.siteId} onChange={(v) => setFilter({ siteId: v })} options={lk.resources.filter((x: any) => x.kind === 'site').map((x: any) => [x.id, x.name])} />
            <Sel label="Formation" value={prefs.filters.programId} onChange={(v) => setFilter({ programId: v })} options={[...new Map(lk.sessions.map((s: any) => [s.program_id, s.program_title])).entries()] as any} />
            <Sel label="Session" value={prefs.filters.sessionId} onChange={(v) => setFilter({ sessionId: v })} options={lk.sessions.map((s: any) => [s.id, s.title + (s.reference ? ` (${s.reference})` : '')])} />
            <Sel label="Groupe" value={prefs.filters.groupLabel} onChange={(v) => setFilter({ groupLabel: v })} options={lk.groups.map((g: string) => [g, g])} />
            <Sel label="Modalité" value={prefs.filters.modality} onChange={(v) => setFilter({ modality: v })} options={Object.entries(MODALITY)} />
            <Sel label="Statut" value={prefs.filters.status} onChange={(v) => setFilter({ status: v })} options={Object.entries(STATUS).map(([k, v]) => [k, v.label])} />
            <Sel label="Formateur" value={prefs.filters.trainerId} onChange={(v) => setFilter({ trainerId: v })} options={lk.trainers.map((t: any) => [t.id, t.name])} />
            <Sel label="Salle / matériel" value={prefs.filters.resourceId} onChange={(v) => setFilter({ resourceId: v })} options={lk.resources.filter((x: any) => x.kind !== 'site').map((x: any) => [x.id, x.name])} />
            <Sel label="Stagiaire" value={prefs.filters.learnerId} onChange={(v) => setFilter({ learnerId: v })} options={lk.learners.map((x: any) => [x.id, x.name])} />
            <label className="row small"><input type="checkbox" checked={prefs.filters.incomplete} onChange={(e) => setFilter({ incomplete: e.target.checked })} />Séances incomplètes</label>
            {activeFilters > 0 && <button className="btn ghost sm" onClick={() => set({ filters: NO_FILTERS })}>Effacer</button>}
          </div>
          <div className="pl-toolbar">
            <label className="row small">Couleur par<select value={prefs.colorBy} onChange={(e) => set({ colorBy: e.target.value as ColorBy })}><option value="session">session</option><option value="program">formation</option><option value="status">statut</option></select></label>
            {view === 'timeline' && <label className="row small">Hauteur de ligne<input type="range" min={34} max={80} value={prefs.rowHeight} onChange={(e) => set({ rowHeight: Number(e.target.value) })} /></label>}
            <span className="small muted">Vues favorites :</span>
            {prefs.favorites.map((fv, i) => <span key={i} className="pl-fav"><button className="linklike small" onClick={() => set({ filters: fv.filters, view: fv.view, groupBy: fv.groupBy, subject: (fv as any).subject ?? { by: 'all', id: '' } })}>{fv.name}</button>
              <button className="linklike small" aria-label={`Supprimer la vue ${fv.name}`} onClick={() => set({ favorites: prefs.favorites.filter((_, j) => j !== i) })}>×</button></span>)}
            <button className="btn ghost sm" onClick={() => { const name = prompt('Nom de la vue favorite :'); if (name) set({ favorites: [...prefs.favorites, { name, filters: prefs.filters, view: prefs.view, groupBy: prefs.groupBy, subject }] }); }}>Enregistrer cette vue</button>
          </div>
        </details>
        <div className="legend pl-legend" aria-label="Légende">
          <Help k="planning.legende" label="légende" />
          {legendOf(items, prefs.colorBy).slice(0, 14).map(([l, c]) => <span key={l}><i style={{ background: c }} />{l}</span>)}
          <span className="muted">{Object.values(STATUS).map((s) => `${s.mark} ${s.label}`).join('  ')} · ⚠ incomplète · hachures = pause / indisponibilité</span>
        </div>
        <p className="small muted" aria-live="polite">{loading ? 'Chargement…' : `${items.length} séance(s) · ${fmtH(total)} pédagogiques`}{data?.truncated ? ' · affichage tronqué : affiner les filtres' : ''}
          {narrow && prefs.view !== view ? ' · vue liste sur mobile' : ''}{perms.write && view !== 'list' ? ' · double-clic sur un créneau libre pour créer ; glisser pour déplacer, bord bas pour redimensionner' : ''}{perms.write && view !== 'list' && <Help k="planning.glisser" />}</p>
        {loadErr && <p className="alert">{loadErr}</p>}
        {view === 'list' && selected.length > 0 && <BulkBar ids={selected} lookups={lk} perms={perms} onDone={() => { setSelected([]); load(); }} />}
        <div className="pl-view">
          {view === 'day' && settings && <TimeGrid {...vp} days={[prefs.date]} groupBy={groupBy && !subject.id ? groupBy : undefined} lookups={lk} unavailable={unav.data ?? []} closures={closures.data ?? []} />}
          {view === 'week' && settings && (groupBy && !subject.id
            ? <GroupedGrid {...vp} days={visibleDays} groupBy={groupBy} lookups={lk} closures={closures.data ?? []} onPick={(d, id) => set({ date: d, view: 'day', subject: { by: groupBy, id: id === '__none' ? '' : id } })} />
            : <TimeGrid {...vp} days={visibleDays} lookups={lk} unavailable={unav.data ?? []} closures={closures.data ?? []} />)}
          {view === 'month' && groupBy && !subject.id && <GroupedGrid {...vp} compact days={Array.from({ length: daysBetween(`${prefs.date.slice(0, 8)}01`, addDays(`${prefs.date.slice(0, 8)}01`, 32).slice(0, 8) + '01') }, (_, i) => addDays(`${prefs.date.slice(0, 8)}01`, i))}
            groupBy={groupBy} lookups={lk} closures={closures.data ?? []} onPick={(d, id) => set({ date: d, view: 'day', subject: { by: groupBy, id: id === '__none' ? '' : id } })} />}
          {view === 'month' && !(groupBy && !subject.id) && <MonthView {...vp} start={r.start} days={r.days} month={prefs.date.slice(0, 7)} onDay={(d) => set({ date: d, view: 'day' })} closures={closures.data ?? []} />}
          {view === 'timeline' && settings && <Timeline {...vp} start={r.start} days={r.days} zoom={prefs.zoom} groupBy={groupBy ?? prefs.groupBy} onlyRow={subject.id || undefined} lookups={lk} rowHeight={prefs.rowHeight} unavailable={unav.data ?? []} />}
          {view === 'list' && <ListView {...vp} selected={selected} onSelect={setSelected} groupBy={groupBy && !subject.id ? groupBy : null} lookups={lk} />}
        </div>
      </>}
      {tab === 'conflicts' && <ConflictsTab from={from} to={to} label={anchorLabel} tz={tz} onOpen={(id) => { setTab('planning'); setPanel({ slotId: id }); }} />}
      {tab === 'publish' && <PublishTab from={from} to={to} label={anchorLabel} tz={tz} perms={perms} onOpen={(id) => { setTab('planning'); setPanel({ slotId: id }); }} onChange={load} />}
      {tab === 'availability' && <AvailabilityTab lookups={lk} tz={tz} perms={perms} />}
      {tab === 'closures' && <ClosuresTab lookups={lk} perms={perms} />}
      {tab === 'indicators' && <IndicatorsTab from={from} to={to} label={anchorLabel} />}
      {tab === 'import' && <ImportExportTab query={query} label={anchorLabel} perms={perms} onChange={load} />}
      {tab === 'journal' && <JournalTab lookups={lk} tz={tz} />}
      {tab === 'settings' && <SettingsTab onSaved={lookups.reload} />}

      {panel && <SlotPanel slotId={panel.slotId} draft={panel.draft} lookups={lk} tz={tz} perms={perms} onClose={() => setPanel(null)}
        onSaved={(d) => { load(); if (d && !panel.slotId) set({ date: d }); }} />}
      {proposal && <ChangeDialog p={proposal} tz={tz} derogate={perms.derogate} onClose={(changed) => { setProposal(null); if (changed) load(); }} />}
    </div>
  );
}

function Sel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <label className="row small">{label}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Tous</option>{options.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}

/** Corps de requête d'un changement proposé par glisser-déposer. */
function changeRequest(s: any, change: any) {
  if (change.shiftDays && !change.swap) return { method: 'POST', url: '/api/v1/planning/bulk', body: { slotIds: [s.id], shiftDays: change.shiftDays } };
  const body: any = { version: s.version };
  if (change.startsAt) body.startsAt = change.startsAt;
  if (change.endsAt) body.endsAt = change.endsAt;
  if (change.swap) {
    const { by, from, to } = change.swap;
    if (by === 'trainer') body.trainers = s.trainers.map((t: any) => ({ id: t.id === from ? to : t.id, role: t.role })).filter((t: any, i: number, a: any[]) => a.findIndex((x) => x.id === t.id) === i);
    else body.resourceIds = [...new Set(s.resources.map((r: any) => r.id === from ? to : r.id).concat(from === '__none' ? [to] : []))];
    if (from === '__none' && by === 'trainer') body.trainers = [...s.trainers.map((t: any) => ({ id: t.id, role: t.role })), { id: to, role: 'lead' }];
  }
  if (change.shiftDays) { // Timeline zoom semaine/mois avec changement de ligne
    const dur = +new Date(s.ends_at) - +new Date(s.starts_at);
    body.startsAt = new Date(+new Date(s.starts_at) + change.shiftDays * 86400000).toISOString(); body.endsAt = new Date(+new Date(body.startsAt) + dur).toISOString();
  }
  return { method: 'PATCH', url: `/api/v1/planning/slots/${s.id}`, body };
}

/** Aperçu du résultat et des conflits ; enregistrement seulement après confirmation, sinon position initiale. */
function ChangeDialog({ p, tz, derogate, onClose }: { p: { s: any; change: any }; tz: string; derogate: boolean; onClose: (changed: boolean) => void }) {
  const req = changeRequest(p.s, p.change);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(req.method, req.url, { ...req.body, preview: true }).then(setPreview, (e) => setErr(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = async (derogation?: string) => {
    setBusy(true);
    try { await api(req.method, req.url, { ...req.body, ...(derogation ? { derogation } : {}) }, { headers: { 'Idempotency-Key': crypto.randomUUID?.() ?? String(Date.now()) } }); onClose(true); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const after = req.body.startsAt ? { ...p.s, starts_at: req.body.startsAt, ends_at: req.body.endsAt ?? p.s.ends_at }
    : req.body.endsAt ? { ...p.s, ends_at: req.body.endsAt } : p.change.shiftDays ? { ...p.s, starts_at: new Date(+new Date(p.s.starts_at) + p.change.shiftDays * 86400000).toISOString(), ends_at: new Date(+new Date(p.s.ends_at) + p.change.shiftDays * 86400000).toISOString() } : p.s;
  return (
    <div className="pl-modal" role="dialog" aria-modal="true" aria-labelledby="pl-change-title" onKeyDown={(e) => e.key === 'Escape' && onClose(false)}>
      <div className="panel">
        <h2 id="pl-change-title" style={{ marginTop: 0 }}>Confirmer la modification <Help k="planning.controles" /></h2>
        <p className="small">Avant : {describe(p.s, tz)}</p>
        <p className="small"><strong>Après : {describe(after, tz)}</strong>{p.change.swap ? ` · ${GROUP_LABEL[p.change.swap.by as GroupBy].toLowerCase()} remplacé(e)` : ''}</p>
        {p.s.status === 'published' && <p className="small banner warn">Séance publiée : les personnes concernées seront notifiées après confirmation.</p>}
        {!preview && !err && <p className="muted small">Contrôle en cours…</p>}
        {preview && <Issues report={preview.report} />}
        {err && <p className="alert">{err}</p>}
        {preview && !preview.ok && preview.canDerogate && derogate && <DerogationBox onSubmit={(r) => confirm(r)} />}
        <div className="toolbar">
          <button className="btn" autoFocus disabled={!preview?.ok || busy} onClick={() => confirm()}>Confirmer</button>
          <button className="btn ghost" onClick={() => onClose(false)}>Annuler (position initiale)</button>
        </div>
      </div>
    </div>
  );
}

/** Édition groupée : aperçu par séance, puis application atomique. */
function BulkBar({ ids, lookups, perms, onDone }: { ids: string[]; lookups: any; perms: any; onDone: () => void }) {
  const [op, setOp] = useState({ kind: 'shiftDays', value: '1', target: '', mode: 'replace' });
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const request = (): [string, any] => {
    if (op.kind === 'publish') return ['/api/v1/planning/transition', { slotIds: ids, status: 'published' }];
    if (op.kind === 'cancel') return ['', null];
    const body: any = { slotIds: ids };
    if (op.kind === 'shiftDays') body.shiftDays = Number(op.value);
    if (op.kind === 'shiftMinutes') body.shiftMinutes = Number(op.value);
    if (op.kind === 'trainer') body.trainers = { ids: op.target ? [op.target] : [], mode: op.mode };
    if (op.kind === 'room') body.resources = { ids: op.target ? [op.target] : [], mode: op.mode };
    if (op.kind === 'modality') body.modality = op.value;
    return ['/api/v1/planning/bulk', body];
  };
  const run = async (dry: boolean) => {
    setErr(null);
    try {
      if (op.kind === 'cancel') {
        const reason = prompt(`Annuler ${ids.length} séance(s) ? Motif :`); if (!reason) return;
        for (const id of ids) await post(`/api/v1/planning/slots/${id}/cancel`, { reason });
        onDone(); return;
      }
      const [url, body] = request();
      const r = await post(url, { ...body, preview: dry });
      if (dry) setPreview(r); else { setPreview(null); onDone(); }
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel pl-bulk" aria-label="Édition groupée">
      <strong>{ids.length} séance(s) sélectionnée(s)</strong> <Help k="planning.groupee" />
      <div className="pl-toolbar">
        <select aria-label="Opération" value={op.kind} onChange={(e) => { setOp({ ...op, kind: e.target.value, value: e.target.value === 'modality' ? 'onsite' : '1' }); setPreview(null); }}>
          <option value="shiftDays">Décaler de N jours</option><option value="shiftMinutes">Décaler de N minutes</option><option value="trainer">Formateur</option><option value="room">Salle / matériel</option>
          <option value="modality">Modalité</option>{(perms.publish || perms.directPublish) && <option value="publish">Publier</option>}<option value="cancel">Annuler</option>
        </select>
        {['shiftDays', 'shiftMinutes'].includes(op.kind) && <input aria-label="Valeur" type="number" value={op.value} onChange={(e) => { setOp({ ...op, value: e.target.value }); setPreview(null); }} style={{ width: 90 }} />}
        {['trainer', 'room'].includes(op.kind) && <>
          <select aria-label="Mode" value={op.mode} onChange={(e) => { setOp({ ...op, mode: e.target.value }); setPreview(null); }}><option value="replace">remplacer par</option><option value="add">ajouter</option><option value="remove">retirer</option></select>
          <select aria-label="Ressource" value={op.target} onChange={(e) => { setOp({ ...op, target: e.target.value }); setPreview(null); }}><option value="">—</option>
            {(op.kind === 'trainer' ? lookups.trainers.map((t: any) => [t.id, t.name]) : lookups.resources.map((r: any) => [r.id, r.name])).map(([k, v]: string[]) => <option key={k} value={k}>{v}</option>)}</select></>}
        {op.kind === 'modality' && <select aria-label="Modalité" value={op.value} onChange={(e) => { setOp({ ...op, value: e.target.value }); setPreview(null); }}>{Object.entries(MODALITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        {op.kind !== 'cancel' && <button className="btn ghost sm" onClick={() => run(true)}>Prévisualiser</button>}
        <button className="btn sm" disabled={op.kind !== 'cancel' && !preview?.ok} onClick={() => run(false)}>Appliquer{op.kind !== 'cancel' ? ' (tout ou rien)' : ''}</button>
      </div>
      {preview && <><p className="small">{preview.ok ? 'Bilan : toutes les séances passent les contrôles.' : 'Bilan : au moins une séance est bloquée, rien ne sera enregistré.'}</p><Issues report={preview.report} /></>}
      {err && <p className="alert">{err}</p>}
    </div>
  );
}

