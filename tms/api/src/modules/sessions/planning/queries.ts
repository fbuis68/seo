import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context';
import { csvCell } from '../../../core/csv';
import { Db, Tx, many, one } from '../../../core/db';
import { badRequest, forbidden, notFound } from '../../../core/errors';
import { Block, renderPdf } from '../../../core/pdf';
import { PlanningEngine, SlotFields } from './engine';
import { Issue, checkSlots, loadSettings } from './rules';
import { WeeklyHours, addDays, dowOf, fmtDay, hmToMin, local, zoned } from './time';

export interface SlotQuery {
  from: string; to: string; sessionId?: string; trainerId?: string; resourceId?: string; siteId?: string; learnerId?: string; programId?: string;
  status?: string; modality?: string; groupLabel?: string; q?: string; incomplete?: boolean; limit?: number; withLearners?: boolean;
}

const MAX_RANGE_DAYS = 186;

/** Séance complète pour l'affichage (cartes, liste, exports). */
const SLOT_COLUMNS = `
  sl.id, sl.session_id, sl.status, sl.version, sl.starts_at, sl.ends_at, sl.title, sl.modality, sl.video_url, sl.breaks, sl.group_label,
  sl.part_id, sl.series_id, sl.derogation, sl.cancel_reason, sl.published_at, sl.notes,
  slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks) AS pedagogical_minutes,
  ts.title AS session_title, ts.reference AS session_reference, ts.color AS session_color, ts.timezone, ts.status AS session_status,
  p.id AS program_id, p.title AS program_title, pt.title AS part_title, slot_site(sl.id) AS site_id,
  coalesce((SELECT json_agg(json_build_object('id', pe.id, 'name', pe.first_name || ' ' || pe.last_name, 'role', st.role) ORDER BY st.role DESC, pe.last_name)
              FROM slot_trainers st JOIN persons pe ON pe.id = st.person_id WHERE st.slot_id = sl.id), '[]') AS trainers,
  coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'capacity', r.capacity, 'site_id', r.site_id) ORDER BY r.kind, r.name)
              FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = sl.id), '[]') AS resources`;
const PARTICIPANT_COUNTS = `,
  (SELECT count(*) FROM slot_expected x WHERE x.slot_id = sl.id AND x.mode = 'onsite' AND x.dates_ok)::int AS expected_onsite,
  (SELECT count(*) FROM slot_expected x WHERE x.slot_id = sl.id AND x.mode = 'remote' AND x.dates_ok)::int AS expected_remote,
  (SELECT count(*) FROM slot_expected x WHERE x.slot_id = sl.id AND x.mode = 'to_resolve')::int AS to_resolve`;
const FROM = `FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id JOIN program_versions v ON v.id = ts.program_version_id
              JOIN programs p ON p.id = v.program_id LEFT JOIN session_parts pt ON pt.id = sl.part_id`;
const INCOMPLETE = `(NOT EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id)
   OR (sl.modality <> 'onsite' AND sl.video_url IS NULL)
   OR (sl.modality <> 'remote' AND ts.site_id IS NULL AND NOT EXISTS (SELECT 1 FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = sl.id AND r.kind IN ('room','site'))))`;

const ics = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d: Date | string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fmtH = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
export const STATUS_LABEL: Record<string, string> = { draft: 'Brouillon', pending: 'À valider', published: 'Publié', done: 'Réalisé', cancelled: 'Annulé' };
export const MODALITY_LABEL: Record<string, string> = { onsite: 'Présentiel', remote: 'Distanciel', hybrid: 'Hybride' };

@Injectable()
export class PlanningQueries {
  constructor(private db: Db, private engine: PlanningEngine) {}

  private range(q: { from: string; to: string }) {
    const from = new Date(q.from); const to = new Date(q.to);
    if (Number.isNaN(+from) || Number.isNaN(+to) || to <= from) throw badRequest('invalid_range', 'Période invalide.', 'to');
    if (+to - +from > MAX_RANGE_DAYS * 86400000) throw badRequest('range_too_large', `Période limitée à ${MAX_RANGE_DAYS} jours : affiner la sélection.`, 'to');
    return { from, to };
  }

  /** Lecture par intervalle avec filtres combinables (bornes et pagination maximales). */
  async slots(ctx: RequestContext, q: SlotQuery, tx?: Tx) {
    const { from, to } = this.range(q);
    const params: unknown[] = [from, to];
    const where = ['sl.starts_at < $2', 'sl.ends_at > $1', `ts.status <> 'archived'`];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (ctx.role === 'trainer') { // formateur : son planning publié uniquement
      where.push(`EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id AND st.person_id = ${p(ctx.personId ?? null)})`, `(sl.status IN ('published','done') OR (sl.status = 'cancelled' AND sl.published_at IS NOT NULL))`);
    }
    if (q.sessionId) where.push(`sl.session_id = ${p(q.sessionId)}`);
    if (q.programId) where.push(`p.id = ${p(q.programId)}`);
    if (q.trainerId) where.push(`EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id AND st.person_id = ${p(q.trainerId)})`);
    if (q.resourceId) where.push(`EXISTS (SELECT 1 FROM slot_resources sr WHERE sr.slot_id = sl.id AND sr.resource_id = ${p(q.resourceId)})`);
    if (q.siteId) where.push(`slot_site(sl.id) = ${p(q.siteId)}`);
    if (q.learnerId) where.push(`EXISTS (SELECT 1 FROM slot_expected x WHERE x.slot_id = sl.id AND x.person_id = ${p(q.learnerId)} AND x.mode <> 'excluded')`);
    if (q.status) where.push(`sl.status = ANY(${p(q.status.split(','))}::text[])`);
    else where.push(`sl.status <> 'cancelled'`);
    if (q.modality) where.push(`sl.modality = ${p(q.modality)}`);
    if (q.groupLabel) where.push(`sl.group_label = ${p(q.groupLabel)}`);
    if (q.incomplete) where.push(INCOMPLETE);
    if (q.q) {
      const like = p(`%${q.q.trim()}%`);
      where.push(`(ts.title ILIKE ${like} OR ts.reference ILIKE ${like} OR sl.title ILIKE ${like} OR p.title ILIKE ${like}
        OR EXISTS (SELECT 1 FROM slot_trainers st JOIN persons pe ON pe.id = st.person_id WHERE st.slot_id = sl.id AND (pe.first_name || ' ' || pe.last_name) ILIKE ${like})
        OR EXISTS (SELECT 1 FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = sl.id AND r.name ILIKE ${like})
        ${ctx.role === 'trainer' ? '' : `OR EXISTS (SELECT 1 FROM slot_expected x JOIN persons pe ON pe.id = x.person_id WHERE x.slot_id = sl.id AND (pe.first_name || ' ' || pe.last_name) ILIKE ${like})`})`);
    }
    const limit = Math.min(q.limit ?? 2000, 5000);
    const learners = q.withLearners && ctx.role !== 'trainer' ? `, coalesce((SELECT json_agg(json_build_object('id', pe.id, 'name', pe.first_name || ' ' || pe.last_name, 'mode', x.mode) ORDER BY pe.last_name)
        FROM slot_expected x JOIN persons pe ON pe.id = x.person_id WHERE x.slot_id = sl.id AND x.mode IN ('onsite','remote') AND x.dates_ok), '[]') AS learners` : '';
    const sql = `SELECT ${SLOT_COLUMNS}${PARTICIPANT_COUNTS}${learners}, ${INCOMPLETE} AS incomplete ${FROM} WHERE ${where.join(' AND ')} ORDER BY sl.starts_at, sl.id LIMIT ${limit + 1}`;
    const run = async (t: Tx) => {
      const rows = await many(t, sql, params);
      return { items: rows.slice(0, limit), truncated: rows.length > limit };
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  /** Fiche séance : participants attendus et exceptions (présentiel, distanciel, exclu, à résoudre). */
  slot(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const s = await one(tx, `SELECT ${SLOT_COLUMNS}${PARTICIPANT_COUNTS}, ${INCOMPLETE} AS incomplete ${FROM} WHERE sl.id = $1`, [id]);
      if (!s) throw notFound('Séance');
      if (ctx.role === 'trainer' && !s.trainers.some((t: any) => t.id === ctx.personId)) throw notFound('Séance');
      s.participants = ctx.role === 'trainer' ? [] : await many(tx, `
        SELECT x.enrollment_id, x.person_id, x.mode, x.explicit, x.reason, x.dates_ok, pe.first_name || ' ' || pe.last_name AS name, e.group_label
          FROM slot_expected x JOIN persons pe ON pe.id = x.person_id JOIN enrollments e ON e.id = x.enrollment_id WHERE x.slot_id = $1 ORDER BY pe.last_name`, [id]);
      return s;
    });
  }

  /** Référentiels pour la barre de filtres, le formulaire et les lignes de la Timeline. */
  lookups(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => ({
      settings: await loadSettings(tx),
      sessions: await many(tx, `SELECT s.id, s.title, s.reference, s.color, s.timezone, s.status, s.site_id, s.capacity, s.min_participants, s.kind,
                                       coalesce(s.target_minutes, v.duration_minutes) AS target_minutes, p.title AS program_title, p.id AS program_id, v.modality,
                                       coalesce((SELECT json_agg(json_build_object('id', pt.id, 'title', pt.title) ORDER BY pt.position) FROM session_parts pt WHERE pt.session_id = s.id), '[]') AS parts,
                                       coalesce((SELECT array_agg(DISTINCT e.group_label) FROM enrollments e WHERE e.session_id = s.id AND e.group_label IS NOT NULL), '{}') AS groups
                                  FROM training_sessions s JOIN program_versions v ON v.id = s.program_version_id JOIN programs p ON p.id = v.program_id
                                 WHERE s.status NOT IN ('archived','cancelled') ORDER BY s.starts_on DESC NULLS LAST, s.created_at DESC LIMIT 500`),
      trainers: ctx.role === 'trainer' ? [] : await many(tx, `
        SELECT pe.id, pe.first_name || ' ' || pe.last_name AS name, pe.email, pe.skills, coalesce(tp.status, 'internal') AS status, coalesce(tp.active, true) AS active,
               coalesce(tp.allowed_site_ids, '{}') AS allowed_site_ids, tp.working_hours, tp.max_weekly_minutes, coalesce(tp.travel_minutes, 0) AS travel_minutes
          FROM persons pe JOIN person_roles r ON r.person_id = pe.id AND r.role = 'trainer' LEFT JOIN trainer_profiles tp ON tp.person_id = pe.id
         WHERE pe.archived_at IS NULL ORDER BY pe.last_name, pe.first_name`),
      resources: await many(tx, `SELECT id, kind, name, category, capacity, site_id, equipment, accessible, setup_minutes, teardown_minutes, opening_hours, location, inspection_due_on
                                   FROM resources WHERE archived_at IS NULL ORDER BY kind, name`),
      groups: (await many(tx, `SELECT DISTINCT group_label FROM enrollments WHERE group_label IS NOT NULL ORDER BY 1`)).map((r) => r.group_label),
      learners: ctx.role === 'trainer' ? [] : await many(tx, `SELECT DISTINCT pe.id, pe.first_name || ' ' || pe.last_name AS name FROM enrollments e JOIN persons pe ON pe.id = e.person_id
                                                              JOIN training_sessions s ON s.id = e.session_id WHERE e.status <> 'cancelled' AND s.status NOT IN ('archived','cancelled') ORDER BY 2 LIMIT 2000`),
    }));
  }

  /**
   * Planning personnel (formateur ou stagiaire) : séances publiées uniquement ;
   * le stagiaire ne voit ni noms ni coordonnées des autres stagiaires.
   */
  me(ctx: RequestContext, q: { from: string; to: string }) {
    if (!ctx.personId || !['trainer', 'learner'].includes(ctx.role ?? '')) throw forbidden('no_personal_planning', 'Planning personnel réservé aux formateurs et stagiaires rattachés à une fiche.');
    const { from, to } = this.range(q);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const visible = `(sl.status IN ('published','done') OR (sl.status = 'cancelled' AND sl.published_at IS NOT NULL))`;
      const mine = ctx.role === 'trainer'
        ? `EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id AND st.person_id = $3)`
        : `EXISTS (SELECT 1 FROM slot_expected x WHERE x.slot_id = sl.id AND x.person_id = $3 AND x.mode IN ('onsite','remote') AND (x.dates_ok OR sl.status = 'cancelled'))`;
      const items = await many(tx, `
        SELECT sl.id, sl.status, sl.version, sl.starts_at, sl.ends_at, sl.title, sl.modality, sl.video_url, sl.breaks, sl.cancel_reason,
               slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks) AS pedagogical_minutes,
               ts.title AS session_title, ts.color AS session_color, ts.timezone, pt.title AS part_title,
               coalesce((SELECT json_agg(json_build_object('id', pe.id, 'name', pe.first_name || ' ' || pe.last_name, 'role', st.role)) FROM slot_trainers st JOIN persons pe ON pe.id = st.person_id WHERE st.slot_id = sl.id), '[]') AS trainers,
               coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'address', r.address)) FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = sl.id), '[]') AS resources
               ${ctx.role === 'trainer' ? PARTICIPANT_COUNTS : `, (SELECT x.mode FROM slot_expected x WHERE x.slot_id = sl.id AND x.person_id = $3 LIMIT 1) AS my_mode`}
          FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id LEFT JOIN session_parts pt ON pt.id = sl.part_id
         WHERE sl.starts_at < $2 AND sl.ends_at > $1 AND ${visible} AND ${mine} ORDER BY sl.starts_at`, [from, to, ctx.personId]);
      const changes = await many(tx, `SELECT id, kind, summary, created_at, status FROM planning_changes WHERE person_id = $1 ORDER BY id DESC LIMIT 20`, [ctx.personId]);
      return { role: ctx.role, personId: ctx.personId, items, changes };
    });
  }

  /** Liste des conflits à résoudre : mêmes règles que l'enregistrement, toutes réservations actives. */
  async conflicts(ctx: RequestContext, q: { from: string; to: string }) {
    const { from, to } = this.range(q);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const ids = (await many(tx, `SELECT sl.id FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id
                                    WHERE sl.starts_at < $2 AND sl.ends_at > $1 AND sl.status NOT IN ('cancelled','done') AND ts.status NOT IN ('cancelled','archived')
                                    ORDER BY sl.starts_at LIMIT 501`, [from, to])).map((r) => r.id);
      if (ids.length > 500) throw badRequest('range_too_large', 'Plus de 500 séances sur la période : réduire la période.', 'to');
      const checks = await checkSlots(tx, ids);
      const seen = new Set<string>();
      const pairKey = (i: Issue) => i.other ? [i.rule, i.ref?.id, ...[i.slotId, i.other.slotId].sort()].join('|') : `${i.rule}|${i.slotId}|${i.message}`;
      const keep = (i: Issue) => { const k = pairKey(i); if (seen.has(k)) return false; seen.add(k); return true; };
      const titles = new Map(checks.map((c) => [c.slotId, { title: c.title, startsAt: c.startsAt, endsAt: c.endsAt, sessionId: c.sessionId }]));
      const decorate = (i: Issue) => ({ ...i, slot: titles.get(i.slotId) });
      return {
        blocking: checks.flatMap((c) => c.blocking).filter(keep).map(decorate),
        warnings: checks.flatMap((c) => c.warnings).filter(keep).map(decorate),
        derogations: await many(tx, `SELECT sl.id, sl.starts_at, sl.ends_at, sl.derogation, ts.title AS session_title FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id
                                      WHERE sl.derogation IS NOT NULL AND sl.status <> 'cancelled' AND sl.starts_at < $2 AND sl.ends_at > $1 ORDER BY sl.starts_at`, [from, to]),
        checked: ids.length,
      };
    });
  }

  /**
   * Indicateurs : heures pédagogiques (prévisionnel / réalisé), charge formateur
   * (réservé / disponible), occupation des salles (réservé avec temps tampon / ouverture).
   */
  indicators(ctx: RequestContext, q: { from: string; to: string }) {
    const { from, to } = this.range(q);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const settings = await loadSettings(tx);
      const tz = (await one(tx, `SELECT timezone FROM tenants WHERE id = $1`, [ctx.tenantId]))!.timezone as string;
      const days: string[] = [];
      for (let d = local(from, tz).date; d < local(to, tz).date || days.length === 0; d = addDays(d, 1)) days.push(d);
      const hours = await one(tx, `
        SELECT coalesce(sum(slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks)) FILTER (WHERE sl.status <> 'cancelled'), 0)::int AS planned_minutes,
               coalesce(sum(slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks)) FILTER (WHERE sl.status = 'done'), 0)::int AS done_minutes,
               count(*) FILTER (WHERE sl.status <> 'cancelled')::int AS slots,
               count(*) FILTER (WHERE sl.status <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id))::int AS without_trainer,
               count(*) FILTER (WHERE sl.status <> 'cancelled' AND ${INCOMPLETE})::int AS incomplete
          FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id
         WHERE sl.starts_at < $2 AND sl.ends_at > $1 AND ts.status NOT IN ('cancelled','archived')`, [from, to]);
      const byStatus = await many(tx, `SELECT sl.status, count(*)::int AS n FROM slots sl WHERE sl.starts_at < $2 AND sl.ends_at > $1 GROUP BY 1`, [from, to]);
      // Minutes disponibles d'un horaire hebdomadaire sur la période, moins les indisponibilités.
      const weeklyMinutes = (h: WeeklyHours, fallbackPerWeek: number | null) => {
        if (!h) return fallbackPerWeek == null ? null : Math.round(fallbackPerWeek * days.filter((d) => settings.workdays.includes(dowOf(d))).length / Math.max(1, settings.workdays.length));
        return days.reduce((a, d) => a + (h[String(dowOf(d))] ?? []).reduce((x, [f, t]) => x + (t === '24:00' ? 1440 : hmToMin(t)) - hmToMin(f), 0), 0);
      };
      const unavailable = async (ownerId: string) => Number((await one(tx, `
        SELECT coalesce(sum(extract(epoch FROM least(ends_at, $3) - greatest(starts_at, $2)) / 60), 0)::int AS m FROM availabilities
         WHERE owner_id = $1 AND kind = 'unavailable' AND status = 'approved' AND starts_at < $3 AND ends_at > $2`, [ownerId, from, to]))!.m);
      const trainers = await many(tx, `
        SELECT pe.id, pe.first_name || ' ' || pe.last_name AS name, tp.working_hours, tp.max_weekly_minutes,
               coalesce(sum(extract(epoch FROM sl.ends_at - sl.starts_at) / 60) FILTER (WHERE sl.status <> 'done'), 0)::int AS planned_minutes,
               coalesce(sum(extract(epoch FROM sl.ends_at - sl.starts_at) / 60) FILTER (WHERE sl.status = 'done'), 0)::int AS done_minutes
          FROM persons pe JOIN person_roles r ON r.person_id = pe.id AND r.role = 'trainer' LEFT JOIN trainer_profiles tp ON tp.person_id = pe.id
          LEFT JOIN slot_trainers st ON st.person_id = pe.id
          LEFT JOIN slots sl ON sl.id = st.slot_id AND sl.status <> 'cancelled' AND sl.starts_at < $2 AND sl.ends_at > $1
         WHERE pe.archived_at IS NULL GROUP BY pe.id, tp.working_hours, tp.max_weekly_minutes ORDER BY pe.last_name`, [from, to]);
      for (const t of trainers) {
        const avail = weeklyMinutes(t.working_hours, t.max_weekly_minutes ?? settings.default_weekly_minutes);
        t.available_minutes = avail == null ? null : Math.max(0, avail - await unavailable(t.id));
        t.load = t.available_minutes ? Math.round(((t.planned_minutes + t.done_minutes) / t.available_minutes) * 1000) / 10 : null;
        delete t.working_hours;
      }
      const dayStart = hmToMin(settings.day_start); const dayEnd = hmToMin(settings.day_end);
      const rooms = await many(tx, `
        SELECT r.id, r.name, r.kind, r.opening_hours,
               coalesce(sum(extract(epoch FROM sl.ends_at - sl.starts_at) / 60 + r.setup_minutes + r.teardown_minutes) FILTER (WHERE sl.id IS NOT NULL), 0)::int AS reserved_minutes
          FROM resources r LEFT JOIN slot_resources sr ON sr.resource_id = r.id
          LEFT JOIN slots sl ON sl.id = sr.slot_id AND sl.status <> 'cancelled' AND sl.starts_at < $2 AND sl.ends_at > $1
         WHERE r.archived_at IS NULL AND r.kind IN ('room','equipment') GROUP BY r.id ORDER BY r.kind, r.name`, [from, to]);
      for (const r of rooms) {
        const open = r.opening_hours ? weeklyMinutes(r.opening_hours, null)! : days.filter((d) => settings.workdays.includes(dowOf(d))).length * (dayEnd - dayStart);
        r.open_minutes = Math.max(0, open - await unavailable(r.id));
        r.occupancy = r.open_minutes ? Math.round((r.reserved_minutes / r.open_minutes) * 1000) / 10 : null;
        delete r.opening_hours;
      }
      return { from, to, ...hours, byStatus, trainers, rooms, note: 'Prévisionnel = séances non annulées ; réalisé = statut Réalisé. Charge = heures réservées / heures disponibles ; occupation = temps réservé (tampons compris) / ouverture.' };
    });
  }

  /** Ressources libres (avec raisons d'indisponibilité) et prochains créneaux compatibles. */
  suggest(ctx: RequestContext, b: { slotId?: string; sessionId: string; kind: 'trainer' | 'room' | 'equipment' | 'slot' } & SlotFields & { startsAt: string; endsAt: string }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const { kind, slotId, sessionId, ...fields } = b;
      const target = slotId ? { slotId } : { sessionId };
      const reasons = (c: any) => [...c.blocking, ...c.warnings].map((i: Issue) => ({ rule: i.rule, severity: i.severity, message: i.message }));
      if (kind === 'trainer') {
        const list = await many(tx, `SELECT pe.id, pe.first_name || ' ' || pe.last_name AS name FROM persons pe JOIN person_roles r ON r.person_id = pe.id AND r.role = 'trainer' WHERE pe.archived_at IS NULL ORDER BY pe.last_name`);
        const out = [];
        for (const t of list) {
          out.push(await this.engine.simulate(tx, ctx, target, { ...fields, trainers: [{ id: t.id }] },
            ['trainer_overlap', 'travel_time', 'unavailable', 'inactive_trainer', 'site_not_allowed', 'skill', 'trainer_hours', 'trainer_load'],
            (c) => ({ ...t, available: !c.blocking.length, reasons: reasons(c) })));
        }
        return out.sort((a, b) => Number(b.available) - Number(a.available));
      }
      if (kind === 'room' || kind === 'equipment') {
        const list = await many(tx, `SELECT id, name, capacity, category FROM resources WHERE kind = $1 AND archived_at IS NULL ORDER BY name`, [kind]);
        const keep = fields.resourceIds?.length ? (await many(tx, `SELECT id FROM resources WHERE id = ANY($1::uuid[]) AND kind <> $2`, [fields.resourceIds, kind])).map((r) => r.id) : [];
        const out = [];
        for (const r of list) {
          out.push(await this.engine.simulate(tx, ctx, target, { ...fields, resourceIds: [...keep, r.id] },
            ['resource_overlap', 'setup_time', 'unavailable', 'outside_hours', 'capacity', 'equipment_required', 'closure', 'inspection_overdue'],
            (c) => ({ ...r, available: !c.blocking.some((i) => i.ref?.id === r.id || i.rule === 'capacity'), reasons: reasons(c).filter((x: any) => x.severity === 'blocking') })));
        }
        return out.sort((a, b) => Number(b.available) - Number(a.available));
      }
      // Prochains créneaux : même horaire local, jours ouvrés suivants (30 jours).
      const settings = await loadSettings(tx);
      const s = await one(tx, `SELECT timezone FROM training_sessions WHERE id = $1`, [sessionId]);
      const tz = s!.timezone; const ls = local(fields.startsAt, tz); const le = local(fields.endsAt, tz);
      const span = Math.round((Date.parse(le.date) - Date.parse(ls.date)) / 86400000);
      const out: any[] = [];
      for (let d = 1; d <= 30 && out.length < 5; d++) {
        const date = addDays(ls.date, d);
        if (!settings.workdays.includes(dowOf(date))) continue;
        const zs = zoned(date, ls.hm, tz); const ze = zoned(addDays(date, span), le.hm, tz);
        if (zs.status !== 'ok' || ze.status !== 'ok') continue;
        const c = await this.engine.simulate(tx, ctx, target, { ...fields, startsAt: zs.at.toISOString(), endsAt: ze.at.toISOString() }, undefined);
        if (!c.blocking.length) out.push({ startsAt: zs.at.toISOString(), endsAt: ze.at.toISOString(), warnings: c.warnings.map((i) => i.message) });
      }
      return out;
    });
  }

  /** Contrôle en direct d'un formulaire ou d'un glisser-déposer, sans écriture. */
  check(ctx: RequestContext, b: { slotId?: string; sessionId?: string } & SlotFields) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const { slotId, sessionId, ...fields } = b;
      return this.engine.simulate(tx, ctx, slotId ? { slotId } : { sessionId }, fields, undefined);
    });
  }

  history(ctx: RequestContext, q: { slotId?: string; sessionId?: string; limit?: number }) {
    if (!q.slotId && !q.sessionId) throw badRequest('filter_required', 'slotId ou sessionId requis.');
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT h.id, h.slot_id, h.session_id, h.version, h.action, h.at, h.reason, h.changes, h.rules, u.full_name AS actor,
             coalesce(h.after, h.before)->>'starts_at' AS starts_at, coalesce(h.after, h.before)->>'title' AS title
        FROM planning_history h LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE ($1::uuid IS NULL OR h.slot_id = $1) AND ($2::uuid IS NULL OR h.session_id = $2) ORDER BY h.id DESC LIMIT $3`,
      [q.slotId ?? null, q.sessionId ?? null, Math.min(q.limit ?? 200, 1000)]));
  }

  /** Flux d'événements sortants : identifiant unique, version, horodatage ; curseur seq. */
  events(ctx: RequestContext, q: { after?: number; limit?: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT seq, id, type, slot_id, session_id, version, occurred_at, payload FROM planning_events
                                                              WHERE seq > $1 ORDER BY seq LIMIT $2`, [q.after ?? 0, Math.min(q.limit ?? 100, 1000)]));
  }

  // ─── Exports (mêmes filtres et même périmètre que la lecture) ──────────
  async exportCsv(ctx: RequestContext, q: SlotQuery) {
    const { items } = await this.slots(ctx, { ...q, limit: 5000 });
    const head = ['Début', 'Fin', 'Durée (min)', 'Durée pédagogique (min)', 'Session', 'Référence', 'Séance', 'Module', 'Lieu', 'Salles', 'Matériel', 'Formateurs', 'Modalité', 'Statut', 'Participants attendus'];
    const fmt = (d: string, tz: string) => { const l = local(d, tz); return `${l.date} ${l.hm}`; };
    const lines = items.map((s: any) => [fmt(s.starts_at, s.timezone), fmt(s.ends_at, s.timezone), Math.round((+new Date(s.ends_at) - +new Date(s.starts_at)) / 60000), s.pedagogical_minutes,
      s.session_title, s.session_reference ?? '', s.title ?? '', s.part_title ?? '', s.resources.filter((r: any) => r.kind === 'site').map((r: any) => r.name).join(' | '),
      s.resources.filter((r: any) => r.kind === 'room').map((r: any) => r.name).join(' | '), s.resources.filter((r: any) => r.kind === 'equipment').map((r: any) => r.name).join(' | '),
      s.trainers.map((t: any) => t.name).join(' | '), MODALITY_LABEL[s.modality], STATUS_LABEL[s.status], (s.expected_onsite ?? 0) + (s.expected_remote ?? 0)]);
    return '\ufeff' + [head, ...lines].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  async exportPdf(ctx: RequestContext, q: SlotQuery & { groupBy?: 'session' | 'trainer' | 'room' | 'group' }) {
    const { items, truncated } = await this.slots(ctx, { ...q, limit: 3000 });
    const groupBy = q.groupBy ?? 'session';
    const groups = new Map<string, any[]>();
    const keys = (s: any): string[] => groupBy === 'trainer' ? (s.trainers.length ? s.trainers.map((t: any) => t.name) : ['Sans formateur'])
      : groupBy === 'room' ? (s.resources.filter((r: any) => r.kind === 'room').map((r: any) => r.name).concat([]).length ? s.resources.filter((r: any) => r.kind === 'room').map((r: any) => r.name) : ['Sans salle'])
      : groupBy === 'group' ? [s.group_label ?? 'Tous groupes'] : [`${s.session_title}${s.session_reference ? ` (${s.session_reference})` : ''}`];
    for (const s of items) for (const k of keys(s)) { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
    const filters = Object.entries(q).filter(([k, v]) => v && !['from', 'to', 'groupBy', 'limit'].includes(k)).map(([k, v]) => `${k} = ${v}`).join(', ');
    const tz = items[0]?.timezone ?? 'Europe/Paris';
    const blocks: Block[] = [
      { type: 'title', text: 'Planning' },
      { type: 'text', text: `Période : ${fmtDay(q.from, tz)} → ${fmtDay(new Date(+new Date(q.to) - 1), tz)} · regroupement : ${({ session: 'session', trainer: 'formateur', room: 'salle', group: 'groupe' })[groupBy]}${filters ? ` · filtres : ${filters}` : ''}`, size: 9 },
      ...(truncated ? [{ type: 'text' as const, text: 'Attention : export tronqué, affiner la période.', bold: true }] : []),
    ];
    for (const [k, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      blocks.push({ type: 'heading', text: `${k} — ${fmtH(rows.reduce((a, s) => a + (s.status === 'cancelled' ? 0 : s.pedagogical_minutes), 0))}` });
      blocks.push({ type: 'table', columns: [{ label: 'Date', width: 13 }, { label: 'Horaire', width: 13 }, { label: groupBy === 'session' ? 'Séance' : 'Session', width: 30 }, { label: 'Lieu', width: 20 }, { label: groupBy === 'trainer' ? 'Salle' : 'Formateur(s)', width: 22 }, { label: 'Statut', width: 12 }],
        rows: rows.map((s) => [fmtDay(s.starts_at, s.timezone), `${local(s.starts_at, s.timezone).hm}–${local(s.ends_at, s.timezone).hm}`,
          groupBy === 'session' ? (s.title ?? s.part_title ?? '—') : s.session_title,
          s.modality === 'remote' ? 'Distanciel' : s.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', ') || '—',
          groupBy === 'trainer' ? s.resources.filter((r: any) => r.kind === 'room').map((r: any) => r.name).join(', ') || '—' : s.trainers.map((t: any) => t.name).join(', ') || '—',
          STATUS_LABEL[s.status]]) });
    }
    if (!items.length) blocks.push({ type: 'text', text: 'Aucune séance sur la période.' });
    return renderPdf(blocks, { title: 'Planning', footer: `Édité le ${fmtDay(new Date(), tz)}` });
  }

  toIcs(items: any[], name: string) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TMS//Planning//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${ics(name)}`];
    for (const s of items) {
      const place = s.modality === 'remote' ? 'Distanciel' : s.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name + (r.address ? ` (${r.address})` : '')).join(', ');
      lines.push('BEGIN:VEVENT', `UID:${s.id}@tms`, `SEQUENCE:${s.version}`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(s.starts_at)}`, `DTEND:${icsDate(s.ends_at)}`,
        `SUMMARY:${ics((s.title ? `${s.title} — ` : '') + s.session_title)}`, ...(place ? [`LOCATION:${ics(place)}`] : []),
        `DESCRIPTION:${ics([s.part_title, s.trainers?.length ? `Formateur(s) : ${s.trainers.map((t: any) => t.name).join(', ')}` : '', s.video_url ? `Visio : ${s.video_url}` : ''].filter(Boolean).join('\n'))}`,
        `STATUS:${s.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map((l) => (l.length > 74 ? l.match(/.{1,74}/g)!.join('\r\n ') : l)).join('\r\n') + '\r\n';
  }

  async exportIcs(ctx: RequestContext, q: SlotQuery) {
    return this.toIcs((await this.slots(ctx, { ...q, limit: 5000 })).items, 'Planning');
  }
  async meIcs(ctx: RequestContext, q: { from: string; to: string }) {
    return this.toIcs((await this.me(ctx, q)).items, 'Mon planning');
  }
}

