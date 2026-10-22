import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { toCents } from '../../core/decimal';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { EntitlementsService } from '../billing/entitlements.service';
import { PlanningEngine } from './planning/engine';
import { reconcileEnrollment } from './planning/rules';
import { lock } from '../../core/db';

const fmtH = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;

/** Créneaux avec partie, formateurs et ressources (lieux, salles, matériel). */
export const SLOTS_SQL = `
  SELECT sl.id, sl.session_id, sl.part_id, sl.starts_at, sl.ends_at, sl.status, sl.version, sl.title, sl.modality, sl.video_url, sl.breaks,
         sl.group_label, sl.notes, sl.series_id, sl.derogation, sl.cancel_reason, sl.published_at,
         extract(epoch FROM sl.ends_at - sl.starts_at)::int / 60 AS duration_minutes,
         slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks) AS pedagogical_minutes,
         coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'role', st.role) ORDER BY st.role DESC, p.last_name)
                     FROM slot_trainers st JOIN persons p ON p.id=st.person_id WHERE st.slot_id=sl.id), '[]') AS trainers,
         coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'category', r.category, 'inspection_due_on', r.inspection_due_on) ORDER BY r.kind, r.name)
                     FROM slot_resources sr JOIN resources r ON r.id=sr.resource_id WHERE sr.slot_id=sl.id), '[]') AS resources,
         (SELECT count(*) FROM slot_expected x WHERE x.slot_id = sl.id AND x.mode IN ('onsite','remote') AND x.dates_ok)::int AS expected,
         (SELECT count(*) FROM slot_expected x WHERE x.slot_id = sl.id AND x.mode = 'to_resolve')::int AS to_resolve,
         (SELECT count(*) FROM attendance a WHERE a.slot_id = sl.id)::int AS attendance_count
    FROM slots sl WHERE sl.session_id=$1 ORDER BY sl.starts_at`;

/** Parties : durée prévue vs planifiée, formateurs intervenant sur la partie. */
export const PARTS_SQL = `
  SELECT pt.id, pt.title, pt.planned_minutes, pt.position, pt.notes,
         coalesce((SELECT sum(slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks)) FROM slots sl WHERE sl.part_id=pt.id AND sl.status <> 'cancelled'), 0)::int AS scheduled_minutes,
         coalesce((SELECT json_agg(DISTINCT jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name))
                     FROM slots sl JOIN slot_trainers st ON st.slot_id=sl.id JOIN persons p ON p.id=st.person_id WHERE sl.part_id=pt.id AND sl.status <> 'cancelled'), '[]') AS trainers
    FROM session_parts pt WHERE pt.session_id=$1 ORDER BY pt.position, pt.created_at`;

export type SessionStatus = 'draft' | 'planned' | 'confirmed' | 'in_progress' | 'completed' | 'archived' | 'cancelled';
const ACTIVE: SessionStatus[] = ['planned', 'confirmed', 'in_progress'];
/** Cycle de vie §5.1 : brouillon → planifiée → confirmée → en cours → terminée → archivée ; annulation motivée. */
export const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['confirmed', 'draft', 'cancelled'],
  confirmed: ['in_progress', 'planned', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['archived'],
  archived: [],
  cancelled: [],
};

export interface SessionInput {
  programVersionId: string; kind: 'inter' | 'intra'; clientId?: string | null; title?: string;
  capacity?: number | null; timezone?: string; startsOn?: string | null; endsOn?: string | null; location?: string | null;
  reference?: string | null; minParticipants?: number | null; siteId?: string | null; responsible?: string | null; targetMinutes?: number | null;
  requiredSkills?: string[]; requiredEquipment?: string[]; color?: string | null; internalNotes?: string | null;
  priceHt?: string | null; priceBasis?: 'per_learner' | 'per_session' | null;
}

@Injectable()
export class SessionsService {
  constructor(private db: Db, private ent: EntitlementsService, private audit: AuditService, private engine: PlanningEngine) {}

  /** Le formateur ne voit que les sessions où il est affecté. */
  private trainerFilter(ctx: RequestContext) {
    return ctx.role === 'trainer' ? ctx.personId ?? '00000000-0000-0000-0000-000000000000' : null;
  }

  list(ctx: RequestContext, q: { status?: string; from?: string; to?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT s.*, p.title program_title, v.version program_version, v.duration_minutes,
        (SELECT count(*) FROM enrollments e WHERE e.session_id=s.id AND e.status <> 'cancelled') enrolled
        FROM training_sessions s JOIN program_versions v ON v.id=s.program_version_id JOIN programs p ON p.id=v.program_id
       WHERE ($1::text IS NULL OR s.status=$1) AND ($2::date IS NULL OR s.starts_on >= $2) AND ($3::date IS NULL OR s.starts_on <= $3)
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM slots sl JOIN slot_trainers st ON st.slot_id=sl.id WHERE sl.session_id=s.id AND st.person_id=$4))
       ORDER BY s.starts_on NULLS LAST, s.created_at LIMIT $5 OFFSET $6`,
      [q.status ?? null, q.from ?? null, q.to ?? null, this.trainerFilter(ctx), q.limit, q.offset]));
  }

  async get(ctx: RequestContext, id: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const s = await one(t, `SELECT s.*, p.title program_title, p.id program_id, v.version program_version, v.duration_minutes, coalesce(s.target_minutes, v.duration_minutes) AS target, v.price_ht, v.vat_rate, v.modality
                                FROM training_sessions s JOIN program_versions v ON v.id=s.program_version_id JOIN programs p ON p.id=v.program_id WHERE s.id=$1`, [id]);
      if (!s) throw notFound('Session');
      const trainer = this.trainerFilter(ctx);
      s.slots = await many(t, SLOTS_SQL, [id]);
      if (trainer && !s.slots.some((x: any) => x.trainers.some((tr: any) => tr.id === trainer))) throw notFound('Session');
      s.parts = await many(t, PARTS_SQL, [id]);
      s.trainers = await many(t, `SELECT DISTINCT p.id, p.first_name || ' ' || p.last_name AS name
                                    FROM slots sl JOIN slot_trainers st ON st.slot_id=sl.id JOIN persons p ON p.id=st.person_id
                                   WHERE sl.session_id=$1 AND sl.status <> 'cancelled' ORDER BY 2`, [id]);
      // Formateur : liste strictement nécessaire des inscrits (pas de données financières).
      s.enrollments = await many(t, `SELECT e.id, e.status, e.person_id, e.starts_on, e.ends_on, e.group_label, p.first_name, p.last_name ${trainer ? '' : ', p.email, e.client_id, c.name client_name'}
                                       FROM enrollments e JOIN persons p ON p.id=e.person_id LEFT JOIN clients c ON c.id=e.client_id
                                      WHERE e.session_id=$1 ORDER BY p.last_name`, [id]);
      s.missing = trainer ? [] : await this.missingPieces(t, s);
      return s;
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  /** Assistant : pièces manquantes, sans bloquer les étapes. */
  private async missingPieces(tx: Tx, s: any) {
    const missing: string[] = [];
    const slots = s.slots.filter((x: any) => x.status !== 'cancelled'); // séances annulées : hors durées et réservations
    if (!slots.length) missing.push('Aucun créneau planifié');
    const noTrainer = slots.filter((x: any) => !x.trainers.length).length;
    if (noTrainer) missing.push(`${noTrainer} créneau(x) sans formateur`);
    const scheduled = slots.reduce((a: number, x: any) => a + x.pedagogical_minutes, 0);
    if (slots.length && scheduled !== s.target) {
      missing.push(`Planning : ${fmtH(scheduled)} planifiées pour ${fmtH(s.target)} prévues au programme (${scheduled < s.target ? 'incomplet' : 'dépassement'})`);
    }
    const unpublished = slots.filter((x: any) => ['draft', 'pending'].includes(x.status)).length;
    if (unpublished) missing.push(`${unpublished} séance(s) non publiée(s)`);
    const toResolve = slots.reduce((a: number, x: any) => a + x.to_resolve, 0);
    if (toResolve) missing.push(`${toResolve} participation(s) à résoudre (collision ou capacité)`);
    if (s.parts.length) {
      const planned = s.parts.reduce((a: number, x: any) => a + x.planned_minutes, 0);
      if (planned !== s.target) missing.push(`Découpage : ${fmtH(planned)} réparties en parties pour ${fmtH(s.target)} au programme`);
      for (const pt of s.parts) if (pt.scheduled_minutes < pt.planned_minutes) missing.push(`Partie « ${pt.title} » : ${fmtH(pt.scheduled_minutes)} planifiées sur ${fmtH(pt.planned_minutes)}`);
      const orphan = slots.filter((x: any) => !x.part_id).length;
      if (orphan) missing.push(`${orphan} créneau(x) non rattaché(s) à une partie`);
    }
    // Matériel (ex. engins CACES) : vérification périodique échue à la date du créneau.
    const day = (d: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(new Date(d)); // AAAA-MM-JJ
    const overdue = new Map<string, string>();
    for (const sl of slots) for (const r of sl.resources) {
      if (r.kind === 'equipment' && r.inspection_due_on && String(r.inspection_due_on).slice(0, 10) < day(sl.starts_at) && !overdue.has(r.id)) {
        overdue.set(r.id, `${r.name} : vérification périodique échue le ${String(r.inspection_due_on).slice(0, 10)} (utilisé le ${day(sl.starts_at)})`);
      }
    }
    missing.push(...overdue.values());
    // Émargement : présences attendues non saisies sur les séances terminées.
    const closure = await closureCheck(tx, s.id);
    const att = closure.issues.find((i) => i.code === 'attendance_missing');
    if (att) missing.push(att.message);
    if (['completed', 'archived'].includes(s.status) && !(await one(tx, `SELECT 1 FROM invoices WHERE session_id=$1`, [s.id]))) missing.push('Session terminée non facturée');
    const docs = await many(tx, `SELECT kind, owner_id FROM documents WHERE owner_type='enrollment' AND owner_id = ANY($1)`, [s.enrollments.map((e: any) => e.id)]);
    const active = s.enrollments.filter((e: any) => e.status !== 'cancelled');
    const without = (kind: string) => active.filter((e: any) => !docs.some((d) => d.owner_id === e.id && d.kind === kind)).length;
    if (active.length && without('convocation')) missing.push(`${without('convocation')} convocation(s) non générée(s)`);
    if (s.kind === 'intra' && !(await one(tx, `SELECT 1 FROM documents WHERE owner_type='session' AND owner_id=$1 AND kind='convention'`, [s.id]))) missing.push('Convention non générée');
    if (['completed'].includes(s.status) && active.length && without('attestation')) missing.push(`${without('attestation')} attestation(s) manquante(s)`);
    return missing;
  }

  create(ctx: RequestContext, b: SessionInput, tx?: Tx) {
    const run = async (t: Tx) => {
      await this.ent.assertQuota(t, ctx.tenantId, 'draftSessions');
      const v = await one(t, `SELECT v.*, p.title FROM program_versions v JOIN programs p ON p.id=v.program_id WHERE v.id=$1`, [b.programVersionId]);
      if (!v) throw notFound('Version de programme');
      if (b.kind === 'intra' && !b.clientId) throw badRequest('client_required', 'Une session intra nécessite un client.', 'clientId');
      // Figer la version de programme utilisée.
      await t.query(`UPDATE program_versions SET locked_at = coalesce(locked_at, now()) WHERE id=$1`, [v.id]);
      const tz = b.timezone ?? (await one(t, `SELECT timezone FROM tenants WHERE id=$1`, [ctx.tenantId]))!.timezone;
      if (b.siteId && !(await one(t, `SELECT 1 FROM resources WHERE id=$1 AND kind='site'`, [b.siteId]))) throw badRequest('invalid_site', 'Site inconnu.', 'siteId');
      const s = await one(t, `INSERT INTO training_sessions(tenant_id, program_version_id, kind, client_id, title, capacity, timezone, starts_on, ends_on, location,
                                reference, min_participants, site_id, responsible, target_minutes, required_skills, required_equipment, color, internal_notes, price_ht, price_basis)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [ctx.tenantId, v.id, b.kind, b.clientId ?? null, b.title ?? v.title, b.capacity ?? null, tz, b.startsOn ?? null, b.endsOn ?? null, b.location ?? null,
          b.reference ?? null, b.minParticipants ?? null, b.siteId ?? null, b.responsible ?? null, b.targetMinutes ?? null, b.requiredSkills ?? [], b.requiredEquipment ?? [], b.color ?? null, b.internalNotes ?? null, b.priceHt ?? null, b.priceBasis ?? null]);
      await this.audit.log(t, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.created', entityType: 'session', entityId: s!.id });
      return s;
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  update(ctx: RequestContext, id: string, version: number, b: Partial<SessionInput>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (b.siteId && !(await one(tx, `SELECT 1 FROM resources WHERE id=$1 AND kind='site'`, [b.siteId]))) throw badRequest('invalid_site', 'Site inconnu.', 'siteId');
      // Champs fournis uniquement (null = effacer pour les champs facultatifs du planning).
      const cols: [string, unknown][] = [['title', b.title], ['capacity', b.capacity], ['starts_on', b.startsOn], ['ends_on', b.endsOn], ['location', b.location],
        ['reference', b.reference], ['min_participants', b.minParticipants], ['site_id', b.siteId], ['responsible', b.responsible], ['target_minutes', b.targetMinutes],
        ['required_skills', b.requiredSkills], ['required_equipment', b.requiredEquipment], ['color', b.color], ['internal_notes', b.internalNotes],
        ['price_ht', b.priceHt], ['price_basis', b.priceBasis]];
      const set = cols.filter(([, v]) => v !== undefined);
      const before = (await one(tx, `SELECT starts_on FROM training_sessions WHERE id=$1`, [id])) ?? {};
      const s = await one(tx, `UPDATE training_sessions SET ${[...set.map(([c], i) => `${c}=$${i + 3}`), 'version=version+1'].join(', ')}
                               WHERE id=$1 AND version=$2 AND status NOT IN ('archived','cancelled') RETURNING *`,
        [id, version, ...set.map(([, v]) => v)]);
      if (!s) throw conflict('version_conflict', 'Session modifiée entre-temps ou close.');
      // Déplacement d'une session planifiée vers un autre mois : quota mensuel du mois d'arrivée.
      if (b.startsOn && s.status !== 'draft' && !s.is_historical && String(b.startsOn).slice(0, 7) !== String(before.starts_on ?? '').slice(0, 7)) {
        await this.ent.assertSessionsPerMonth(tx, ctx.tenantId, b.startsOn, s.id);
      }
      // Modification après démarrage : tracée.
      if (['in_progress', 'completed'].includes(s.status)) await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.modified_after_start', entityType: 'session', entityId: id, data: b });
      return s;
    });
  }

  /** Contrôle de clôture (lecture seule) : séances réalisées, émargement complet. */
  closure(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (!(await one(tx, `SELECT 1 FROM training_sessions WHERE id=$1`, [id]))) throw notFound('Session');
      return closureCheck(tx, id);
    });
  }

  transition(ctx: RequestContext, id: string, to: SessionStatus, reason?: string, force?: boolean) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const s = await one(tx, `SELECT * FROM training_sessions WHERE id=$1 FOR UPDATE`, [id]);
      if (!s) throw notFound('Session');
      if (!TRANSITIONS[s.status as SessionStatus].includes(to)) throw conflict('invalid_transition', `Transition ${s.status} → ${to} impossible.`);
      if (to === 'cancelled' && !reason) throw badRequest('reason_required', "Motif d'annulation obligatoire.", 'reason');
      if (ACTIVE.includes(to) && !ACTIVE.includes(s.status)) await this.ent.assertQuota(tx, ctx.tenantId, 'activeSessions');
      if (!['draft', 'cancelled'].includes(to) && ['draft', 'cancelled'].includes(s.status) && !s.is_historical) await this.ent.assertSessionsPerMonth(tx, ctx.tenantId, s.starts_on, s.id);
      if (to === 'planned' && !s.starts_on) throw badRequest('dates_required', 'Dates requises pour planifier la session.', 'startsOn');
      // Clôture : toutes les séances réalisées (ou annulées) et émargement complet ; forçage motivé et tracé par un responsable.
      if (to === 'completed') {
        const check = await closureCheck(tx, id);
        if (!check.ok) {
          if (!force) throw conflict('closure_incomplete', `Clôture impossible : ${check.issues.map((i) => i.message).join(' ; ')}.`, check);
          if (!ctx.permissions.has('planning.derogate')) throw forbidden('permission_denied', 'Clôture forcée réservée aux responsables (permission planning.derogate).');
          if (!reason || reason.trim().length < 5) throw badRequest('reason_required', 'Motif obligatoire pour forcer la clôture.', 'reason');
          await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.closure_forced', entityType: 'session', entityId: id, data: { reason, issues: check.issues } });
        }
      }
      const r = await one(tx, `UPDATE training_sessions SET status=$2, cancel_reason=coalesce($3,cancel_reason), version=version+1 WHERE id=$1 RETURNING *`, [id, to, to === 'cancelled' ? reason ?? null : null]);
      // Session annulée : séances annulées (réservations libérées, notifications si publiées).
      if (to === 'cancelled') await this.engine.cancelSessionSlots(tx, ctx, id, `Session annulée : ${reason}`);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.status_changed', entityType: 'session', entityId: id, data: { from: s.status, to, reason } });
      return r;
    });
  }

  // ─── Inscriptions et financements ────────────────────────────────────────
  async enroll(ctx: RequestContext, sessionId: string, b: {
    personId: string; clientId?: string | null; status?: 'provisional' | 'confirmed';
    fundedAmount?: string | null; fundings?: { funderClientId: string; amount: string }[];
    startsOn?: string | null; endsOn?: string | null; groupLabel?: string | null;
  }, tx?: Tx) {
    const run = async (t: Tx) => {
      const s = await one(t, `SELECT * FROM training_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
      if (!s) throw notFound('Session');
      if (['archived', 'cancelled', 'completed'].includes(s.status)) throw conflict('session_closed', 'Inscriptions closes pour cette session.');
      if (await one(t, `SELECT 1 FROM enrollments WHERE session_id=$1 AND person_id=$2`, [sessionId, b.personId])) {
        throw conflict('already_enrolled', 'Cet apprenant est déjà inscrit à cette session.');
      }
      if (s.capacity && (b.status ?? 'provisional') === 'confirmed') {
        const n = await one(t, `SELECT count(*) n FROM enrollments WHERE session_id=$1 AND status='confirmed'`, [sessionId]);
        if (Number(n!.n) >= s.capacity) throw conflict('session_full', 'Capacité de la session atteinte.');
      }
      // Ventilation des financements : somme = montant financé.
      const fundings = b.fundings ?? [];
      if (fundings.length || b.fundedAmount) {
        const sum = fundings.reduce((a, f) => a + toCents(f.amount), 0n);
        if (b.fundedAmount == null || sum !== toCents(b.fundedAmount)) throw badRequest('funding_mismatch', 'La ventilation des financeurs doit correspondre exactement au montant financé.', 'fundings');
      }
      // Quota apprenants/an : personne distincte, sessions de l'année civile ; doublons non comptés deux fois.
      const year = s.starts_on ? Number(String(s.starts_on).slice(0, 4)) : new Date().getFullYear();
      const counted = await one(t, `SELECT 1 FROM enrollments e JOIN training_sessions ts ON ts.id=e.session_id
                                     WHERE e.person_id=$1 AND NOT ts.is_historical AND extract(year FROM ts.starts_on)=$2`, [b.personId, year]);
      if (!s.is_historical && !counted) await this.ent.assertQuota(t, ctx.tenantId, 'learnersPerYear', 1, undefined, year);
      await t.query(`INSERT INTO person_roles(tenant_id, person_id, role) VALUES ($1,$2,'learner') ON CONFLICT DO NOTHING`, [ctx.tenantId, b.personId]);
      if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) throw badRequest('invalid_range', 'Date de sortie antérieure à la date d’entrée.', 'endsOn');
      const e = await one(t, `INSERT INTO enrollments(tenant_id, session_id, person_id, client_id, status, starts_on, ends_on, group_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ctx.tenantId, sessionId, b.personId, b.clientId ?? null, b.status ?? 'provisional', b.startsOn ?? null, b.endsOn ?? null, b.groupLabel ?? null]);
      for (const f of fundings) {
        await t.query(`INSERT INTO funding_allocations(tenant_id, enrollment_id, funder_client_id, amount) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, e!.id, f.funderClientId, f.amount]);
      }
      await this.audit.log(t, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'enrollment.created', entityType: 'enrollment', entityId: e!.id });
      // Séances futures revérifiées : collision ou surcapacité → participation à résoudre.
      await lock(t, `planning:${ctx.tenantId}`);
      const toResolve = await reconcileEnrollment(t, ctx.tenantId, e!.id);
      return { ...e, toResolve };
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  /** Groupe ou dates d'entrée/sortie modifiés : revérification des séances futures. */
  updateEnrollment(ctx: RequestContext, id: string, b: { startsOn?: string | null; endsOn?: string | null; groupLabel?: string | null; clientId?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await lock(tx, `planning:${ctx.tenantId}`);
      const cur = await one(tx, `SELECT * FROM enrollments WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur) throw notFound('Inscription');
      const startsOn = b.startsOn !== undefined ? b.startsOn : cur.starts_on; const endsOn = b.endsOn !== undefined ? b.endsOn : cur.ends_on;
      if (startsOn && endsOn && endsOn < startsOn) throw badRequest('invalid_range', 'Date de sortie antérieure à la date d’entrée.', 'endsOn');
      // Client payeur : modifiable tant qu'aucune facture n'a été préparée pour cette inscription.
      if (b.clientId !== undefined && b.clientId !== cur.client_id && (await one(tx, `SELECT 1 FROM billing_items WHERE enrollment_id=$1`, [id]))) {
        throw conflict('enrollment_billed', 'Inscription déjà facturée : supprimez le brouillon ou émettez un avoir avant de changer le client payeur.');
      }
      const e = await one(tx, `UPDATE enrollments SET starts_on=$2, ends_on=$3, group_label=$4, client_id=$5 WHERE id=$1 RETURNING *`,
        [id, startsOn, endsOn, b.groupLabel !== undefined ? b.groupLabel : cur.group_label, b.clientId !== undefined ? b.clientId : cur.client_id]);
      // Nouveau groupe : les exceptions « à résoudre » précédentes sont réévaluées.
      await tx.query(`DELETE FROM slot_participants WHERE enrollment_id=$1 AND mode='to_resolve'`, [id]);
      const toResolve = await reconcileEnrollment(tx, ctx.tenantId, id);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'enrollment.updated', entityType: 'enrollment', entityId: id, data: b });
      return { ...e, toResolve };
    });
  }

  /** Annulation : motif, aucune pièce ni trace supprimée, quota annuel non libéré. */
  setEnrollmentStatus(ctx: RequestContext, id: string, status: 'confirmed' | 'cancelled', reason?: string) {
    if (status === 'cancelled' && !reason) throw badRequest('reason_required', "Motif d'annulation obligatoire.", 'reason');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const e = await one(tx, `UPDATE enrollments SET status=$2, cancel_reason=$3 WHERE id=$1 AND status <> 'cancelled' RETURNING *`, [id, status, reason ?? null]);
      if (!e) throw notFound('Inscription active');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: `enrollment.${status}`, entityType: 'enrollment', entityId: id, data: { reason } });
      return e;
    });
  }

  // ─── Présences ──────────────────────────────────────────────────────────
  /** Présence par apprenant/créneau ; durée effectuée bornée par la durée du créneau. */
  recordAttendance(ctx: RequestContext, b: { enrollmentId: string; slotId: string; status: 'present' | 'absent' | 'partial'; minutes?: number }, proof: Record<string, unknown> = {}) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const r = await one(tx, `SELECT sl.id, slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks) dur, sl.status slot_status, e.status estatus,
                                      EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id=sl.id AND st.person_id=$3) assigned
                                 FROM slots sl JOIN enrollments e ON e.session_id = sl.session_id WHERE sl.id=$1 AND e.id=$2`, [b.slotId, b.enrollmentId, ctx.personId ?? null]);
      if (!r) throw badRequest('slot_enrollment_mismatch', "Créneau et inscription n'appartiennent pas à la même session.");
      if (ctx.role === 'trainer' && !r.assigned) throw forbidden('not_assigned', "Vous n'êtes pas affecté à ce créneau.");
      if (r.estatus === 'cancelled') throw conflict('enrollment_cancelled', 'Inscription annulée.');
      if (r.slot_status === 'cancelled') throw conflict('slot_cancelled', 'Séance annulée : pas d’émargement.');
      const minutes = b.status === 'absent' ? 0 : b.status === 'present' ? (b.minutes ?? r.dur) : b.minutes;
      if (minutes == null || minutes < 0 || minutes > r.dur) throw badRequest('invalid_minutes', `Durée effectuée entre 0 et ${r.dur} minutes.`, 'minutes');
      const method = ctx.role === 'trainer' ? 'trainer' : ctx.role === 'learner' ? 'learner_link' : 'manager';
      const a = await one(tx, `INSERT INTO attendance(tenant_id, enrollment_id, slot_id, status, minutes, method, proof, recorded_by)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                               ON CONFLICT (tenant_id, enrollment_id, slot_id) DO UPDATE SET status=EXCLUDED.status, minutes=EXCLUDED.minutes,
                                 method=EXCLUDED.method, proof=EXCLUDED.proof, recorded_by=EXCLUDED.recorded_by, recorded_at=now(), version=attendance.version+1
                               RETURNING *`,
        [ctx.tenantId, b.enrollmentId, b.slotId, b.status, minutes, method, JSON.stringify({ ...proof, at: new Date().toISOString(), ip: ctx.ip }), ctx.userId]);
      if (a!.version > 1) await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'attendance.corrected', entityType: 'attendance', entityId: a!.id, data: { status: b.status, minutes } });
      // Émargement complet d'une séance publiée et terminée → séance « Réalisé » automatiquement.
      const slotDone = await this.engine.autoDone(tx, ctx, b.slotId);
      return { ...a, slotDone };
    });
  }

  attendanceSheet(ctx: RequestContext, sessionId: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.get(ctx, sessionId, tx); // contrôle d'accès formateur
      return many(tx, `SELECT a.*, p.first_name, p.last_name FROM attendance a JOIN enrollments e ON e.id=a.enrollment_id JOIN persons p ON p.id=e.person_id
                        WHERE e.session_id=$1 ORDER BY a.slot_id, p.last_name`, [sessionId]);
    });
  }
}

/**
 * Clôture d'une session : séances passées réalisées (ou annulées), aucune séance à venir,
 * présences saisies pour chaque participant attendu des séances terminées.
 */
export async function closureCheck(tx: Tx, sessionId: string) {
  const issues: { code: string; message: string; count: number; details?: any[] }[] = [];
  const st = await one(tx, `
    SELECT count(*) FILTER (WHERE ends_at > now())::int AS future,
           count(*) FILTER (WHERE ends_at <= now() AND status <> 'done')::int AS not_done,
           count(*)::int AS total
      FROM slots WHERE session_id = $1 AND status <> 'cancelled'`, [sessionId]);
  if (!st!.total) issues.push({ code: 'no_slot', message: 'aucune séance', count: 0 });
  if (st!.future) issues.push({ code: 'future_slots', message: `${st!.future} séance(s) pas encore terminée(s)`, count: st!.future });
  if (st!.not_done) issues.push({ code: 'slots_not_done', message: `${st!.not_done} séance(s) passée(s) non marquée(s) réalisée(s)`, count: st!.not_done });
  const missing = await many(tx, `
    SELECT x.slot_id, sl.starts_at, pe.first_name || ' ' || pe.last_name AS name
      FROM slot_expected x JOIN slots sl ON sl.id = x.slot_id JOIN persons pe ON pe.id = x.person_id
     WHERE sl.session_id = $1 AND sl.status <> 'cancelled' AND sl.ends_at <= now() AND x.mode IN ('onsite','remote') AND x.dates_ok
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.slot_id = x.slot_id AND a.enrollment_id = x.enrollment_id)
     ORDER BY sl.starts_at, pe.last_name`, [sessionId]);
  if (missing.length) issues.push({ code: 'attendance_missing', message: `${missing.length} présence(s) non saisie(s) sur des séances terminées`, count: missing.length, details: missing.slice(0, 50) });
  return { ok: !issues.length, issues };
}
