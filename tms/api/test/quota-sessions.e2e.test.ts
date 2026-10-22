import { Db } from '../src/core/db';
import { closeApp, getApp, signupAndLogin } from './helpers';

let app: any;
beforeAll(async () => { app = await getApp(); });
afterAll(closeApp);

describe('Quota mensuel de sessions', () => {
  it('Solo : 10 sessions par mois ; la 11e du même mois est bloquée avec invitation à passer en Equipe', async () => {
    const u = await signupAndLogin({ legalName: 'OF Solo' });
    await app.get(Db).query(`UPDATE subscriptions SET plan_code='solo', status='active', provider='manual' WHERE tenant_id=$1`, [u.tenantId]);
    const prog = (await u.api.post('/api/v1/programs', { title: 'Anglais', durationMinutes: 60, modality: 'onsite' }).expect(201)).body;
    const Y = new Date().getFullYear() + 1;
    const plan = async (day: string) => {
      const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: day, endsOn: day }).expect(201)).body;
      return { s, r: await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'planned' }) };
    };
    for (let i = 1; i <= 10; i++) expect((await plan(`${Y}-03-${String(i).padStart(2, '0')}`)).r.status).toBe(201);
    const over = await plan(`${Y}-03-20`);
    expect(over.r.status).toBe(402);
    expect(over.r.body.code).toBe('quota_exceeded');
    expect(over.r.body.details).toMatchObject({ quota: 'sessionsPerMonth', limit: 10, used: 10, upgradeTo: 'equipe' });
    expect(over.r.body.message).toMatch(/10 sessions par mois.*Equipe/);
    // Brouillon conservé ; un autre mois reste disponible.
    expect((await plan(`${Y}-04-02`)).r.status).toBe(201);
    // Déplacer une session planifiée vers le mois complet : bloqué.
    const apr = (await u.api.get(`/api/v1/sessions?limit=50`)).body.find((x: any) => x.starts_on === `${Y}-04-02`);
    const mv = await u.api.patch(`/api/v1/sessions/${apr.id}`, { version: apr.version, startsOn: `${Y}-03-25`, endsOn: `${Y}-03-25` });
    expect(mv.status).toBe(402);
    // Passage en Equipe (20/mois) : la 11e passe.
    await app.get(Db).query(`UPDATE subscriptions SET plan_code='equipe' WHERE tenant_id=$1`, [u.tenantId]);
    expect((await u.api.post(`/api/v1/sessions/${over.s.id}/status`, { status: 'planned' })).status).toBe(201);
  });
});
