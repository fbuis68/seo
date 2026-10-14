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
    // Double réservation bloquante par défaut, même motivée ; dérogeable seulement si le centre l'autorise.
    expect((await u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: '2025-10-26T02:00:00+01:00', endsAt: '2025-10-26T04:00:00+01:00', trainerId: trainer.id, overrideReason: 'Co-animation validée' })).status).toBe(409);
    await u.api.put('/api/v1/planning/settings', { overlap_derogable: true }).expect(200);
    await u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: '2025-10-26T02:00:00+01:00', endsAt: '2025-10-26T04:00:00+01:00', trainerId: trainer.id, overrideReason: 'Co-animation validée' }).expect(201);
    const p = await person(u, 1);
    const e = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: p.id }).expect(201)).body;
    const a = await u.api.post('/api/v1/attendance', { enrollmentId: e.id, slotId: slot.body.id, status: 'present' }).expect(201);
    expect(a.body.minutes).toBe(180); // 3 h réelles malgré 2 h "d'horloge"
    expect((await u.api.post('/api/v1/attendance', { enrollmentId: e.id, slotId: slot.body.id, status: 'partial', minutes: 500 })).status).toBe(400);
  });
});

describe('Formateur affecté après création de la session', () => {
  it('affecte sur tous les créneaux, refuse un chevauchement sans motif, permet le retrait', async () => {
    const u = await signupAndLogin();
    const prog = await program(u);
    const s1 = await session(u, prog.versions[0].id);
    const s2 = await session(u, prog.versions[0].id);
    for (const [sid, start, end] of [[s1.id, '2026-11-12T09:00:00+01:00', '2026-11-12T12:00:00+01:00'], [s1.id, '2026-11-12T13:00:00+01:00', '2026-11-12T17:00:00+01:00'], [s2.id, '2026-11-12T10:00:00+01:00', '2026-11-12T11:00:00+01:00']]) {
      await u.api.post(`/api/v1/sessions/${sid}/slots`, { startsAt: start, endsAt: end }).expect(201);
    }
    const t = (await u.api.post('/api/v1/persons', { firstName: 'Jeanne', lastName: 'Formatrice', roles: ['trainer'] }).expect(201)).body;
    const learner = await person(u, 99);
    expect((await u.api.post(`/api/v1/sessions/${s1.id}/trainer`, { trainerId: learner.id })).status).toBe(400); // pas formateur
    const all = (await u.api.post(`/api/v1/sessions/${s1.id}/trainer`, { trainerId: t.id }).expect(201)).body;
    expect(all.updated).toBe(2);
    let detail = (await u.api.get(`/api/v1/sessions/${s1.id}`)).body;
    expect(detail.slots.every((sl: any) => sl.trainers.length === 1 && sl.trainers[0].id === t.id && sl.trainers[0].name === 'Jeanne Formatrice')).toBe(true);
    expect(detail.missing.some((m: string) => m.includes('sans formateur'))).toBe(false);
    // Même formateur sur la session 2, créneau qui chevauche : refusé (rien modifié), puis forcé avec motif.
    const clash = await u.api.post(`/api/v1/sessions/${s2.id}/trainer`, { trainerId: t.id });
    expect(clash.status).toBe(409);
    expect((await u.api.get(`/api/v1/sessions/${s2.id}`)).body.slots[0].trainers).toHaveLength(0);
    expect((await u.api.post(`/api/v1/sessions/${s2.id}/trainer`, { trainerId: t.id, overrideReason: 'Co-animation prévue' })).status).toBe(409);
    await u.api.put('/api/v1/planning/settings', { overlap_derogable: true }).expect(200);
    await u.api.post(`/api/v1/sessions/${s2.id}/trainer`, { trainerId: t.id, overrideReason: 'Co-animation prévue' }).expect(201);
    expect((await u.api.get(`/api/v1/sessions/${s2.id}`)).body.slots[0].derogation.reason).toBe('Co-animation prévue');
    // Changement sur un seul créneau, puis retrait.
    const firstSlot = detail.slots[0].id;
    await u.api.post(`/api/v1/sessions/${s1.id}/trainer`, { trainerId: null, slotIds: [firstSlot] }).expect(201);
    detail = (await u.api.get(`/api/v1/sessions/${s1.id}`)).body;
    expect(detail.slots.find((sl: any) => sl.id === firstSlot).trainers).toHaveLength(0);
    expect(detail.slots.filter((sl: any) => sl.trainers.some((x: any) => x.id === t.id))).toHaveLength(1);
    expect(detail.missing).toContain('1 créneau(x) sans formateur');
  });
});

describe('Session découpée en parties, plusieurs formateurs, lieux et matériel (CACES)', () => {
  it('14 h = 7 h théorie (prof 1) + 7 h pratique engin (prof 2) ; engin et salle non réservables deux fois ; VGP échue signalée', async () => {
    const u = await signupAndLogin();
    const prog = (await u.api.post('/api/v1/programs', { title: 'CACES R489 cat. 3', durationMinutes: 840, modality: 'onsite' }).expect(201)).body;
    const s = await session(u, prog.versions[0].id, '2026-11-16');
    const other = await session(u, prog.versions[0].id, '2026-11-16');
    const p1 = (await u.api.post('/api/v1/persons', { firstName: 'Paul', lastName: 'Théorie', roles: ['trainer'] }).expect(201)).body;
    const p2 = (await u.api.post('/api/v1/persons', { firstName: 'Lina', lastName: 'Pratique', roles: ['trainer'] }).expect(201)).body;
    const site = (await u.api.post('/api/v1/resources', { kind: 'site', name: 'Centre de Lyon', address: '1 rue des Engins, 69000 Lyon' }).expect(201)).body;
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle A', location: 'Centre de Lyon', capacity: 12 }).expect(201)).body;
    const engin = (await u.api.post('/api/v1/resources', { kind: 'equipment', name: 'Chariot n°3', category: 'Chariot élévateur cat. 3', serialNumber: 'CH-2023-003', inspectionDueOn: '2026-11-01' }).expect(201)).body;
    expect((await u.api.post('/api/v1/resources', { kind: 'room', name: 'X', serialNumber: '1' })).status).toBe(400);
    const theory = (await u.api.post(`/api/v1/sessions/${s.id}/parts`, { title: 'Théorie', plannedMinutes: 420 }).expect(201)).body;
    const practice = (await u.api.post(`/api/v1/sessions/${s.id}/parts`, { title: 'Pratique engin', plannedMinutes: 420 }).expect(201)).body;
    const slot = (partId: string, d: string, h1: string, h2: string, trainerIds: string[], resourceIds: string[], extra: any = {}) =>
      u.api.post(`/api/v1/sessions/${s.id}/slots`, { startsAt: `${d}T${h1}:00+01:00`, endsAt: `${d}T${h2}:00+01:00`, partId, trainerIds, resourceIds, ...extra });
    await slot(theory.id, '2026-11-16', '09:00', '12:30', [p1.id], [site.id, room.id]).expect(201);
    await slot(theory.id, '2026-11-16', '13:30', '17:00', [p1.id], [site.id, room.id]).expect(201);
    await slot(practice.id, '2026-11-17', '09:00', '12:30', [p2.id], [site.id, engin.id]).expect(201);
    // Co-animation : deux formateurs sur le même créneau.
    await slot(practice.id, '2026-11-17', '13:30', '17:00', [p2.id, p1.id], [site.id, engin.id]).expect(201);
    // Même engin réservé par une autre session au même moment : refusé ; le site, lui, est partageable.
    const clash = await u.api.post(`/api/v1/sessions/${other.id}/slots`, { startsAt: '2026-11-17T10:00:00+01:00', endsAt: '2026-11-17T11:00:00+01:00', resourceIds: [site.id, engin.id] });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain('Chariot n°3');
    await u.api.post(`/api/v1/sessions/${other.id}/slots`, { startsAt: '2026-11-17T10:00:00+01:00', endsAt: '2026-11-17T11:00:00+01:00', resourceIds: [site.id] }).expect(201);
    const d = (await u.api.get(`/api/v1/sessions/${s.id}`).expect(200)).body;
    expect(d.parts.map((p: any) => [p.title, p.planned_minutes, p.scheduled_minutes])).toEqual([['Théorie', 420, 420], ['Pratique engin', 420, 420]]);
    expect(d.parts[0].trainers.map((t: any) => t.name)).toEqual(['Paul Théorie']);
    expect(d.parts[1].trainers.map((t: any) => t.name).sort()).toEqual(['Lina Pratique', 'Paul Théorie']);
    expect(d.trainers).toHaveLength(2);
    expect(d.missing.some((m: string) => m.includes('Chariot n°3') && m.includes('vérification périodique'))).toBe(true);
    expect(d.missing.some((m: string) => m.startsWith('Planning') || m.startsWith('Découpage'))).toBe(false);
    // Affecter un formateur à toute une partie (mode ajout), puis retirer.
    await u.api.post(`/api/v1/sessions/${s.id}/trainer`, { partId: theory.id, trainerIds: [p2.id], mode: 'add' }).expect(201);
    let d2 = (await u.api.get(`/api/v1/sessions/${s.id}`)).body;
    expect(d2.parts[0].trainers).toHaveLength(2);
    await u.api.post(`/api/v1/sessions/${s.id}/trainer`, { partId: theory.id, trainerIds: [p2.id], mode: 'remove' }).expect(201);
    d2 = (await u.api.get(`/api/v1/sessions/${s.id}`)).body;
    expect(d2.parts[0].trainers.map((t: any) => t.name)).toEqual(['Paul Théorie']);
    // Le matériel apparaît sur la convention et la feuille d'émargement générées.
    const conv = (await u.api.post('/api/v1/documents/generate', { template: 'attendance_sheet', sessionId: s.id }).expect(201)).body;
    const pdf = await u.api.get(`/api/v1/documents/${conv.id}/download`).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.body.toString('latin1')).toContain('Chariot n');
    // Engin remis en conformité : alerte levée.
    await u.api.patch(`/api/v1/resources/${engin.id}`, { inspectionDueOn: '2027-05-01' }).expect(200);
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.missing.some((m: string) => m.includes('vérification'))).toBe(false);
    expect((await u.api.get('/api/v1/resources?kind=equipment')).body[0].serial_number).toBe('CH-2023-003');
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

describe('Identité visuelle', () => {
  it('logo et couleurs enregistrés ; logo public ; logo et couleur repris sur les documents PDF', async () => {
    const fs = await import('fs');
    const u = await signupAndLogin();
    const png = fs.readFileSync(`${__dirname}/fixtures/logo.png`).toString('base64');
    const jpeg = fs.readFileSync(`${__dirname}/fixtures/logo.jpg`).toString('base64');
    // Contenu non image (ex. SVG / script) refusé.
    expect((await http().put('/api/v1/organization/logo').set(u.auth).send({ png: Buffer.from('<svg onload=alert(1)>').toString('base64'), jpeg })).status).toBe(400);
    const b = (await http().put('/api/v1/organization/logo').set(u.auth).send({ png, jpeg }).expect(200)).body;
    expect([b.logoWidth, b.logoHeight]).toEqual([240, 80]);
    const colors = (await http().put('/api/v1/organization/branding').set(u.auth).send({ accentColor: '#C2185B', docColor: '#1B4F9C', theme: 'dark' }).expect(200)).body;
    expect([colors.accentColor, colors.theme]).toEqual(['#C2185B', 'dark']);
    expect((await http().put('/api/v1/organization/branding').set(u.auth).send({ accentColor: 'red' })).status).toBe(400);
    const pub = await http().get(b.logoUrl).expect(200);
    expect(pub.headers['content-type']).toBe('image/png');
    // Document généré : image JPEG intégrée et titres dans la couleur choisie.
    const prog = (await u.api.post('/api/v1/programs', { title: 'Logo test', durationMinutes: 60, modality: 'onsite' }).expect(201)).body;
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2027-01-10' }).expect(201)).body;
    const doc = (await u.api.post('/api/v1/documents/generate', { template: 'attendance_sheet', sessionId: s.id }).expect(201)).body;
    const pdf = await u.api.get(`/api/v1/documents/${doc.id}/download`).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const text = pdf.body.toString('latin1');
    expect(text).toContain('/Subtype /Image /Width 240 /Height 80');
    expect(text).toContain('/Im1 Do');
    expect(text).toContain('0.106 0.310 0.612 rg');
    await http().delete('/api/v1/organization/logo').set(u.auth).expect(200);
    expect((await http().get(b.logoUrl)).status).toBe(404);
  });
});

describe('Session ↔ émargement ↔ facturation', () => {
  it('clôture contrôlée, séance réalisée par émargement complet, facturation au prorata des heures sans double facturation', async () => {
    const u = await signupAndLogin();
    const prog = (await u.api.post('/api/v1/programs', { title: 'Habilitation électrique', durationMinutes: 420, modality: 'onsite', priceHt: '900.00', vatRate: '20' }).expect(201)).body;
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2026-09-01', endsOn: '2026-09-01' }).expect(201)).body;
    const room = (await u.api.post('/api/v1/resources', { kind: 'room', name: 'Salle Volta', capacity: 10 }).expect(201)).body;
    const t = (await u.api.post('/api/v1/persons', { firstName: 'Ampère', lastName: 'Formateur', roles: ['trainer'] }).expect(201)).body;
    const clientA = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Entreprise A', status: 'customer' }).expect(201)).body;
    const clientB = (await u.api.post('/api/v1/clients', { kind: 'person', name: 'Particulier B', status: 'customer' }).expect(201)).body;
    const opco = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'OPCO Test', status: 'customer', isFunder: true }).expect(201)).body;
    const p = async (n: string) => (await u.api.post('/api/v1/persons', { firstName: n, lastName: 'Stagiaire', roles: ['learner'] }).expect(201)).body;
    const e1 = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: (await p('Un')).id, clientId: clientA.id, status: 'confirmed', fundedAmount: '600.00', fundings: [{ funderClientId: opco.id, amount: '600.00' }] }).expect(201)).body;
    const e2 = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: (await p('Deux')).id, clientId: clientA.id, status: 'confirmed' }).expect(201)).body;
    const e3 = (await u.api.post(`/api/v1/sessions/${s.id}/enrollments`, { personId: (await p('Trois')).id, clientId: clientB.id, status: 'confirmed' }).expect(201)).body;
    const mk = async (h1: string, h2: string) => (await u.api.post('/api/v1/planning/slots', { sessionId: s.id, startsAt: `2026-09-01T${h1}:00+02:00`, endsAt: `2026-09-01T${h2}:00+02:00`, trainerIds: [t.id], resourceIds: [room.id], status: 'published' }).expect(201)).body.id;
    const sl1 = await mk('09:00', '12:30'); const sl2 = await mk('13:30', '17:00');
    for (const st of ['planned', 'confirmed', 'in_progress']) await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: st }).expect(201);
    // Clôture refusée : séances non réalisées, émargement manquant.
    const refused = await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'completed' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('closure_incomplete');
    expect(refused.body.details.issues.map((i: any) => i.code)).toEqual(['slots_not_done', 'attendance_missing']);
    // Émargement : la séance passe « Réalisé » dès que tous les attendus sont saisis.
    let r = await u.api.post('/api/v1/attendance', { enrollmentId: e1.id, slotId: sl1, status: 'present' }).expect(201);
    expect(r.body.slotDone).toBe(false);
    await u.api.post('/api/v1/attendance', { enrollmentId: e2.id, slotId: sl1, status: 'present' }).expect(201);
    r = await u.api.post('/api/v1/attendance', { enrollmentId: e3.id, slotId: sl1, status: 'present' }).expect(201);
    expect(r.body.slotDone).toBe(true);
    expect(r.body.minutes).toBe(210);
    await u.api.post('/api/v1/attendance', { enrollmentId: e1.id, slotId: sl2, status: 'present' }).expect(201);
    await u.api.post('/api/v1/attendance', { enrollmentId: e2.id, slotId: sl2, status: 'absent' }).expect(201);
    await u.api.post('/api/v1/attendance', { enrollmentId: e3.id, slotId: sl2, status: 'present' }).expect(201);
    expect((await u.api.get(`/api/v1/sessions/${s.id}/closure`)).body).toEqual({ ok: true, issues: [] });
    await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'completed' }).expect(201);
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.missing).toContain('Session terminée non facturée');
    expect((await u.api.get('/api/v1/billing/to-bill')).body.map((x: any) => x.id)).toContain(s.id);
    // Aperçu au prorata des heures émargées : financeur, reste à charge client, absences.
    const prev = (await u.api.get(`/api/v1/sessions/${s.id}/billing?basis=hours`).expect(200)).body;
    expect(prev.state).toBe('not_billed');
    const totals = Object.fromEntries(prev.invoices.map((i: any) => [i.clientName, i.totalHt]));
    expect(totals).toEqual({ 'OPCO Test': '600.00', 'Entreprise A': '750.00', 'Particulier B': '900.00' });
    const gen = (await u.api.post(`/api/v1/sessions/${s.id}/billing`, { basis: 'hours' }).expect(201)).body;
    expect(gen.created).toHaveLength(3);
    expect((await u.api.get(`/api/v1/sessions/${s.id}/billing?basis=hours`)).body.state).toBe('drafts');
    expect((await u.api.post(`/api/v1/sessions/${s.id}/billing`, { basis: 'hours' })).status).toBe(409); // pas de double facturation
    // Brouillon supprimé → partie à refacturer ; seule celle-ci est recréée.
    const b = gen.created.find((x: any) => x.clientName === 'Particulier B');
    await u.api.del(`/api/v1/invoices/${b.id}`).expect(200);
    expect((await u.api.get(`/api/v1/sessions/${s.id}/billing?basis=hours`)).body.state).toBe('partial');
    const again = (await u.api.post(`/api/v1/sessions/${s.id}/billing`, { basis: 'hours' }).expect(201)).body;
    expect(again.created.map((x: any) => [x.clientName, x.totalHt])).toEqual([['Particulier B', '900.00']]);
    for (const inv of [...gen.created.filter((x: any) => x.id !== b.id), ...again.created]) await u.api.post(`/api/v1/invoices/${inv.id}/issue`).expect(201);
    const fin = (await u.api.get(`/api/v1/sessions/${s.id}/billing?basis=hours`)).body;
    expect(fin.state).toBe('billed');
    expect(fin.billed).toHaveLength(4);
    expect((await u.api.get('/api/v1/billing/to-bill')).body.map((x: any) => x.id)).not.toContain(s.id);
    expect((await u.api.get(`/api/v1/sessions/${s.id}`)).body.missing).not.toContain('Session terminée non facturée');
  });

  it('clôture forcée : motif obligatoire, tracée', async () => {
    const u = await signupAndLogin();
    const prog = (await u.api.post('/api/v1/programs', { title: 'Sans séance', durationMinutes: 60, modality: 'onsite' }).expect(201)).body;
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'inter', startsOn: '2026-09-02' }).expect(201)).body;
    for (const st of ['planned', 'confirmed', 'in_progress']) await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: st }).expect(201);
    expect((await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'completed', force: true })).status).toBe(400);
    await u.api.post(`/api/v1/sessions/${s.id}/status`, { status: 'completed', force: true, reason: 'Session réalisée hors plateforme' }).expect(201);
  });
});
