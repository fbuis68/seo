import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';

export type ResourceKind = 'site' | 'room' | 'equipment';
export interface ResourceInput {
  kind: ResourceKind; name: string; category?: string | null; location?: string | null; address?: string | null;
  capacity?: number | null; serialNumber?: string | null; inspectionDueOn?: string | null; notes?: string | null;
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
  constructor(private db: Db, private audit: AuditService) {}

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
      const r = await one(tx, `INSERT INTO resources(tenant_id, kind, name, category, location, address, capacity, serial_number, inspection_due_on, notes)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.tenantId, b.kind, b.name.trim(), b.category ?? null, b.location ?? null, b.address ?? null, b.capacity ?? null, b.serialNumber ?? null, b.inspectionDueOn ?? null, b.notes ?? null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'resource.created', entityType: 'resource', entityId: r!.id, data: { kind: b.kind } });
      return r;
    });
  }

  updateResource(ctx: RequestContext, id: string, b: Partial<ResourceInput>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cols: [string, unknown][] = [['name', b.name], ['category', b.category], ['location', b.location], ['address', b.address],
        ['capacity', b.capacity], ['serial_number', b.serialNumber], ['inspection_due_on', b.inspectionDueOn], ['notes', b.notes]];
      const set = cols.filter(([, v]) => v !== undefined);
      if (!set.length) return one(tx, `SELECT * FROM resources WHERE id=$1`, [id]);
      const r = await one(tx, `UPDATE resources SET ${set.map(([c], i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...set.map(([, v]) => v)]);
      if (!r) throw notFound('Ressource');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'resource.updated', entityType: 'resource', entityId: id, data: { fields: set.map(([c]) => c) } });
      return r;
    });
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

  // ─── Créneaux ───────────────────────────────────────────────────────────
  private async validateRefs(tx: Tx, sessionId: string, b: { partId?: string | null; trainerIds?: string[]; resourceIds?: string[] }) {
    if (b.partId && !(await one(tx, `SELECT 1 FROM session_parts WHERE id=$1 AND session_id=$2`, [b.partId, sessionId]))) {
      throw badRequest('invalid_part', 'Partie inconnue pour cette session.', 'partId');
    }
    const trainers = [...new Set(b.trainerIds ?? [])];
    if (trainers.length) {
      const ok = await many(tx, `SELECT person_id FROM person_roles WHERE role='trainer' AND person_id = ANY($1::uuid[])`, [trainers]);
      if (ok.length !== trainers.length) throw badRequest('not_a_trainer', "Une des personnes n'a pas le rôle formateur.", 'trainerIds');
    }
    const resources = [...new Set(b.resourceIds ?? [])];
    if (resources.length) {
      const ok = await many(tx, `SELECT id FROM resources WHERE archived_at IS NULL AND id = ANY($1::uuid[])`, [resources]);
      if (ok.length !== resources.length) throw badRequest('invalid_resource', 'Ressource inconnue ou archivée.', 'resourceIds');
    }
    return { trainers, resources };
  }

  /** Chevauchements formateur / salle / matériel avec d'autres créneaux actifs. */
  private async findConflicts(tx: Tx, startsAt: string | Date, endsAt: string | Date, trainers: string[], resources: string[], excludeSlotId: string | null) {
    const out: any[] = [];
    if (trainers.length) out.push(...await many(tx, `
      SELECT sl.id slot_id, ts.id session_id, ts.title session_title, sl.starts_at, sl.ends_at, 'trainer' kind, p.id ref_id, p.first_name || ' ' || p.last_name AS label
        FROM slot_trainers st JOIN slots sl ON sl.id=st.slot_id JOIN training_sessions ts ON ts.id=sl.session_id JOIN persons p ON p.id=st.person_id
       WHERE st.person_id = ANY($3::uuid[]) AND ($4::uuid IS NULL OR sl.id <> $4) AND ts.status NOT IN ('cancelled','archived')
         AND sl.starts_at < $2 AND sl.ends_at > $1`, [startsAt, endsAt, trainers, excludeSlotId]));
    if (resources.length) out.push(...await many(tx, `
      SELECT sl.id slot_id, ts.id session_id, ts.title session_title, sl.starts_at, sl.ends_at, r.kind, r.id ref_id, r.name AS label
        FROM slot_resources sr JOIN resources r ON r.id=sr.resource_id JOIN slots sl ON sl.id=sr.slot_id JOIN training_sessions ts ON ts.id=sl.session_id
       WHERE sr.resource_id = ANY($3::uuid[]) AND r.kind <> 'site' AND ($4::uuid IS NULL OR sl.id <> $4) AND ts.status NOT IN ('cancelled','archived')
         AND sl.starts_at < $2 AND sl.ends_at > $1`, [startsAt, endsAt, resources, excludeSlotId]));
    return out;
  }

  private overlapError(conflicts: any[]) {
    const labels = [...new Set(conflicts.map((c) => `${c.label} (${c.session_title})`))].join(', ');
    return conflict('slot_overlap', `Chevauchement : ${labels} déjà réservé(s) sur ce créneau.`, conflicts);
  }

  private async setLinks(tx: Tx, tenantId: string, slotId: string, trainers?: string[], resources?: string[]) {
    if (trainers) {
      await tx.query(`DELETE FROM slot_trainers WHERE slot_id=$1`, [slotId]);
      for (const t of trainers) await tx.query(`INSERT INTO slot_trainers(tenant_id, slot_id, person_id) VALUES ($1,$2,$3)`, [tenantId, slotId, t]);
    }
    if (resources) {
      await tx.query(`DELETE FROM slot_resources WHERE slot_id=$1`, [slotId]);
      for (const r of resources) await tx.query(`INSERT INTO slot_resources(tenant_id, slot_id, resource_id) VALUES ($1,$2,$3)`, [tenantId, slotId, r]);
    }
  }

  async addSlot(ctx: RequestContext, sessionId: string, b: SlotInput) {
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('invalid_slot', 'La fin doit être postérieure au début.', 'endsAt');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.openSession(tx, sessionId, false);
      const { trainers, resources } = await this.validateRefs(tx, sessionId, b);
      const conflicts = await this.findConflicts(tx, b.startsAt, b.endsAt, trainers, resources, null);
      if (conflicts.length && !b.overrideReason) throw this.overlapError(conflicts);
      const slot = await one(tx, `INSERT INTO slots(tenant_id, session_id, part_id, starts_at, ends_at, overlap_override_reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, sessionId, b.partId ?? null, b.startsAt, b.endsAt, conflicts.length ? b.overrideReason : null]);
      await this.setLinks(tx, ctx.tenantId, slot!.id, trainers, resources);
      if (conflicts.length) await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'slot.overlap_override', entityType: 'slot', entityId: slot!.id, data: { reason: b.overrideReason, conflicts } });
      return { ...slot, trainerIds: trainers, resourceIds: resources, overlaps: conflicts };
    });
  }

  /** Modification d'un créneau (horaires, partie, formateurs, ressources) ; les listes fournies remplacent l'existant. */
  async updateSlot(ctx: RequestContext, slotId: string, b: Partial<SlotInput>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cur = await one(tx, `SELECT * FROM slots WHERE id=$1 FOR UPDATE`, [slotId]);
      if (!cur) throw notFound('Créneau');
      await this.openSession(tx, cur.session_id);
      const startsAt = b.startsAt ?? cur.starts_at; const endsAt = b.endsAt ?? cur.ends_at;
      if (new Date(endsAt) <= new Date(startsAt)) throw badRequest('invalid_slot', 'La fin doit être postérieure au début.', 'endsAt');
      if ((b.startsAt || b.endsAt) && (await one(tx, `SELECT 1 FROM attendance WHERE slot_id=$1`, [slotId]))) {
        throw conflict('slot_has_attendance', 'Présences déjà saisies sur ce créneau : horaires non modifiables.');
      }
      const { trainers, resources } = await this.validateRefs(tx, cur.session_id, b);
      const keepT = b.trainerIds ? trainers : (await many(tx, `SELECT person_id FROM slot_trainers WHERE slot_id=$1`, [slotId])).map((x) => x.person_id);
      const keepR = b.resourceIds ? resources : (await many(tx, `SELECT resource_id FROM slot_resources WHERE slot_id=$1`, [slotId])).map((x) => x.resource_id);
      const conflicts = await this.findConflicts(tx, startsAt, endsAt, keepT, keepR, slotId);
      if (conflicts.length && !b.overrideReason) throw this.overlapError(conflicts);
      const slot = await one(tx, `UPDATE slots SET starts_at=$2, ends_at=$3, part_id = CASE WHEN $4::boolean THEN $5::uuid ELSE part_id END,
                                    overlap_override_reason = CASE WHEN $6::boolean THEN $7 ELSE overlap_override_reason END WHERE id=$1 RETURNING *`,
        [slotId, startsAt, endsAt, b.partId !== undefined, b.partId ?? null, conflicts.length > 0, b.overrideReason ?? null]);
      await this.setLinks(tx, ctx.tenantId, slotId, b.trainerIds ? trainers : undefined, b.resourceIds ? resources : undefined);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'slot.updated', entityType: 'slot', entityId: slotId,
        data: { fields: Object.keys(b), overrideReason: conflicts.length ? b.overrideReason : undefined } });
      return { ...slot, overlaps: conflicts };
    });
  }

  async deleteSlot(ctx: RequestContext, slotId: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cur = await one(tx, `SELECT session_id FROM slots WHERE id=$1`, [slotId]);
      if (!cur) throw notFound('Créneau');
      await this.openSession(tx, cur.session_id);
      if (await one(tx, `SELECT 1 FROM attendance WHERE slot_id=$1`, [slotId])) throw conflict('slot_has_attendance', 'Présences déjà saisies : créneau non supprimable.');
      await tx.query(`DELETE FROM slots WHERE id=$1`, [slotId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'slot.deleted', entityType: 'slot', entityId: slotId });
      return { deleted: true };
    });
  }

  /**
   * Formateurs sur plusieurs créneaux d'un coup : toute la session, une partie ou une sélection.
   * mode replace (défaut) / add / remove. Tout ou rien en cas de chevauchement non justifié.
   */
  async assignTrainers(ctx: RequestContext, sessionId: string, b: { trainerIds: string[]; slotIds?: string[]; partId?: string; mode?: 'replace' | 'add' | 'remove'; overrideReason?: string }) {
    const mode = b.mode ?? 'replace';
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.openSession(tx, sessionId);
      const { trainers } = await this.validateRefs(tx, sessionId, { trainerIds: b.trainerIds, partId: b.partId });
      const slots = await many(tx, `SELECT id, starts_at, ends_at FROM slots WHERE session_id=$1
                                      AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) AND ($3::uuid IS NULL OR part_id=$3) ORDER BY starts_at`,
        [sessionId, b.slotIds?.length ? b.slotIds : null, b.partId ?? null]);
      if (!slots.length) throw badRequest('no_slot', b.partId ? 'Aucun créneau dans cette partie : ajoutez d’abord des créneaux.' : 'Aucun créneau à affecter : ajoutez d’abord un créneau à la session.');
      if (b.slotIds?.length && slots.length !== new Set(b.slotIds).size) throw notFound('Créneau');
      const targets = new Map<string, string[]>();
      for (const sl of slots) {
        const current = (await many(tx, `SELECT person_id FROM slot_trainers WHERE slot_id=$1`, [sl.id])).map((x) => x.person_id as string);
        targets.set(sl.id, mode === 'replace' ? trainers : mode === 'add' ? [...new Set([...current, ...trainers])] : current.filter((t) => !trainers.includes(t)));
      }
      const conflicts: any[] = [];
      if (mode !== 'remove') {
        for (const sl of slots) conflicts.push(...(await this.findConflicts(tx, sl.starts_at, sl.ends_at, trainers, [], sl.id)).map((c) => ({ ...c, target_slot_id: sl.id })));
      }
      if (conflicts.length && !b.overrideReason) throw this.overlapError(conflicts);
      for (const sl of slots) {
        await this.setLinks(tx, ctx.tenantId, sl.id, targets.get(sl.id));
        if (conflicts.some((c) => c.target_slot_id === sl.id)) await tx.query(`UPDATE slots SET overlap_override_reason=$2 WHERE id=$1`, [sl.id, b.overrideReason]);
      }
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.trainers_assigned', entityType: 'session', entityId: sessionId,
        data: { mode, trainerIds: trainers, partId: b.partId, slots: slots.map((x) => x.id), overrideReason: conflicts.length ? b.overrideReason : undefined } });
      return { updated: slots.length, overlaps: conflicts };
    });
  }
}
