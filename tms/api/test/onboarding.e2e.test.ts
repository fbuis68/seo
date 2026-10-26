import { Db } from '../src/core/db';
import { JobsService } from '../src/core/jobs.service';
import { SystemMailer } from '../src/core/system-mail';
import { ADDR, closeApp, getApp, http, signupAndLogin } from './helpers';

let app: any;
beforeAll(async () => { app = await getApp(); });
afterAll(closeApp);

async function setupCompany(u: any) {
  await u.api.patch('/api/v1/organization', { siret: '73282932000074', address: { line1: '1 rue de la Paix', postal_code: '75002', city: 'Paris' } }).expect(200);
}

describe('Mise en service (onboarding)', () => {
  it('REC 01 : compte neuf → assistant persistant → profil validé → brouillon → émission ; jalons horodatés', async () => {
    const u = await signupAndLogin({ legalName: 'OF Neuf', billingReady: false });
    let st = (await u.api.get('/api/v1/onboarding').expect(200)).body;
    expect(st.status).toBe('new');
    expect(st.steps.map((s: any) => s.key)).toEqual(['company', 'data', 'training', 'billing', 'check', 'first_invoice', 'finish']);
    expect(st.current).toBe('company');
    expect(st.readiness.state).toBe('not_ready'); // aucun client

    // Sauvegarde automatique, contrôle de version (autre appareil).
    st = (await u.api.patch('/api/v1/onboarding', { version: st.session.version, path: 'start', answers: { activity: 'Formation langues', country: 'FR', currency: 'EUR', goal: 'facturer ce mois-ci' } }).expect(200)).body;
    expect((await u.api.patch('/api/v1/onboarding', { version: st.session.version - 1, answers: { volume: '50' } })).status).toBe(409);
    await setupCompany(u);
    // Reprise après déconnexion : nouvelle connexion, même état.
    const again = await http().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(201);
    st = (await http().get('/api/v1/onboarding').set({ Authorization: `Bearer ${again.body.token}`, 'X-Tenant-Id': u.tenantId }).expect(200)).body;
    expect(st.session.answers.activity).toBe('Formation langues');
    expect(st.steps[0].state).toBe('done');

    const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client Un', billingAddress: ADDR, billingEmail: 'compta@un.test' }).expect(201)).body;
    await u.api.post('/api/v1/programs', { title: 'Anglais', durationMinutes: 600, modality: 'onsite', priceHt: '800.00', vatRate: '20' }).expect(201);
    st = (await u.api.get('/api/v1/onboarding')).body;
    expect(st.steps[1].state).toBe('done');
    expect(st.readiness.state).toBe('ready_to_prepare');

    // Brouillon possible avant validation ; émission bloquée avec causes précises.
    const draft = (await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'Anglais', quantity: '1', unitPriceHt: '800', vatRate: '20' }] }).expect(201)).body;
    const blocked = await u.api.post(`/api/v1/invoices/${draft.id}/issue`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('not_ready_to_issue');
    expect(blocked.body.details.checks.map((c: any) => c.code)).toEqual(expect.arrayContaining(['billing_profile', 'billing_profile_confirmed', 'series_confirmed']));
    // Aperçu PDF sans numéro.
    const pdf = (await u.api.post('/api/v1/documents/generate', { template: 'invoice', invoiceId: draft.id }).expect(201)).body;
    expect(pdf.filename).toMatch(/brouillon/);

    // Profil : IBAN contrôlé, confirmation sur la dernière version.
    expect((await u.api.put('/api/v1/billing-profile', { vatRegime: 'subject', paymentTermsDays: 30, iban: 'FR7630006000011234567890188', showBankDetails: true })).status).toBe(400);
    st = (await u.api.put('/api/v1/billing-profile', { vatRegime: 'subject', paymentTermsDays: 30, iban: 'FR7630006000011234567890189', showBankDetails: true, latePenalty: '3 fois le taux légal' }).expect(200)).body;
    expect(st.billing.profile.confirmedAt).toBeNull();
    expect((await u.api.post('/api/v1/billing-profile/confirm', { version: st.billing.profile.version - 1 })).status).toBe(409);
    st = (await u.api.post('/api/v1/billing-profile/confirm', { version: st.billing.profile.version }).expect(201)).body;
    expect(st.billing.profile.confirmedAt).toBeTruthy();
    // Changement non critique : validation conservée ; critique : invalidée.
    st = (await u.api.put('/api/v1/billing-profile', { footer: 'Merci !' }).expect(200)).body;
    expect(st.billing.profile.confirmedAt).toBeTruthy();
    st = (await u.api.put('/api/v1/billing-profile', { paymentTermsDays: 45 }).expect(200)).body;
    expect(st.billing.profile.confirmedAt).toBeNull();
    await u.api.post('/api/v1/billing-profile/confirm', { version: st.billing.profile.version }).expect(201);

    // Numérotation : bascule depuis l'ancien outil.
    const Y = new Date().getFullYear();
    expect((await u.api.put('/api/v1/invoice-series', { prefix: 'FAC-', nextNumber: 120, legacyLastNumber: `FAC-${Y}-00150` })).body.code).toBe('series_overlap');
    st = (await u.api.put('/api/v1/invoice-series', { prefix: 'FAC-', nextNumber: 151, legacyLastNumber: `FAC-${Y}-00150` }).expect(200)).body;
    expect(st.billing.series.confirmed_at).toBeNull();
    st = (await u.api.post('/api/v1/invoice-series/confirm', {}).expect(201)).body;
    expect(st.readiness.canIssue).toBe(true);

    const issued = (await u.api.post(`/api/v1/invoices/${draft.id}/issue`).expect(201)).body;
    expect(issued.number).toBe(`FAC-${Y}-00151`);
    expect((await u.api.post(`/api/v1/invoices/${draft.id}/issue`).expect(201)).body.number).toBe(issued.number); // rejeu = même facture
    st = (await u.api.get('/api/v1/onboarding')).body;
    expect(st.milestones.first_draft_at).toBeTruthy();
    expect(st.milestones.first_issue_at).toBeTruthy();
    expect(st.status).toBe('ready');
    expect(st.steps.find((s: any) => s.key === 'first_invoice').state).toBe('done');
    // Préfixe figé une fois des factures émises.
    expect((await u.api.put('/api/v1/invoice-series', { prefix: 'F-', nextNumber: 500 })).body.code).toBe('series_in_use');
  });

  it('REC 03 : TVA incohérente avec le régime, double facturation et droits bloquent l’émission côté API', async () => {
    const u = await signupAndLogin({ legalName: 'OF Exonéré', billingReady: false });
    await setupCompany(u);
    let st = (await u.api.put('/api/v1/billing-profile', { vatRegime: 'exempt_261_4_4', paymentTermsDays: 30 }).expect(200)).body;
    await u.api.post('/api/v1/billing-profile/confirm', { version: st.billing.profile.version }).expect(201);
    await u.api.post('/api/v1/invoice-series/confirm', {}).expect(201);
    const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client E', billingAddress: ADDR }).expect(201)).body;
    const bad = (await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'X', quantity: '1', unitPriceHt: '100', vatRate: '20' }] }).expect(201)).body;
    const r = await u.api.post(`/api/v1/invoices/${bad.id}/issue`);
    expect(r.body.details.checks.map((c: any) => c.code)).toEqual(['vat_consistency']);
    const diag = (await u.api.get(`/api/v1/billing-readiness?invoiceId=${bad.id}`).expect(200)).body;
    expect(diag.state).toBe('ready_to_prepare');
    // Double facturation d'une même session.
    const prog = (await u.api.post('/api/v1/programs', { title: 'Programme P', durationMinutes: 60, modality: 'onsite' }).expect(201)).body;
    const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'intra', clientId: client.id, startsOn: `${new Date().getFullYear() + 1}-02-02` }).expect(201)).body;
    const mk = async () => (await u.api.post('/api/v1/invoices', { clientId: client.id, sessionId: s.id, lines: [{ label: 'Session', quantity: '1', unitPriceHt: '500', vatRate: '0' }] }).expect(201)).body;
    const a = await mk(), b = await mk();
    await u.api.post(`/api/v1/invoices/${a.id}/issue`).expect(201);
    const dup = await u.api.post(`/api/v1/invoices/${b.id}/issue`);
    expect(dup.status).toBe(409);
    expect(dup.body.details.checks[0].code).toBe('duplicate');
  });

  it('ONB 04 : relance après 24 h d’inactivité, une seule fois, arrêtée à la clôture', async () => {
    const u = await signupAndLogin({ legalName: 'OF Inactif', billingReady: false });
    const mailer: SystemMailer = app.get(SystemMailer);
    const db: Db = app.get(Db);
    await db.tenantTx(u.tenantId, (tx) => tx.query(`UPDATE onboarding_sessions SET last_activity_at = now() - interval '25 hours'`));
    await db.query(`UPDATE jobs SET run_at = now() WHERE type='onboarding.remind' AND tenant_id=$1 AND payload->>'level'='24'`, [u.tenantId]);
    await app.get(JobsService).runOnce(10, ['onboarding.remind']);
    const sent = mailer.devOutbox.filter((m) => m.to === u.email && /mise en service/.test(m.subject));
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/Prochaine étape/);
    await app.get(JobsService).runOnce(10, ['onboarding.remind']);
    expect(mailer.devOutbox.filter((m) => m.to === u.email && /mise en service/.test(m.subject)).length).toBe(1);
    // Clôture : plus de relance.
    await u.api.post('/api/v1/onboarding/close', {}).expect(201);
    await db.tenantTx(u.tenantId, (tx) => tx.query(`UPDATE onboarding_sessions SET last_activity_at = now() - interval '80 hours'`));
    await db.query(`UPDATE jobs SET run_at = now() WHERE type='onboarding.remind' AND tenant_id=$1`, [u.tenantId]);
    await app.get(JobsService).runOnce(10, ['onboarding.remind']);
    expect(mailer.devOutbox.filter((m) => m.to === u.email && /mise en service/.test(m.subject)).length).toBe(1);
  });

  it('Données : modèle Excel clients + apprenants → dépôt → colonnes reconnues → simulation → publication', async () => {
    const u = await signupAndLogin({ legalName: 'OF Excel' });
    const tpl = await http().get('/api/v1/imports/templates/clients-apprenants.xlsx').set(u.auth).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(tpl.headers['content-type']).toMatch(/spreadsheetml/);
    const b = (await u.api.post('/api/v1/imports', { sourceSoftware: 'generic', sourceInstanceId: 'fichier-excel' }).expect(201)).body;
    const up = await http().put(`/api/v1/imports/${b.id}/package`).set(u.auth).set('Content-Type', 'application/octet-stream').set('X-Filename', 'mes-clients.xlsx').send(tpl.body);
    expect(up.body.status).toBe('uploaded');
    const det = (await u.api.post(`/api/v1/imports/${b.id}/detect`).expect(201)).body;
    const gen = det.candidates.find((c: any) => c.profile === 'generic');
    expect(gen.confidence).toBe(1);
    expect(gen.files.map((f: any) => [f.path, f.entity])).toEqual([['mes-clients.xlsx#Clients', 'client'], ['mes-clients.xlsx#Apprenants', 'person']]);
    const person = gen.files.find((f: any) => f.entity === 'person').columns;
    expect(person).toMatchObject({ first_name: 'Prénom', last_name: 'Nom', client_ref: 'Code client', mobile: 'Portable', birth_date: 'Date de naissance', civility: 'Civilité' });
    expect(det.tables[0].samples.length).toBeGreaterThan(0);
    await u.api.post(`/api/v1/imports/${b.id}/mapping`, { profile: 'generic', files: gen.files }).expect(201);
    const sim = (await u.api.post(`/api/v1/imports/${b.id}/simulate`, {}).expect(201)).body;
    expect(sim.summary.client.create).toBe(3);
    expect(sim.summary.person.create).toBe(3);
    expect(sim.canCommit).toBe(true);
    await u.api.post(`/api/v1/imports/${b.id}/commit`).expect(201);
    const db: Db = app.get(Db);
    const rows = await db.tenantTx(u.tenantId, async (tx): Promise<any[]> => (await tx.query(`SELECT p.first_name, p.civility, p.birth_date, c.name employer FROM persons p LEFT JOIN clients c ON c.id=p.employer_client_id ORDER BY p.last_name`)).rows);
    expect(rows).toEqual([
      { first_name: 'Lina', civility: 'Mme', birth_date: '1992-09-03', employer: null },
      { first_name: 'Jean', civility: 'M.', birth_date: '1988-02-14', employer: 'ACME Industrie' },
      { first_name: 'Sophie', civility: 'Mme', birth_date: null, employer: 'Martin Sophie' },
    ]);
    const st = (await u.api.get('/api/v1/onboarding')).body;
    expect(st.counts.clients).toBe(3);
    expect(st.remainingMinutes).toBeUndefined();
  });
});
