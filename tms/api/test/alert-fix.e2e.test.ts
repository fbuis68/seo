import { closeApp, getApp, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

describe('Messages d’alerte avec lien de correction', () => {
  it('fiche session et facturation : chaque alerte porte sa cible', async () => {
    const u = await signupAndLogin({ legalName: 'OF Liens' });
    const prog = (await u.api.post('/api/v1/programs', { title: 'Excel', durationMinutes: 420, modality: 'onsite', priceHt: '550.00', vatRate: '20' }).expect(201)).body;
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2031-02-02' }).expect(201)).body;
    const p = (await u.api.post('/api/v1/persons', { firstName: 'Silvio', lastName: 'B', roles: ['learner'] }).expect(201)).body;
    const e = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: p.id, status: 'confirmed' }).expect(201)).body;

    const d = (await u.api.get(`/api/v1/sessions/${s.id}`).expect(200)).body;
    expect(d.todo[0]).toEqual({ message: 'Aucun créneau planifié', fix: { label: 'Ajouter une séance', anchor: 'session-add-slot' } });
    expect(d.missing).toContain('Aucun créneau planifié');

    const b = (await u.api.get(`/api/v1/sessions/${s.id}/billing`).expect(200)).body;
    expect(b.skipped[0]).toMatchObject({ name: 'Silvio B', fix: { label: 'Désigner le client', anchor: `enr-${e.id ?? e.enrollment?.id}-client` } });
    expect(b.skipped[0].reason).toMatch(/sans client payeur/);

    // Session intra sans client : lien vers « Modifier la session ».
    const prog2 = (await u.api.post('/api/v1/programs', { title: 'Sans prix', durationMinutes: 60, modality: 'onsite' }).expect(201)).body;
    const s2 = (await u.api.post('/api/v1/sessions', { programVersionId: prog2.versions[0].id, kind: 'inter' }).expect(201)).body;
    const b2 = (await u.api.get(`/api/v1/sessions/${s2.id}/billing`).expect(200)).body;
    expect(b2).toMatchObject({ state: 'not_configured', fix: { anchor: 'session-price' } });
  });
});
