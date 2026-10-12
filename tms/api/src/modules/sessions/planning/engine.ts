import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../core/audit.service';
import { RequestContext } from '../../../core/context';
import { Db, Tx, lock, many, one } from '../../../core/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../../core/errors';
import { JobsService } from '../../../core/jobs.service';
import { SystemMailer } from '../../../core/system-mail';
import { Issue, SlotCheck, checkSlots, loadSettings } from './rules';
import { addDays, dowOf, fmtRange, local, zoned } from './time';

export type Modality = 'onsite' | 'remote' | 'hybrid';
export type SlotStatus = 'draft' | 'pending' | 'published' | 'done' | 'cancelled';
export interface Break { startsAt: string; endsAt: string }
export interface SlotFields {
  startsAt?: string; endsAt?: string; title?: string | null; partId?: string | null; modality?: Modality; videoUrl?: string | null;
  breaks?: Break[]; groupLabel?: string | null; notes?: string | null;
  trainers?: { id: string; role?: 'lead' | 'co' }[]; resourceIds?: string[];
  participants?: { enrollmentId: string; mode: 'onsite' | 'remote' | 'excluded' | 'default' }[];
}
export interface WriteOpts { preview?: boolean; derogation?: string; idempotencyKey?: string; reason?: string }

const MAX_SLOT_MS = 24 * 3600000;
const NOTIFY_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 60000; // regroupement des changements successifs

/** Instantané d'une séance : base de l'historique, des différences et des notifications. */
const SNAP_SQL = `
  SELECT sl.id, sl.session_id, sl.status, sl.version, sl.starts_at, sl.ends_at, sl.title, sl.modality, sl.video_url, sl.breaks,
         sl.part_id, sl.group_label, sl.notes, sl.series_id, sl.published_at, ts.title AS session_title, ts.timezone,
         coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'role', st.role) ORDER BY p.last_name, p.id)
                     FROM slot_trainers st JOIN persons p ON p.id = st.person_id WHERE st.slot_id = sl.id), '[]') AS trainers,
         coalesce((SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind) ORDER BY r.kind, r.name, r.id)
                     FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = sl.id), '[]') AS resources,
         coalesce((SELECT json_agg(x.person_id ORDER BY x.person_id) FROM slot_expected x
                    WHERE x.slot_id = sl.id AND x.mode IN ('onsite','remote') AND x.dates_ok), '[]') AS learners
    FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id WHERE sl.id = ANY($1::uuid[])`;

type Snap = Record<string, any>;
async function snapshot(tx: Tx, ids: string[]): Promise<Map<string, Snap>> {
  const rows = ids.length ? await many(tx, SNAP_SQL, [ids]) : [];
  return new Map(rows.map((r) => [r.id, { ...r, starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString() }]));
}

const FIELDS: [string, string][] = [['starts_at', 'Début'], ['ends_at', 'Fin'], ['status', 'Statut'], ['title', 'Intitulé'], ['modality', 'Modalité'], ['video_url', 'Lien visio'],
  ['breaks', 'Pauses'], ['part_id', 'Module'], ['group_label', 'Groupe'], ['notes', 'Notes'], ['trainers', 'Formateurs'], ['resources', 'Lieu / ressources'], ['learners', 'Participants']];
function diff(b: Snap | null, a: Snap | null) {
  if (!b || !a) return [];
  const norm = (k: string, v: any) => k === 'trainers' ? v.map((t: any) => `${t.name}${t.role === 'co' ? ' (co)' : ''}`).join(', ')
    : k === 'resources' ? v.map((r: any) => r.name).join(', ') : k === 'learners' ? v.length : k === 'breaks' ? JSON.stringify(v) : v ?? null;
  return FIELDS.filter(([k]) => JSON.stringify(norm(k, b[k])) !== JSON.stringify(norm(k, a[k]))).map(([k, label]) => ({ field: k, label, from: norm(k, b[k]), to: norm(k, a[k]) }));
}
/** Changements qui justifient une notification (lieu, date, horaire, formateur, modalité, lien). */
const NOTIFIABLE = ['starts_at', 'ends_at', 'trainers', 'resources', 'modality', 'video_url'];

class Work {
  before = new Map<string, Snap | null>();
  actions = new Map<string, string>();
  changed = new Set<string>();
  checked = new Map<string, SlotCheck>();
  constructor(private tx: Tx) {}
  async touch(id: string, action = 'updated') {
    if (!this.before.has(id)) this.before.set(id, (await snapshot(this.tx, [id])).get(id) ?? null);
    const prev = this.actions.get(id);
    if (!prev || prev === 'updated') this.actions.set(id, action);
    this.changed.add(id);
  }
  created(id: string) { this.before.set(id, null); this.actions.set(id, 'created'); this.changed.add(id); }
}

/** Fin de prévisualisation : la transaction est annulée, aucune écriture ni message. */
class PreviewDone { constructor(public payload: unknown) {} }

const issueLine = (i: Issue) => i.message;
export function conflictError(checks: SlotCheck[], code = 'planning_conflict') {
  const all = checks.flatMap((c) => c.blocking);
  const first = all[0];
  const msg = first ? `${first.message}${all.length > 1 ? ` (+${all.length - 1} autre(s) contrôle(s) bloquant(s))` : ''}` : 'Contrôle bloquant.';
  return new AppError(409, code, msg, undefined, { report: checks });
}

@Injectable()
export class PlanningEngine {
  constructor(private db: Db, private audit: AuditService, private jobs: JobsService, private mailer: SystemMailer) {
    this.jobs.register('planning.notify', (p) => this.deliver(p.tenantId, p.personId));
  }

  // ─── Exécution transactionnelle commune ─────────────────────────────────
  /**
   * Écriture provisoire → contrôle complet → dérogation éventuelle → historique, événements,
   * notifications et idempotence ; tout ou rien. Prévisualisation = même chemin, puis annulation.
   */
  async run<T>(ctx: RequestContext, route: string, opts: WriteOpts, body: (tx: Tx, w: Work) => Promise<T>): Promise<any> {
    try {
      return await this.db.tenantTx(ctx.tenantId, (tx) => this.runIn(tx, ctx, route, opts, body));
    } catch (e) {
      if (e instanceof PreviewDone) return e.payload;
      throw e;
    }
  }

  async runIn<T>(tx: Tx, ctx: RequestContext, route: string, opts: WriteOpts, body: (tx: Tx, w: Work) => Promise<T>): Promise<any> {
    // Sérialise les écritures de planning de l'organisme : deux réservations simultanées de la même
    // ressource → la seconde voit la première et reçoit un conflit explicite (aucun écrasement).
    await lock(tx, `planning:${ctx.tenantId}`);
    if (opts.idempotencyKey && !opts.preview) {
      const prev = await one(tx, `SELECT route, response FROM idempotency_keys WHERE key = $1`, [opts.idempotencyKey]);
      if (prev) {
        if (prev.route !== route) throw conflict('idempotency_key_reused', "Clé d'idempotence déjà utilisée pour une autre opération.");
        return { ...prev.response, replayed: true };
      }
    }
    const w = new Work(tx);
    const result: any = await body(tx, w);
    const live = [...w.actions.entries()].filter(([, a]) => a !== 'deleted').map(([id]) => id);
    const toCheck = live.filter((id) => !w.checked.has(id));
    const checks = [...w.checked.values(), ...(await checkSlots(tx, toCheck, { changed: w.changed }))].filter((c) => live.includes(c.slotId));
    const blocking = checks.flatMap((c) => c.blocking);
    let derogated: Issue[] = [];
    if (blocking.length) {
      const canDerogate = blocking.every((i) => i.derogable) && !!opts.derogation && ctx.permissions.has('planning.derogate');
      if (opts.preview) throw new PreviewDone({ preview: true, ok: false, canDerogate: blocking.every((i) => i.derogable), result, report: checks });
      if (!canDerogate) {
        if (opts.derogation && blocking.every((i) => i.derogable)) throw forbidden('derogation_not_allowed', 'Dérogation réservée aux rôles habilités (permission planning.derogate).');
        throw conflictError(checks);
      }
      derogated = blocking;
      for (const c of checks.filter((c) => c.blocking.length)) {
        await tx.query(`UPDATE slots SET derogation = jsonb_build_object('reason', $2::text, 'by', $3::text, 'at', now(),
                          'rules', (SELECT jsonb_agg(DISTINCT r) FROM jsonb_array_elements_text(coalesce(derogation->'rules', '[]') || $4::jsonb) r)) WHERE id = $1`,
          [c.slotId, opts.derogation, ctx.userId, JSON.stringify([...new Set(c.blocking.map((i) => i.rule))])]);
      }
    }
    if (opts.preview) throw new PreviewDone({ preview: true, ok: true, result, report: checks });
    await this.record(tx, ctx, w, opts.reason ?? opts.derogation, derogated);
    const response = { ...(result ?? {}), report: checks.map((c) => ({ ...c, blocking: undefined, derogated: c.blocking.length ? c.blocking : undefined })) };
    if (opts.idempotencyKey) {
      await tx.query(`INSERT INTO idempotency_keys(tenant_id, key, route, response) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, opts.idempotencyKey, route, JSON.stringify(response)]);
    }
    return response;
  }

  /** Historique versionné, événements sortants, version de référence publiée, notifications après validation. */
  private async record(tx: Tx, ctx: RequestContext, w: Work, reason: string | undefined, derogated: Issue[]) {
    const ids = [...w.actions.keys()];
    const after = await snapshot(tx, ids);
    for (const id of ids) {
      const action = w.actions.get(id)!;
      const b = w.before.get(id) ?? null; const a = after.get(id) ?? null;
      const changes = diff(b, a);
      if (action === 'updated' && b && a && !changes.length) continue;
      let version = a?.version ?? b?.version ?? 1;
      if (b && a) { version = b.version + 1; await tx.query(`UPDATE slots SET version = $2, updated_at = now() WHERE id = $1`, [id, version]); a.version = version; }
      const rules = derogated.filter((i) => i.slotId === id).map((i) => ({ rule: i.rule, message: i.message }));
      const ref = a ?? b!;
      await tx.query(`INSERT INTO planning_history(tenant_id, slot_id, session_id, version, action, actor_user_id, reason, before, after, changes, rules)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [ctx.tenantId, id, ref.session_id, version, action, ctx.userId, reason ?? null, b && JSON.stringify(b), a && JSON.stringify(a), JSON.stringify(changes), rules.length ? JSON.stringify(rules) : null]);
      const moved = changes.some((c) => c.field === 'starts_at' || c.field === 'ends_at');
      const type = action === 'created' ? 'slot.created' : action === 'deleted' ? 'slot.deleted' : a?.status === 'cancelled' && b?.status !== 'cancelled' ? 'slot.cancelled'
        : a?.status === 'published' && b?.status !== 'published' ? 'slot.published' : moved ? 'slot.moved' : 'slot.updated';
      await tx.query(`INSERT INTO planning_events(tenant_id, type, slot_id, session_id, version, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.tenantId, type, id, ref.session_id, version, JSON.stringify({ slot: ref, changes })]);
      if (a?.status === 'published') {
        await tx.query(`UPDATE slots SET published_snapshot = $2, published_at = coalesce(published_at, now()) WHERE id = $1`, [id, JSON.stringify(a)]);
      }
      await this.notify(tx, ctx.tenantId, b, a, changes);
    }
    if (derogated.length) {
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'planning.derogation', entityType: 'slot', entityId: derogated[0].slotId,
        data: { reason, rules: derogated.map((i) => ({ slotId: i.slotId, rule: i.rule })) } });
    }
  }

  /** Notifications regroupées par personne : persistées dans la transaction, envoyées après commit. */
  private async notify(tx: Tx, tenantId: string, b: Snap | null, a: Snap | null, changes: { field: string; label: string; from: any; to: any }[]) {
    const wasPublished = !!b && ['published', 'done'].includes(b.status);
    const isPublished = a?.status === 'published';
    const s = (a ?? b)!;
    const label = `« ${s.title || s.session_title} » ${fmtRange(s.starts_at, s.ends_at, s.timezone)}`;
    const people = (x: Snap | null) => new Set<string>([...(x?.trainers ?? []).map((t: any) => t.id), ...(x?.learners ?? [])]);
    const out: { person: string; kind: string; summary: string }[] = [];
    if (isPublished && !wasPublished) {
      for (const p of people(a)) out.push({ person: p, kind: 'published', summary: `Nouvelle séance publiée : ${label}.` });
    } else if (wasPublished && a?.status === 'cancelled' && b?.status !== 'cancelled') {
      for (const p of people(b)) out.push({ person: p, kind: 'cancelled', summary: `Séance annulée : ${label}${a.cancel_reason ? ` (${a.cancel_reason})` : ''}.` });
    } else if (wasPublished && isPublished) {
      const relevant = changes.filter((c) => NOTIFIABLE.includes(c.field));
      if (!relevant.length) return;
      const before = people(b); const now = people(a);
      const desc = relevant.map((c) => c.field === 'starts_at' || c.field === 'ends_at' ? null : `${c.label.toLowerCase()} : ${c.from || '—'} → ${c.to || '—'}`).filter(Boolean);
      if (relevant.some((c) => c.field === 'starts_at' || c.field === 'ends_at')) desc.unshift(`horaire : ${fmtRange(b!.starts_at, b!.ends_at, b!.timezone)} → ${fmtRange(a!.starts_at, a!.ends_at, a!.timezone)}`);
      for (const p of now) out.push({ person: p, kind: before.has(p) ? 'changed' : 'assigned', summary: before.has(p) ? `Séance modifiée : ${label} — ${desc.join(' ; ')}.` : `Vous êtes attendu(e) : ${label}.` });
      for (const p of before) if (!now.has(p)) out.push({ person: p, kind: 'unassigned', summary: `Vous n'êtes plus attendu(e) : ${label}.` });
    }
    for (const n of out) {
      const row = await one(tx, `INSERT INTO planning_changes(tenant_id, person_id, slot_id, kind, summary) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenantId, n.person, s.id, n.kind, n.summary]);
      await this.jobs.enqueue(tx, 'planning.notify', { tenantId, personId: n.person }, { tenantId, dedupeKey: `planning.notify:${row!.id}`, runAt: new Date(Date.now() + NOTIFY_DELAY_MS) });
    }
  }

  /** Envoi regroupé ; relance sans doublon : seules les lignes non envoyées partent. */
  async deliver(tenantId: string, personId: string) {
    await this.db.tenantTx(tenantId, async (tx) => {
      const rows = await many(tx, `SELECT id, summary FROM planning_changes WHERE person_id = $1 AND status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED`, [personId]);
      if (!rows.length) return;
      const p = await one(tx, `SELECT email, first_name FROM persons WHERE id = $1`, [personId]);
      const ids = rows.map((r) => r.id);
      if (!p?.email) { await tx.query(`UPDATE planning_changes SET status = 'skipped', last_error = 'sans email' WHERE id = ANY($1)`, [ids]); return; }
      const t = await one(tx, `SELECT legal_name FROM tenants WHERE id = $1`, [tenantId]);
      await this.mailer.send({ to: p.email, subject: `Planning ${t?.legal_name ?? ''} : ${rows.length} changement(s)`.trim(),
        text: `Bonjour ${p.first_name},\n\n${rows.map((r) => `- ${r.summary}`).join('\n')}\n\nConsultez votre planning personnel dans votre espace.` });
      await tx.query(`UPDATE planning_changes SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [ids]);
    });
  }

  // ─── Briques d'écriture ─────────────────────────────────────────────────
  private async session(tx: Tx, sessionId: string) {
    const s = await one(tx, `SELECT id, status, timezone, title FROM training_sessions WHERE id = $1`, [sessionId]);
    if (!s) throw notFound('Session');
    if (['archived', 'cancelled'].includes(s.status)) throw conflict('session_closed', 'Session close : planning non modifiable.');
    return s;
  }

  private validateTimes(startsAt: string | Date, endsAt: string | Date, breaks?: Break[]) {
    const s = new Date(startsAt).getTime(); const e = new Date(endsAt).getTime();
    if (!(e > s)) throw badRequest('invalid_slot', 'La fin doit être postérieure au début.', 'endsAt');
    if (e - s > MAX_SLOT_MS) throw badRequest('invalid_slot', 'Une séance dure au plus 24 h : découper en plusieurs séances.', 'endsAt');
    for (const b of breaks ?? []) if (Number.isNaN(new Date(b.startsAt).getTime()) || Number.isNaN(new Date(b.endsAt).getTime())) throw badRequest('invalid_break', 'Pause invalide.', 'breaks');
  }

  private async validateRefs(tx: Tx, sessionId: string, f: SlotFields) {
    if (f.partId && !(await one(tx, `SELECT 1 FROM session_parts WHERE id = $1 AND session_id = $2`, [f.partId, sessionId]))) {
      throw badRequest('invalid_part', 'Module inconnu pour cette session.', 'partId');
    }
    const trainers = [...new Map((f.trainers ?? []).map((t) => [t.id, t])).values()];
    if (trainers.length) {
      const ok = await many(tx, `SELECT person_id FROM person_roles WHERE role = 'trainer' AND person_id = ANY($1::uuid[])`, [trainers.map((t) => t.id)]);
      if (ok.length !== trainers.length) throw badRequest('not_a_trainer', "Une des personnes n'a pas le rôle formateur.", 'trainerIds');
    }
    const resources = [...new Set(f.resourceIds ?? [])];
    if (resources.length) {
      const ok = await many(tx, `SELECT id FROM resources WHERE id = ANY($1::uuid[])`, [resources]);
      if (ok.length !== resources.length) throw badRequest('invalid_resource', 'Ressource inconnue.', 'resourceIds');
    }
    if (f.participants?.length) {
      const ok = await many(tx, `SELECT id FROM enrollments WHERE session_id = $1 AND id = ANY($2::uuid[])`, [sessionId, f.participants.map((p) => p.enrollmentId)]);
      if (ok.length !== new Set(f.participants.map((p) => p.enrollmentId)).size) throw badRequest('invalid_participant', 'Inscription inconnue pour cette session.', 'participants');
    }
    return { trainers, resources };
  }

  private async setLinks(tx: Tx, tenantId: string, slotId: string, f: SlotFields, refs: { trainers: { id: string; role?: string }[]; resources: string[] }) {
    if (f.trainers) {
      await tx.query(`DELETE FROM slot_trainers WHERE slot_id = $1`, [slotId]);
      for (const t of refs.trainers) await tx.query(`INSERT INTO slot_trainers(tenant_id, slot_id, person_id, role) VALUES ($1,$2,$3,$4)`, [tenantId, slotId, t.id, t.role ?? 'lead']);
    }
    if (f.resourceIds) {
      await tx.query(`DELETE FROM slot_resources WHERE slot_id = $1`, [slotId]);
      for (const r of refs.resources) await tx.query(`INSERT INTO slot_resources(tenant_id, slot_id, resource_id) VALUES ($1,$2,$3)`, [tenantId, slotId, r]);
    }
    for (const p of f.participants ?? []) {
      if (p.mode === 'default') await tx.query(`DELETE FROM slot_participants WHERE slot_id = $1 AND enrollment_id = $2`, [slotId, p.enrollmentId]);
      else await tx.query(`INSERT INTO slot_participants(tenant_id, slot_id, enrollment_id, mode) VALUES ($1,$2,$3,$4)
                           ON CONFLICT (tenant_id, slot_id, enrollment_id) DO UPDATE SET mode = EXCLUDED.mode, reason = NULL, updated_at = now()`, [tenantId, slotId, p.enrollmentId, p.mode]);
    }
  }

  /** Insertion d'une séance (statut brouillon par défaut). */
  async insert(tx: Tx, ctx: RequestContext, w: Work, sessionId: string, f: SlotFields & { startsAt: string; endsAt: string }, extra: { seriesId?: string } = {}) {
    await this.session(tx, sessionId);
    this.validateTimes(f.startsAt, f.endsAt, f.breaks);
    const refs = await this.validateRefs(tx, sessionId, f);
    const slot = await one(tx, `INSERT INTO slots(tenant_id, session_id, part_id, starts_at, ends_at, title, modality, video_url, breaks, group_label, notes, series_id)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ctx.tenantId, sessionId, f.partId ?? null, f.startsAt, f.endsAt, f.title ?? null, f.modality ?? 'onsite', f.videoUrl ?? null,
        JSON.stringify(f.breaks ?? []), f.groupLabel ?? null, f.notes ?? null, extra.seriesId ?? null]);
    await this.setLinks(tx, ctx.tenantId, slot!.id, { ...f, trainers: f.trainers ?? [], resourceIds: f.resourceIds ?? [] }, refs);
    w.created(slot!.id);
    return slot!.id as string;
  }

  /** Mise à jour des champs fournis ; les listes fournies remplacent l'existant. */
  async apply(tx: Tx, ctx: RequestContext, w: Work, slotId: string, f: SlotFields, o: { version?: number; reason?: string; action?: string } = {}) {
    const cur = await one(tx, `SELECT * FROM slots WHERE id = $1 FOR UPDATE`, [slotId]);
    if (!cur) throw notFound('Séance');
    if (o.version != null && cur.version !== o.version) {
      throw conflict('version_conflict', 'Séance modifiée entre-temps par un autre utilisateur : rechargez avant de modifier.', { currentVersion: cur.version });
    }
    await this.session(tx, cur.session_id);
    if (cur.status === 'cancelled') throw conflict('slot_cancelled', 'Séance annulée : non modifiable.');
    const timeChange = (f.startsAt && +new Date(f.startsAt) !== +new Date(cur.starts_at)) || (f.endsAt && +new Date(f.endsAt) !== +new Date(cur.ends_at));
    if (cur.status === 'done') {
      if (timeChange) throw conflict('slot_done', 'Séance réalisée : déplacement impossible.');
      if (!o.reason) throw badRequest('reason_required', 'Correction administrative d’une séance réalisée : motif obligatoire.', 'reason');
      if (!ctx.permissions.has('planning.publish')) throw forbidden('permission_denied', 'Correction d’une séance réalisée réservée aux responsables.');
    }
    if (timeChange && (await one(tx, `SELECT 1 FROM attendance WHERE slot_id = $1`, [slotId]))) {
      throw conflict('slot_has_attendance', 'Présences déjà saisies sur cette séance : horaires non modifiables.');
    }
    const startsAt = f.startsAt ?? cur.starts_at; const endsAt = f.endsAt ?? cur.ends_at;
    // Pauses : décalées avec la séance si non fournies.
    let breaks = f.breaks;
    if (!breaks && f.startsAt && cur.breaks?.length) {
      const delta = +new Date(startsAt) - +new Date(cur.starts_at);
      breaks = cur.breaks.map((b: Break) => ({ startsAt: new Date(+new Date(b.startsAt) + delta).toISOString(), endsAt: new Date(+new Date(b.endsAt) + delta).toISOString() }));
    }
    this.validateTimes(startsAt, endsAt, breaks);
    const refs = await this.validateRefs(tx, cur.session_id, f);
    await w.touch(slotId, o.action ?? (timeChange ? 'moved' : 'updated'));
    const set: [string, unknown][] = [['starts_at', startsAt], ['ends_at', endsAt]];
    if (timeChange) set.push(['derogation', null]); // nouvel horaire : dérogation à redemander
    if (f.title !== undefined) set.push(['title', f.title]);
    if (f.partId !== undefined) set.push(['part_id', f.partId]);
    if (f.modality !== undefined) set.push(['modality', f.modality]);
    if (f.videoUrl !== undefined) set.push(['video_url', f.videoUrl]);
    if (breaks !== undefined) set.push(['breaks', JSON.stringify(breaks)]);
    if (f.groupLabel !== undefined) set.push(['group_label', f.groupLabel]);
    if (f.notes !== undefined) set.push(['notes', f.notes]);
    await tx.query(`UPDATE slots SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [slotId, ...set.map(([, v]) => v)]);
    await this.setLinks(tx, ctx.tenantId, slotId, f, refs);
    return cur;
  }

  // ─── Opérations ─────────────────────────────────────────────────────────
  create(ctx: RequestContext, sessionId: string, f: SlotFields & { startsAt: string; endsAt: string; status?: 'draft' | 'pending' | 'published' }, opts: WriteOpts) {
    return this.run(ctx, 'slot.create', opts, async (tx, w) => {
      const id = await this.insert(tx, ctx, w, sessionId, f);
      if (f.status && f.status !== 'draft') await this.setStatus(tx, ctx, w, [id], f.status);
      return { id };
    });
  }

  /**
   * Modification (formulaire, glisser-déposer, redimensionnement). Séance d'une série :
   * scope this (défaut) / following / all ; occurrences passées et réalisées protégées.
   */
  update(ctx: RequestContext, slotId: string, f: SlotFields & { version?: number; scope?: 'this' | 'following' | 'all' }, opts: WriteOpts) {
    return this.run(ctx, 'slot.update', opts, async (tx, w) => {
      const cur = await one(tx, `SELECT sl.*, ts.timezone FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id WHERE sl.id = $1`, [slotId]);
      if (!cur) throw notFound('Séance');
      const scope = cur.series_id ? f.scope ?? 'this' : 'this';
      const { version: _v, scope: _s, ...fields } = f;
      await this.apply(tx, ctx, w, slotId, fields, { version: f.version, reason: opts.reason });
      if (scope === 'this') return { id: slotId, updated: 1 };
      const tz = cur.timezone;
      const others = await many(tx, `SELECT id, starts_at, ends_at FROM slots WHERE series_id = $1 AND id <> $2 AND status NOT IN ('cancelled','done')
                                      AND starts_at > now() AND ($3 OR starts_at > $4) ORDER BY starts_at`, [cur.series_id, slotId, scope === 'all', cur.starts_at]);
      // Horaires repris en heure locale sur chaque occurrence (changement d'heure sans dérive).
      const ns = f.startsAt ? local(f.startsAt, tz) : null; const ne = f.endsAt ? local(f.endsAt, tz) : null;
      const cs = local(cur.starts_at, tz);
      const { participants: _p, ...shared } = fields;
      for (const o of others) {
        const os = local(o.starts_at, tz); const oe = local(o.ends_at, tz);
        const dayShift = ns ? daysBetween(cs.date, ns.date) : 0;
        const startsAt = ns ? this.at(addDays(os.date, dayShift), ns.hm, tz) : undefined;
        const endsAt = ne ? this.at(addDays(oe.date, daysBetween(local(cur.ends_at, tz).date, ne.date)), ne.hm, tz) : undefined;
        await this.apply(tx, ctx, w, o.id, { ...shared, breaks: undefined, startsAt, endsAt }, { reason: opts.reason });
      }
      return { id: slotId, updated: others.length + 1 };
    });
  }

  private at(date: string, hm: string, tz: string) {
    const z = zoned(date, hm, tz);
    if (z.status === 'nonexistent') throw badRequest('invalid_local_time', `${hm} n'existe pas le ${date} (passage à l'heure d'été) : choisir un autre horaire.`);
    if (z.status === 'ambiguous') throw badRequest('ambiguous_local_time', `${hm} existe deux fois le ${date} (passage à l'heure d'hiver) : préciser l'horaire avec son décalage.`);
    return z.at.toISOString();
  }

  /** Édition groupée : décalage, formateurs, ressources, modalité ; bilan par séance ; atomique. */
  bulk(ctx: RequestContext, b: {
    slotIds: string[]; shiftDays?: number; shiftMinutes?: number;
    trainers?: { ids: string[]; mode: 'replace' | 'add' | 'remove'; role?: 'lead' | 'co' };
    resources?: { ids: string[]; mode: 'replace' | 'add' | 'remove' };
    modality?: Modality; videoUrl?: string | null; groupLabel?: string | null;
  }, opts: WriteOpts) {
    return this.run(ctx, 'slot.bulk', opts, async (tx, w) => {
      const rows = await many(tx, `SELECT sl.*, ts.timezone FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id WHERE sl.id = ANY($1::uuid[]) ORDER BY sl.starts_at`, [b.slotIds]);
      if (rows.length !== new Set(b.slotIds).size) throw notFound('Séance');
      for (const sl of rows) {
        const f: SlotFields = {};
        if (b.shiftDays || b.shiftMinutes) {
          const tz = sl.timezone;
          let s = new Date(sl.starts_at).toISOString(); let e = new Date(sl.ends_at).toISOString();
          if (b.shiftDays) { // jours : heure locale conservée
            const ls = local(s, tz); const le = local(e, tz);
            s = this.at(addDays(ls.date, b.shiftDays), ls.hm, tz); e = this.at(addDays(le.date, b.shiftDays), le.hm, tz);
          }
          if (b.shiftMinutes) { s = new Date(+new Date(s) + b.shiftMinutes * 60000).toISOString(); e = new Date(+new Date(e) + b.shiftMinutes * 60000).toISOString(); }
          f.startsAt = s; f.endsAt = e;
        }
        if (b.trainers) {
          const cur = await many(tx, `SELECT person_id AS id, role FROM slot_trainers WHERE slot_id = $1`, [sl.id]);
          const add = b.trainers.ids.map((id) => ({ id, role: b.trainers!.role ?? 'lead' }));
          f.trainers = b.trainers.mode === 'replace' ? add : b.trainers.mode === 'add' ? [...cur, ...add.filter((a) => !cur.some((c) => c.id === a.id))] : cur.filter((c) => !b.trainers!.ids.includes(c.id));
        }
        if (b.resources) {
          const cur = (await many(tx, `SELECT resource_id FROM slot_resources WHERE slot_id = $1`, [sl.id])).map((x) => x.resource_id as string);
          f.resourceIds = b.resources.mode === 'replace' ? b.resources.ids : b.resources.mode === 'add' ? [...new Set([...cur, ...b.resources.ids])] : cur.filter((c) => !b.resources!.ids.includes(c));
        }
        if (b.modality) f.modality = b.modality;
        if (b.videoUrl !== undefined) f.videoUrl = b.videoUrl;
        if (b.groupLabel !== undefined) f.groupLabel = b.groupLabel;
        await this.apply(tx, ctx, w, sl.id, f, { reason: opts.reason });
      }
      return { updated: rows.length };
    });
  }

  /** Déplacement de session : séances choisies décalées de N jours, intervalles et pauses conservés. */
  async shiftSession(ctx: RequestContext, sessionId: string, b: { days: number; slotIds?: string[] }, opts: WriteOpts) {
    const ids = await this.db.tenantTx(ctx.tenantId, async (tx) => (await many(tx,
      `SELECT id FROM slots WHERE session_id = $1 AND status NOT IN ('cancelled','done') AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [sessionId, b.slotIds?.length ? b.slotIds : null])).map((r) => r.id));
    if (!ids.length) throw badRequest('no_slot', 'Aucune séance déplaçable.');
    return this.bulk(ctx, { slotIds: ids, shiftDays: b.days }, opts);
  }

  /** Duplication sur d'autres dates : copie pédagogique et affectations proposées ; ni émargement ni historique. */
  duplicate(ctx: RequestContext, slotId: string, b: { dates: string[]; keepTrainers?: boolean; keepResources?: boolean }, opts: WriteOpts) {
    return this.run(ctx, 'slot.duplicate', opts, async (tx, w) => {
      const sl = await one(tx, `SELECT sl.*, ts.timezone FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id WHERE sl.id = $1`, [slotId]);
      if (!sl) throw notFound('Séance');
      const tz = sl.timezone;
      const trainers = b.keepTrainers === false ? [] : await many(tx, `SELECT person_id AS id, role FROM slot_trainers WHERE slot_id = $1`, [slotId]);
      const resourceIds = b.keepResources === false ? [] : (await many(tx, `SELECT resource_id FROM slot_resources WHERE slot_id = $1`, [slotId])).map((r) => r.resource_id);
      const ls = local(sl.starts_at, tz); const le = local(sl.ends_at, tz); const span = daysBetween(ls.date, le.date);
      const ids: string[] = [];
      for (const date of [...new Set(b.dates)]) {
        const startsAt = this.at(date, ls.hm, tz); const endsAt = this.at(addDays(date, span), le.hm, tz);
        const delta = +new Date(startsAt) - +new Date(sl.starts_at);
        const breaks = (sl.breaks ?? []).map((x: Break) => ({ startsAt: new Date(+new Date(x.startsAt) + delta).toISOString(), endsAt: new Date(+new Date(x.endsAt) + delta).toISOString() }));
        ids.push(await this.insert(tx, ctx, w, sl.session_id, { startsAt, endsAt, breaks, title: sl.title, partId: sl.part_id, modality: sl.modality, videoUrl: sl.video_url, groupLabel: sl.group_label, notes: sl.notes, trainers, resourceIds }));
      }
      return { ids };
    });
  }

  /** Statuts : Brouillon → À valider → Publié → Réalisé ; retour en brouillon depuis À valider. */
  private async setStatus(tx: Tx, ctx: RequestContext, w: Work, ids: string[], to: 'draft' | 'pending' | 'published' | 'done') {
    const settings = await loadSettings(tx);
    if (to === 'published' && !ctx.permissions.has('planning.publish') && !(settings.direct_publish && ctx.permissions.has('sessions.write'))) {
      throw forbidden('permission_denied', 'Publication réservée aux responsables (permission planning.publish) : demander la validation.');
    }
    const FROM: Record<string, string[]> = { draft: ['pending'], pending: ['draft'], published: ['draft', 'pending'], done: ['published'] };
    let n = 0;
    for (const id of ids) {
      const sl = await one(tx, `SELECT status, ends_at FROM slots WHERE id = $1 FOR UPDATE`, [id]);
      if (!sl) throw notFound('Séance');
      if (sl.status === to) continue;
      if (!FROM[to].includes(sl.status)) throw conflict('invalid_transition', `Transition ${sl.status} → ${to} impossible.`);
      if (to === 'done' && new Date(sl.ends_at) > new Date()) throw conflict('slot_not_finished', 'Séance non terminée : statut Réalisé impossible.');
      await w.touch(id, to === 'published' ? 'published' : to === 'pending' ? 'submitted' : to === 'done' ? 'done' : 'returned');
      await tx.query(`UPDATE slots SET status = $2 WHERE id = $1`, [id, to]);
      n++;
    }
    return n;
  }

  transition(ctx: RequestContext, b: { slotIds?: string[]; sessionId?: string; status: 'draft' | 'pending' | 'published' | 'done' }, opts: WriteOpts) {
    return this.run(ctx, `slot.${b.status}`, opts, async (tx, w) => {
      const FROM: Record<string, string[]> = { draft: ['pending'], pending: ['draft'], published: ['draft', 'pending'], done: ['published'] };
      const ids = b.slotIds?.length ? b.slotIds : (await many(tx, `SELECT id FROM slots WHERE session_id = $1 AND status = ANY($2::text[])`, [b.sessionId, FROM[b.status]])).map((r) => r.id);
      if (!ids.length) throw badRequest('no_slot', 'Aucune séance concernée.');
      return { updated: await this.setStatus(tx, ctx, w, ids, b.status) };
    });
  }

  /** Annulation motivée : réservations libérées, historique conservé, notification si publiée. */
  cancel(ctx: RequestContext, slotIds: string[], reason: string, opts: WriteOpts) {
    return this.run(ctx, 'slot.cancel', { ...opts, reason }, async (tx, w) => this.cancelIn(tx, w, slotIds, reason));
  }
  async cancelIn(tx: Tx, w: Work, slotIds: string[], reason: string) {
    const effects = { convocations: 0 };
    for (const id of slotIds) {
      const sl = await one(tx, `SELECT status, session_id FROM slots WHERE id = $1 FOR UPDATE`, [id]);
      if (!sl) throw notFound('Séance');
      if (sl.status === 'cancelled') continue;
      if (sl.status === 'done') throw conflict('slot_done', 'Séance réalisée : annulation impossible.');
      if (await one(tx, `SELECT 1 FROM attendance WHERE slot_id = $1`, [id])) throw conflict('slot_has_attendance', 'Présences saisies sur cette séance : annulation impossible.');
      await w.touch(id, 'cancelled');
      await tx.query(`UPDATE slots SET status = 'cancelled', cancel_reason = $2, cancelled_at = now() WHERE id = $1`, [id, reason]);
      effects.convocations += Number((await one(tx, `SELECT count(*) n FROM documents d JOIN enrollments e ON e.id = d.owner_id WHERE d.owner_type = 'enrollment' AND d.kind = 'convocation' AND e.session_id = $1`, [sl.session_id]))!.n);
    }
    return { cancelled: slotIds.length, effects };
  }

  /** Session annulée : ses séances actives le sont aussi (même transaction). */
  cancelSessionSlots(tx: Tx, ctx: RequestContext, sessionId: string, reason: string) {
    return this.runIn(tx, ctx, 'session.cancel', { reason }, async (t, w) => {
      const ids = (await many(t, `SELECT id FROM slots WHERE session_id = $1 AND status NOT IN ('cancelled','done')
                                   AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.slot_id = slots.id)`, [sessionId])).map((r) => r.id);
      return this.cancelIn(t, w, ids, reason);
    });
  }

  /** Suppression physique : brouillon jamais publié, sans présence. */
  remove(ctx: RequestContext, slotId: string) {
    return this.run(ctx, 'slot.delete', {}, async (tx, w) => {
      const sl = await one(tx, `SELECT status, published_at FROM slots WHERE id = $1 FOR UPDATE`, [slotId]);
      if (!sl) throw notFound('Séance');
      if (sl.status !== 'draft' || sl.published_at) throw conflict('slot_not_draft', 'Seul un brouillon jamais publié peut être supprimé : annuler la séance.');
      if (await one(tx, `SELECT 1 FROM attendance WHERE slot_id = $1`, [slotId])) throw conflict('slot_has_attendance', 'Présences déjà saisies : séance non supprimable.');
      await w.touch(slotId, 'deleted');
      await tx.query(`DELETE FROM slots WHERE id = $1`, [slotId]);
      return { deleted: true };
    });
  }

  /**
   * Récurrence en heure locale : jours choisis, fréquence, date de fin ou nombre, exclusions.
   * Aperçu : séances créées, exclues, en conflit. Atomique par défaut ; mode partiel explicite.
   */
  series(ctx: RequestContext, sessionId: string, b: {
    startDate: string; days: number[]; intervalWeeks?: number; until?: string; count?: number; startTime: string; endTime: string;
    exclusions?: string[]; breaks?: { start: string; end: string }[]; partial?: boolean;
  } & Omit<SlotFields, 'startsAt' | 'endsAt' | 'breaks'>, opts: WriteOpts) {
    if (!b.until && !b.count) throw badRequest('series_end_required', 'Date de fin ou nombre d’occurrences requis.', 'until');
    return this.run(ctx, 'slot.series', opts, async (tx, w) => {
      const s = await this.session(tx, sessionId);
      const tz = s.timezone;
      const overnight = b.endTime <= b.startTime;
      const dates: string[] = [];
      const step = Math.max(1, b.intervalWeeks ?? 1);
      const monday = addDays(b.startDate, -(dowOf(b.startDate) - 1));
      for (let week = 0; dates.length < (b.count ?? 366) && week < 260; week += step) {
        for (const d of [...new Set(b.days)].sort()) {
          const date = addDays(monday, week * 7 + d - 1);
          if (date < b.startDate || (b.until && date > b.until) || dates.length >= (b.count ?? 366)) continue;
          dates.push(date);
        }
        if (b.until && addDays(monday, week * 7) > b.until) break;
      }
      const series = await one(tx, `INSERT INTO planning_series(tenant_id, session_id, rule, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [ctx.tenantId, sessionId, JSON.stringify({ ...b, timezone: tz, trainers: undefined, resourceIds: undefined, participants: undefined }), ctx.userId]);
      const occurrences: any[] = [];
      const { startDate: _a, days: _b, intervalWeeks: _c, until: _d, count: _e, startTime: _f, endTime: _g, exclusions: _h, breaks: bk, partial, ...fields } = b;
      for (const date of dates) {
        const occ: any = { date, status: 'create' };
        occurrences.push(occ);
        if (b.exclusions?.includes(date)) { occ.status = 'excluded'; continue; }
        const zs = zoned(date, b.startTime, tz); const ze = zoned(overnight ? addDays(date, 1) : date, b.endTime, tz);
        if (zs.status !== 'ok' || ze.status !== 'ok') { occ.status = 'invalid_time'; occ.issues = [`Horaire ${zs.status !== 'ok' ? b.startTime : b.endTime} ${zs.status === 'nonexistent' || ze.status === 'nonexistent' ? 'inexistant' : 'ambigu'} le ${date} (changement d'heure) : correction explicite requise.`]; continue; }
        const breaks = (bk ?? []).map((x) => ({ startsAt: zoned(x.start < b.startTime ? addDays(date, 1) : date, x.start, tz).at.toISOString(), endsAt: zoned(x.end < b.startTime ? addDays(date, 1) : date, x.end, tz).at.toISOString() }));
        occ.startsAt = zs.at.toISOString(); occ.endsAt = ze.at.toISOString();
        if (partial) await tx.query('SAVEPOINT occ');
        const id = await this.insert(tx, ctx, w, sessionId, { ...fields, startsAt: occ.startsAt, endsAt: occ.endsAt, breaks }, { seriesId: series!.id });
        occ.slotId = id;
        if (partial) {
          const [c] = await checkSlots(tx, [id], { changed: w.changed });
          if (c.blocking.length) {
            await tx.query('ROLLBACK TO SAVEPOINT occ');
            w.actions.delete(id); w.before.delete(id); w.changed.delete(id);
            occ.status = 'conflict'; occ.issues = c.blocking.map(issueLine); occ.slotId = undefined;
          } else { await tx.query('RELEASE SAVEPOINT occ'); w.checked.set(id, c); }
        }
      }
      if (!partial && occurrences.some((o) => o.status === 'invalid_time') && !opts.preview) {
        throw new AppError(409, 'series_invalid_time', occurrences.find((o) => o.status === 'invalid_time').issues[0], undefined, { occurrences });
      }
      // Atomique : contrôle de toutes les occurrences ensemble (rejet global si conflit).
      if (!partial) {
        const created = occurrences.filter((o) => o.slotId).map((o) => o.slotId);
        for (const c of await checkSlots(tx, created, { changed: w.changed })) {
          w.checked.set(c.slotId, c);
          const occ = occurrences.find((o) => o.slotId === c.slotId);
          if (c.blocking.length) { occ.status = 'conflict'; occ.issues = c.blocking.map(issueLine); }
        }
      }
      return { seriesId: series!.id, occurrences, created: occurrences.filter((o) => o.status === 'create').length };
    });
  }

  /** Participation : exceptions (présentiel, distanciel, exclu) ; « défaut » rétablit la règle. */
  participants(ctx: RequestContext, slotId: string, b: { participants: SlotFields['participants']; version?: number }, opts: WriteOpts) {
    return this.run(ctx, 'slot.participants', opts, async (tx, w) => {
      await this.apply(tx, ctx, w, slotId, { participants: b.participants }, { version: b.version, reason: opts.reason });
      return { id: slotId };
    });
  }

  /**
   * Simulation sans écriture (savepoint annulé) : contrôle en direct du formulaire,
   * disponibilité des ressources candidates, prochains créneaux compatibles.
   */
  async simulate<T = SlotCheck>(tx: Tx, ctx: RequestContext, target: { slotId?: string; sessionId?: string }, f: SlotFields, rules: string[] | undefined, after?: (c: SlotCheck) => T): Promise<T> {
    await tx.query('SAVEPOINT sim');
    try {
      const w = new Work(tx);
      let id = target.slotId;
      if (id) await this.apply(tx, ctx, w, id, f);
      else id = await this.insert(tx, ctx, w, target.sessionId!, f as SlotFields & { startsAt: string; endsAt: string });
      const [c] = await checkSlots(tx, [id], { changed: new Set([id]), rules });
      return after ? after(c) : (c as unknown as T);
    } finally {
      await tx.query('ROLLBACK TO SAVEPOINT sim');
    }
  }
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
export { daysBetween };
