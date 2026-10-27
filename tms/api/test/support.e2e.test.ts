import { anonymize } from '../src/modules/support/support.module';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(async () => { await getApp(); });
afterAll(closeApp);

describe('Signaler un problème → récapitulatif éditeur', () => {
  it('ticket créé avec contexte ; l’auteur voit le sien ; l’éditeur liste, exporte (Excel, Markdown anonymisé), clôt', async () => {
    const u = await signupAndLogin({ legalName: 'OF Ticket' });
    const t = (await u.api.post('/api/v1/support/tickets', {
      screen: '/clients', feature: 'Clients — Modifier', category: 'bug', severity: 'blocking',
      message: 'Impossible d’enregistrer le client jean.dupont@acme.fr, tél 06 12 34 56 78', expected: 'La fiche est enregistrée',
      context: { url: 'https://saas/clients?edit=1', userAgent: 'Test', errors: [{ at: '2026-10-27T10:00:00Z', method: 'PATCH', path: '/api/v1/clients/1', status: 409, code: 'version_conflict', message: 'Fiche modifiée' }] },
    }).expect(201)).body;
    expect(t.ref).toMatch(/^TCK-\d{5}$/);
    expect((await u.api.post('/api/v1/support/tickets', { screen: '/x', message: 'ko' })).status).toBe(400);
    expect((await u.api.get('/api/v1/support/tickets').expect(200)).body[0]).toMatchObject({ ref: t.ref, status: 'new' });
    // Non-éditeur : back-office invisible.
    expect((await u.api.get('/api/v1/platform/tickets')).status).toBe(404);

    const ed = await signupAndLogin({ email: 'editeur@example.test', legalName: 'Éditeur' });
    const list = (await ed.api.get('/api/v1/platform/tickets').expect(200)).body;
    expect(list.counts).toMatchObject({ new: 1, not_exported: 1 });
    expect(list.tickets[0]).toMatchObject({ ref: t.ref, tenant_name: 'OF Ticket', severity: 'blocking' });

    const md = await ed.api.get('/api/v1/platform/tickets/export?format=md&mark=true').expect(200);
    expect(md.text).toContain(t.ref);
    expect(md.text).toContain('[email]');
    expect(md.text).toContain('[tél]');
    expect(md.text).not.toContain('jean.dupont@acme.fr');
    expect(md.text).toContain('version_conflict');
    expect((await ed.api.get('/api/v1/platform/tickets')).body.counts.not_exported).toBe(0);

    const x = await http().get('/api/v1/platform/tickets/export?format=xlsx&status=all').set(ed.auth).buffer(true)
      .parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect(x.body.subarray(0, 2).toString()).toBe('PK');

    const done = (await ed.api.patch(`/api/v1/platform/tickets/${t.id}`, { status: 'fixed', resolution: 'Corrigé dans la version du 28/10.' }).expect(200)).body;
    expect(done.status).toBe('fixed');
    expect((await u.api.get('/api/v1/support/tickets')).body[0]).toMatchObject({ status: 'fixed', resolution: 'Corrigé dans la version du 28/10.' });
    expect((await ed.api.get('/api/v1/platform/tickets')).body.tickets).toHaveLength(0); // ouverts seulement par défaut
  });

  it('anonymisation', () => {
    expect(anonymize('a.b@c.fr 0612345678 +33 6 12 34 56 78 FR76 3000 6000 0112 3456 7890 189 Bearer abc.def')).toBe('[email] [tél] [tél] [iban] Bearer [jeton]');
  });
});
