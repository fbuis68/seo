import { JobsService } from '../src/core/jobs.service';
import { SystemMailer } from '../src/core/system-mail';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

/** Recette du module planning (cahier des charges §9, scénarios R01 à R14). */
beforeAll(getApp);
afterAll(closeApp);

type U = Awaited<ReturnType<typeof signupAndLogin>>;
const mailer = async () => (await getApp()).get(SystemMailer);
const runJobs = async () => (await getApp()).get(JobsService).runOnce(100);

async function setup(u: U, opts: { duration?: number; title?: string } = {}) {
  const prog = (await u.api.post('/api/v1/programs', { title: opts.title ?? 'Sécurité incendie', durationMinutes: opts.duration ?? 900, modality: 'onsite' }).expect(201)).body;
  return prog.versions[0].id as string;
}
async function session(u: U, versionId: string, extra: any = {}) {
  return (await u.api.post('/api/v1/sessions', { programVersionId: versionId, kind: 'inter', startsOn: '2027-03-01', endsOn: '2027-03-31', ...extra }).expect(201)).body;
}
async function trainer(u: U, name: string, email?: string) {
  return (await u.api.post('/api/v1/persons', { firstName: name, lastName: 'Formateur', email, roles: ['trainer'] }).expect(201)).body;
}
async function learner(u: U, i: number, email?: string) {
  return (await u.api.post('/api/v1/persons', { firstName: `Stagiaire${i}`, lastName: `Nom${i}`, email, roles: ['learner'] }).expect(201)).body;
}
const at = (day: string, hm: string) => `${day}T${hm}:00+01:00`;
const slot = (u: U, sessionId: string, day: string, h1: string, h2: string, extra: any = {}) =>
  u.api.post('/api/v1/planning/slots', { sessionId, startsAt: at(day, h1), endsAt: at(day, h2), ...extra });

/** Compte rattaché à l'organisme avec un rôle (formateur, stagiaire) et une fiche personne. */
async function member(u: U, role: 'trainer' | 'learner', personId: string) {
  const other = await signupAndLogin();
  await u.api.post('/api/v1/invitations', { email: other.email, role, personId }).expect(201);
  const mail = [...(await mailer()).devOutbox].reverse().find((m) => m.to === other.email && m.text.includes('accept-invitation'))!;
  const token = /token=([\w-]+)/.exec(mail.text)![1];
  await http().post('/api/v1/invitations/accept').set({ Authorization: `Bearer ${other.token}` }).send({ token }).expect(201);
  const auth = { Authorization: `Bearer ${other.token}`, 'X-Tenant-Id': u.tenantId };
  return { get: (url: string) => http().get(url).set(auth), post: (url: string, b?: any) => http().post(url).set(auth).send(b) };
}

describe('Planning — recette', () => {
  it('R01 : session de cinq séances ; jour, semaine, mois et Timeline lisent les mêmes horaires, affectations et durée', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u, { duration: 900 }));
    const t = await trainer(u, 'Alice');
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Rhône', capacity: 15 }).expect(201)).body;
    for (const day of ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04']) await slot(u, s.id, day, '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201);
    // Cinquième séance avec une pause non pédagogique de 30 min.
    const last = await slot(u, s.id, '2027-03-05', '09:00', '12:30', { trainerIds: [t.id], resourceIds: [room.id], breaks: [{ startsAt: at('2027-03-05', '10:30'), endsAt: at('2027-03-05', '11:00') }] }).expect(201);
    expect(last.body.report[0].warnings.map((w: any) => w.rule)).not.toContain('target_duration'); // 4 × 3 h + 3 h = 15 h
    const views = {
      day: ['2027-03-03T00:00:00+01:00', '2027-03-04T00:00:00+01:00'], week: ['2027-03-01T00:00:00+01:00', '2027-03-08T00:00:00+01:00'],
      month: ['2027-03-01T00:00:00+01:00', '2027-04-01T00:00:00+02:00'], timeline: ['2027-02-22T00:00:00+01:00', '2027-04-05T00:00:00+02:00'],
    };
    const res: Record<string, any[]> = {};
    for (const [k, [from, to]] of Object.entries(views)) res[k] = (await u.api.get(`/api/v1/planning/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).expect(200)).body.items;
    expect(res.day).toHaveLength(1);
    for (const k of ['week', 'month', 'timeline']) {
      expect(res[k]).toHaveLength(5);
      expect(res[k].reduce((a, x) => a + x.pedagogical_minutes, 0)).toBe(900);
      expect(res[k].every((x) => x.trainers[0].name === 'Alice Formateur' && x.resources[0].name === 'Salle Rhône')).toBe(true);
    }
    expect(res.day[0]).toEqual(res.week.find((x) => x.id === res.day[0].id));
    const detail = (await u.api.get(`/api/v1/sessions/${s.id}`).expect(200)).body;
    expect(detail.missing.some((m: string) => m.startsWith('Planning'))).toBe(false);
    expect(detail.missing).toContain('5 séance(s) non publiée(s)');
  });

  it('R02 : déplacement sur une salle occupée, même hors filtre : refusé, position initiale conservée ; conflit de version', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const a = await session(u, v); const b = await session(u, v);
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Saône', capacity: 10 }).expect(201)).body;
    await slot(u, a.id, '2027-03-08', '09:00', '12:00', { resourceIds: [room.id] }).expect(201);
    const mine = (await slot(u, b.id, '2027-03-08', '13:00', '16:00', { resourceIds: [room.id] }).expect(201)).body;
    // Vue filtrée sur la session B : la séance de A n'apparaît pas…
    const filtered = (await u.api.get(`/api/v1/planning/slots?from=${encodeURIComponent('2027-03-08T00:00:00+01:00')}&to=${encodeURIComponent('2027-03-09T00:00:00+01:00')}&sessionId=${b.id}`)).body.items;
    expect(filtered).toHaveLength(1);
    // …mais le contrôle porte sur toutes les réservations actives.
    const preview = (await u.api.patch(`/api/v1/planning/slots/${mine.id}`, { startsAt: at('2027-03-08', '10:00'), endsAt: at('2027-03-08', '13:00'), version: 1, preview: true }).expect(200)).body;
    expect(preview.ok).toBe(false);
    expect(preview.report[0].blocking[0]).toMatchObject({ rule: 'resource_overlap', ref: { label: 'Salle Saône' } });
    const moved = await u.api.patch(`/api/v1/planning/slots/${mine.id}`, { startsAt: at('2027-03-08', '10:00'), endsAt: at('2027-03-08', '13:00'), version: 1 });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe('planning_conflict');
    expect(moved.body.message).toContain('Salle Saône');
    const after = (await u.api.get(`/api/v1/sessions/${b.id}`)).body.slots[0];
    expect(new Date(after.starts_at).toISOString()).toBe('2027-03-08T12:00:00.000Z');
    expect(after.version).toBe(1);
    // Version périmée : aucune écriture écrasant la modification précédente.
    await u.api.patch(`/api/v1/planning/slots/${mine.id}`, { title: 'Pratique', version: 1 }).expect(200);
    const stale = await u.api.patch(`/api/v1/planning/slots/${mine.id}`, { title: 'Théorie', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('R03 / R13 : formateur ou stagiaire déjà réservé : conflit précis, rien enregistré ; inscription en collision à résoudre', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const a = await session(u, v); const b = await session(u, v);
    const t = await trainer(u, 'Bruno');
    const site = (await u.api.post('/api/v1/resources', { kind: 'site', name: 'Annecy' }).expect(201)).body;
    const sa = (await slot(u, a.id, '2027-03-09', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [site.id] }).expect(201)).body;
    const sb = (await slot(u, b.id, '2027-03-09', '10:00', '11:00').expect(201)).body;
    const r = await u.api.patch(`/api/v1/planning/slots/${sb.id}`, { trainerIds: [t.id] });
    expect(r.status).toBe(409);
    expect(r.body.details.report[0].blocking[0]).toMatchObject({ rule: 'trainer_overlap', ref: { id: t.id }, other: { slotId: sa.id, sessionId: a.id } });
    expect((await u.api.get(`/api/v1/sessions/${b.id}`)).body.slots[0].trainers).toHaveLength(0);
    // Stagiaire inscrit en A puis en B : collision → participation « à résoudre », pas d'incohérence silencieuse.
    const l = await learner(u, 1);
    await u.api.post(`/api/v1/sessions/${a.id}/enrollments`, { personId: l.id, status: 'confirmed' }).expect(201);
    const e = (await u.api.post(`/api/v1/sessions/${b.id}/enrollments`, { personId: l.id, status: 'confirmed' }).expect(201)).body;
    expect(e.toResolve).toHaveLength(1);
    expect(e.toResolve[0].reason).toContain('Stagiaire1 Nom1');
    const detail = (await u.api.get(`/api/v1/sessions/${b.id}`)).body;
    expect(detail.slots[0].to_resolve).toBe(1);
    expect(detail.missing).toContain('1 participation(s) à résoudre (collision ou capacité)');
    // Forcer la présence : refusé ; l'exclure : accepté.
    const force = await u.api.put(`/api/v1/planning/slots/${sb.id}/participants`, { participants: [{ enrollmentId: e.id, mode: 'onsite' }] });
    expect(force.status).toBe(409);
    expect(force.body.details.report[0].blocking[0].rule).toBe('learner_overlap');
    await u.api.put(`/api/v1/planning/slots/${sb.id}/participants`, { participants: [{ enrollmentId: e.id, mode: 'excluded' }] }).expect(200);
    // Publication possible : la séance publiée ne contient aucune collision.
    await u.api.post('/api/v1/planning/transition', { slotIds: [sa.id], status: 'published' }).expect(201);
  });

  it('R04 : 9 h–12 h puis 12 h–14 h acceptés sans tampon ; bloqués avec préparation de salle ou déplacement formateur', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const a = await session(u, v); const b = await session(u, v);
    const t = await trainer(u, 'Chloé');
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Atelier', capacity: 8 }).expect(201)).body;
    await slot(u, a.id, '2027-03-10', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201);
    const second = (await slot(u, b.id, '2027-03-10', '12:00', '14:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201)).body;
    await u.api.del(`/api/v1/planning/slots/${second.id}`).expect(200);
    // Salle : 15 min de préparation et 15 min de remise en état.
    await u.api.patch(`/api/v1/resources/${room.id}`, { setupMinutes: 15, teardownMinutes: 15 }).expect(200);
    const r1 = await slot(u, b.id, '2027-03-10', '12:00', '14:00', { resourceIds: [room.id] });
    expect(r1.status).toBe(409);
    expect(r1.body.details.report[0].blocking[0].rule).toBe('setup_time');
    // Formateur : 30 min de déplacement entre deux sites différents.
    const lyon = (await u.api.post('/api/v1/resources', { kind: 'site', name: 'Lyon' }).expect(201)).body;
    const vienne = (await u.api.post('/api/v1/resources', { kind: 'site', name: 'Vienne' }).expect(201)).body;
    await u.api.patch(`/api/v1/resources/${room.id}`, { siteId: lyon.id }).expect(200);
    await u.api.put(`/api/v1/planning/trainers/${t.id}/profile`, { travelMinutes: 30 }).expect(200);
    const r2 = await slot(u, b.id, '2027-03-10', '12:00', '14:00', { trainerIds: [t.id], resourceIds: [vienne.id] });
    expect(r2.status).toBe(409);
    expect(r2.body.details.report[0].blocking.map((i: any) => i.rule)).toEqual(['travel_time']);
    await slot(u, b.id, '2027-03-10', '12:30', '14:00', { trainerIds: [t.id], resourceIds: [vienne.id] }).expect(201);
  });

  it('R05 : salle de 12 places, 13 présents : bloqué ; hybride 10 présents + 3 distants : publication possible', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u));
    const t = await trainer(u, 'Damien');
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle 12', capacity: 12 }).expect(201)).body;
    const sl = (await slot(u, s.id, '2027-03-11', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201)).body;
    const enr: any[] = [];
    for (let i = 0; i < 13; i++) enr.push((await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: (await learner(u, i)).id, status: 'confirmed' }).expect(201)).body);
    expect(enr[12].toResolve[0].reason).toContain('Capacité dépassée');
    const over = await u.api.put(`/api/v1/planning/slots/${sl.id}/participants`, { participants: [{ enrollmentId: enr[12].id, mode: 'onsite' }] });
    expect(over.status).toBe(409);
    expect(over.body.details.report[0].blocking[0]).toMatchObject({ rule: 'capacity', message: 'Capacité dépassée : 13 participant(s) en présentiel pour 12 place(s).' });
    // Hybride sans lien : publication refusée.
    await u.api.patch(`/api/v1/planning/slots/${sl.id}`, { modality: 'hybrid' }).expect(200);
    await u.api.put(`/api/v1/planning/slots/${sl.id}/participants`, { participants: [10, 11, 12].map((i) => ({ enrollmentId: enr[i].id, mode: 'remote' })) }).expect(200);
    const noLink = await u.api.post('/api/v1/planning/transition', { slotIds: [sl.id], status: 'published' });
    expect(noLink.status).toBe(409);
    expect(noLink.body.details.report[0].blocking.map((i: any) => i.rule)).toEqual(['missing_video']);
    await u.api.patch(`/api/v1/planning/slots/${sl.id}`, { videoUrl: 'https://visio.example.test/salle-12' }).expect(200);
    await u.api.post('/api/v1/planning/transition', { slotIds: [sl.id], status: 'published' }).expect(201);
    const row = (await u.api.get(`/api/v1/planning/slots?from=${encodeURIComponent('2027-03-11T00:00:00+01:00')}&to=${encodeURIComponent('2027-03-12T00:00:00+01:00')}`)).body.items[0];
    expect([row.expected_onsite, row.expected_remote, row.to_resolve, row.status]).toEqual([10, 3, 0, 'published']);
  });

  it('R06 : récurrence traversant le changement d’heure : horaire local conservé ; une occurrence modifiée seule', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u), { startsOn: '2027-10-25', endsOn: '2027-11-05' });
    const body = { startDate: '2027-10-28', days: [1, 4], until: '2027-11-08', startTime: '09:00', endTime: '12:00', exclusions: ['2027-11-01'] };
    const preview = (await u.api.post(`/api/v1/planning/sessions/${s.id}/series`, { ...body, preview: true }).expect(201)).body;
    expect(preview.result.occurrences.map((o: any) => [o.date, o.status])).toEqual([['2027-10-28', 'create'], ['2027-11-01', 'excluded'], ['2027-11-04', 'create'], ['2027-11-08', 'create']]);
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots).toHaveLength(0); // aperçu : rien créé
    const created = (await u.api.post(`/api/v1/planning/sessions/${s.id}/series`, body).expect(201)).body;
    expect(created.created).toBe(3);
    const slots = (await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots;
    // 28/10 en heure d'été (UTC+2), 04/11 en heure d'hiver (UTC+1) : 9 h locales dans les deux cas.
    expect(slots.map((x: any) => new Date(x.starts_at).toISOString())).toEqual(['2027-10-28T07:00:00.000Z', '2027-11-04T08:00:00.000Z', '2027-11-08T08:00:00.000Z']);
    await u.api.patch(`/api/v1/planning/slots/${slots[1].id}`, { startsAt: '2027-11-04T10:00:00+01:00', endsAt: '2027-11-04T13:00:00+01:00', scope: 'this' }).expect(200);
    const after = (await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots;
    expect(after.map((x: any) => new Date(x.starts_at).toISOString())).toEqual(['2027-10-28T07:00:00.000Z', '2027-11-04T09:00:00.000Z', '2027-11-08T08:00:00.000Z']);
    // « Toute la série » : nouvel horaire local appliqué partout (heure d'été comme d'hiver).
    await u.api.patch(`/api/v1/planning/slots/${after[2].id}`, { startsAt: '2027-11-08T14:00:00+01:00', endsAt: '2027-11-08T17:00:00+01:00', scope: 'all' }).expect(200);
    const all = (await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots;
    expect(all.map((x: any) => new Date(x.starts_at).toISOString())).toEqual(['2027-10-28T12:00:00.000Z', '2027-11-04T13:00:00.000Z', '2027-11-08T13:00:00.000Z']);
    // Horaire inexistant (passage à l'heure d'été, 28/03/2027 2 h 30) : correction explicite exigée.
    const gap = await u.api.post(`/api/v1/planning/sessions/${s.id}/series`, { startDate: '2027-03-28', days: [7], count: 1, startTime: '02:30', endTime: '04:00' });
    expect(gap.status).toBe(409);
    expect(gap.body.code).toBe('series_invalid_time');
  });

  it('R07 / R08 / R14 : publication, modification et annulation : historique, portails, une notification par changement, relance sans doublon', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const s = await session(u, v); const other = await session(u, v);
    const t = await trainer(u, 'Emma', `emma.${Date.now()}@example.test`);
    const l = await learner(u, 1, `stagiaire.${Date.now()}@example.test`);
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Bleue', capacity: 10 }).expect(201)).body;
    await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: l.id, status: 'confirmed' }).expect(201);
    const sl = (await slot(u, s.id, '2027-03-15', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201)).body;
    const trainerApi = await member(u, 'trainer', t.id);
    const range = `from=${encodeURIComponent('2027-03-15T00:00:00+01:00')}&to=${encodeURIComponent('2027-03-16T00:00:00+01:00')}`;
    expect((await trainerApi.get(`/api/v1/planning/me?${range}`).expect(200)).body.items).toHaveLength(0); // brouillon invisible
    const outbox = (await mailer()).devOutbox;
    const count = (to: string) => outbox.filter((m) => m.to === to && m.subject.startsWith('Planning')).length;
    await u.api.post('/api/v1/planning/transition', { sessionId: s.id, status: 'published' }).expect(201);
    await runJobs();
    expect([count(t.email), count(l.email)]).toEqual([1, 1]);
    // Modification publiée : horaire décalé d'une heure.
    await u.api.patch(`/api/v1/planning/slots/${sl.id}`, { startsAt: at('2027-03-15', '10:00'), endsAt: at('2027-03-15', '13:00') }).expect(200);
    await runJobs(); await runJobs(); // relance : aucun doublon
    expect([count(t.email), count(l.email)]).toEqual([2, 2]);
    expect(outbox.filter((m) => m.to === l.email).pop()!.text).toContain('horaire : 15/03/2027 09:00–12:00 → 15/03/2027 10:00–13:00');
    const me = (await trainerApi.get(`/api/v1/planning/me?${range}`).expect(200)).body;
    expect(new Date(me.items[0].starts_at).toISOString()).toBe('2027-03-15T09:00:00.000Z');
    expect(me.changes[0].kind).toBe('changed');
    // Modification sans effet notifiable (notes) : pas de message.
    await u.api.patch(`/api/v1/planning/slots/${sl.id}`, { notes: 'Apporter les EPI' }).expect(200);
    await runJobs();
    expect(count(t.email)).toBe(2);
    // Annulation : réservation libérée, durée recalculée, historique, notification.
    await u.api.post(`/api/v1/planning/slots/${sl.id}/cancel`, { reason: 'Formateur malade' }).expect(201);
    await runJobs();
    expect(count(l.email)).toBe(3);
    expect(outbox.filter((m) => m.to === l.email).pop()!.text).toContain('Séance annulée');
    await slot(u, other.id, '2027-03-15', '10:00', '13:00', { resourceIds: [room.id] }).expect(201);
    const d = (await u.api.get(`/api/v1/sessions/${s.id}`)).body;
    expect(d.missing).toContain('Aucun créneau planifié');
    expect(d.slots[0].status).toBe('cancelled');
    const hist = (await u.api.get(`/api/v1/planning/history?slotId=${sl.id}`).expect(200)).body;
    expect(hist.map((h: any) => h.action)).toEqual(['cancelled', 'updated', 'moved', 'published', 'created']);
    expect(hist.find((h: any) => h.action === 'moved').changes.map((c: any) => c.field)).toEqual(['starts_at', 'ends_at']);
    expect(hist[0].reason).toBe('Formateur malade');
    // Le portail affiche la séance annulée ; le brouillon n'est jamais supprimable une fois publié.
    expect((await trainerApi.get(`/api/v1/planning/me?${range}`)).body.items[0].status).toBe('cancelled');
    // Événements sortants ordonnés, identifiants uniques.
    const events = (await u.api.get('/api/v1/planning/events').expect(200)).body.filter((e: any) => e.slot_id === sl.id);
    expect(events.map((e: any) => e.type)).toEqual(['slot.created', 'slot.published', 'slot.moved', 'slot.updated', 'slot.cancelled']);
    expect(events.map((e: any) => e.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('R09 : deux réservations simultanées de la même salle : une réussit, l’autre reçoit un conflit ; idempotence', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const a = await session(u, v); const b = await session(u, v);
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Unique', capacity: 10 }).expect(201)).body;
    const res = await Promise.all([a, b].map((s) => slot(u, s.id, '2027-03-16', '09:00', '12:00', { resourceIds: [room.id] })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.code).toBe('planning_conflict');
    // Même requête rejouée avec la même clé : un seul enregistrement.
    const send = () => http().post('/api/v1/planning/slots').set({ ...u.auth, 'Idempotency-Key': 'creation-42' }).send({ sessionId: a.id, startsAt: at('2027-03-17', '09:00'), endsAt: at('2027-03-17', '12:00') });
    const r1 = await send(); const r2 = await send();
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.body.replayed).toBe(true);
  });

  it('R10 : stagiaire connecté : seules ses séances publiées, sans données des autres stagiaires ; API et exports refusés', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u));
    const l1 = await learner(u, 1); const l2 = await learner(u, 2);
    const e1 = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: l1.id, status: 'confirmed' }).expect(201)).body;
    await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: l2.id, status: 'confirmed' }).expect(201);
    const t = await trainer(u, 'Fanny');
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Verte', capacity: 10 }).expect(201)).body;
    const pub = (await slot(u, s.id, '2027-03-18', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id], status: 'published' }).expect(201)).body;
    await slot(u, s.id, '2027-03-19', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201); // brouillon
    const excluded = (await slot(u, s.id, '2027-03-22', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id], status: 'published', participants: [{ enrollmentId: e1.id, mode: 'excluded' }] }).expect(201)).body;
    const me = await member(u, 'learner', l1.id);
    const range = `from=${encodeURIComponent('2027-03-01T00:00:00+01:00')}&to=${encodeURIComponent('2027-04-01T00:00:00+02:00')}`;
    const mine = (await me.get(`/api/v1/planning/me?${range}`).expect(200)).body;
    expect(mine.items.map((x: any) => x.id)).toEqual([pub.id]);
    expect(mine.items.map((x: any) => x.id)).not.toContain(excluded.id);
    expect(JSON.stringify(mine)).not.toContain('Stagiaire2');
    expect(mine.items[0]).not.toHaveProperty('expected_onsite');
    expect((await me.get(`/api/v1/planning/slots?${range}`)).status).toBe(403);
    expect((await me.get(`/api/v1/planning/export.csv?${range}`)).status).toBe(403);
    expect((await me.get(`/api/v1/sessions/${s.id}`)).status).toBe(403);
    expect((await me.get(`/api/v1/planning/history?sessionId=${s.id}`)).status).toBe(403);
    const ics = await me.get(`/api/v1/planning/me.ics?${range}`).expect(200);
    expect(ics.text).toContain(`UID:${pub.id}@tms`);
    expect(ics.text).toContain('LOCATION:Salle Verte');
  });

  it('R11 : import avec conflit : aperçu des erreurs, aucune création partielle, aucun doublon au second essai', async () => {
    const u = await signupAndLogin();
    const v = await setup(u);
    const s = await session(u, v, { reference: 'INC-2027-03' });
    const blocker = await session(u, v);
    const t = await trainer(u, 'Gaël', `gael.${Date.now()}@example.test`);
    await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Import', capacity: 10 }).expect(201);
    const room2 = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Occupée', capacity: 10 }).expect(201)).body;
    await slot(u, blocker.id, '2027-03-23', '13:00', '17:00', { resourceIds: [room2.id] }).expect(201);
    const csv = `Session;Date;Début;Fin;Formateurs;Salles;Intitulé\nINC-2027-03;23/03/2027;09:00;12:00;${t.email};Salle Import;Théorie\nINC-2027-03;23/03/2027;13:00;17:00;${t.email};Salle Occupée;Pratique\nINC-2027-03;24/03/2027;9h;12h;Inconnu Total;Salle Import;Révision\n`;
    const preview = (await u.api.post('/api/v1/planning/import', { csv, preview: true }).expect(201)).body;
    expect(preview.result.lines.map((l: any) => l.status)).toEqual(['ok', 'conflict', 'error']);
    expect(preview.result.lines[1].errors[0]).toContain('Salle Occupée');
    expect(preview.result.lines[2].errors[0]).toContain('Formateur « inconnu total »');
    const rejected = await u.api.post('/api/v1/planning/import', { csv });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('import_rejected');
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots).toHaveLength(0);
    // Mode partiel explicite : bilan des lignes enregistrées et rejetées.
    const partial = (await u.api.post('/api/v1/planning/import', { csv, partial: true }).expect(201)).body;
    expect([partial.created, partial.rejected]).toEqual([1, 2]);
    const again = (await u.api.post('/api/v1/planning/import', { csv, partial: true }).expect(201)).body;
    expect([again.created, again.duplicates]).toEqual([0, 1]);
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.slots).toHaveLength(1);
  });

  it('disponibilités, fermetures, dérogations par rôle habilité, conflits et indicateurs', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u));
    const t = await trainer(u, 'Hugo');
    const site = (await u.api.post('/api/v1/resources', { kind: 'site', name: 'Grenoble' }).expect(201)).body;
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Alpes', capacity: 10, siteId: site.id, openingHours: { 1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']], 4: [['08:00', '18:00']], 5: [['08:00', '17:00']] } }).expect(201)).body;
    // Indisponibilité formateur : bloquante, non dérogeable.
    await u.api.post('/api/v1/planning/availabilities', { ownerType: 'person', ownerId: t.id, kind: 'unavailable', startsAt: at('2027-03-24', '00:00'), endsAt: at('2027-03-25', '00:00'), reason: 'Congé' }).expect(201);
    const off = await slot(u, s.id, '2027-03-24', '09:00', '12:00', { trainerIds: [t.id], derogation: 'Urgence client' });
    expect(off.status).toBe(409);
    expect(off.body.message).toContain('Congé');
    // Hors ouverture et fermeture de site : dérogeables, motif tracé.
    const late = await slot(u, s.id, '2027-03-26', '15:00', '18:00', { resourceIds: [room.id] });
    expect(late.body.details.report[0].blocking[0].rule).toBe('outside_hours');
    const derog = (await slot(u, s.id, '2027-03-26', '15:00', '18:00', { resourceIds: [room.id], derogation: 'Accord du gardien' }).expect(201)).body;
    expect(derog.report[0].derogated[0].rule).toBe('outside_hours');
    await u.api.post('/api/v1/planning/closures', { siteId: site.id, startsOn: '2027-03-29', endsOn: '2027-03-29', label: 'Lundi de Pâques' }).expect(201);
    expect((await slot(u, s.id, '2027-03-29', '09:00', '12:00', { resourceIds: [room.id] })).body.details.report[0].blocking[0].message).toContain('Lundi de Pâques');
    // Formateur saisissant ses disponibilités : soumises à validation.
    const tApi = await member(u, 'trainer', t.id);
    const req = (await tApi.post('/api/v1/planning/availabilities', { ownerType: 'person', ownerId: t.id, kind: 'unavailable', startsAt: at('2027-03-30', '00:00'), endsAt: at('2027-03-31', '00:00') }).expect(201)).body;
    expect(req.status).toBe('pending');
    expect((await tApi.post('/api/v1/planning/availabilities', { ownerType: 'resource', ownerId: room.id, kind: 'unavailable', startsAt: at('2027-03-30', '00:00'), endsAt: at('2027-03-31', '00:00') })).status).toBe(403);
    await slot(u, s.id, '2027-03-30', '09:00', '12:00', { trainerIds: [t.id] }).expect(201); // demande non validée : pas bloquante
    const decided = (await u.api.post(`/api/v1/planning/availabilities/${req.id}/decision`, { status: 'approved' }).expect(201)).body;
    expect(decided.impacted).toHaveLength(1);
    const conflicts = (await u.api.get(`/api/v1/planning/conflicts?from=${encodeURIComponent('2027-03-01T00:00:00+01:00')}&to=${encodeURIComponent('2027-04-01T00:00:00+02:00')}`).expect(200)).body;
    expect(conflicts.blocking.map((i: any) => i.rule)).toEqual(['unavailable']);
    expect(conflicts.derogations).toHaveLength(1);
    const ind = (await u.api.get(`/api/v1/planning/indicators?from=${encodeURIComponent('2027-03-22T00:00:00+01:00')}&to=${encodeURIComponent('2027-03-29T00:00:00+02:00')}`).expect(200)).body;
    expect(ind.planned_minutes).toBe(180);
    expect(ind.rooms.find((r: any) => r.id === room.id).occupancy).toBe(Math.round(180 / (4 * 600 + 540) * 1000) / 10);
    // Exports : CSV et PDF de la période.
    const csv = await u.api.get(`/api/v1/planning/export.csv?from=${encodeURIComponent('2027-03-01T00:00:00+01:00')}&to=${encodeURIComponent('2027-04-01T00:00:00+02:00')}`).expect(200);
    expect(csv.text.split('\r\n')[0]).toContain('Début;Fin;Durée (min)');
    await u.api.get(`/api/v1/planning/export.pdf?groupBy=room&from=${encodeURIComponent('2027-03-01T00:00:00+01:00')}&to=${encodeURIComponent('2027-04-01T00:00:00+02:00')}`).expect(200);
  });

  it('workflow : brouillon → à valider → publié → réalisé ; suppression physique réservée au brouillon ; duplication et décalage de session', async () => {
    const u = await signupAndLogin();
    const s = await session(u, await setup(u));
    const t = await trainer(u, 'Inès');
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Jaune', capacity: 10 }).expect(201)).body;
    const sl = (await slot(u, s.id, '2027-03-02', '09:00', '12:00', { trainerIds: [t.id], resourceIds: [room.id] }).expect(201)).body;
    await u.api.post('/api/v1/planning/transition', { slotIds: [sl.id], status: 'pending' }).expect(201);
    expect((await u.api.post('/api/v1/planning/transition', { slotIds: [sl.id], status: 'done' })).status).toBe(409);
    await u.api.post('/api/v1/planning/transition', { slotIds: [sl.id], status: 'published' }).expect(201);
    expect((await u.api.del(`/api/v1/planning/slots/${sl.id}`)).status).toBe(409);
    // Duplication : mêmes horaires locaux, affectations reprises, nouvelle séance en brouillon.
    const dup = (await u.api.post(`/api/v1/planning/slots/${sl.id}/duplicate`, { dates: ['2027-03-03', '2027-03-04'] }).expect(201)).body;
    expect(dup.ids).toHaveLength(2);
    let d = (await u.api.get(`/api/v1/sessions/${s.id}`)).body;
    expect(d.slots.map((x: any) => [x.status, x.trainers.length, new Date(x.starts_at).toISOString()])).toEqual([
      ['published', 1, '2027-03-02T08:00:00.000Z'], ['draft', 1, '2027-03-03T08:00:00.000Z'], ['draft', 1, '2027-03-04T08:00:00.000Z']]);
    // Décalage de session (+7 jours, passage à l'heure d'été le 28/03 non concerné) : intervalles conservés.
    const preview = (await u.api.post(`/api/v1/planning/sessions/${s.id}/shift`, { days: 28, preview: true }).expect(201)).body;
    expect(preview.ok).toBe(true);
    await u.api.post(`/api/v1/planning/sessions/${s.id}/shift`, { days: 28 }).expect(201);
    d = (await u.api.get(`/api/v1/sessions/${s.id}`)).body;
    expect(d.slots.map((x: any) => new Date(x.starts_at).toISOString())).toEqual(['2027-03-30T07:00:00.000Z', '2027-03-31T07:00:00.000Z', '2027-04-01T07:00:00.000Z']);
    // Planificateur sans habilitation : publication refusée quand la publication directe est désactivée.
    await u.api.put('/api/v1/planning/settings', { direct_publish: false }).expect(200);
  });
});
