import { Tx, many, one } from '../../../core/db';
import { WeeklyHours, addDays, dailySegments, fmtRange, local, withinWeekly } from './time';

/**
 * Moteur de règles du planning (§5). Exécuté côté serveur pour toute écriture : saisie,
 * glisser-déposer, duplication, récurrence, édition groupée, import, API.
 * Les contrôles lisent l'état de la base APRÈS écriture provisoire dans la transaction :
 * les séances déplacées ensemble sont donc contrôlées entre elles, et toute réservation
 * active est prise en compte, même hors de la vue filtrée.
 */

export type Severity = 'blocking' | 'warning';
export interface Issue {
  rule: string;
  severity: Severity;
  derogable: boolean;
  message: string;
  slotId: string;
  ref?: { type: 'trainer' | 'room' | 'equipment' | 'site' | 'learner' | 'session'; id: string; label: string };
  other?: { slotId: string; sessionId: string; sessionTitle: string; startsAt: string; endsAt: string };
}
export interface SlotCheck { slotId: string; sessionId: string; startsAt: string; endsAt: string; title: string; blocking: Issue[]; warnings: Issue[] }

export interface PlanningSettings {
  grid_step: number; day_start: string; day_end: string; workdays: number[]; direct_publish: boolean; overlap_derogable: boolean;
  max_daily_minutes: number; default_weekly_minutes: number; short_notice_hours: number; unusual_before: string; unusual_after: string;
}
export const DEFAULT_SETTINGS: PlanningSettings = {
  grid_step: 15, day_start: '07:00', day_end: '20:00', workdays: [1, 2, 3, 4, 5], direct_publish: true, overlap_derogable: false,
  max_daily_minutes: 480, default_weekly_minutes: 2100, short_notice_hours: 48, unusual_before: '07:30', unusual_after: '19:30',
};
export async function loadSettings(tx: Tx): Promise<PlanningSettings> {
  const s = await one(tx, `SELECT * FROM planning_settings`);
  return s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
}

/** Statuts qui réservent les ressources : brouillon compris (§6), annulé exclu. */
export const ACTIVE_SLOT = `sl.status <> 'cancelled'`;
const ACTIVE_OTHER = `o.status <> 'cancelled' AND ots.status NOT IN ('cancelled','archived')`;
export const PUBLISHED = ['pending', 'published'];

const iso = (d: any) => new Date(d).toISOString();
const fmtH = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;

/**
 * Contrôle des séances (déjà écrites dans la transaction courante).
 * publish : contrôles de publication (complétude) en plus ; par défaut selon le statut de la séance.
 * changed : séances effectivement modifiées par l'opération (alerte délai court).
 */
export async function checkSlots(tx: Tx, slotIds: string[], opts: { publish?: boolean; changed?: Set<string>; rules?: string[] } = {}): Promise<SlotCheck[]> {
  const settings = await loadSettings(tx);
  const out: SlotCheck[] = [];
  for (const id of slotIds) out.push(await checkOne(tx, id, settings, opts));
  // Dérogation déjà accordée sur la séance (mêmes règles, horaires inchangés) : reste valable.
  const derogs = slotIds.length ? await many(tx, `SELECT id, derogation FROM slots WHERE id = ANY($1::uuid[]) AND derogation IS NOT NULL`, [slotIds]) : [];
  for (const d of derogs) {
    const c = out.find((x) => x.slotId === d.id)!;
    const rules: string[] = d.derogation.rules ?? [];
    const kept = c.blocking.filter((i) => !(i.derogable && rules.includes(i.rule)));
    for (const i of c.blocking.filter((i) => !kept.includes(i))) c.warnings.push({ ...i, severity: 'warning', message: `${i.message} (dérogation : ${d.derogation.reason})` });
    c.blocking = kept;
  }
  return out;
}

async function checkOne(tx: Tx, slotId: string, settings: PlanningSettings, opts: { publish?: boolean; changed?: Set<string>; rules?: string[] }): Promise<SlotCheck> {
  const sl = await one(tx, `
    SELECT sl.*, slot_site(sl.id) AS site_id, ts.title AS session_title, ts.status AS session_status, ts.timezone, ts.capacity AS session_capacity,
           ts.min_participants, ts.required_skills, ts.required_equipment, ts.site_id AS session_site_id,
           coalesce(ts.target_minutes, v.duration_minutes) AS target_minutes
      FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id JOIN program_versions v ON v.id = ts.program_version_id
     WHERE sl.id = $1`, [slotId]);
  const res: SlotCheck = { slotId, sessionId: sl?.session_id, startsAt: sl ? iso(sl.starts_at) : '', endsAt: sl ? iso(sl.ends_at) : '', title: sl?.title || sl?.session_title || '', blocking: [], warnings: [] };
  if (!sl || sl.status === 'cancelled') return res;
  const tz = sl.timezone as string;
  const start = new Date(sl.starts_at); const end = new Date(sl.ends_at);
  const when = fmtRange(start, end, tz);
  const want = (rule: string) => !opts.rules || opts.rules.includes(rule);
  const add = (severity: Severity, rule: string, derogable: boolean, message: string, extra: Partial<Issue> = {}) => {
    if (!want(rule)) return;
    (severity === 'blocking' ? res.blocking : res.warnings).push({ rule, severity, derogable, message, slotId, ...extra });
  };
  const publish = opts.publish ?? PUBLISHED.includes(sl.status);
  const overlapDerogable = settings.overlap_derogable;
  const otherOf = (o: any) => ({ slotId: o.slot_id, sessionId: o.session_id, sessionTitle: o.session_title, startsAt: iso(o.starts_at), endsAt: iso(o.ends_at) });

  // ─── Cohérence temporelle et pauses ─────────────────────────────────────
  const breaks: { startsAt: string; endsAt: string }[] = Array.isArray(sl.breaks) ? sl.breaks : [];
  const sorted = breaks.map((b) => [new Date(b.startsAt).getTime(), new Date(b.endsAt).getTime()]).sort((a, b) => a[0] - b[0]);
  let breakTotal = 0;
  sorted.forEach(([bs, be], i) => {
    breakTotal += (be - bs) / 60000;
    if (!(be > bs) || bs < start.getTime() || be > end.getTime()) add('blocking', 'breaks', false, `Pause invalide (${when}) : durée positive et incluse dans la séance attendues.`);
    else if (i > 0 && bs < sorted[i - 1][1]) add('blocking', 'breaks', false, `Pauses qui se chevauchent (${when}).`);
  });
  const total = (end.getTime() - start.getTime()) / 60000;
  if (breaks.length && breakTotal >= total) add('blocking', 'breaks', false, `Pauses couvrant toute la séance (${when}) : durée pédagogique nulle.`);

  // ─── Formateurs ─────────────────────────────────────────────────────────
  const trainers = await many(tx, `
    SELECT p.id, p.first_name || ' ' || p.last_name AS name, p.skills, p.archived_at, st.role,
           coalesce(tp.active, true) AS active, coalesce(tp.travel_minutes, 0) AS travel_minutes, coalesce(tp.allowed_site_ids, '{}') AS allowed_site_ids,
           tp.working_hours, tp.max_weekly_minutes
      FROM slot_trainers st JOIN persons p ON p.id = st.person_id LEFT JOIN trainer_profiles tp ON tp.person_id = p.id
     WHERE st.slot_id = $1 ORDER BY p.last_name`, [slotId]);
  for (const t of trainers) {
    const ref = { type: 'trainer' as const, id: t.id, label: t.name };
    if (t.archived_at || !t.active) add('blocking', 'inactive_trainer', false, `${t.name} est inactif : affectation impossible.`, { ref });
    // Double réservation (coanimation dans la même séance exclue par construction) puis temps de déplacement.
    const clashes = await many(tx, `
      SELECT o.id slot_id, o.session_id, ots.title session_title, o.starts_at, o.ends_at, slot_site(o.id) AS site_id
        FROM slot_trainers st JOIN slots o ON o.id = st.slot_id JOIN training_sessions ots ON ots.id = o.session_id
       WHERE st.person_id = $1 AND o.id <> $2 AND ${ACTIVE_OTHER}
         AND o.starts_at < $4::timestamptz + make_interval(mins => $5) AND o.ends_at > $3::timestamptz - make_interval(mins => $5)
       ORDER BY o.starts_at`, [t.id, slotId, start, end, t.travel_minutes]);
    for (const o of clashes) {
      const os = new Date(o.starts_at).getTime(); const oe = new Date(o.ends_at).getTime();
      if (os < end.getTime() && oe > start.getTime()) {
        add('blocking', 'trainer_overlap', overlapDerogable, `${t.name} est déjà réservé(e) ${fmtRange(o.starts_at, o.ends_at, tz)} (${o.session_title}).`, { ref, other: otherOf(o) });
      } else if (o.session_id !== sl.session_id && !(o.site_id && sl.site_id && o.site_id === sl.site_id)) {
        add('blocking', 'travel_time', overlapDerogable, `${t.name} : ${t.travel_minutes} min de déplacement requises avant/après ${fmtRange(o.starts_at, o.ends_at, tz)} (${o.session_title}).`, { ref, other: otherOf(o) });
      }
    }
    await unavailability(tx, 'person', t.id, start, end, (msg) => add('blocking', 'unavailable', false, `${t.name} indisponible : ${msg}.`, { ref }));
    if (t.allowed_site_ids.length && sl.site_id && !t.allowed_site_ids.includes(sl.site_id)) {
      add('blocking', 'site_not_allowed', true, `${t.name} n'est pas autorisé(e) sur ce site.`, { ref });
    }
    if (t.working_hours && !withinWeekly(t.working_hours, start, end, tz) && !(await availableException(tx, 'person', t.id, start, end))) {
      add('warning', 'trainer_hours', true, `${t.name} : séance hors de ses horaires habituels.`, { ref });
    }
    // Charge : jour et semaine (heures réservées).
    const l = local(start, tz);
    const monday = addDays(l.date, -(l.dow - 1));
    const load = await one(tx, `
      SELECT coalesce(sum(extract(epoch FROM o.ends_at - o.starts_at) / 60) FILTER (WHERE (o.starts_at AT TIME ZONE $3)::date = $4::date), 0)::int AS day,
             coalesce(sum(extract(epoch FROM o.ends_at - o.starts_at) / 60), 0)::int AS week
        FROM slot_trainers st JOIN slots o ON o.id = st.slot_id JOIN training_sessions ots ON ots.id = o.session_id
       WHERE st.person_id = $1 AND ${ACTIVE_OTHER}
         AND (o.starts_at AT TIME ZONE $3)::date BETWEEN $2::date AND $2::date + 6`, [t.id, monday, tz, l.date]);
    if (load!.day > settings.max_daily_minutes) add('warning', 'trainer_load', true, `${t.name} : ${fmtH(load!.day)} le ${l.date.split('-').reverse().join('/')} (maximum ${fmtH(settings.max_daily_minutes)}).`, { ref });
    const weekly = t.max_weekly_minutes ?? null;
    if (weekly && load!.week > weekly) add('warning', 'trainer_load', true, `${t.name} : ${fmtH(load!.week)} sur la semaine (maximum ${fmtH(weekly)}).`, { ref });
  }

  // ─── Ressources : salles, matériel, lieux ──────────────────────────────
  const resources = await many(tx, `
    SELECT r.* FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = $1 ORDER BY r.kind, r.name`, [slotId]);
  for (const r of resources) {
    const ref = { type: r.kind as 'room' | 'equipment' | 'site', id: r.id, label: r.name };
    if (r.archived_at) add('blocking', 'inactive_resource', false, `${r.name} est désactivé(e).`, { ref });
    if (r.kind !== 'site') {
      const buffer = r.setup_minutes + r.teardown_minutes;
      const clashes = await many(tx, `
        SELECT o.id slot_id, o.session_id, ots.title session_title, o.starts_at, o.ends_at
          FROM slot_resources sr JOIN slots o ON o.id = sr.slot_id JOIN training_sessions ots ON ots.id = o.session_id
         WHERE sr.resource_id = $1 AND o.id <> $2 AND ${ACTIVE_OTHER}
           AND o.starts_at < $4::timestamptz + make_interval(mins => $5) AND o.ends_at > $3::timestamptz - make_interval(mins => $5)
         ORDER BY o.starts_at`, [r.id, slotId, start, end, buffer]);
      for (const o of clashes) {
        const raw = new Date(o.starts_at).getTime() < end.getTime() && new Date(o.ends_at).getTime() > start.getTime();
        add('blocking', raw ? 'resource_overlap' : 'setup_time', overlapDerogable, raw
          ? `${r.name} est déjà réservé(e) ${fmtRange(o.starts_at, o.ends_at, tz)} (${o.session_title}).`
          : `${r.name} : ${r.setup_minutes} min de préparation et ${r.teardown_minutes} min de remise en état à respecter autour de ${fmtRange(o.starts_at, o.ends_at, tz)} (${o.session_title}).`, { ref, other: otherOf(o) });
      }
    }
    await unavailability(tx, 'resource', r.id, start, end, (msg) => add('blocking', 'unavailable', false, `${r.name} indisponible : ${msg}.`, { ref }));
    if (r.opening_hours && !withinWeekly(r.opening_hours as WeeklyHours, start, end, tz) && !(await availableException(tx, 'resource', r.id, start, end))) {
      add('blocking', 'outside_hours', true, `${r.name} : séance hors des horaires d'ouverture.`, { ref });
    }
    if (r.kind === 'equipment' && r.inspection_due_on && String(r.inspection_due_on).slice(0, 10) < local(start, tz).date) {
      add(publish ? 'blocking' : 'warning', 'inspection_overdue', false, `${r.name} : vérification périodique échue le ${String(r.inspection_due_on).slice(0, 10).split('-').reverse().join('/')}.`, { ref });
    }
  }

  // ─── Fermetures (centre ou site) ───────────────────────────────────────
  const days = dailySegments(start, end, tz).map((s) => s.date);
  const closures = await many(tx, `SELECT c.label, c.site_id FROM closures c WHERE c.starts_on <= $2::date AND c.ends_on >= $1::date AND (c.site_id IS NULL OR c.site_id = $3)`,
    [days[0], days[days.length - 1], sl.site_id]);
  for (const c of closures) add('blocking', 'closure', true, `Fermeture ${c.site_id ? 'du site' : 'du centre'} : ${c.label}.`);

  // ─── Participants : capacité, collisions, dates d'inscription ──────────
  const parts = await many(tx, `
    SELECT x.*, p.first_name || ' ' || p.last_name AS name FROM slot_expected x JOIN persons p ON p.id = x.person_id WHERE x.slot_id = $1`, [slotId]);
  const expected = parts.filter((x) => ['onsite', 'remote'].includes(x.mode) && x.dates_ok);
  for (const x of parts) {
    if (x.explicit && ['onsite', 'remote'].includes(x.mode) && !x.dates_ok) {
      add('blocking', 'enrollment_dates', false, `${x.name} : inscription incompatible avec la date de la séance.`, { ref: { type: 'learner', id: x.person_id, label: x.name } });
    }
  }
  const onsite = expected.filter((x) => x.mode === 'onsite').length;
  const rooms = resources.filter((r) => r.kind === 'room' && r.capacity);
  if (rooms.length && sl.modality !== 'remote') {
    // Pas d'addition automatique de salles indépendantes : la plus grande salle réservée fait foi.
    const cap = Math.max(...rooms.map((r) => r.capacity));
    if (onsite > cap) add('blocking', 'capacity', false, `Capacité dépassée : ${onsite} participant(s) en présentiel pour ${cap} place(s).`, { ref: { type: 'room', id: rooms[0].id, label: rooms[0].name } });
  }
  if (expected.length) {
    const clashes = await many(tx, `
      SELECT DISTINCT ON (b.person_id, o.id) b.person_id, p.first_name || ' ' || p.last_name AS name, o.id slot_id, o.session_id, ots.title session_title, o.starts_at, o.ends_at
        FROM slot_expected b JOIN slots o ON o.id = b.slot_id JOIN training_sessions ots ON ots.id = o.session_id JOIN persons p ON p.id = b.person_id
       WHERE b.person_id = ANY($1::uuid[]) AND b.slot_id <> $2 AND b.mode IN ('onsite','remote') AND b.dates_ok AND ${ACTIVE_OTHER}
         AND o.starts_at < $4 AND o.ends_at > $3`, [expected.map((x) => x.person_id), slotId, start, end]);
    for (const o of clashes) {
      add('blocking', 'learner_overlap', overlapDerogable, `${o.name} est déjà attendu(e) ${fmtRange(o.starts_at, o.ends_at, tz)} (${o.session_title}).`, { ref: { type: 'learner', id: o.person_id, label: o.name }, other: otherOf(o) });
    }
  }
  const toResolve = parts.filter((x) => x.mode === 'to_resolve');
  if (toResolve.length) add('warning', 'participant_to_resolve', false, `${toResolve.length} participant(s) à résoudre (collision ou capacité) : non comptés comme attendus.`);
  if (sl.min_participants && expected.length < sl.min_participants) add('warning', 'min_participants', true, `Effectif minimum non atteint : ${expected.length} / ${sl.min_participants}.`);

  // ─── Besoins : compétences, équipements ────────────────────────────────
  if (sl.required_skills?.length && trainers.length) {
    const have = new Set(trainers.flatMap((t) => (t.skills ?? []).map((s: string) => s.toLowerCase())));
    const missing = sl.required_skills.filter((s: string) => !have.has(s.toLowerCase()));
    if (missing.length) add('blocking', 'skill', true, `Compétence exigée non couverte : ${missing.join(', ')}.`);
  }
  if (sl.required_equipment?.length && sl.modality !== 'remote' && (resources.some((r) => r.kind !== 'site') || publish)) {
    const have = new Set(resources.flatMap((r) => [...(r.equipment ?? []), r.kind === 'equipment' ? r.category ?? r.name : null, r.kind === 'equipment' ? r.name : null]).filter(Boolean).map((s: string) => s.toLowerCase()));
    const missing = sl.required_equipment.filter((s: string) => !have.has(s.toLowerCase()));
    if (missing.length) add('blocking', 'equipment_required', true, `Équipement requis non couvert : ${missing.join(', ')}.`);
  }

  // ─── Complétude exigée à la publication ────────────────────────────────
  if (publish) {
    if (!trainers.length) add('blocking', 'missing_trainer', false, `Formateur manquant (${when}).`);
    if (sl.modality !== 'onsite' && !sl.video_url) add('blocking', 'missing_video', false, `Lien de visioconférence obligatoire en ${sl.modality === 'remote' ? 'distanciel' : 'hybride'} (${when}).`);
    if (sl.modality !== 'remote' && !resources.some((r) => r.kind === 'room' || r.kind === 'site') && !sl.session_site_id) {
      add('blocking', 'missing_place', false, `Lieu ou salle manquant (${when}).`);
    }
  }

  // ─── Alertes ───────────────────────────────────────────────────────────
  const ls = local(start, tz); const le = local(end, tz);
  if (ls.hm < settings.unusual_before || (le.date === ls.date ? le.hm > settings.unusual_after : true)) {
    add('warning', 'unusual_hours', true, `Horaires inhabituels (${when}).`);
  }
  if (opts.changed?.has(slotId) && start.getTime() > Date.now() && start.getTime() - Date.now() < settings.short_notice_hours * 3600000) {
    add('warning', 'short_notice', true, `Délai court : séance dans moins de ${settings.short_notice_hours} h.`);
  }
  const sum = await one(tx, `SELECT coalesce(sum(slot_pedagogical_minutes(starts_at, ends_at, breaks)), 0)::int AS m FROM slots WHERE session_id = $1 AND status <> 'cancelled'`, [sl.session_id]);
  if (sl.target_minutes && sum!.m !== sl.target_minutes) {
    add('warning', 'target_duration', true, `${sl.session_title} : ${fmtH(sum!.m)} planifiées pour une durée cible de ${fmtH(sl.target_minutes)} (${sum!.m < sl.target_minutes ? 'non atteinte' : 'dépassée'}).`, { ref: { type: 'session', id: sl.session_id, label: sl.session_title } });
  }
  return res;
}

async function unavailability(tx: Tx, ownerType: string, ownerId: string, start: Date, end: Date, report: (msg: string) => void) {
  const rows = await many(tx, `SELECT reason, starts_at, ends_at FROM availabilities
                                WHERE owner_type = $1 AND owner_id = $2 AND kind = 'unavailable' AND status = 'approved' AND starts_at < $4 AND ends_at > $3`,
    [ownerType, ownerId, start, end]);
  for (const r of rows) report(r.reason || 'période d’indisponibilité');
}
async function availableException(tx: Tx, ownerType: string, ownerId: string, start: Date, end: Date) {
  return !!(await one(tx, `SELECT 1 FROM availabilities WHERE owner_type = $1 AND owner_id = $2 AND kind = 'available' AND status = 'approved' AND starts_at <= $3 AND ends_at >= $4`,
    [ownerType, ownerId, start, end]));
}

/**
 * Nouvelle inscription ou changement de groupe : vérification de toutes les séances futures
 * concernées. Collision ou surcapacité → participation « à résoudre » (non attendue), jamais
 * introduite silencieusement dans une séance publiée.
 */
export async function reconcileEnrollment(tx: Tx, tenantId: string, enrollmentId: string) {
  const rows = await many(tx, `SELECT x.slot_id, x.person_id FROM slot_expected x JOIN slots sl ON sl.id = x.slot_id
                                WHERE x.enrollment_id = $1 AND sl.status NOT IN ('cancelled','done') AND sl.ends_at > now()
                                  AND x.mode IN ('onsite','remote') AND x.dates_ok`, [enrollmentId]);
  const unresolved: { slotId: string; reason: string }[] = [];
  for (const r of rows) {
    const [c] = await checkSlots(tx, [r.slot_id], { rules: ['learner_overlap', 'capacity'] });
    const hit = c.blocking.find((i) => (i.rule === 'learner_overlap' && i.ref?.id === r.person_id) || i.rule === 'capacity');
    if (!hit) continue;
    await tx.query(`INSERT INTO slot_participants(tenant_id, slot_id, enrollment_id, mode, reason) VALUES ($1,$2,$3,'to_resolve',$4)
                    ON CONFLICT (tenant_id, slot_id, enrollment_id) DO UPDATE SET mode = 'to_resolve', reason = EXCLUDED.reason, updated_at = now()`,
      [tenantId, r.slot_id, enrollmentId, hit.message]);
    unresolved.push({ slotId: r.slot_id, reason: hit.message });
  }
  return unresolved;
}
