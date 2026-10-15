import { getApp, closeApp, http, signupAndLogin } from './helpers';
import { SubscriptionService } from '../src/modules/billing/subscription.service';
import { FakePaymentProvider } from '../src/modules/billing/providers/fake.provider';

let fake: FakePaymentProvider;
let subs: SubscriptionService;

beforeAll(async () => {
  const app = await getApp();
  subs = app.get(SubscriptionService);
  fake = subs.provider as FakePaymentProvider;
});
afterAll(closeApp);

async function payCheckout(url: string) {
  const id = url.split('/').pop()!;
  for (const e of fake.complete(id)) await http().post('/api/v1/webhooks/payment').set(e.headers).send(e.body.toString()).expect(201);
  return id;
}

describe('Souscription en ligne', () => {
  it('expose le catalogue public pour le site web', async () => {
    const res = await http().get('/api/v1/public/catalog').expect(200);
    expect(res.body.plans.map((p: any) => p.code)).toEqual(['free', 'solo', 'equipe', 'centre']);
    expect(res.body.plans[1].yearlyPriceCents).toBe(39000);
    expect(res.body.addons.find((a: any) => a.code === 'bank').priceCents).toBe(1200);
  });

  it('refuse une inscription sans acceptation des CGV', async () => {
    const res = await http().post('/api/v1/public/signup').send({ email: 'x@example.test', password: 'motdepasse-solide', fullName: 'X Y', organization: { legalName: 'OF' } });
    expect(res.status).toBe(400);
  });

  it('crée un organisme Free sans carte, puis interdit l’accès avant vérification email', async () => {
    const res = await http().post('/api/v1/public/signup').send({
      email: 'nonverifie@example.test', password: 'motdepasse-solide', fullName: 'A B', organization: { legalName: 'OF A' }, acceptTerms: true, plan: 'solo',
    }).expect(201);
    expect(res.body.plan).toBe('free');
    const login = await http().post('/api/v1/auth/login').send({ email: 'nonverifie@example.test', password: 'motdepasse-solide' }).expect(201);
    const r = await http().get('/api/v1/billing').set({ Authorization: `Bearer ${login.body.token}`, 'X-Tenant-Id': res.body.tenantId });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('email_not_verified');
  });

  it('mauvais mot de passe : 401 (pas d’erreur interne), verrouillage au 5e échec', async () => {
    const u = await signupAndLogin();
    for (let i = 0; i < 4; i++) {
      const r = await http().post('/api/v1/auth/login').send({ email: u.email, password: 'mauvais-mot-de-passe' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_credentials');
    }
    expect((await http().post('/api/v1/auth/login').send({ email: u.email, password: 'mauvais-mot-de-passe' })).status).toBe(401);
    const locked = await http().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
  });

  it('active l’offre uniquement après webhook vérifié, sans double abonnement', async () => {
    const u = await signupAndLogin();
    const c1 = await u.api.post('/api/v1/billing/checkout', { plan: 'equipe', interval: 'month', addons: [{ code: 'bank', quantity: 1 }] }).expect(201);
    const c2 = await u.api.post('/api/v1/billing/checkout', { plan: 'equipe', interval: 'month', addons: [{ code: 'bank', quantity: 1 }] }).expect(201);
    expect(c2.body.url).toBe(c1.body.url); // clic répété
    let st = await u.api.get('/api/v1/billing').expect(200);
    expect(st.body.status).toBe('free'); // pas d'activation sur retour navigateur
    await payCheckout(c1.body.url);
    st = await u.api.get('/api/v1/billing').expect(200);
    expect(st.body.status).toBe('active');
    expect(st.body.plan).toBe('equipe');
    expect(st.body.entitlements.features).toContain('bank');
    expect(st.body.signatureCredits.available).toBe(20);
    const again = await u.api.post('/api/v1/billing/checkout', { plan: 'solo', interval: 'month', addons: [] });
    expect(again.status).toBe(409);
  });

  it('rejette un webhook à signature invalide et ignore un doublon', async () => {
    const u = await signupAndLogin();
    const c = await u.api.post('/api/v1/billing/checkout', { plan: 'solo', interval: 'year', addons: [] }).expect(201);
    const events = fake.complete(c.body.url.split('/').pop());
    const bad = await http().post('/api/v1/webhooks/payment').set({ ...events[0].headers, 'x-fake-signature': 't=1,v1=00' }).send(events[0].body.toString());
    expect(bad.status).toBe(400);
    for (const e of events) await http().post('/api/v1/webhooks/payment').set(e.headers).send(e.body.toString()).expect(201);
    const dup = await http().post('/api/v1/webhooks/payment').set(events[0].headers).send(events[0].body.toString()).expect(201);
    expect(dup.body.duplicate).toBe(true);
    const st = await u.api.get('/api/v1/billing').expect(200);
    expect(st.body.interval).toBe('year');
  });

  it('upgrade avec aperçu confirmé, puis résiliation : retour Free sous quotas', async () => {
    const u = await signupAndLogin();
    const c = await u.api.post('/api/v1/billing/checkout', { plan: 'solo', interval: 'month', addons: [] }).expect(201);
    await payCheckout(c.body.url);
    const prev = await u.api.post('/api/v1/billing/preview-change', { plan: 'centre', interval: 'month', addons: [] }).expect(201);
    expect(prev.body.direction).toBe('upgrade');
    const bad = await u.api.post('/api/v1/billing/change', { plan: 'centre', interval: 'month', addons: [], confirm: { direction: 'upgrade', newAmountCents: 1 } });
    expect(bad.status).toBe(409);
    const ok = await u.api.post('/api/v1/billing/change', { plan: 'centre', interval: 'month', addons: [], confirm: { direction: 'upgrade', newAmountCents: prev.body.newAmountCents } }).expect(201);
    expect(ok.body.plan).toBe('centre');
    const st = await u.api.get('/api/v1/billing');
    const subId = [...fake.subscriptions.values()].find((s) => s.tenantId === u.tenantId)!.providerSubscriptionId;
    expect(st.body.hasPaymentMethod).toBe(true);
    const evt = fake.mutate(subId, { status: 'canceled' }, 'customer.subscription.deleted');
    await http().post('/api/v1/webhooks/payment').set(evt.headers).send(evt.body.toString()).expect(201);
    const after = await u.api.get('/api/v1/billing').expect(200);
    expect(after.body.status).toBe('free');
    expect(after.body.plan).toBe('free');
  });

  it('échec de paiement : past_due avec délai de grâce', async () => {
    const u = await signupAndLogin();
    const c = await u.api.post('/api/v1/billing/checkout', { plan: 'solo', interval: 'month', addons: [] }).expect(201);
    await payCheckout(c.body.url);
    const subId = [...fake.subscriptions.values()].find((s) => s.tenantId === u.tenantId)!.providerSubscriptionId;
    const evt = fake.mutate(subId, { status: 'past_due' }, 'invoice.payment_failed');
    await http().post('/api/v1/webhooks/payment').set(evt.headers).send(evt.body.toString()).expect(201);
    const st = await u.api.get('/api/v1/billing').expect(200);
    expect(st.body.status).toBe('past_due');
    expect(new Date(st.body.graceUntil).getTime()).toBeGreaterThan(Date.now() + 6 * 86400e3);
    expect(st.body.entitlements.canSendSignatures).toBe(true);
  });
});

describe('Back-office éditeur', () => {
  it('réservé aux comptes éditeur ; vue des organismes ; actions tracées (offre offerte, retour Free, suspension)', async () => {
    const admin = await signupAndLogin({ email: 'editeur@example.test', legalName: 'Éditeur' });
    const client = await signupAndLogin({ legalName: 'Centre Client BO' });
    const as = (u: typeof admin) => ({ get: (p: string) => http().get(p).set({ Authorization: `Bearer ${u.token}` }), post: (p: string, b: any) => http().post(p).set({ Authorization: `Bearer ${u.token}` }).send(b) });
    expect((await as(client).get('/api/v1/platform/overview')).status).toBe(404);
    expect((await http().get('/api/v1/me').set({ Authorization: `Bearer ${admin.token}` })).body.isPlatformAdmin).toBe(true);
    const ov = (await as(admin).get('/api/v1/platform/overview').expect(200)).body;
    expect(ov.tenants).toBeGreaterThanOrEqual(2);
    expect(ov.months).toHaveLength(12);
    const list = (await as(admin).get('/api/v1/platform/tenants?q=Client BO').expect(200)).body;
    expect(list.map((t: any) => t.id)).toEqual([client.tenantId]);
    expect(list[0].owner_email).toBe(client.email);
    // Offre offerte : droits appliqués immédiatement, motif obligatoire, journal.
    expect((await as(admin).post(`/api/v1/platform/tenants/${client.tenantId}/actions`, { action: 'comp', plan: 'centre' })).status).toBe(400);
    const d = (await as(admin).post(`/api/v1/platform/tenants/${client.tenantId}/actions`, { action: 'comp', plan: 'centre', until: '2099-12-31', reason: 'Partenaire pilote' }).expect(201)).body;
    expect([d.plan_code, d.status, d.mrr_cents]).toEqual(['centre', 'active', 0]);
    expect(d.events[0]).toMatchObject({ action: 'platform.comp', actor: 'editeur@example.test' });
    expect((await client.api.get('/api/v1/billing/usage')).body.plan).toBe('centre');
    await as(admin).post(`/api/v1/platform/tenants/${client.tenantId}/actions`, { action: 'free', reason: 'Fin du pilote' }).expect(201);
    expect((await client.api.get('/api/v1/billing/usage')).body.plan).toBe('free');
    // Suspension : accès coupé ; réactivation.
    await as(admin).post(`/api/v1/platform/tenants/${client.tenantId}/actions`, { action: 'suspend', reason: 'Impayé contentieux' }).expect(201);
    expect([401, 403]).toContain((await client.api.get('/api/v1/billing/usage')).status);
    await as(admin).post(`/api/v1/platform/tenants/${client.tenantId}/actions`, { action: 'reactivate', reason: 'Régularisé' }).expect(201);
    const relog = await http().post('/api/v1/auth/login').send({ email: client.email, password: client.password }).expect(201);
    await http().get('/api/v1/billing/usage').set({ Authorization: `Bearer ${relog.body.token}`, 'X-Tenant-Id': client.tenantId }).expect(200);
  });
});
