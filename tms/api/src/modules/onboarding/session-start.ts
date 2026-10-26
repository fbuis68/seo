import { Tx, many, one } from '../../core/db';
import { computeEntitlements } from '../billing/entitlements';
import { USAGE_QUERIES, sessionsInMonth, yearOf } from '../billing/usage';
import { checkSlots } from '../sessions/planning/rules';

export interface StartCheck {
  code: string; ok: boolean; severity: 'blocking' | 'warning';
  /** Domaine : catalogue, formateur, lieu, session, planning, apprenants, offre, documents. */
  area: 'catalog' | 'trainer' | 'place' | 'session' | 'planning' | 'learners' | 'plan' | 'documents';
  message: string; screen?: string;
}

const fmtDay = (d: any) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').reverse().join('/') : '');

/**
 * Diagnostic de démarrage (mise en route d'une formation) : tout ce qui empêche de lancer une session
 * d'un programme avec planning et apprenants. Sans session : prérequis de l'organisme (catalogue,
 * formateur, salle, apprenant). Avec session (ou la plus récente) : session, créneaux publiables,
 * inscriptions, quotas de l'offre, documents.
 */
export async function startReadiness(tx: Tx, tenantId: string, o: { sessionId?: string | null } = {}) {
  const checks: StartCheck[] = [];
  const add = (c: StartCheck) => checks.push(c);
  const n = (await one(tx, `SELECT
      (SELECT count(*)::int FROM programs p WHERE p.archived_at IS NULL) programs,
      (SELECT count(*)::int FROM programs p JOIN program_versions v ON v.program_id=p.id WHERE p.archived_at IS NULL AND v.modality <> 'remote') onsite_programs,
      (SELECT count(*)::int FROM persons pe JOIN person_roles r ON r.person_id=pe.id AND r.role='trainer' LEFT JOIN trainer_profiles tp ON tp.person_id=pe.id
        WHERE pe.archived_at IS NULL AND coalesce(tp.active, true)) trainers,
      (SELECT count(*)::int FROM resources WHERE kind IN ('room','site') AND archived_at IS NULL) places,
      (SELECT count(*)::int FROM persons pe JOIN person_roles r ON r.person_id=pe.id AND r.role='learner' WHERE pe.archived_at IS NULL) learners,
      (SELECT count(*)::int FROM training_sessions WHERE status <> 'cancelled' AND NOT is_historical) sessions`))!;

  add({ code: 'program', area: 'catalog', severity: 'blocking', ok: n.programs > 0, message: n.programs ? `${n.programs} formation(s) au catalogue.` : 'Créez une formation au catalogue (intitulé, durée, modalité).', screen: '/onboarding?step=training' });
  add({ code: 'trainer', area: 'trainer', severity: 'blocking', ok: n.trainers > 0, message: n.trainers ? `${n.trainers} formateur(s) actif(s).` : 'Créez au moins un formateur : une séance ne peut pas être publiée sans formateur.', screen: '/onboarding?step=training' });
  add({ code: 'place', area: 'place', severity: n.onsite_programs > 0 || !n.programs ? 'blocking' : 'warning', ok: n.places > 0,
    message: n.places ? `${n.places} salle(s) ou site(s).` : 'Créez une salle (ou un site) : une séance en présentiel ne peut pas être publiée sans lieu.', screen: '/onboarding?step=training' });
  add({ code: 'learner', area: 'learners', severity: 'blocking', ok: n.learners > 0, message: n.learners ? `${n.learners} apprenant(s).` : 'Créez ou importez au moins un apprenant.', screen: '/onboarding?step=data' });

  const s = o.sessionId
    ? await one(tx, `SELECT s.*, v.duration_minutes, v.modality, p.title program_title FROM training_sessions s JOIN program_versions v ON v.id=s.program_version_id JOIN programs p ON p.id=v.program_id WHERE s.id=$1`, [o.sessionId])
    : await one(tx, `SELECT s.*, v.duration_minutes, v.modality, p.title program_title FROM training_sessions s JOIN program_versions v ON v.id=s.program_version_id JOIN programs p ON p.id=v.program_id
                      WHERE s.status <> 'cancelled' AND NOT s.is_historical ORDER BY (s.starts_on >= current_date) DESC, abs(coalesce(s.starts_on, current_date) - current_date), s.created_at DESC LIMIT 1`);
  add({ code: 'session', area: 'session', severity: 'blocking', ok: !!s, message: s ? `Session « ${s.title} ».` : 'Créez une session de la formation (dates, type inter/intra).', screen: '/onboarding?step=training' });

  if (s) {
    const link = `/sessions/${s.id}`;
    add({ code: 'session_dates', area: 'session', severity: 'blocking', ok: !!s.starts_on, message: s.starts_on ? `Du ${fmtDay(s.starts_on)} au ${fmtDay(s.ends_on ?? s.starts_on)}.` : 'Dates de la session à renseigner.', screen: link });
    if (s.kind === 'intra') add({ code: 'session_client', area: 'session', severity: 'blocking', ok: !!s.client_id, message: s.client_id ? 'Client intra renseigné.' : 'Session intra sans client.', screen: link });
    const active = ['planned', 'confirmed', 'in_progress', 'completed'].includes(s.status);
    add({ code: 'session_status', area: 'session', severity: 'blocking', ok: active, message: active ? 'Session planifiée.' : 'Session en brouillon : passez-la en « planifiée » (dates requises, quota de l’offre).', screen: link });

    // Créneaux : présence, durée, complétude et conflits (règles de publication du planning).
    const slots = await many(tx, `SELECT id, status, starts_at, ends_at FROM slots WHERE session_id=$1 AND status <> 'cancelled' ORDER BY starts_at`, [s.id]);
    add({ code: 'slots', area: 'planning', severity: 'blocking', ok: slots.length > 0, message: slots.length ? `${slots.length} séance(s) au planning.` : 'Aucune séance au planning : ajoutez au moins un créneau (date, heures, formateur, salle).', screen: link });
    if (slots.length) {
      const minutes = slots.reduce((a: number, x: any) => a + (new Date(x.ends_at).getTime() - new Date(x.starts_at).getTime()) / 60000, 0);
      const target = s.target_minutes ?? s.duration_minutes;
      add({ code: 'slots_duration', area: 'planning', severity: 'warning', ok: !target || minutes >= target,
        message: !target || minutes >= target ? `Durée planifiée : ${Math.round(minutes / 6) / 10} h.` : `Planning incomplet : ${Math.round(minutes / 6) / 10} h planifiées sur ${Math.round(target / 6) / 10} h prévues.`, screen: link });
      const res = await checkSlots(tx, slots.map((x: any) => x.id), { publish: true });
      const issues = res.flatMap((r) => r.blocking.map((i) => i.message));
      add({ code: 'slots_valid', area: 'planning', severity: 'blocking', ok: !issues.length,
        message: issues.length ? `${[...new Set(issues)].slice(0, 5).join(' ')}${issues.length > 5 ? ` (+${issues.length - 5})` : ''}` : 'Séances complètes : formateur, lieu ou lien de visio, sans conflit.', screen: '/planning' });
      const unpublished = slots.filter((x: any) => !['published', 'done'].includes(x.status)).length;
      add({ code: 'slots_published', area: 'planning', severity: 'blocking', ok: !unpublished,
        message: unpublished ? `${unpublished} séance(s) non publiée(s) : formateurs et apprenants ne les voient pas et l’émargement n’est pas ouvert.` : 'Planning publié.', screen: '/planning' });
    }

    // Inscriptions.
    const e = (await one(tx, `SELECT count(*) FILTER (WHERE status='confirmed')::int confirmed, count(*) FILTER (WHERE status='provisional')::int provisional FROM enrollments WHERE session_id=$1`, [s.id]))!;
    add({ code: 'enrollments', area: 'learners', severity: 'blocking', ok: e.confirmed > 0, message: e.confirmed ? `${e.confirmed} apprenant(s) inscrit(s)${e.provisional ? `, ${e.provisional} provisoire(s)` : ''}.` : e.provisional ? `${e.provisional} inscription(s) provisoire(s) à confirmer.` : 'Aucun apprenant inscrit.', screen: link });
    if (s.capacity) add({ code: 'capacity', area: 'learners', severity: 'blocking', ok: e.confirmed <= s.capacity, message: e.confirmed <= s.capacity ? `Capacité : ${e.confirmed}/${s.capacity}.` : `Capacité dépassée : ${e.confirmed} inscrits pour ${s.capacity} places.`, screen: link });
    if (s.min_participants) add({ code: 'min_participants', area: 'learners', severity: 'warning', ok: e.confirmed >= s.min_participants, message: `Minimum de participants : ${e.confirmed}/${s.min_participants}.`, screen: link });

    // Quotas de l'offre qui bloqueraient la planification.
    const sub = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    const addons = await many(tx, `SELECT addon_code, quantity, status FROM subscription_addons WHERE tenant_id=$1`, [tenantId]);
    const ent = computeEntitlements(sub, addons);
    const tz = s.timezone ?? 'Europe/Paris';
    if (!active && ent.limits.activeSessions != null) {
      const used = await USAGE_QUERIES.activeSessions(tx, tenantId, yearOf(new Date(), tz));
      add({ code: 'quota_active', area: 'plan', severity: 'blocking', ok: used < ent.limits.activeSessions, message: used < ent.limits.activeSessions ? `Sessions actives : ${used}/${ent.limits.activeSessions}.` : `Offre ${ent.planCode} : ${ent.limits.activeSessions} sessions actives maximum, déjà atteint. Changez d’offre pour planifier.`, screen: '/billing' });
    }
    if (!active && s.starts_on && ent.limits.sessionsPerMonth != null) {
      const month = String(s.starts_on).slice(0, 7);
      const used = await sessionsInMonth(tx, month, s.id);
      add({ code: 'quota_month', area: 'plan', severity: 'blocking', ok: used < ent.limits.sessionsPerMonth, message: used < ent.limits.sessionsPerMonth ? `Sessions du mois : ${used}/${ent.limits.sessionsPerMonth}.` : `Offre : ${ent.limits.sessionsPerMonth} sessions par mois, déjà atteint pour ce mois. Changez d’offre.`, screen: '/billing' });
    }
    const learnersYear = await USAGE_QUERIES.learnersPerYear(tx, tenantId, yearOf(new Date(), tz));
    add({ code: 'quota_learners', area: 'plan', severity: 'warning', ok: learnersYear <= ent.limits.learnersPerYear, message: `Apprenants de l’année : ${learnersYear}/${ent.limits.learnersPerYear}.`, screen: '/billing' });

    // Documents attendus avant le démarrage (n'empêchent pas la planification).
    const docs = await many(tx, `SELECT kind FROM documents WHERE (owner_type='session' AND owner_id=$1) OR (owner_type='enrollment' AND owner_id IN (SELECT id FROM enrollments WHERE session_id=$1))`, [s.id]);
    const convoc = docs.filter((d: any) => d.kind === 'convocation').length;
    add({ code: 'convocations', area: 'documents', severity: 'warning', ok: !e.confirmed || convoc >= e.confirmed, message: convoc >= e.confirmed ? 'Convocations générées.' : `Convocations à générer (${convoc}/${e.confirmed}).`, screen: link });
    if (s.kind === 'intra') add({ code: 'convention', area: 'documents', severity: 'warning', ok: docs.some((d: any) => d.kind === 'convention'), message: docs.some((d: any) => d.kind === 'convention') ? 'Convention générée.' : 'Convention de formation à générer.', screen: link });
  }

  const blocking = checks.filter((c) => !c.ok && c.severity === 'blocking');
  return { sessionId: s?.id ?? null, sessionTitle: s?.title ?? null, modality: s?.modality ?? null, ready: !blocking.length, checks, blocking, warnings: checks.filter((c) => !c.ok && c.severity === 'warning'), checkedAt: new Date().toISOString() };
}
