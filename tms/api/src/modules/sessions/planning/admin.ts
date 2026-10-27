import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../core/audit.service';
import { RequestContext } from '../../../core/context';
import { Db, many, one } from '../../../core/db';
import { AppError, badRequest, forbidden, notFound } from '../../../core/errors';
import { decodeText, parseCsv, parseXlsx } from '../../migration/tabular';
import { PlanningEngine, WriteOpts } from './engine';
import { PlanningSettings, checkSlots, loadSettings } from './rules';
import { zoned } from './time';

/** Disponibilités, fermetures, profils formateurs, paramètres du centre, import. */
@Injectable()
export class PlanningAdmin {
  constructor(private db: Db, private audit: AuditService, private engine: PlanningEngine) {}

  // ─── Paramètres ─────────────────────────────────────────────────────────
  settings(ctx: RequestContext) { return this.db.tenantTx(ctx.tenantId, loadSettings); }
  saveSettings(ctx: RequestContext, b: Partial<PlanningSettings>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const s = { ...(await loadSettings(tx)), ...b };
      await tx.query(`INSERT INTO planning_settings(tenant_id, grid_step, day_start, day_end, workdays, direct_publish, overlap_derogable, max_daily_minutes,
                                                    default_weekly_minutes, short_notice_hours, unusual_before, unusual_after, updated_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
                      ON CONFLICT (tenant_id) DO UPDATE SET grid_step=EXCLUDED.grid_step, day_start=EXCLUDED.day_start, day_end=EXCLUDED.day_end, workdays=EXCLUDED.workdays,
                        direct_publish=EXCLUDED.direct_publish, overlap_derogable=EXCLUDED.overlap_derogable, max_daily_minutes=EXCLUDED.max_daily_minutes,
                        default_weekly_minutes=EXCLUDED.default_weekly_minutes, short_notice_hours=EXCLUDED.short_notice_hours, unusual_before=EXCLUDED.unusual_before,
                        unusual_after=EXCLUDED.unusual_after, updated_at=now()`,
        [ctx.tenantId, s.grid_step, s.day_start, s.day_end, s.workdays, s.direct_publish, s.overlap_derogable, s.max_daily_minutes, s.default_weekly_minutes, s.short_notice_hours, s.unusual_before, s.unusual_after]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'planning.settings_updated', data: b });
      return loadSettings(tx);
    });
  }

  // ─── Profil formateur ───────────────────────────────────────────────────
  profile(ctx: RequestContext, personId: string) {
    if (ctx.role === 'trainer' && ctx.personId !== personId) throw forbidden('permission_denied', 'Profil d’un autre formateur.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await one(tx, `SELECT pe.id, pe.first_name || ' ' || pe.last_name AS name, pe.skills, tp.* FROM persons pe
                                 JOIN person_roles r ON r.person_id = pe.id AND r.role = 'trainer' LEFT JOIN trainer_profiles tp ON tp.person_id = pe.id WHERE pe.id = $1`, [personId]);
      if (!p) throw notFound('Formateur');
      return { ...p, person_id: personId, status: p.status ?? 'internal', active: p.active ?? true, travel_minutes: p.travel_minutes ?? 0, allowed_site_ids: p.allowed_site_ids ?? [] };
    });
  }
  saveProfile(ctx: RequestContext, personId: string, b: { status?: 'internal' | 'external'; allowedSiteIds?: string[]; workingHours?: any; maxWeeklyMinutes?: number | null; travelMinutes?: number; active?: boolean; skills?: string[] }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (!(await one(tx, `SELECT 1 FROM person_roles WHERE person_id = $1 AND role = 'trainer'`, [personId]))) throw notFound('Formateur');
      const cur = await one(tx, `SELECT * FROM trainer_profiles WHERE person_id = $1`, [personId]);
      const v = {
        status: b.status ?? cur?.status ?? 'internal', allowed: b.allowedSiteIds ?? cur?.allowed_site_ids ?? [], hours: b.workingHours !== undefined ? b.workingHours : cur?.working_hours ?? null,
        max: b.maxWeeklyMinutes !== undefined ? b.maxWeeklyMinutes : cur?.max_weekly_minutes ?? null, travel: b.travelMinutes ?? cur?.travel_minutes ?? 0, active: b.active ?? cur?.active ?? true,
      };
      await tx.query(`INSERT INTO trainer_profiles(tenant_id, person_id, status, allowed_site_ids, working_hours, max_weekly_minutes, travel_minutes, active, updated_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
                      ON CONFLICT (tenant_id, person_id) DO UPDATE SET status=EXCLUDED.status, allowed_site_ids=EXCLUDED.allowed_site_ids, working_hours=EXCLUDED.working_hours,
                        max_weekly_minutes=EXCLUDED.max_weekly_minutes, travel_minutes=EXCLUDED.travel_minutes, active=EXCLUDED.active, updated_at=now()`,
        [ctx.tenantId, personId, v.status, v.allowed, v.hours && JSON.stringify(v.hours), v.max, v.travel, v.active]);
      if (b.skills) await tx.query(`UPDATE persons SET skills = $2 WHERE id = $1`, [personId, b.skills]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'planning.trainer_profile_updated', entityType: 'person', entityId: personId, data: { fields: Object.keys(b) } });
      return { ok: true };
    });
  }

  // ─── Disponibilités ─────────────────────────────────────────────────────
  availabilities(ctx: RequestContext, q: { ownerId?: string; from?: string; to?: string; status?: string }) {
    const own = ctx.role === 'trainer' ? ctx.personId ?? '00000000-0000-0000-0000-000000000000' : null;
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT a.*, coalesce(pe.first_name || ' ' || pe.last_name, r.name) AS owner_name
        FROM availabilities a LEFT JOIN persons pe ON a.owner_type = 'person' AND pe.id = a.owner_id LEFT JOIN resources r ON a.owner_type = 'resource' AND r.id = a.owner_id
       WHERE ($1::uuid IS NULL OR a.owner_id = $1) AND ($2::timestamptz IS NULL OR a.ends_at > $2) AND ($3::timestamptz IS NULL OR a.starts_at < $3)
         AND ($4::text IS NULL OR a.status = $4) AND ($5::uuid IS NULL OR a.owner_id = $5)
       ORDER BY a.starts_at LIMIT 1000`, [q.ownerId ?? null, q.from ?? null, q.to ?? null, q.status ?? null, own]));
  }

  /** Gestionnaire : approuvée d'emblée. Formateur : pour lui-même, soumise à validation. */
  createAvailability(ctx: RequestContext, b: { ownerType: 'person' | 'resource'; ownerId: string; kind: 'unavailable' | 'available'; startsAt: string; endsAt: string; reason?: string | null }) {
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('invalid_range', 'La fin doit être postérieure au début.', 'endsAt');
    const manager = ctx.permissions.has('sessions.write');
    if (!manager && !(ctx.role === 'trainer' && b.ownerType === 'person' && b.ownerId === ctx.personId)) throw forbidden('permission_denied', 'Saisie limitée à vos propres disponibilités.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const exists = b.ownerType === 'person' ? await one(tx, `SELECT 1 FROM persons WHERE id = $1`, [b.ownerId]) : await one(tx, `SELECT 1 FROM resources WHERE id = $1`, [b.ownerId]);
      if (!exists) throw notFound(b.ownerType === 'person' ? 'Personne' : 'Ressource');
      const a = await one(tx, `INSERT INTO availabilities(tenant_id, owner_type, owner_id, kind, starts_at, ends_at, reason, status, created_by, decided_by)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.tenantId, b.ownerType, b.ownerId, b.kind, b.startsAt, b.endsAt, b.reason ?? null, manager ? 'approved' : 'pending', ctx.userId, manager ? ctx.userId : null]);
      // Séances actives désormais touchées par l'indisponibilité : signalées (jamais modifiées silencieusement).
      const impacted = a!.status === 'approved' && b.kind === 'unavailable' ? await this.impacted(tx, b.ownerType, b.ownerId, b.startsAt, b.endsAt) : [];
      return { ...a, impacted };
    });
  }
  private impacted(tx: any, ownerType: string, ownerId: string, startsAt: string | Date, endsAt: string | Date) {
    return many(tx, `SELECT sl.id, sl.session_id, sl.starts_at, sl.ends_at, ts.title AS session_title FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id
                      WHERE sl.status NOT IN ('cancelled','done') AND sl.starts_at < $4 AND sl.ends_at > $3
                        AND (($1 = 'person' AND EXISTS (SELECT 1 FROM slot_trainers st WHERE st.slot_id = sl.id AND st.person_id = $2))
                          OR ($1 = 'resource' AND EXISTS (SELECT 1 FROM slot_resources sr WHERE sr.slot_id = sl.id AND sr.resource_id = $2)))
                      ORDER BY sl.starts_at`, [ownerType, ownerId, startsAt, endsAt]);
  }
  decideAvailability(ctx: RequestContext, id: string, status: 'approved' | 'rejected') {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const a = await one(tx, `UPDATE availabilities SET status = $2, decided_by = $3 WHERE id = $1 AND status = 'pending' RETURNING *`, [id, status, ctx.userId]);
      if (!a) throw notFound('Demande en attente');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: `availability.${status}`, entityType: 'availability', entityId: id });
      const impacted = status === 'approved' && a.kind === 'unavailable' ? await this.impacted(tx, a.owner_type, a.owner_id, a.starts_at, a.ends_at) : [];
      return { ...a, impacted };
    });
  }
  deleteAvailability(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const a = await one(tx, `SELECT * FROM availabilities WHERE id = $1`, [id]);
      if (!a) throw notFound('Disponibilité');
      if (!ctx.permissions.has('sessions.write') && !(a.owner_id === ctx.personId && a.status === 'pending')) throw forbidden('permission_denied', 'Suppression non autorisée.');
      await tx.query(`DELETE FROM availabilities WHERE id = $1`, [id]);
      return { deleted: true };
    });
  }

  // ─── Fermetures ─────────────────────────────────────────────────────────
  closures(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT c.*, r.name AS site_name FROM closures c LEFT JOIN resources r ON r.id = c.site_id ORDER BY c.starts_on DESC LIMIT 500`));
  }
  createClosure(ctx: RequestContext, b: { siteId?: string | null; startsOn: string; endsOn: string; label: string }) {
    if (b.endsOn < b.startsOn) throw badRequest('invalid_range', 'Fin antérieure au début.', 'endsOn');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (b.siteId && !(await one(tx, `SELECT 1 FROM resources WHERE id = $1 AND kind = 'site'`, [b.siteId]))) throw badRequest('invalid_site', 'Site inconnu.', 'siteId');
      const c = await one(tx, `INSERT INTO closures(tenant_id, site_id, starts_on, ends_on, label) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ctx.tenantId, b.siteId ?? null, b.startsOn, b.endsOn, b.label]);
      // Politique de report explicite : séances concernées listées, à déplacer ou annuler par le planificateur.
      const impacted = await many(tx, `SELECT sl.id, sl.session_id, sl.starts_at, sl.ends_at, ts.title AS session_title FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id
                                        WHERE sl.status NOT IN ('cancelled','done') AND (sl.starts_at AT TIME ZONE ts.timezone)::date BETWEEN $1 AND $2
                                          AND ($3::uuid IS NULL OR slot_site(sl.id) = $3) ORDER BY sl.starts_at`, [b.startsOn, b.endsOn, b.siteId ?? null]);
      return { ...c, impacted };
    });
  }
  deleteClosure(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (!(await one(tx, `DELETE FROM closures WHERE id = $1 RETURNING id`, [id]))) throw notFound('Fermeture');
      return { deleted: true };
    });
  }

  // ─── Import CSV / Excel ─────────────────────────────────────────────────
  /**
   * Correspondance des colonnes, contrôle des dates et fuseaux, doublons, rapport par ligne.
   * Mêmes contrôles que l'interface ; atomique par défaut, partiel sur choix explicite.
   * Second essai : lignes déjà présentes reconnues comme doublons, rien n'est recréé.
   */
  async import(ctx: RequestContext, b: { csv?: string; fileBase64?: string; filename?: string; mapping?: Record<string, string>; partial?: boolean }, opts: WriteOpts) {
    let rows: Record<string, string>[];
    if (b.csv != null) rows = parseCsv(b.csv).rows;
    else if (b.fileBase64) {
      const buf = Buffer.from(b.fileBase64, 'base64');
      if ((b.filename ?? '').toLowerCase().endsWith('.xlsx')) rows = (await parseXlsx(buf, 'planning'))[0]?.rows ?? [];
      else rows = parseCsv(decodeText(buf).text).rows;
    } else throw badRequest('file_required', 'Fichier CSV ou Excel requis.');
    if (rows.length > 2000) throw badRequest('too_many_rows', 'Import limité à 2 000 lignes par fichier.');
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ALIASES: Record<string, string[]> = {
      session: ['session', 'reference', 'referencesession', 'sessionreference', 'codesession'], date: ['date', 'jour'], start: ['debut', 'heuredebut', 'start', 'de'],
      end: ['fin', 'heurefin', 'end', 'a'], trainers: ['formateur', 'formateurs', 'intervenant', 'intervenants', 'trainers'], resources: ['salle', 'salles', 'lieu', 'ressources', 'materiel'],
      title: ['intitule', 'titre', 'seance', 'title', 'module'], modality: ['modalite', 'modality'], video: ['lien', 'visio', 'lienvisio', 'videourl'],
    };
    const col = (row: Record<string, string>, key: string) => {
      const mapped = b.mapping?.[key];
      if (mapped) return row[mapped] ?? '';
      const h = Object.keys(row).find((k) => ALIASES[key].includes(norm(k)));
      return h ? row[h] : '';
    };
    const parseDate = (v: string) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v) ; if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
    const parseTime = (v: string) => { const m = /^(\d{1,2})\s*[:hH]\s*(\d{2})?$/.exec(v.trim()); if (!m || +m[1] > 24) return null; return `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`; };
    const MODALITY: Record<string, string> = { presentiel: 'onsite', onsite: 'onsite', distanciel: 'remote', remote: 'remote', hybride: 'hybrid', hybrid: 'hybrid' };

    return this.engine.run(ctx, 'planning.import', opts, async (tx, w) => {
      const sessions = await many(tx, `SELECT id, title, reference, timezone FROM training_sessions WHERE status NOT IN ('archived','cancelled')`);
      const trainers = await many(tx, `SELECT pe.id, lower(pe.email) AS email, lower(pe.first_name || ' ' || pe.last_name) AS name FROM persons pe JOIN person_roles r ON r.person_id = pe.id AND r.role = 'trainer' WHERE pe.archived_at IS NULL`);
      const resources = await many(tx, `SELECT id, lower(name) AS name FROM resources WHERE archived_at IS NULL`);
      const seen = new Set<string>();
      const lines: any[] = [];
      for (const [i, row] of rows.entries()) {
        const line: any = { line: i + 2, status: 'ok', errors: [] as string[] };
        lines.push(line);
        const sRef = col(row, 'session').trim();
        const s = sessions.find((x) => x.id === sRef || (x.reference && x.reference.toLowerCase() === sRef.toLowerCase())) ?? (sessions.filter((x) => x.title.toLowerCase() === sRef.toLowerCase()).length === 1 ? sessions.find((x) => x.title.toLowerCase() === sRef.toLowerCase()) : undefined);
        if (!s) line.errors.push(`Session « ${sRef} » inconnue ou ambiguë (référence attendue).`);
        const date = parseDate(col(row, 'date').trim()); const st = parseTime(col(row, 'start')); const en = parseTime(col(row, 'end'));
        if (!date) line.errors.push('Date invalide (JJ/MM/AAAA ou AAAA-MM-JJ).');
        if (!st || !en) line.errors.push('Heure de début ou de fin invalide (HH:MM).');
        const tIds: string[] = [];
        for (const t of col(row, 'trainers').split(/[|,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
          const found = trainers.filter((x) => x.email === t || x.name === t);
          if (found.length !== 1) line.errors.push(`Formateur « ${t} » inconnu ou ambigu.`); else tIds.push(found[0].id);
        }
        const rIds: string[] = [];
        for (const r of col(row, 'resources').split(/[|,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
          const found = resources.filter((x) => x.name === r);
          if (found.length !== 1) line.errors.push(`Ressource « ${r} » inconnue ou ambiguë.`); else rIds.push(found[0].id);
        }
        const modRaw = norm(col(row, 'modality'));
        const modality = modRaw ? MODALITY[modRaw] : 'onsite';
        if (!modality) line.errors.push('Modalité inconnue (présentiel, distanciel, hybride).');
        if (line.errors.length || !s || !date || !st || !en) { line.status = 'error'; continue; }
        const zs = zoned(date, st, s.timezone); const ze = zoned(en <= st ? addDay(date) : date, en === '24:00' ? '00:00' : en, s.timezone);
        if (zs.status !== 'ok' || ze.status !== 'ok') { line.status = 'error'; line.errors.push('Horaire inexistant ou ambigu (changement d’heure) : préciser.'); continue; }
        const startsAt = zs.at.toISOString(); const endsAt = ze.at.toISOString();
        const key = `${s.id}|${startsAt}|${endsAt}`;
        if (seen.has(key) || (await one(tx, `SELECT 1 FROM slots WHERE session_id = $1 AND starts_at = $2 AND ends_at = $3 AND status <> 'cancelled'`, [s.id, startsAt, endsAt]))) {
          line.status = 'duplicate'; seen.add(key); continue;
        }
        seen.add(key);
        if (b.partial) await tx.query('SAVEPOINT line');
        const id = await this.engine.insert(tx, ctx, w, s.id, { startsAt, endsAt, title: col(row, 'title') || null, modality: modality as any, videoUrl: col(row, 'video') || null,
          trainers: tIds.map((id) => ({ id })), resourceIds: rIds });
        line.slotId = id;
        if (b.partial) {
          const [c] = await checkSlots(tx, [id], { changed: w.changed });
          if (c.blocking.length) {
            await tx.query('ROLLBACK TO SAVEPOINT line');
            w.actions.delete(id); w.before.delete(id); w.changed.delete(id);
            line.status = 'conflict'; line.errors = c.blocking.map((x) => x.message); line.slotId = undefined;
          } else { await tx.query('RELEASE SAVEPOINT line'); w.checked.set(id, c); }
        }
      }
      if (!b.partial) {
        const ids = lines.filter((l) => l.slotId).map((l) => l.slotId);
        for (const c of await checkSlots(tx, ids, { changed: w.changed })) {
          w.checked.set(c.slotId, c);
          if (c.blocking.length) { const l = lines.find((x) => x.slotId === c.slotId); l.status = 'conflict'; l.errors = c.blocking.map((x) => x.message); }
        }
        if (!opts.preview && lines.some((l) => ['error', 'conflict'].includes(l.status))) {
          throw new AppError(409, 'import_rejected', `Import refusé : ${lines.filter((l) => ['error', 'conflict'].includes(l.status)).length} ligne(s) en erreur ou en conflit ; aucune séance créée.`, undefined, { lines });
        }
      }
      return { lines, created: lines.filter((l) => l.status === 'ok').length, duplicates: lines.filter((l) => l.status === 'duplicate').length, rejected: lines.filter((l) => ['error', 'conflict'].includes(l.status)).length };
    });
  }
}

function addDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
