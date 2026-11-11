import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { migrate } from '../scripts/migrate';
import { createApp } from '../src/bootstrap';
import { config } from '../src/config';

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
export type Api = ReturnType<typeof client>;
function client(token: string) {
  const h = { Authorization: `Bearer ${token}` };
  return {
    token,
    get: (url: string) => http().get(url).set(h),
    post: (url: string, body?: unknown) => http().post(url).set(h).send(body as any),
    patch: (url: string, body?: unknown) => http().patch(url).set(h).send(body as any),
    del: (url: string) => http().delete(url).set(h),
  };
}

/** Compte (organisateur si `org`, sinon joueur) connecté. */
export async function account(opts: { org?: string; first?: string; last?: string } = {}) {
  const n = ++seq;
  const email = `u${n}_${Date.now()}@example.test`;
  const res = await http().post('/api/auth/signup').set('X-Forwarded-For', `10.9.${n % 250}.${Math.floor(n / 250) + 1}`).send({
    email, password: 'motdepasse-solide', firstName: opts.first ?? `Prénom${n}`, lastName: opts.last ?? `Nom${n}`, acceptTerms: true,
    organization: opts.org ? { name: opts.org } : undefined,
  });
  if (res.status !== 201) throw new Error(`signup ${res.status} ${JSON.stringify(res.body)}`);
  return { ...client(res.body.token), email, userId: res.body.userId as string, orgId: res.body.orgId as string | undefined };
}

export const padelTournament = (orgId: string, over: Record<string, unknown> = {}) => ({
  orgId, name: 'Open de padel', discipline: 'padel', startsAt: '2026-12-05T09:00:00+01:00', endsAt: '2026-12-05T20:00:00+01:00',
  venueName: 'Padel Club', maxParticipants: 16, mode: 'double', format: 'groups_knockout', courts: 4, matchMinutes: 45,
  formatConfig: { groups: { count: 4, distribution: 'snake', legs: 1, qualifiers: 2, avoidSameGroup: true }, knockout: { thirdPlace: true, seeding: 'seeded' } },
  ...over,
});

export const pair = (i: number, rating?: number) => ({
  name: `Paire ${String(i).padStart(2, '0')}`, rating: rating ?? 100 - i,
  members: [{ firstName: `A${i}`, lastName: `Joueur${i}` }, { firstName: `B${i}`, lastName: `Partenaire${i}` }],
});
export const solo = (i: number, rating?: number) => ({ rating: rating ?? 100 - i, members: [{ firstName: `J${i}`, lastName: `Solo${i}` }] });

/** Score de victoire (sets) pour le côté indiqué. */
export const win = (side: 'home' | 'away', sets: [number, number][] = [[6, 2], [6, 3]]) =>
  ({ sets: sets.map(([w, l]) => (side === 'home' ? { home: w, away: l } : { home: l, away: w })) });

export function expectStatus(res: request.Response, status: number) {
  if (res.status !== status) throw new Error(`HTTP ${res.status} (attendu ${status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}
