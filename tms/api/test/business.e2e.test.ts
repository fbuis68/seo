import { closeApp, getApp, http, signupAndLogin } from './helpers';

beforeAll(getApp);
afterAll(closeApp);

type U = Awaited<ReturnType<typeof signupAndLogin>>;

async function program(u: U) {
  const p = await u.api.post('/api/v1/programs', { title: 'Excel avancé', durationMinutes: 420, modality: 'onsite', priceHt: '900.00', vatRate: '20' }).expect(201);
  return p.body;
}
async function session(u: U, versionId: string, startsOn = `${new Date().getFullYear()}-11-12`) {
  const s = await u.api.post('/api/v1/sessions', { programVersionId: versionId, kind: 'inter', capacity: 30, startsOn, endsOn: startsOn }).expect(201);
  return s.body;
}
async function person(u: U, i: number) {
  return (await u.api.post('/api/v1/persons', { firstName: `Prénom${i}`, lastName: `Nom${i}`, roles: ['learner'] }).expect(201)).body;
}

describe('Quotas Free et règles métier', () => {
  it('REC-25 : bloque le 11e client facturé ; l’archivage ne libère pas de place ; la suppression oui', async () => {
    const u = await signupAndLogin();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await u.api.post('/api/v1/clients', { kind: 'company', name: `Client ${i}`, status: 'customer' }).expect(201)).body.id);
    const r = await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client 11', status: 'customer' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('quota_exceeded');
    await u.api.post(`/api/v1/clients/${ids[0]}/archive`, { archived: true }).expect(201);
    expect((await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client 11', status: 'customer' })).status).toBe(402);
    // Les prospects ne consomment pas le quota clients.
    await u.api.post('/api/v1/clients', { kind: 'company', name: 'Prospect', status: 'prospect' }).expect(201);
    await u.api.del(`/api/v1/clients/${ids[1]}`).expect(200);
    await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client 11', status: 'customer' }).expect(201);
  });

  it('REC-26 : 1 entreprise + 20 salariés = 1 client / 20 apprenants ; doublons non comptés ; 51e bloqué', async () => {
    const u = await signupAndLogin();
    const prog = await program(u);
    const s1 = await session(u, prog.versions[0].id);
    const s2 = await session(u, prog.versions[0].id);
    const company = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'ACME', status: 'customer', siret: '73282932000074' }).expect(201)).body;
    const people = [];
    for (let i = 0; i < 50; i++) people.push(await person(u, i));
    for (let i = 0; i < 20; i++) await u.api.post(`/api/v1/sessions/${s1.id}/enrollments`, { personId: people[i].id, clientId: company.id }).expect(201);
    // Mêmes personnes sur une 2e session : pas de double comptage.
    for (let i = 0; i < 20; i++) await u.api.post(`/api/v1/sessions/${s2.id}/enrollments`, { personId: people[i].id, clientId: company.id }).expect(201);
    let usage = await u.api.get('/api/v1/billing/usage').expect(200);
    expect(usage.body.quotas.billedClients.used).toBe(1);
    expect(usage.body.quotas.learnersPerYear.used).toBe(20);
    for (let i = 20; i < 50; i++) await u.api.post(`/api/v1/sessions/${s1.id}/enrollments`, { personId: people[i].id }).expect(201);
    const extra = await person(u, 51);
    const r = await u.api.post(`/api/v1/sessions/${s1.id}/enrollments`, { personId: extra.id });
    expect(r.status).toBe(402);
    // REC-04 : double inscription refusée, quota inchangé.
    const dup = await u.api.post(`/api/v1/sessions/${s1.id}/enrollments`, { personId: people[0].id });
    expect(dup.status).toBe(409);
    usage = await u.api.get('/api/v1/billing/usage').expect(200);
    expect(usage.body.quotas.learnersPerYear.used).toBe(50);
  });

  it('limite les sessions actives à 3 en Free', async () => {
    const u = await signupAndLogin();
    const prog = await program(u);
    for (let i = 0; i < 3; i++) {
      const s = await session(u, prog.versions[0].id);
      await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'planned' }).expect(201);
    }
    const s4 = await session(u, prog.versions[0].id);
    expect((await u.api.post(`/api/v1/sessions/${s4.id}/status`, { status: 'planned' })).status).toBe(402);
    expect((await u.api.post(`/api/v1/sessions/${s4.id}/status`, { status: 'cancelled' })).status).toBe(400); // motif requis
  });

  it('REC-05 : version de programme figée après usage', async () => {
    const u = await signupAndLogin();
    const prog = await program(u);
    await session(u, prog.versions[0].id);
    const v2 = await u.api.post(`/api/v1/programs/${prog.id}/versions`, { durationMinutes: 480, modality: 'remote' }).expect(201);
    expect(v2.body.version).toBe(2);
    const full = await u.api.get(`/api/v1/programs/${prog.id}`).expect(200);
    expect(full.body.versions.find((v: any) => v.version === 1).locked_at).toBeTruthy();
  });

  it('REC-06 : chevauchement formateur détecté, dérogation justifiée tracée ; présence bornée', async () => {
    const u = await signupAndLogin();
    const prog = await program(u);
    const s = await session(u, prog.versions[0].id);
    const trainer = (await u.api.post('/api/v1/persons', { firstName: 'Fo', lastName: 'Rmateur', roles: ['trainer'] }).expect(201)).body;
    // Passage à l'heure d'hiver (26/10/2025) : durée calculée sur instants UTC.
    const slot = await u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: '2025-10-26T01:30:00+02:00', endsAt: '2025-10-26T03:30:00+01:00', trainerId: trainer.id }).expect(201);
    const clash = await u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: '2025-10-26T02:00:00+01:00', endsAt: '2025-10-26T04:00:00+01:00', trainerId: trainer.id });
    expect(clash.status).toBe(409);
    await u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: '2025-10-26T02:00:00+01:00', endsAt: '2025-10-26T04:00:00+01:00', trainerId: trainer.id, overrideReason: 'Co-animation validée' }).expect(201);
    const p = await person(u, 1);
    const e = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: p.id }).expect(201)).body;
    const a = await u.api.post('/api/v1/attendance', { enrollmentId: e.id, slotId: slot.body.id, status: 'present' }).expect(201);
    expect(a.body.minutes).toBe(180); // 3 h réelles malgré 2 h "d'horloge"
    expect((await u.api.post('/api/v1/attendance', { enrollmentId: e.id, slotId: slot.body.id, status: 'partial', minutes: 500 })).status).toBe(400);
  });
});

describe('Finance', () => {
  it('REC-07 : émission concurrente → numéros uniques ; facture émise immuable ; avoir et paiement partiel', async () => {
    const u = await signupAndLogin();
    const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client F' }).expect(201)).body;
    const drafts = [];
    for (let i = 0; i < 6; i++) {
      drafts.push((await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'Formation', quantity: '2', unitPriceHt: '450.005', vatRate: '20' }] }).expect(201)).body);
    }
    expect(drafts[0].total_ht).toBe('900.01');
    expect(drafts[0].total_vat).toBe('180.00');
    expect(drafts[0].total_ttc).toBe('1080.01');
    const issued = await Promise.all(drafts.map((d) => u.api.post(`/api/v1/invoices/${d.id}/issue`)));
    const numbers = issued.map((r) => r.body.number);
    expect(issued.every((r) => r.status === 201)).toBe(true);
    expect(new Set(numbers).size).toBe(6);
    const reissue = await u.api.post(`/api/v1/invoices/${drafts[0].id}/issue`).expect(201);
    expect(reissue.body.number).toBe(issued[0].body.number); // idempotent
    expect((await u.api.patch(`/api/v1/invoices/${drafts[0].id}`, { lines: [{ label: 'x', quantity: '1', unitPriceHt: '1', vatRate: '20' }] })).status).toBe(409);
    expect((await u.api.del(`/api/v1/invoices/${drafts[0].id}`)).status).toBe(409);
    // Client passé en "customer" à l'émission.
    expect((await u.api.get(`/api/v1/clients/${client.id}`)).body.status).toBe('customer');

    const pay = await u.api.post('/api/v1/payments', { clientId: client.id, amount: '500.00', receivedOn: '2026-10-01', allocations: [{ invoiceId: drafts[0].id, amount: '500.00' }] }).expect(201);
    expect(pay.body.id).toBeTruthy();
    const cn = (await u.api.post('/api/v1/invoices', { clientId: client.id, kind: 'credit_note', creditedInvoiceId: drafts[0].id, lines: [{ label: 'Remise', quantity: '1', unitPriceHt: '100', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${cn.id}/issue`).expect(201);
    const inv = await u.api.get(`/api/v1/invoices/${drafts[0].id}`).expect(200);
    expect(inv.body.balance).toBe('460.01'); // 1080.01 - 120 - 500
    const over = await u.api.post('/api/v1/payments', { clientId: client.id, amount: '1000.00', receivedOn: '2026-10-02', allocations: [{ invoiceId: drafts[0].id, amount: '470.00' }] });
    expect(over.status).toBe(400);
    const bigCn = (await u.api.post('/api/v1/invoices', { clientId: client.id, kind: 'credit_note', creditedInvoiceId: drafts[0].id, lines: [{ label: 'Trop', quantity: '1', unitPriceHt: '900', vatRate: '20' }] }).expect(201)).body;
    expect((await u.api.post(`/api/v1/invoices/${bigCn.id}/issue`)).status).toBe(409);
  });
});

describe('Isolation multi-organismes (REC-02)', () => {
  it('refuse tout accès aux données d’un autre organisme', async () => {
    const a = await signupAndLogin();
    const b = await signupAndLogin();
    const client = (await a.api.post('/api/v1/clients', { kind: 'company', name: 'Secret A' }).expect(201)).body;
    // B demande l'objet de A dans son propre contexte : RLS → introuvable.
    expect((await b.api.get(`/api/v1/clients/${client.id}`)).status).toBe(404);
    // B tente d'utiliser le tenant de A : pas d'adhésion → 403.
    const r = await http().get(`/api/v1/clients/${client.id}`).set({ Authorization: `Bearer ${b.token}`, 'X-Tenant-Id': a.tenantId });
    expect(r.status).toBe(403);
    // B tente de lier un objet de A (FK composite + RLS).
    const prog = await program(b);
    const s = await session(b, prog.versions[0].id);
    const enr = await b.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: client.id });
    expect([404, 409]).toContain(enr.status);
    const list = await b.api.get('/api/v1/clients').expect(200);
    expect(list.body.find((c: any) => c.id === client.id)).toBeUndefined();
  });
});
