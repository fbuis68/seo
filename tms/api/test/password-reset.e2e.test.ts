import { SystemMailer } from '../src/core/system-mail';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

let app: any;
beforeAll(async () => { app = await getApp(); });
afterAll(closeApp);

const lastLink = (to: string) => {
  const m = (app.get(SystemMailer) as any).devOutbox.filter((x: any) => x.to === to && /Réinitialisation/.test(x.subject)).pop();
  return m ? /reset-password\?token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1] : undefined;
};

describe('Mot de passe oublié', () => {
  it('lien unique 1 h → nouveau mot de passe → sessions fermées ; compte inconnu : même réponse', async () => {
    const u = await signupAndLogin({ legalName: 'OF Oubli' });
    // Compte inconnu : même réponse, aucun email.
    const unknown = await http().post('/api/v1/auth/forgot-password').send({ email: 'personne@nulle.part' }).expect(201);
    expect(unknown.body).toEqual({ sent: true });

    expect((await http().post('/api/v1/auth/forgot-password').send({ email: u.email.toUpperCase() }).expect(201)).body).toEqual({ sent: true });
    const first = lastLink(u.email)!;
    expect(first).toBeTruthy();
    // Nouvelle demande : l'ancien lien est annulé.
    await http().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(201);
    const token = lastLink(u.email)!;
    expect(token).not.toBe(first);
    expect((await http().post('/api/v1/auth/reset-password/check').send({ token: first })).status).toBe(400);
    expect((await http().post('/api/v1/auth/reset-password/check').send({ token }).expect(201)).body.email).toMatch(/•••@/);

    expect((await http().post('/api/v1/auth/reset-password').send({ token, password: 'court' })).status).toBe(400);
    await http().post('/api/v1/auth/reset-password').send({ token, password: 'NouveauMotDePasse!2026' }).expect(201);
    // Lien consommé, ancienne session fermée, ancien mot de passe refusé, nouveau accepté.
    expect((await http().post('/api/v1/auth/reset-password').send({ token, password: 'EncoreUnAutre!2026' })).status).toBe(400);
    expect((await u.api.get('/api/v1/me')).status).toBe(401);
    expect((await http().post('/api/v1/auth/login').send({ email: u.email, password: u.password })).status).toBe(401);
    await http().post('/api/v1/auth/login').send({ email: u.email, password: 'NouveauMotDePasse!2026' }).expect(201);
    expect((app.get(SystemMailer) as any).devOutbox.some((x: any) => x.to === u.email && /a été modifié/.test(x.subject))).toBe(true);
  });

  it('3 demandes maximum par heure et par compte', async () => {
    const u = await signupAndLogin({ legalName: 'OF Limite' });
    const box = (app.get(SystemMailer) as any).devOutbox;
    const before = box.filter((x: any) => x.to === u.email && /Réinitialisation/.test(x.subject)).length;
    for (let i = 0; i < 5; i++) await http().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(201);
    expect(box.filter((x: any) => x.to === u.email && /Réinitialisation/.test(x.subject)).length - before).toBe(3);
  });
});
