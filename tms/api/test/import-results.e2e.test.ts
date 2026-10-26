import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

describe('Résultat d’import ligne à ligne', () => {
  it('référence chaque erreur par fichier, ligne, colonne (lettre) et correction', async () => {
    const u = await signupAndLogin({ legalName: 'OF Résultats' });
    const csv = 'Identifiant;Prénom;Nom;Email\nA1;Jean;Dupont;jean@test.fr\nA2;Marie;;marie@test.fr\nA1;Paul;Durand;paul@test.fr\n';
    const b = (await u.api.post('/api/v1/imports', { sourceSoftware: 'generic', sourceInstanceId: 'fichier-excel' }).expect(201)).body;
    await http().put(`/api/v1/imports/${b.id}/package`).set(u.auth).set('Content-Type', 'application/octet-stream').set('X-Filename', 'apprenants.csv').send(Buffer.from(csv)).expect(200);
    const det = (await u.api.post(`/api/v1/imports/${b.id}/detect`).expect(201)).body;
    const files = [{ path: det.tables[0].name, entity: 'person', columns: { external_id: 'Identifiant', first_name: 'Prénom', last_name: 'Nom', email: 'Email' } }];
    await u.api.post(`/api/v1/imports/${b.id}/mapping`, { profile: 'generic', files }).expect(201);
    await u.api.post(`/api/v1/imports/${b.id}/simulate`, { partial: true }).expect(201);

    const r = (await u.api.get(`/api/v1/imports/${b.id}/results?filter=errors`).expect(200)).body;
    expect(r.counts).toMatchObject({ total: 3, errors: 2, ok: 1 });
    const missing = r.rows.find((x: any) => x.line === 3);
    expect(missing).toMatchObject({ file: 'apprenants.csv', action: 'reject', label: 'Marie' });
    expect(missing.issues[0]).toMatchObject({ severity: 'blocking', code: 'required', column: 'Nom', columnLetter: 'C' });
    expect(missing.issues[0].fix).toMatch(/Renseignez/);
    const dup = r.rows.find((x: any) => x.line === 4);
    expect(dup.issues.map((i: any) => i.code)).toContain('duplicate_in_package');

    const ok = (await u.api.get(`/api/v1/imports/${b.id}/results?filter=ok`)).body;
    expect(ok.rows.map((x: any) => [x.line, x.action, x.label])).toEqual([[2, 'create', 'Dupont Jean']]);
  });
});
