import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

const base = (siret?: string, n = 0) => ({ email: `siret${Date.now()}_${n}@example.test`, password: 'motdepasse-solide-42', fullName: 'Sam Siret',
  organization: { legalName: 'OF Siret', ...(siret !== undefined ? { siret } : {}) }, acceptTerms: true, plan: 'free', interval: 'month', addons: [] });

describe('SIRET obligatoire', () => {
  it('inscription : absent, vide, mal formé ou clé fausse → refusé ; espaces tolérés', async () => {
    let i = 0;
    for (const s of [undefined, '', '1234', '73282932000075']) {
      const r = await http().post('/api/v1/public/signup').set('X-Forwarded-For', `10.77.0.${++i}`).send(base(s, i));
      expect(r.status).toBe(400);
    }
    const ok = await http().post('/api/v1/public/signup').set('X-Forwarded-For', '10.77.1.1').send(base('732 829 320 00074', 9)).expect(201);
    expect(ok.body.tenantId).toBeTruthy();
  });

  it('paramétrage : impossible d’effacer ou de saisir un SIRET invalide', async () => {
    const u = await signupAndLogin({ legalName: 'OF Param' });
    expect((await u.api.patch('/api/v1/organization', { siret: null })).status).toBe(400);
    expect((await u.api.patch('/api/v1/organization', { siret: '' })).status).toBe(400);
    expect((await u.api.patch('/api/v1/organization', { siret: '12345678901234' })).status).toBe(400);
    expect((await u.api.patch('/api/v1/organization', { siret: '55210055400013' }).expect(200)).body.siret).toBe('55210055400013');
    expect((await u.api.post('/api/v1/tenants', { legalName: 'Filiale' })).status).toBe(400);
  });
});
