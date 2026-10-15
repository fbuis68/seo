import { useEffect, useRef, useState } from 'react';
import { ColorBy, GROUP_LABEL, GroupBy, MODALITY, STATUS, addDays, at, colorOf, dayLabel, dowOf, fmtH, hmToMin, keysOf, lanes, minToHm, parts, rowsOf, today } from './lib';

export interface ViewProps {
  items: any[]; tz: string; colorBy: ColorBy; settings: any; canWrite: boolean;
  onOpen: (s: any) => void;
  onCreate: (startsAt: string, endsAt: string, key?: { by: GroupBy; id: string }) => void;
  /** Proposition de changement (glisser-déposer) : contrôlée puis confirmée, sinon position initiale. */
  onPropose: (s: any, change: { startsAt?: string; endsAt?: string; swap?: { by: GroupBy; from: string; to: string }; shiftDays?: number }) => void;
}

// Un glisser-déposer se termine par un clic : il ne doit pas ouvrir la fiche.
let lastDragEnd = 0;
const people = (s: any) => s.trainers.map((t: any) => t.name).join(', ');
const places = (s: any) => s.modality === 'remote' ? 'Distanciel' : s.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', ');
export function describe(s: any, tz: string) {
  const a = parts(s.starts_at, tz); const b = parts(s.ends_at, tz);
  return `${s.title || s.session_title} · ${dayLabel(a.date)} ${a.hm}–${b.hm} · ${STATUS[s.status].label}${people(s) ? ` · ${people(s)}` : ''}${places(s) ? ` · ${places(s)}` : ''}`;
}

/** Carte de séance : texte + icône de statut (lisible sans couleur), détail au survol / focus. */
export function Card({ s, tz, colorBy, compact, onOpen, style, onPointerDown, onResize, dragging }: {
  s: any; tz: string; colorBy: ColorBy; compact?: boolean; onOpen: (s: any) => void; style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent) => void; onResize?: (e: React.PointerEvent) => void; dragging?: boolean;
}) {
  const a = parts(s.starts_at, tz); const b = parts(s.ends_at, tz);
  const color = colorOf(s, colorBy);
  const n = (s.expected_onsite ?? 0) + (s.expected_remote ?? 0);
  return (
    <div role="button" tabIndex={0} className={`pl-card st-${s.status}${s.incomplete ? ' incomplete' : ''}${dragging ? ' dragging' : ''}`}
      style={{ ...style, ['--c' as any]: color }} title={describe(s, tz)} aria-label={describe(s, tz)}
      onClick={(e) => { if (!(e.target as HTMLElement).dataset.resize && Date.now() - lastDragEnd > 300) onOpen(s); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s); } }}
      onPointerDown={onPointerDown}>
      <div className="pl-card-h"><span aria-hidden>{STATUS[s.status].mark}</span> <strong>{a.hm}–{b.hm}</strong> {s.incomplete && <span className="pl-flag" title="Séance incomplète">⚠</span>}
        {s.to_resolve > 0 && <span className="pl-flag" title="Participants à résoudre">!{s.to_resolve}</span>}</div>
      <div className="pl-card-t">{s.title || s.part_title || s.session_title}</div>
      {!compact && <>
        {(s.title || s.part_title) && <div className="pl-card-l">{s.session_title}</div>}
        <div className="pl-card-l">{places(s) || <em>sans lieu</em>}</div>
        <div className="pl-card-l">{people(s) || <em>sans formateur</em>}{n ? ` · ${n} pers.` : ''}{s.modality !== 'onsite' ? ` · ${MODALITY[s.modality]}` : ''}</div>
        <div className="pl-card-l sr">{STATUS[s.status].label}</div>
      </>}
      {s.breaks?.map((br: any, i: number) => {
        const total = +new Date(s.ends_at) - +new Date(s.starts_at);
        return <span key={i} className="pl-break" aria-hidden style={{ top: `${((+new Date(br.startsAt) - +new Date(s.starts_at)) / total) * 100}%`, height: `${((+new Date(br.endsAt) - +new Date(br.startsAt)) / total) * 100}%` }} />;
      })}
      {onResize && <span className="pl-resize" data-resize="1" aria-hidden onPointerDown={onResize} />}
    </div>
  );
}

/** Glisser-déposer générique : déplacement (x, y) ou redimensionnement (y), relâché = proposition. */
function useDrag(onDrop: (id: string, mode: 'move' | 'resize', dx: number, dy: number, e: PointerEvent) => void) {
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'resize'; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const ref = useRef(drag); ref.current = drag;
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => d && { ...d, dx: e.clientX - d.x0, dy: e.clientY - d.y0 });
    const up = (e: PointerEvent) => {
      const d = ref.current; setDrag(null);
      if (d && (Math.abs(e.clientX - d.x0) > 4 || Math.abs(e.clientY - d.y0) > 4)) { lastDragEnd = Date.now(); onDrop(d.id, d.mode, e.clientX - d.x0, e.clientY - d.y0, e); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag?.id, drag?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (id: string, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDrag({ id, mode, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
  };
  return { drag, start };
}

/**
 * Vue jour / semaine : grille horaire verticale. Semaine : colonnes jours ; jour : colonnes
 * par ressource (formateur, salle, session, groupe). Pas visuel paramétrable, heure actuelle,
 * pauses, indisponibilités, chevauchements côte à côte.
 */
export function TimeGrid(p: ViewProps & { days: string[]; groupBy?: GroupBy; lookups?: any; unavailable?: any[]; closures?: any[] }) {
  const { settings, tz } = p;
  const dayStart = hmToMin(settings.day_start); const dayEnd = hmToMin(settings.day_end);
  const stepMin = settings.grid_step as number;
  const PPM = 0.9; // pixels par minute
  const height = (dayEnd - dayStart) * PPM;
  const byResource = p.days.length === 1 && p.groupBy;
  const columns = byResource ? rowsOf(p.groupBy!, p.lookups, p.items).map((r) => ({ key: r.id, label: r.label, sub: r.sub, date: p.days[0] }))
    : p.days.map((d) => ({ key: d, label: dayLabel(d), sub: undefined as string | undefined, date: d }));
  const colOf = (s: any) => byResource ? keysOf(s, p.groupBy!) : [parts(s.starts_at, tz).date];
  const gridRef = useRef<HTMLDivElement>(null);
  const snap = (m: number) => Math.round(m / stepMin) * stepMin;
  const { drag, start } = useDrag((id, mode, dx, dy, e) => {
    const s = p.items.find((x) => x.id === id)!;
    const dm = snap(dy / PPM);
    if (mode === 'resize') { if (dm) p.onPropose(s, { endsAt: new Date(+new Date(s.ends_at) + dm * 60000).toISOString() }); return; }
    const rect = gridRef.current!.getBoundingClientRect();
    const colW = (rect.width - 56) / columns.length;
    const fromCol = columns.findIndex((c) => colOf(s).includes(c.key));
    const toCol = Math.max(0, Math.min(columns.length - 1, Math.floor((e.clientX - rect.left - 56) / colW)));
    const a = parts(s.starts_at, tz);
    if (byResource) {
      const change: any = {};
      if (dm) { change.startsAt = new Date(+new Date(s.starts_at) + dm * 60000).toISOString(); change.endsAt = new Date(+new Date(s.ends_at) + dm * 60000).toISOString(); }
      if (toCol !== fromCol && !['session', 'group', 'learner'].includes(p.groupBy!)) change.swap = { by: p.groupBy!, from: columns[fromCol].key, to: columns[toCol].key };
      if (Object.keys(change).length) p.onPropose(s, change);
      return;
    }
    const days = toCol - fromCol;
    if (!dm && !days) return;
    const newStartLocal = minToHm(Math.max(0, Math.min(1439, a.minutes + dm)));
    const startsAt = at(addDays(a.date, days), newStartLocal, tz);
    const dur = +new Date(s.ends_at) - +new Date(s.starts_at);
    p.onPropose(s, { startsAt, endsAt: new Date(+new Date(startsAt) + dur).toISOString() });
  });
  const now = new Date(); const nowP = parts(now, tz);
  return (
    <div className="pl-grid" ref={gridRef} style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(${byResource ? 140 : 110}px, 1fr))` }}>
      <div className="pl-corner" />
      {columns.map((c) => {
        const closed = p.closures?.filter((x) => x.starts_on <= c.date && x.ends_on >= c.date) ?? [];
        return <div key={c.key} className={`pl-colh${!byResource && c.date === today(tz) ? ' today' : ''}`}>{c.label}{c.sub && <div className="small muted">{c.sub}</div>}
          {!byResource && closed.map((x) => <div key={x.id} className="pl-closed">Fermé : {x.label}{x.site_name ? ` (${x.site_name})` : ''}</div>)}</div>;
      })}
      <div className="pl-hours" style={{ height }}>
        {Array.from({ length: Math.ceil((dayEnd - dayStart) / 60) }, (_, i) => <div key={i} className="pl-hour" style={{ top: i * 60 * PPM }}>{minToHm(dayStart + i * 60)}</div>)}
      </div>
      {columns.map((c) => {
        const col = p.items.filter((s) => colOf(s).includes(c.key));
        const placed = lanes(col.map((s) => {
          const a = parts(s.starts_at, tz); const b = parts(s.ends_at, tz);
          const sMin = a.date < c.date ? 0 : a.minutes; const eMin = b.date > c.date ? 1440 : b.minutes;
          return { s: sMin, e: eMin, slot: s };
        }));
        const unav = byResource ? (p.unavailable ?? []).filter((u) => u.owner_id === c.key) : [];
        return (
          <div key={c.key} className="pl-col" style={{ height, backgroundSize: `100% ${stepMin * PPM}px` }}
            onDoubleClick={(e) => {
              if (!p.canWrite || e.target !== e.currentTarget) return;
              const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
              const m = Math.floor((dayStart + y / PPM) / stepMin) * stepMin;
              p.onCreate(at(c.date, minToHm(m), tz), at(c.date, minToHm(Math.min(1439, m + 60)), tz), byResource && c.key !== '__none' ? { by: p.groupBy!, id: c.key } : undefined);
            }}>
            {unav.map((u) => {
              const a = parts(u.starts_at, tz); const b = parts(u.ends_at, tz);
              const s = a.date < c.date ? dayStart : Math.max(dayStart, a.minutes); const e = b.date > c.date ? dayEnd : Math.min(dayEnd, b.minutes);
              return e > s ? <div key={u.id} className="pl-unav" style={{ top: (s - dayStart) * PPM, height: (e - s) * PPM }} title={`Indisponible : ${u.reason ?? ''}`}>Indisponible</div> : null;
            })}
            {c.date === nowP.date && nowP.minutes >= dayStart && nowP.minutes <= dayEnd && <div className="pl-now" style={{ top: (nowP.minutes - dayStart) * PPM }} aria-hidden />}
            {placed.map(({ s: sMin, e: eMin, slot, lane, lanes: n }) => {
              const top = Math.max(0, (sMin - dayStart) * PPM); const h = Math.max(18, (Math.min(eMin, dayEnd) - Math.max(sMin, dayStart)) * PPM);
              const d = drag?.id === slot.id ? drag : null;
              const movable = p.canWrite && !['done', 'cancelled'].includes(slot.status);
              return <Card key={slot.id + c.key} s={slot} tz={tz} colorBy={p.colorBy} onOpen={p.onOpen} compact={h < 60} dragging={!!d}
                style={{ position: 'absolute', top, height: d?.mode === 'resize' ? Math.max(18, h + d.dy) : h, left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`,
                  transform: d?.mode === 'move' ? `translate(${d.dx}px, ${d.dy}px)` : undefined }}
                onPointerDown={movable ? start(slot.id, 'move') : undefined} onResize={movable ? start(slot.id, 'resize') : undefined} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Vue mois : séances, horaires, statut ; compteur des éléments supplémentaires ; déplacement de date. */
export function MonthView(p: ViewProps & { start: string; days: number; month: string; onDay: (date: string) => void; closures?: any[] }) {
  const [over, setOver] = useState<string | null>(null);
  const MAX = 3;
  const cells = Array.from({ length: p.days }, (_, i) => addDays(p.start, i));
  return (
    <div className="pl-month">
      {['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'].map((d) => <div key={d} className="pl-colh">{d}</div>)}
      {cells.map((d) => {
        const list = p.items.filter((s) => parts(s.starts_at, p.tz).date === d);
        const closed = p.closures?.filter((x) => x.starts_on <= d && x.ends_on >= d) ?? [];
        return (
          <div key={d} className={`pl-mcell${d.slice(0, 7) !== p.month ? ' out' : ''}${d === today(p.tz) ? ' today' : ''}${over === d ? ' over' : ''}`}
            onDragOver={(e) => { if (p.canWrite) { e.preventDefault(); setOver(d); } }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/slot'); const s = p.items.find((x) => x.id === id);
              if (s) { const from = parts(s.starts_at, p.tz).date; const n = Math.round((Date.parse(d) - Date.parse(from)) / 86400000); if (n) p.onPropose(s, { shiftDays: n }); } }}>
            <button className="pl-mday" onClick={() => p.onDay(d)} aria-label={`Ouvrir la journée du ${dayLabel(d)}`}>{Number(d.slice(8, 10))}</button>
            {closed.map((x) => <div key={x.id} className="pl-closed">Fermé : {x.label}</div>)}
            {list.slice(0, MAX).map((s) => (
              <div key={s.id} role="button" tabIndex={0} draggable={p.canWrite && !['done', 'cancelled'].includes(s.status)} className={`pl-mitem st-${s.status}`} style={{ ['--c' as any]: colorOf(s, p.colorBy) }}
                onDragStart={(e) => e.dataTransfer.setData('text/slot', s.id)} onClick={() => p.onOpen(s)} onKeyDown={(e) => e.key === 'Enter' && p.onOpen(s)} title={describe(s, p.tz)}>
                <span aria-hidden>{STATUS[s.status].mark}</span> {parts(s.starts_at, p.tz).hm} {s.title || s.session_title}
              </div>
            ))}
            {list.length > MAX && <button className="pl-more" onClick={() => p.onDay(d)}>+{list.length - MAX} autre(s)</button>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Timeline : axe horizontal, lignes par ressource, entêtes fixes au défilement,
 * chevauchements empilés, glisser horizontal = date / heure, vertical = autre ressource du même type.
 */
export function Timeline(p: ViewProps & { start: string; days: number; zoom: 'day' | 'week' | 'month'; groupBy: GroupBy; lookups: any; rowHeight: number; unavailable?: any[]; onlyRow?: string }) {
  const { tz, settings } = p;
  // Axe limité à la plage visible paramétrée (séances hors plage ramenées aux bornes).
  const dayStart = hmToMin(settings.day_start); const dayEnd = hmToMin(settings.day_end);
  const pxPerDay = p.zoom === 'day' ? (dayEnd - dayStart) * 1.6 : p.zoom === 'week' ? 260 : 64;
  const width = pxPerDay * p.days;
  const t0 = +new Date(at(p.start, minToHm(dayStart), tz));
  const xOf = (iso: string) => {
    const a = parts(iso, tz); const d = Math.round((Date.parse(a.date) - Date.parse(p.start)) / 86400000);
    const m = Math.max(dayStart, Math.min(dayEnd, a.minutes));
    return d * pxPerDay + ((m - dayStart) / (dayEnd - dayStart)) * pxPerDay;
  };
  const rows = rowsOf(p.groupBy, p.lookups, p.items).filter((r) => !p.onlyRow || r.id === p.onlyRow);
  const rowDrag = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const { drag, start } = useDrag((id, _mode, dx, _dy, e) => {
    const s = p.items.find((x) => x.id === id)!;
    const change: any = {};
    const minutesPerPx = (dayEnd - dayStart) / pxPerDay;
    const dm = p.zoom === 'day' ? Math.round((dx * minutesPerPx) / settings.grid_step) * settings.grid_step : Math.round(dx / pxPerDay) * 1440;
    if (dm) {
      if (p.zoom === 'day') { change.startsAt = new Date(+new Date(s.starts_at) + dm * 60000).toISOString(); change.endsAt = new Date(+new Date(s.ends_at) + dm * 60000).toISOString(); }
      else change.shiftDays = dm / 1440;
    }
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => (x as HTMLElement).dataset?.row) as HTMLElement | undefined;
    const target = el?.dataset.row;
    const from = rowDrag.current;
    if (target && from && target !== from && !['session', 'group', 'learner'].includes(p.groupBy) && target !== '__none') change.swap = { by: p.groupBy, from, to: target };
    if (Object.keys(change).length) p.onPropose(s, change);
  });
  const ticks = Array.from({ length: p.days }, (_, i) => addDays(p.start, i));
  const now = Date.now();
  return (
    <div className="pl-tl" ref={bodyRef}>
      <div className="pl-tl-inner" style={{ width: width + 200 }}>
        <div className="pl-tl-head">
          <div className="pl-tl-label pl-tl-corner">{rows.length} ligne(s)</div>
          <div className="pl-tl-axis" style={{ width }}>
            {ticks.map((d, i) => (
              <div key={d} className={`pl-tl-tick${d === today(tz) ? ' today' : ''}${dowOf(d) > 5 ? ' we' : ''}`} style={{ left: i * pxPerDay, width: pxPerDay }}>
                {p.zoom === 'month' ? <>{dayLabel(d).split(' ')[0].slice(0, 1).toUpperCase()}<br />{Number(d.slice(8, 10))}</> : dayLabel(d)}
                {p.zoom === 'day' && Array.from({ length: Math.ceil((dayEnd - dayStart) / 60) }, (_, h) => <span key={h} className="pl-tl-h" style={{ left: (h * 60 / (dayEnd - dayStart)) * pxPerDay }}>{minToHm(dayStart + h * 60).slice(0, 2)}h</span>)}
              </div>
            ))}
          </div>
        </div>
        {rows.map((r) => {
          const list = p.items.filter((s) => keysOf(s, p.groupBy).includes(r.id));
          const placed = lanes(list.map((s) => ({ s: xOf(s.starts_at), e: Math.max(xOf(s.starts_at) + 6, xOf(s.ends_at)), slot: s })));
          const n = Math.max(1, ...placed.map((x) => x.lanes));
          const isCollapsed = p.groupBy === 'session' && collapsed[r.id];
          const h = isCollapsed ? 28 : Math.max(p.rowHeight, n * (p.rowHeight - 6) + 6);
          const span = list.length ? [Math.min(...placed.map((x) => x.s)), Math.max(...placed.map((x) => x.e))] : null;
          const unav = (p.unavailable ?? []).filter((u) => u.owner_id === r.id);
          return (
            <div key={r.id} className="pl-tl-row" style={{ height: h }}>
              <div className="pl-tl-label">
                {p.groupBy === 'session' && <button className="pl-tl-toggle" aria-expanded={!isCollapsed} aria-label={isCollapsed ? 'Déplier' : 'Replier'} onClick={() => setCollapsed({ ...collapsed, [r.id]: !isCollapsed })}>{isCollapsed ? '▸' : '▾'}</button>}
                <span>{r.label}{r.sub && <span className="small muted"> · {r.sub}</span>}</span>
                <span className="small muted"> {fmtH(list.reduce((a, s) => a + (s.status === 'cancelled' ? 0 : s.pedagogical_minutes), 0))}</span>
              </div>
              <div className="pl-tl-track" data-row={r.id} style={{ width, backgroundSize: `${pxPerDay}px 100%` }}
                onDoubleClick={(e) => {
                  if (!p.canWrite || e.target !== e.currentTarget) return;
                  const x = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
                  const d = Math.floor(x / pxPerDay); const date = addDays(p.start, d);
                  const m = p.zoom === 'day' ? Math.floor((dayStart + ((x - d * pxPerDay) / pxPerDay) * (dayEnd - dayStart)) / settings.grid_step) * settings.grid_step : 9 * 60;
                  p.onCreate(at(date, minToHm(m), tz), at(date, minToHm(Math.min(1439, m + 60)), tz), r.id !== '__none' && !['session', 'group', 'learner'].includes(p.groupBy) ? { by: p.groupBy, id: r.id } : undefined);
                }}>
                {span && p.groupBy === 'session' && <div className="pl-tl-span" style={{ left: span[0], width: span[1] - span[0] }} aria-hidden />}
                {unav.map((u) => <div key={u.id} className="pl-unav" style={{ left: xOf(u.starts_at), width: Math.max(4, xOf(u.ends_at) - xOf(u.starts_at)), top: 0, bottom: 0 }} title={`Indisponible : ${u.reason ?? ''}`} />)}
                {now >= t0 && now <= t0 + p.days * 86400000 && <div className="pl-tl-now" style={{ left: xOf(new Date(now).toISOString()) }} aria-hidden />}
                {!isCollapsed && placed.map(({ s: x, e: x2, slot, lane }) => {
                  const d = drag?.id === slot.id ? drag : null;
                  const movable = p.canWrite && !['done', 'cancelled'].includes(slot.status);
                  return <Card key={slot.id} s={slot} tz={tz} colorBy={p.colorBy} onOpen={p.onOpen} compact dragging={!!d}
                    style={{ position: 'absolute', left: x, width: Math.max(8, x2 - x - 2), top: 3 + lane * (p.rowHeight - 6), height: p.rowHeight - 8, transform: d ? `translate(${d.dx}px, ${d.dy}px)` : undefined }}
                    onPointerDown={movable ? (e) => { rowDrag.current = r.id; start(slot.id, 'move')(e); } : undefined} />;
                })}
                {isCollapsed && span && <div className="pl-tl-sum" style={{ left: span[0], width: span[1] - span[0] }}>{list.length} séance(s)</div>}
              </div>
            </div>
          );
        })}
        {!rows.length && <p className="muted small" style={{ padding: 12 }}>Aucune ressource à afficher.</p>}
      </div>
    </div>
  );
}

/** Vue liste (mobile, clavier, sélection pour édition groupée). */
export function ListView(p: ViewProps & { selected: string[]; onSelect: (ids: string[]) => void; groupBy?: GroupBy | null; lookups?: any }) {
  // Sections par jour, ou par ressource (formateur, salle, session…) quand un regroupement est choisi.
  const byDay = new Map<string, any[]>();
  if (p.groupBy && p.lookups) {
    const labels = new Map(rowsOf(p.groupBy, p.lookups, p.items).map((r) => [r.id, r.label]));
    for (const s of p.items) for (const k of keysOf(s, p.groupBy)) { const l = labels.get(k) ?? k; if (!byDay.has(l)) byDay.set(l, []); byDay.get(l)!.push(s); }
  } else for (const s of p.items) { const d = parts(s.starts_at, p.tz).date; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(s); }
  const grouped = !!(p.groupBy && p.lookups);
  const toggle = (id: string) => p.onSelect(p.selected.includes(id) ? p.selected.filter((x) => x !== id) : [...p.selected, id]);
  if (!p.items.length) return <p className="muted">Aucune séance sur la période avec ces filtres.</p>;
  return (
    <div className="pl-list">
      {[...byDay.entries()].map(([d, list]) => (
        <section key={d}>
          <h3>{grouped ? d : dayLabel(d)} <span className="small muted">· {fmtH(list.reduce((a, s) => a + (s.status === 'cancelled' ? 0 : s.pedagogical_minutes), 0))}</span></h3>
          <table><tbody>{list.map((s) => (
            <tr key={s.id} className={`st-${s.status}`}>
              {p.canWrite && <td style={{ width: 28 }}><input type="checkbox" aria-label={`Sélectionner ${describe(s, p.tz)}`} checked={p.selected.includes(s.id)} onChange={() => toggle(s.id)} /></td>}
              <td style={{ width: grouped ? 170 : 110 }}><span className="pl-dot" style={{ background: colorOf(s, p.colorBy) }} aria-hidden /> {grouped ? `${dayLabel(parts(s.starts_at, p.tz).date)} ` : ''}{parts(s.starts_at, p.tz).hm}–{parts(s.ends_at, p.tz).hm}</td>
              <td><button className="linklike" onClick={() => p.onOpen(s)}>{s.title || s.part_title || s.session_title}</button>
                <div className="small muted">{s.session_title}{s.session_reference ? ` (${s.session_reference})` : ''}{s.group_label ? ` · groupe ${s.group_label}` : ''}</div></td>
              <td className="small">{places(s) || <span className="pill warn">sans lieu</span>}</td>
              <td className="small">{people(s) || <span className="pill warn">sans formateur</span>}</td>
              <td className="small num">{(s.expected_onsite ?? 0) + (s.expected_remote ?? 0)} pers.</td>
              <td><span className={`pill st-${s.status}`}>{STATUS[s.status].mark} {STATUS[s.status].label}</span>{s.incomplete && <> <span className="pill warn">incomplet</span></>}</td>
            </tr>))}</tbody></table>
        </section>
      ))}
    </div>
  );
}

/**
 * Semaine ou mois par ressource : une ligne par formateur, salle, session, groupe ou stagiaire,
 * une colonne par jour. Semaine : séances détaillées ; mois : nombre de séances et heures.
 */
export function GroupedGrid(p: ViewProps & { days: string[]; groupBy: GroupBy; lookups: any; compact?: boolean; onPick: (date: string, rowId: string) => void; closures?: any[] }) {
  const rows = rowsOf(p.groupBy, p.lookups, p.items);
  const cell = (rowId: string, d: string) => p.items.filter((s) => keysOf(s, p.groupBy).includes(rowId) && parts(s.starts_at, p.tz).date === d)
    .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));
  if (!rows.length) return <p className="muted" style={{ padding: 12 }}>Aucune ressource à afficher.</p>;
  return (
    <table className={`pl-gg${p.compact ? ' compact' : ''}`}>
      <thead><tr><th className="pl-gg-h">{GROUP_LABEL[p.groupBy]}</th>{p.days.map((d) => {
        const closed = p.closures?.some((x) => x.starts_on <= d && x.ends_on >= d);
        return <th key={d} className={`${d === today(p.tz) ? 'today' : ''}${dowOf(d) > 5 ? ' we' : ''}`} title={closed ? 'Fermeture' : undefined}>
          {p.compact ? <>{dayLabel(d).slice(0, 1).toUpperCase()}<br />{Number(d.slice(8, 10))}</> : dayLabel(d)}{closed && <div className="pl-closed">fermé</div>}</th>;
      })}<th className="num">Total</th></tr></thead>
      <tbody>{rows.map((r) => {
        const all = p.items.filter((s) => keysOf(s, p.groupBy).includes(r.id) && s.status !== 'cancelled');
        return (
          <tr key={r.id}>
            <th className="pl-gg-h">{r.label}{r.sub && <div className="small muted">{r.sub}</div>}</th>
            {p.days.map((d) => {
              const list = cell(r.id, d);
              if (p.compact) {
                const mins = list.filter((s) => s.status !== 'cancelled').reduce((a, s) => a + s.pedagogical_minutes, 0);
                return <td key={d} className={dowOf(d) > 5 ? 'we' : ''}>{list.length > 0 && <button className="pl-gg-count" onClick={() => p.onPick(d, r.id)} title={list.map((s) => describe(s, p.tz)).join('\n')}
                  style={{ ['--c' as any]: colorOf(list[0], p.colorBy) }}>{list.length}<span>{fmtH(mins)}</span></button>}</td>;
              }
              return <td key={d} className={dowOf(d) > 5 ? 'we' : ''} onDoubleClick={(e) => { if (!p.canWrite || e.target !== e.currentTarget) return; p.onCreate(at(d, '09:00', p.tz), at(d, '12:00', p.tz), r.id !== '__none' && !['session', 'group', 'learner'].includes(p.groupBy) ? { by: p.groupBy, id: r.id } : undefined); }}>
                {list.map((s) => (
                  <div key={s.id} role="button" tabIndex={0} className={`pl-mitem st-${s.status}`} style={{ ['--c' as any]: colorOf(s, p.colorBy) }} title={describe(s, p.tz)}
                    onClick={() => p.onOpen(s)} onKeyDown={(e) => e.key === 'Enter' && p.onOpen(s)}>
                    <span aria-hidden>{STATUS[s.status].mark}</span> {parts(s.starts_at, p.tz).hm}–{parts(s.ends_at, p.tz).hm} {s.title || s.part_title || s.session_title}
                  </div>))}
              </td>;
            })}
            <td className="num small">{fmtH(all.reduce((a, s) => a + s.pedagogical_minutes, 0))}</td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}
