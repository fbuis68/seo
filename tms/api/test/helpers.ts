import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/bootstrap';
import { config } from '../src/config';
import { SystemMailer } from '../src/core/system-mail';

let app: INestApplication | undefined;

export async function resetDb() {
  const c = new Client({ connectionString: config.migrationDatabaseUrl });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(config.migrationDatabaseUrl, false);
}

export async function getApp(): Promise<INestApplication> {
  if (!app) {
    await resetDb();
    app = await createApp();
    await app.init();
  }
  return app;
}
export async function closeApp() { await app?.close(); app = undefined; }

export const http = () => request(app!.getHttpServer());

let seq = 0;
/** Inscription publique + vérification email + connexion : renvoie un client authentifié. */
export async function signupAndLogin(opts: { plan?: string; legalName?: string; email?: string; billingReady?: boolean } = {}) {
  const email = opts.email ?? `user${Date.now()}_${++seq}@example.test`;
  if (opts.email) ++seq;
  const password = 'motdepasse-solide-42';
  const res = await http().post('/api/v1/public/signup').send({
    email, password, fullName: 'Camille Martin', organization: { legalName: opts.legalName ?? `OF ${seq}`, siret: '73282932000074' },
    acceptTerms: true, plan: opts.plan ?? 'free', interval: 'month', addons: [],
  }).set('X-Forwarded-For', `10.0.${seq}.1`);
  if (res.status !== 201) throw new Error(`signup ${res.status} ${JSON.stringify(res.body)}`);
  const mailer = app!.get(SystemMailer);
  const mail = [...mailer.devOutbox].reverse().find((m) => m.to === email)!;
  const token = /token=([\w-]+)/.exec(mail.text)![1];
  await http().post('/api/v1/auth/verify-email').send({ token }).expect(201);
  const login = await http().post('/api/v1/auth/login').send({ email, password }).expect(201);
  const tenantId = res.body.tenantId as string;
  const auth = { Authorization: `Bearer ${login.body.token}`, 'X-Tenant-Id': tenantId };
  const api = {
    get: (url: string) => http().get(url).set(auth),
    post: (url: string, body?: unknown) => http().post(url).set(auth).send(body as any),
    patch: (url: string, body?: unknown) => http().patch(url).set(auth).send(body as any),
    put: (url: string, body?: unknown) => http().put(url).set(auth).send(body as any),
    del: (url: string) => http().delete(url).set(auth),
  };
  // Par défaut : émetteur, profil fiscal et numérotation validés (prêt à facturer), comme après l'assistant.
  if (opts.billingReady !== false) {
    await api.patch('/api/v1/organization', { siret: '73282932000074', address: { line1: '1 rue de la Paix', postal_code: '75002', city: 'Paris' } });
    const ob = (await api.put('/api/v1/billing-profile', { vatRegime: 'subject', paymentTermsDays: 30, latePenalty: '3 fois le taux d’intérêt légal' })).body;
    await api.post('/api/v1/billing-profile/confirm', { version: ob.billing.profile.version });
    await api.post('/api/v1/invoice-series/confirm', {});
  }
  return { email, password, tenantId, token: login.body.token as string, auth, api };
}

/** Adresse de facturation de test (exigée pour émettre). */
export const ADDR = { line1: '10 avenue des Tests', postal_code: '69001', city: 'Lyon' };
