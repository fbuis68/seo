import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

const CSV = 'Identifiant;Raison sociale;Email\nC1;ACME;compta@acme.test\nC2;Beta;compta@beta.test\n';
async function newBatch(u: any) {
  const b = (await u.api.post('/api/v1/imports', { sourceSoftware: 'generic', sourceInstanceId: 'fichier-excel' }).expect(201)).body;
  await http().put(`/api/v1/imports/${b.id}/package`).set(u.auth).set('Content-Type', 'application/octet-stream').set('X-Filename', 'clients.csv').send(Buffer.from(CSV)).expect(200);
  const det = (await u.api.post(`/api/v1/imports/${b.id}/detect`).expect(201)).body;
  await u.api.post(`/api/v1/imports/${b.id}/mapping`, { profile: 'generic', files: [{ path: det.tables[0].name, entity: 'client', columns: { external_id: 'Identifiant', name: 'Raison sociale', email: 'Email' } }] }).expect(201);
  await u.api.post(`/api/v1/imports/${b.id}/simulate`, {}).expect(201);
  return b.id as string;
}

describe('Lots d’import : supprimer, relancer', () => {
  it('lot en cours : relancer = reprendre (simulation conservée) ; supprimer le libère', async () => {
    const u = await signupAndLogin({ legalName: 'OF Lots' });
    const id = await newBatch(u);
    expect((await u.api.post(`/api/v1/imports/${id}/relaunch`).expect(201)).body).toMatchObject({ batchId: id, resumed: true });
    await u.api.post(`/api/v1/imports/${id}/detect`).expect(201);
    expect((await u.api.get(`/api/v1/imports/${id}`)).body.status).toBe('simulated');
    await u.api.post(`/api/v1/imports/${id}/delete`).expect(201);
    expect((await u.api.get(`/api/v1/imports/${id}`)).status).toBe(404);
    expect((await u.api.get('/api/v1/imports')).body.find((b: any) => b.id === id)).toBeUndefined();
    await newBatch(u); // plus de lot actif bloquant
  });

  it('lot publié : suppression refusée tant qu’il n’est pas annulé ; relance depuis le même fichier, colonnes reprises', async () => {
    const u = await signupAndLogin({ legalName: 'OF Relance' });
    const id = await newBatch(u);
    await u.api.post(`/api/v1/imports/${id}/commit`).expect(201);
    expect((await u.api.post(`/api/v1/imports/${id}/delete`)).body.code).toBe('batch_published');
    await u.api.post(`/api/v1/imports/${id}/rollback`).expect(201);
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(0);

    const r = (await u.api.post(`/api/v1/imports/${id}/relaunch`).expect(201)).body;
    expect(r.resumed).toBe(false);
    const nb = (await u.api.get(`/api/v1/imports/${r.batchId}`)).body;
    expect(nb.status).toBe('mapped');
    expect(nb.mapping.files[0].columns.name).toBe('Raison sociale');
    const sim = (await u.api.post(`/api/v1/imports/${r.batchId}/simulate`, {}).expect(201)).body;
    expect(sim.summary.client.create).toBe(2);
    await u.api.post(`/api/v1/imports/${r.batchId}/commit`).expect(201);
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(2);
    await u.api.post(`/api/v1/imports/${id}/delete`).expect(201); // ancien lot annulé : supprimable
  });
});
