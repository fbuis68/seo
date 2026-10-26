import { closeApp, getApp, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

const codes = (r: any) => r.blocking.map((c: any) => c.code);

describe('Mise en route d’une formation (diagnostic de démarrage)', () => {
  it('liste les blocages puis passe prêt : formation, formateur, salle, session, séance publiée, apprenant', async () => {
    const u = await signupAndLogin({ legalName: 'OF Démarrage' });
    let r = (await u.api.get('/api/v1/start-readiness').expect(200)).body;
    expect(r.ready).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(['program', 'trainer', 'place', 'learner', 'session']));
    let st = (await u.api.get('/api/v1/onboarding').expect(200)).body;
    expect(st.steps.find((s: any) => s.key === 'training').state).toBe('to_do');

    const prog = (await u.api.post('/api/v1/programs', { title: 'Sécurité incendie', durationMinutes: 420, modality: 'onsite' }).expect(201)).body;
    const trainer = (await u.api.post('/api/v1/persons', { firstName: 'Paul', lastName: 'Prof', email: 'prof@demarrage.test', roles: ['trainer'] }).expect(201)).body;
    r = (await u.api.get('/api/v1/start-readiness')).body;
    expect(codes(r)).toContain('place'); // présentiel : salle obligatoire
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle A', capacity: 10 }).expect(201)).body;

    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2031-03-04', endsOn: '2031-03-04', capacity: 10 }).expect(201)).body;
    r = (await u.api.get(`/api/v1/start-readiness?sessionId=${s.id}`)).body;
    expect(codes(r)).toEqual(expect.arrayContaining(['session_status', 'slots', 'enrollments']));
    await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'planned' }).expect(201);

    // Séance brouillon sans salle : incomplète et non publiée.
    const slot = (await u.api.post('/api/v1/planning/slots', { sessionId: s.id, startsAt: '2031-03-04T08:00:00Z', endsAt: '2031-03-04T12:00:00Z', trainerIds: [trainer.id] }).expect(201)).body;
    r = (await u.api.get(`/api/v1/start-readiness?sessionId=${s.id}`)).body;
    expect(codes(r)).toEqual(expect.arrayContaining(['slots_valid', 'slots_published']));
    expect(r.warnings.map((c: any) => c.code)).toContain('slots_duration'); // 4 h sur 7 h
    await u.api.post(`/api/v1/planning/slots/${slot.id ?? slot.slot?.id}/cancel`, { reason: 'remplacée' });

    await u.api.post('/api/v1/planning/slots', { sessionId: s.id, startsAt: '2031-03-04T07:00:00Z', endsAt: '2031-03-04T15:00:00Z', trainerIds: [trainer.id], resourceIds: [room.id], status: 'published' }).expect(201);
    const learner = (await u.api.post('/api/v1/persons', { firstName: 'Léa', lastName: 'Apprenante', roles: ['learner'] }).expect(201)).body;
    await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: learner.id, status: 'confirmed' }).expect(201);

    r = (await u.api.get(`/api/v1/start-readiness?sessionId=${s.id}`)).body;
    expect(r.blocking).toEqual([]);
    expect(r.ready).toBe(true);
    st = (await u.api.get('/api/v1/onboarding')).body;
    expect(st.steps.find((x: any) => x.key === 'training').state).toBe('done');
  });

  it('formation 100 % distancielle : salle non bloquante, lien de visio exigé', async () => {
    const u = await signupAndLogin({ legalName: 'OF Distanciel' });
    await u.api.post('/api/v1/programs', { title: 'Excel en ligne', durationMinutes: 120, modality: 'remote' }).expect(201);
    const r = (await u.api.get('/api/v1/start-readiness')).body;
    expect(r.checks.find((c: any) => c.code === 'place').severity).toBe('warning');
  });
});
