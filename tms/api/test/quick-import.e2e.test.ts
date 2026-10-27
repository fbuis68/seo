import { splitFullName, suggestMapping } from '../src/modules/migration/quick';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

const send = (u: any, path: string, body: string, name: string, mapping?: (string | null)[]) => {
  const r = http().post(path).set(u.auth).set('Content-Type', 'application/octet-stream').set('X-Filename', encodeURIComponent(name));
  if (mapping) r.set('X-Mapping', encodeURIComponent(JSON.stringify(mapping)));
  return r.send(Buffer.from(body, 'utf8'));
};

describe('Import rapide (parcours Serv-Izy)', () => {
  it('correspondance proposée, découpage du nom complet', () => {
    expect(suggestMapping('person', ['Civilité', 'Nom complet', 'Téléphone portable', 'E-mail', 'CP'])).toEqual(['civility', 'full_name', 'mobile', 'email', 'postal_code']);
    expect(suggestMapping('person', ['Nom', 'Email'])).toEqual(['full_name', 'email']);
    expect(splitFullName('Mme MARTIN Jeanne')).toEqual({ civility: 'Mme', first_name: 'Jeanne', last_name: 'MARTIN' });
    expect(splitFullName('Jean Dupont')).toEqual({ civility: undefined, first_name: 'Jean', last_name: 'Dupont' });
  });

  it('clients puis apprenants : aperçu par ligne, correspondance modifiée, doublons, import, annulation possible', async () => {
    const u = await signupAndLogin({ legalName: 'OF Rapide' });
    await u.api.post('/api/v1/clients', { kind: 'company', name: 'Déjà Là SARL' }).expect(201);
    const clients = 'Code;Raison sociale;SIRET;Email;Adresse;Complément;CP;Ville\nC1;ACME;73282932000074;compta@acme.fr;1 rue A;Bât B;7500;Paris\nC2;Déjà là SARL;;;;;;\nC3;;;;;;;\nC4;ACME;;;;;;\n';
    const p = (await send(u, '/api/v1/imports/quick/client/preview', clients, 'clients.csv').expect(201)).body;
    expect(p.mapping).toEqual(['external_id', 'name', 'siret', 'email', 'address', 'address', 'postal_code', 'city']);
    expect(p.stats).toMatchObject({ total: 4, ok: 1, duplicate: 2, error: 1, toImport: 1 });
    expect(p.rows[0].data).toMatchObject({ address: '1 rue A, Bât B', postal_code: '07500' });
    expect(p.issues.find((x: any) => x.line === 3).messages[0]).toMatch(/Déjà présent/);
    expect(p.issues.find((x: any) => x.line === 5).messages[0]).toMatch(/Doublon de la ligne 2/);
    // Correspondance modifiée : l'email n'est plus repris.
    const p2 = (await send(u, '/api/v1/imports/quick/client/preview', clients, 'clients.csv', ['external_id', 'name', 'siret', null, 'address', 'address', 'postal_code', 'city']).expect(201)).body;
    expect(p2.rows[0].data.email ?? null).toBeNull();
    expect((await send(u, '/api/v1/imports/quick/client/preview', clients, 'clients.csv', ['name', 'name', null, null, null, null, null, null])).status).toBe(400);
    const r = (await send(u, '/api/v1/imports/quick/client/commit', clients, 'clients.csv').expect(201)).body;
    expect(r).toMatchObject({ created: 1, skippedDuplicates: 2, errors: 1 });
    expect((await u.api.get('/api/v1/clients')).body.map((c: any) => c.name).sort()).toEqual(['ACME', 'Déjà Là SARL']);

    const app = 'Nom complet;Email;Portable;Code client\nMme MARTIN Jeanne;jeanne@acme.fr;612345678;C1\nPaul Durand;;;\nLéa Petit;;;ZZZ\n';
    const a = (await send(u, '/api/v1/imports/quick/person/preview', app, 'apprenants.csv').expect(201)).body;
    expect(a.mapping).toEqual(['full_name', 'email', 'mobile', 'client_ref']);
    expect(a.rows[0].data).toMatchObject({ civility: 'Mme', first_name: 'Jeanne', last_name: 'MARTIN', phone: '0612345678', client_ref: 'C1' });
    expect(a.stats).toMatchObject({ ok: 2, error: 1 });
    expect(a.issues[0].messages[0]).toMatch(/ZZZ.*introuvable/);
    const ra = (await send(u, '/api/v1/imports/quick/person/commit', app, 'apprenants.csv').expect(201)).body;
    expect(ra.created).toBe(2);
    const persons = (await u.api.get('/api/v1/persons?role=learner')).body;
    expect(persons.find((x: any) => x.last_name === 'MARTIN').employer_name).toBe('ACME');
    // Réimport : tout est doublon.
    expect((await send(u, '/api/v1/imports/quick/person/preview', app, 'apprenants.csv').expect(201)).body.stats.duplicate).toBe(1);
    // Lot visible et annulable.
    const lots = (await u.api.get('/api/v1/imports')).body.filter((b: any) => b.status === 'published');
    expect(lots).toHaveLength(2);
    await u.api.post(`/api/v1/imports/${ra.batchId}/rollback`).expect(201);
    expect((await u.api.get('/api/v1/persons?role=learner')).body).toHaveLength(0);
  });
});
