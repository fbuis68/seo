import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { PlanningEngine } from './planning/engine';

export type ResourceKind = 'site' | 'room' | 'equipment';
export interface ResourceInput {
  kind: ResourceKind; name: string; category?: string | null; location?: string | null; address?: string | null;
  capacity?: number | null; serialNumber?: string | null; inspectionDueOn?: string | null; notes?: string | null;
  siteId?: string | null; equipment?: string[]; accessible?: boolean | null; setupMinutes?: number; teardownMinutes?: number;
  openingHours?: Record<string, [string, string][]> | null;
}
export interface SlotInput {
  startsAt: string; endsAt: string; partId?: string | null;
  trainerIds?: string[]; resourceIds?: string[]; overrideReason?: string;
}

const OPEN = (status: string) => !['archived', 'cancelled'].includes(status);

/**
 * Planning d'une session : découpage en parties (ex. 7 h théorie + 7 h pratique engin),
 * créneaux avec un ou plusieurs formateurs et ressources (lieu, salle, matériel CACES…).
 * Chevauchement formateur / salle / matériel : refus, ou dérogation motivée et tracée.
 * Un lieu (« site ») accueille plusieurs créneaux simultanés : jamais en conflit.
 */
@Injectable()
export class PlanningService {
  constructor(private db: Db, private audit: AuditService, private engine: PlanningEngine) {}

  // ─── Ressources : lieux, salles, matériel ───────────────────────────────
  listResources(ctx: RequestContext, q: { kind?: ResourceKind; archived?: boolean }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT r.*, (r.kind = 'equipment' AND r.inspection_due_on IS NOT NULL AND r.inspection_due_on < current_date) AS inspection_overdue
        FROM resources r WHERE ($1::text IS NULL OR r.kind=$1) AND (($2::boolean AND r.archived_at IS NOT NULL) OR (NOT $2::boolean AND r.archived_at IS NULL))
       ORDER BY r.kind, r.name`, [q.kind ?? null, !!q.archived]));
  }

  createResource(ctx: RequestContext, b: ResourceInput) {
    if (b.kind !== 'equipment' && (b.serialNumber || b.inspectionDueOn)) throw badRequest('invalid_resource', 'N° de série et vérification périodique concernent le matériel.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.checkSite(tx, b.siteId, b.kind);
      const r = await one(tx, `INSERT INTO resources(tenant_id, kind, name, category, location, address, capacity, serial_number, inspection_due_on, notes,
                                                     site_id, equipment, accessible, setup_minutes, teardown_minutes, opening_hours)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [ctx.tenantId, b.kind, b.name.trim(), b.category ?? null, b.location ?? null, b.address ?? null, b.capacity ?? null, b.serialNumber ?? null, b.inspectionDueOn ?? null, b.notes ?? null,
          b.siteId ?? null, b.equipment ?? [], b.accessible ?? null, b.setupMinutes ?? 0, b.teardownMinutes ?? 0, b.openingHours ? JSON.stringify(b.openingHours) : null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'resource.created', entityType: 'resource', entityId: r!.id, data: { kind: b.kind } });
      return r;
    });
  }

  updateResource(ctx: RequestContext, id: string, b: Partial<ResourceInput>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cols: [string, unknown][] = [['name', b.name], ['category', b.category], ['location', b.location], ['address', b.address],
        ['capacity', b.capacity], ['serial_number', b.serialNumber], ['inspection_due_on', b.inspectionDueOn], ['notes', b.notes],
        ['site_id', b.siteId], ['equipment', b.equipment], ['accessible', b.accessible], ['setup_minutes', b.setupMinutes], ['teardown_minutes', b.teardownMinutes],
        ['opening_hours', b.openingHours === undefined ? undefined : b.openingHours && JSON.stringify(b.openingHours)]];
      if (b.siteId) { const cur = await one(tx, `SELECT kind FROM resources WHERE id=$1`, [id]); if (cur) await this.checkSite(tx, b.siteId, cur.kind, id); }
      const set = cols.filter(([, v]) => v !== undefined);
      if (!set.length) return one(tx, `SELECT * FROM resources WHERE id=$1`, [id]);
      const r = await one(tx, `UPDATE resources SET ${set.map(([c], i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...set.map(([, v]) => v)]);
      if (!r) throw notFound('Ressource');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'resource.updated', entityType: 'resource', entityId: id, data: { fields: set.map(([c]) => c) } });
      return r;
    });
  }

  private async checkSite(tx: Tx, siteId: string | null | undefined, kind: string, selfId?: string) {
    if (!siteId) return;
    if (kind === 'site' || siteId === selfId) throw badRequest('invalid_site', 'Un site ne se rattache pas à un autre site.', 'siteId');
    if (!(await one(tx, `SELECT 1 FROM resources WHERE id=$1 AND kind='site'`, [siteId]))) throw badRequest('invalid_site', 'Site inconnu.', 'siteId');
  }

  /** Archivage : la ressource reste visible sur les créneaux passés, n'est plus proposée. */
  archiveResource(ctx: RequestContext, id: string, archived: boolean) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const r = await one(tx, `UPDATE resources SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`, [id, archived]);
      if (!r) throw notFound('Ressource');
      return r;
    });
  }

  // ─── Parties de session ─────────────────────────────────────────────────
  private async openSession(tx: Tx, sessionId: string, allowCompleted = true) {
    const s = await one(tx, `SELECT id, status FROM training_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!s) throw notFound('Session');
    if (!OPEN(s.status) || (!allowCompleted && s.status === 'completed')) throw conflict('session_closed', 'Session close.');
    return s;
  }

  createPart(ctx: RequestContext, sessionId: string, b: { title: string; plannedMinutes: number; notes?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.openSession(tx, sessionId);
      const pos = await one(tx, `SELECT coalesce(max(position), 0) + 1 n FROM session_parts WHERE session_id=$1`, [sessionId]);
      const pt = await one(tx, `INSERT INTO session_parts(tenant_id, session_id, title, planned_minutes, position, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, sessionId, b.title.trim(), b.plannedMinutes, pos!.n, b.notes ?? null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.part_created', entityType: 'session', entityId: sessionId, data: { partId: pt!.id, title: b.title } });
      return pt;
    });
  }

  updatePart(ctx: RequestContext, partId: string, b: { title?: string; plannedMinutes?: number; position?: number; notes?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const pt = await one(tx, `SELECT session_id FROM session_parts WHERE id=$1`, [partId]);
      if (!pt) throw notFound('Partie');
      await this.openSession(tx, pt.session_id);
      return one(tx, `UPDATE session_parts SET title=coalesce($2,title), planned_minutes=coalesce($3,planned_minutes), position=coalesce($4,position),
                        notes = CASE WHEN $5::boolean THEN $6 ELSE notes END WHERE id=$1 RETURNING *`,
        [partId, b.title ?? null, b.plannedMinutes ?? null, b.position ?? null, b.notes !== undefined, b.notes ?? null]);
    });
  }

  /** Suppression d'une partie : ses créneaux sont conservés, simplement détachés. */
  deletePart(ctx: RequestContext, partId: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const pt = await one(tx, `SELECT session_id FROM session_parts WHERE id=$1`, [partId]);
      if (!pt) throw notFound('Partie');
      await this.openSession(tx, pt.session_id);
      await tx.query(`UPDATE slots SET part_id=NULL WHERE part_id=$1`, [partId]);
      await tx.query(`DELETE FROM session_parts WHERE id=$1`, [partId]);
      return { deleted: true };
    });
  }

  // ─── Séances (routes historiques de la fiche session) : moteur de planning ─────
  // Mêmes contrôles que l'écran planning ; overrideReason = demande de dérogation motivée.
  addSlot(ctx: RequestContext, sessionId: string, b: SlotInput) {
    return this.engine.create(ctx, sessionId, {
      startsAt: b.startsAt, endsAt: b.endsAt, partId: b.partId, trainers: (b.trainerIds ?? []).map((id) => ({ id })), resourceIds: b.resourceIds ?? [],
    }, { derogation: b.overrideReason });
  }

  updateSlot(ctx: RequestContext, slotId: string, b: Partial<SlotInput> & { version?: number }) {
    return this.engine.update(ctx, slotId, {
      startsAt: b.startsAt, endsAt: b.endsAt, partId: b.partId, version: b.version,
      trainers: b.trainerIds?.map((id) => ({ id })), resourceIds: b.resourceIds,
    }, { derogation: b.overrideReason });
  }

  deleteSlot(ctx: RequestContext, slotId: string) { return this.engine.remove(ctx, slotId); }

  /**
   * Formateurs sur plusieurs séances d'un coup : toute la session, un module ou une sélection.
   * mode replace (défaut) / add / remove. Tout ou rien en cas de conflit.
   */
  async assignTrainers(ctx: RequestContext, sessionId: string, b: { trainerIds: string[]; slotIds?: string[]; partId?: string; mode?: 'replace' | 'add' | 'remove'; overrideReason?: string }) {
    const ids = await this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.openSession(tx, sessionId);
      if (b.partId && !(await one(tx, `SELECT 1 FROM session_parts WHERE id=$1 AND session_id=$2`, [b.partId, sessionId]))) throw badRequest('invalid_part', 'Partie inconnue pour cette session.', 'partId');
      const slots = await many(tx, `SELECT id FROM slots WHERE session_id=$1 AND status NOT IN ('cancelled','done')
                                      AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) AND ($3::uuid IS NULL OR part_id=$3) ORDER BY starts_at`,
        [sessionId, b.slotIds?.length ? b.slotIds : null, b.partId ?? null]);
      if (!slots.length) throw badRequest('no_slot', b.partId ? 'Aucune séance dans cette partie : ajoutez d’abord des séances.' : 'Aucune séance à affecter : ajoutez d’abord une séance à la session.');
      if (b.slotIds?.length && slots.length !== new Set(b.slotIds).size) throw notFound('Séance');
      return slots.map((x) => x.id as string);
    });
    const r = await this.engine.bulk(ctx, { slotIds: ids, trainers: { ids: [...new Set(b.trainerIds)], mode: b.mode ?? 'replace' } }, { derogation: b.overrideReason });
    return { ...r, overlaps: [] };
  }
}
