import { ADDR, closeApp, getApp, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

describe('Modification de tous les enregistrements', () => {
  it('client, personne, formation (en place puis nouvelle version), session', async () => {
    const u = await signupAndLogin({ legalName: 'OF Edition' });
    // Client : création avec champs complémentaires, modification, effacement.
    let c = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'ACME', phone: '0102030405', vatNumber: 'FR12345678901', billingAddress: ADDR }).expect(201)).body;
    expect(c).toMatchObject({ phone: '0102030405', vat_number: 'FR12345678901' });
    c = (await u.api.patch(`/api/v1/clients/${c.id}`, { version: c.version, name: 'ACME Industrie', website: 'acme.test', phone: null, siret: '73282932000074' }).expect(200)).body;
    expect(c).toMatchObject({ name: 'ACME Industrie', website: 'acme.test', phone: null, siret: '73282932000074', siren: '732829320' });
    expect((await u.api.patch(`/api/v1/clients/${c.id}`, { version: c.version - 1, name: 'X' })).status).toBe(409);

    // Personne : tous les champs, rôles, employeur, archivage.
    let p = (await u.api.post('/api/v1/persons', { firstName: 'Léa', lastName: 'Martin', roles: ['learner'], civility: 'Mme', birthDate: '1990-05-04' }).expect(201)).body;
    expect(p).toMatchObject({ civility: 'Mme' });
    p = (await u.api.patch(`/api/v1/persons/${p.id}`, { version: p.version, lastName: 'Martin-Durand', mobile: '0611223344', jobTitle: 'Cariste', employerClientId: c.id,
      address: { line1: '1 rue A', postal_code: '69001', city: 'Lyon' }, roles: ['learner', 'contact'], birthDate: '' }).expect(200)).body;
    expect(p).toMatchObject({ last_name: 'Martin-Durand', mobile: '0611223344', job_title: 'Cariste', employer_client_id: c.id, birth_date: null });
    const listed = (await u.api.get('/api/v1/persons?role=contact')).body.find((x: any) => x.id === p.id);
    expect(listed.employer_name).toBe('ACME Industrie');
    await u.api.post(`/api/v1/persons/${p.id}/archive`, { archived: true }).expect(201);
    expect((await u.api.get('/api/v1/persons?role=learner')).body.some((x: any) => x.id === p.id)).toBe(false);
    expect((await u.api.get('/api/v1/persons?role=learner&archived=true')).body.some((x: any) => x.id === p.id)).toBe(true);

    // Formation : modification en place tant qu'aucune session ; nouvelle version ensuite.
    const prog = (await u.api.post('/api/v1/programs', { title: 'CACES', durationMinutes: 420, modality: 'onsite' }).expect(201)).body;
    let r = (await u.api.patch(`/api/v1/programs/${prog.id}`, { title: 'CACES R489', durationMinutes: 840, priceHt: '900.00', code: 'C489' }).expect(200)).body;
    expect(r).toMatchObject({ title: 'CACES R489', code: 'C489', newVersion: false });
    expect(r.versions).toHaveLength(1);
    expect(r.versions[0].duration_minutes).toBe(840);
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2031-01-10' }).expect(201)).body;
    r = (await u.api.patch(`/api/v1/programs/${prog.id}`, { priceHt: '950.00' }).expect(200)).body;
    expect(r.newVersion).toBe(true);
    expect(r.versions[0]).toMatchObject({ version: 2, price_ht: '950.00', duration_minutes: 840 });

    // Session : intitulé, type intra exige un client, changement de formation en brouillon.
    expect((await u.api.patch(`/api/v1/sessions/${s.id}`, { version: s.version, kind: 'intra' })).status).toBe(400);
    const s2 = (await u.api.patch(`/api/v1/sessions/${s.id}`, { version: s.version, kind: 'intra', clientId: c.id, title: 'CACES ACME', programVersionId: r.versions[0].id }).expect(200)).body;
    expect(s2).toMatchObject({ kind: 'intra', client_id: c.id, title: 'CACES ACME', program_version_id: r.versions[0].id });
  });
});

describe('Paramètres booléens d’URL', () => {
  it('archived=false liste les fiches actives (et non les archivées)', async () => {
    const u = await signupAndLogin({ legalName: 'OF Bool' });
    const c = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Actif' }).expect(201)).body;
    const a = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Ancien' }).expect(201)).body;
    await u.api.post(`/api/v1/clients/${a.id}/archive`, { archived: true }).expect(201);
    expect((await u.api.get('/api/v1/clients?archived=false')).body.map((x: any) => x.id)).toEqual([c.id]);
    expect((await u.api.get('/api/v1/clients?archived=true')).body.map((x: any) => x.id)).toEqual([a.id]);
  });
});
