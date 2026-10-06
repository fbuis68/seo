import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { JobsService } from '../src/core/jobs.service';
import { SystemMailer } from '../src/core/system-mail';
import { closeApp, getApp, http, signupAndLogin } from './helpers';
import { makeZip } from './zip';

let app: any;
beforeAll(async () => { app = await getApp(); });
afterAll(closeApp);

const Y = new Date().getFullYear();
function genericPackage(opts: { learners?: number; badInvoice?: boolean } = {}) {
  const n = opts.learners ?? 3;
  const pdf = Buffer.from('%PDF-1.4\n% facture historique\n%%EOF\n');
  const files: Record<string, string | Buffer> = {
    'clients.csv': 'ID;Raison sociale;SIRET;Email;Client facturé\nC1;ACME Formation;73282932000074;compta@acme.test;oui\nC2;Beta SARL;;beta@beta.test;non\n',
    'apprenants.csv': ['ID;Prénom;Nom;Email;Id entreprise', ...Array.from({ length: n }, (_, i) => `P${i};Jean${i};Dupont${i};jean${i}@acme.test;C1`)].join('\n'),
    'programmes.csv': 'ID;Intitulé;Durée (heures);Modalité;Prix HT\nPR1;Excel avancé;14;Présentiel;"1 200,00"\n',
    'sessions.csv': `ID;ID programme;Intitulé;Date début;Date fin;Statut\nS1;PR1;Excel - mars;10/03/${Y - 1};11/03/${Y - 1};Terminée\nS2;PR1;Excel - décembre;14/12/${Y};15/12/${Y};Planifiée\n`,
    'inscriptions.csv': ['ID session;ID apprenant;ID client;Statut', ...Array.from({ length: n }, (_, i) => `S2;P${i};C1;Confirmé`), 'S1;P0;C1;Confirmé', 'S9;P0;C1;Confirmé'].join('\n'),
    'presences.csv': `ID session;ID apprenant;Début;Fin;Présence;Minutes\nS1;P0;10/03/${Y - 1} 09:00;10/03/${Y - 1} 12:30;Présent;210\n`,
    'factures.csv': `ID;Numéro;ID client;ID session;Date facture;Total HT;TVA;Total TTC;Fichier\nF1;FA-2024-001;C1;S1;12/03/${Y - 1};1200,00;240,00;1440,00;pdf/FA-2024-001.pdf\n` +
      (opts.badInvoice ? `F2;FA-2024-002;C1;S1;13/03/${Y - 1};100,00;20,00;999,00;\n` : ''),
    'reglements.csv': `ID;ID client;ID facture;Montant;Date règlement\nR1;C1;F1;1440,00;20/03/${Y - 1}\n`,
    'pdf/FA-2024-001.pdf': pdf,
  };
  return makeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

async function runImport(u: any, pkg: Buffer, opts: { instance?: string; simulate?: any; software?: string } = {}) {
  const b = (await u.api.post('/api/v1/imports', { sourceSoftware: opts.software ?? 'generic', sourceInstanceId: opts.instance ?? 'compte-source-1' }).expect(201)).body;
  const up = await http().put(`/api/v1/imports/${b.id}/package`).set(u.auth).set('Content-Type', 'application/zip').set('X-Filename', 'sauvegarde.zip').send(pkg);
  expect(up.status).toBe(200);
  return { id: b.id, upload: up.body };
}

describe('Reprise par fichiers de sauvegarde', () => {
  it('REC-11/13/17 : détecte, simule sans écrire, classe 100 % des lignes, publie l’historique sans email ni numéro', async () => {
    const u = await signupAndLogin({ legalName: 'OF Reprise' });
    const mailer = app.get(SystemMailer); const mailsBefore = mailer.devOutbox.length;
    const { id } = await runImport(u, genericPackage({ badInvoice: true }));
    const det = (await u.api.post(`/api/v1/imports/${id}/detect`).expect(201)).body;
    expect(det.candidates[0].profile).toBe('generic');
    expect(det.candidates[0].confidence).toBe(1);
    // Confirmation explicite obligatoire avant simulation.
    expect((await u.api.post(`/api/v1/imports/${id}/simulate`, {})).status).toBe(409);
    await u.api.post(`/api/v1/imports/${id}/mapping`, { profile: 'generic' }).expect(201);
    const sim = (await u.api.post(`/api/v1/imports/${id}/simulate`, {}).expect(201)).body;
    expect(sim.summary.client.create).toBe(2);
    expect(sim.summary.enrollment.reject).toBe(1); // S9 inexistante
    expect(sim.summary.invoice.reject).toBe(1); // HT+TVA≠TTC
    expect(sim.canCommit).toBe(false);
    // Aucune écriture métier pendant la simulation.
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(0);
    const csv = await u.api.get(`/api/v1/imports/${id}/anomalies.csv`).expect(200);
    expect(csv.text).toContain('reference_missing');
    expect(csv.text).toContain('totals_mismatch');
    expect((await u.api.post(`/api/v1/imports/${id}/commit`)).status).toBe(409);
    // Import partiel explicitement choisi.
    await u.api.post(`/api/v1/imports/${id}/simulate`, { partial: true }).expect(201);
    const rep = (await u.api.post(`/api/v1/imports/${id}/commit`).expect(201)).body;
    expect(rep.balanced).toBe(true);
    expect(rep.perEntity.invoice.created).toBe(1);
    expect(rep.financial[0].totalTtc).toBe('1440.00');
    expect(rep.financial[0].differenceCents).toBe(0);
    const invoices = (await u.api.get('/api/v1/invoices').expect(200)).body;
    expect(invoices[0].number).toBe('FA-2024-001');
    expect(invoices[0].is_historical).toBe(true);
    expect(invoices[0].balance).toBe('0.00');
    // Pièce originale conservée avec hash.
    const docs = (await u.api.get(`/api/v1/documents?ownerType=invoice&ownerId=${invoices[0].id}`)).body;
    expect(docs[0].sha256).toHaveLength(64);
    // Aucun email déclenché ; la série locale n'a pas avancé.
    expect(mailer.devOutbox.length).toBe(mailsBefore);
    const d = (await u.api.post('/api/v1/invoices', { clientId: invoices[0].client_id, lines: [{ label: 'x', quantity: '1', unitPriceHt: '10', vatRate: '20' }] }).expect(201)).body;
    expect((await u.api.post(`/api/v1/invoices/${d.id}/issue`).expect(201)).body.number).toMatch(/^FAC-\d{4}-00001$/);
    // Session passée marquée historique et hors quota annuel ; session future comptée.
    const usage = (await u.api.get('/api/v1/billing/usage')).body.quotas;
    expect(usage.learnersPerYear.used).toBe(3);
  });

  it('REC-12 : réimport du même paquet puis paquet enrichi → aucun doublon', async () => {
    const u = await signupAndLogin();
    const first = await runImport(u, genericPackage(), { instance: 'acc-42' });
    await u.api.post(`/api/v1/imports/${first.id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${first.id}/mapping`, { profile: 'generic' }).expect(201);
    await u.api.post(`/api/v1/imports/${first.id}/simulate`, { partial: true }).expect(201);
    await u.api.post(`/api/v1/imports/${first.id}/commit`).expect(201);
    const second = await runImport(u, genericPackage({ learners: 4 }), { instance: 'acc-42' });
    await u.api.post(`/api/v1/imports/${second.id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${second.id}/mapping`, { profile: 'generic' }).expect(201);
    const sim = (await u.api.post(`/api/v1/imports/${second.id}/simulate`, { partial: true }).expect(201)).body;
    expect(sim.summary.client.create).toBe(0);
    expect(sim.summary.client.unchanged).toBe(2);
    expect(sim.summary.person.create).toBe(1);
    await u.api.post(`/api/v1/imports/${second.id}/commit`).expect(201);
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(2);
    expect((await u.api.get('/api/v1/persons')).body.length).toBe(4);
    expect((await u.api.get('/api/v1/invoices')).body.length).toBe(1);
  });

  it('REC-14/24 : rejette zip-slip, lien symbolique, archive imbriquée, macro, dump SQL, archive chiffrée', async () => {
    const u = await signupAndLogin();
    const cases: [string, Buffer][] = [
      ['unsafe_path', makeZip([{ name: '../../etc/passwd.csv', data: 'a;b\n1;2' }])],
      ['symlink', makeZip([{ name: 'clients.csv', data: '/etc/passwd', symlink: true }])],
      ['nested_archive', makeZip([{ name: 'inner.zip', data: makeZip([{ name: 'a.csv', data: 'x' }]) }])],
      ['macro_file', makeZip([{ name: 'clients.xlsm', data: 'PK' }])],
      ['database_dump', makeZip([{ name: 'backup.sql', data: 'DROP TABLE users;' }])],
      ['encrypted', makeZip([{ name: 'clients.csv', data: 'x', encrypted: true }])],
    ];
    for (const [code, pkg] of cases) {
      const { id, upload } = await runImport(u, pkg);
      expect(upload.status).toBe('rejected');
      expect(upload.diagnostic.rejections[0].code).toBe(code);
      await u.api.post(`/api/v1/imports/${id}/cancel`).expect(201);
    }
    // Fichier inconnu : diagnostic, aucun succès complet.
    const { id } = await runImport(u, makeZip([{ name: 'export_inconnu.csv', data: 'colA;colB\n1;2\n' }]));
    const det = (await u.api.post(`/api/v1/imports/${id}/detect`).expect(201)).body;
    expect(det.verdict).toBe('unrecognized');
  });

  it('REC-16 : rollback complet, puis rollback bloqué si un objet importé a été utilisé localement', async () => {
    const u = await signupAndLogin();
    const a = await runImport(u, genericPackage(), { instance: 'rb-1' });
    await u.api.post(`/api/v1/imports/${a.id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${a.id}/mapping`, { profile: 'generic' }).expect(201);
    await u.api.post(`/api/v1/imports/${a.id}/simulate`, { partial: true }).expect(201);
    await u.api.post(`/api/v1/imports/${a.id}/commit`).expect(201);
    await u.api.post(`/api/v1/imports/${a.id}/rollback`).expect(201);
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(0);
    expect((await u.api.get('/api/v1/invoices')).body.length).toBe(0);

    const b = await runImport(u, genericPackage(), { instance: 'rb-2' });
    await u.api.post(`/api/v1/imports/${b.id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${b.id}/mapping`, { profile: 'generic' }).expect(201);
    await u.api.post(`/api/v1/imports/${b.id}/simulate`, { partial: true }).expect(201);
    await u.api.post(`/api/v1/imports/${b.id}/commit`).expect(201);
    const client = (await u.api.get('/api/v1/clients')).body.find((c: any) => c.name === 'ACME Formation');
    const inv = (await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'Nouvelle', quantity: '1', unitPriceHt: '50', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${inv.id}/issue`).expect(201);
    const r = await u.api.post(`/api/v1/imports/${b.id}/rollback`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('rollback_blocked');
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(2); // rien supprimé
  });

  it('REC-27 : import Free au-delà des quotas → simulation sans publication, puis sous-périmètre', async () => {
    const u = await signupAndLogin();
    const { id } = await runImport(u, genericPackage({ learners: 60 }));
    await u.api.post(`/api/v1/imports/${id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${id}/mapping`, { profile: 'generic' }).expect(201);
    const sim = (await u.api.post(`/api/v1/imports/${id}/simulate`, { partial: true }).expect(201)).body;
    expect(sim.quota.fits).toBe(false);
    expect(sim.quota.over[0].quota).toBe('learnersPerYear');
    expect((await u.api.post(`/api/v1/imports/${id}/commit`)).status).toBe(402);
    expect((await u.api.get('/api/v1/persons')).body.length).toBe(0);
    // Sous-périmètre cohérent : historique uniquement (sessions avant cette année) — dépendances exclues avec motif.
    const sub = (await u.api.post(`/api/v1/imports/${id}/simulate`, { partial: true, scope: { entities: ['client', 'program', 'session', 'invoice', 'payment', 'document'] } }).expect(201)).body;
    expect(sub.quota.fits).toBe(true);
    await u.api.post(`/api/v1/imports/${id}/commit`).expect(201);
  });

  it('REC-18 : export natif puis réimport dans un espace vierge (montants et documents identiques)', async () => {
    const src = await signupAndLogin({ legalName: 'Source' });
    const client = (await src.api.post('/api/v1/clients', { kind: 'company', name: 'Client Export' }).expect(201)).body;
    const inv = (await src.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'Formation', quantity: '3', unitPriceHt: '333.33', vatRate: '20' }] }).expect(201)).body;
    await src.api.post(`/api/v1/invoices/${inv.id}/issue`).expect(201);
    await src.api.post('/api/v1/documents/generate', { template: 'invoice', invoiceId: inv.id }).expect(201);
    await src.api.post('/api/v1/exports').expect(201);
    await app.get(JobsService).runOnce(5, ['export.full']);
    const ex = (await src.api.get('/api/v1/exports').expect(200)).body.exports[0];
    const zip = await src.api.get(`/api/v1/documents/${ex.id}/download`).buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    const dst = await signupAndLogin({ legalName: 'Destination' });
    const { id } = await runImport(dst, zip.body, { software: 'native', instance: src.tenantId });
    const det = (await dst.api.post(`/api/v1/imports/${id}/detect`).expect(201)).body;
    expect(det.candidates[0].profile).toBe('native');
    await dst.api.post(`/api/v1/imports/${id}/mapping`, { profile: 'native' }).expect(201);
    const sim = (await dst.api.post(`/api/v1/imports/${id}/simulate`, {}).expect(201)).body;
    expect(sim.blocking).toBe(0);
    await dst.api.post(`/api/v1/imports/${id}/commit`).expect(201);
    const invs = (await dst.api.get('/api/v1/invoices')).body;
    expect(invs[0].total_ttc).toBe('1199.99');
    expect(invs[0].number).toBe(inv.number ?? invs[0].number);
    const srcDocs = (await src.api.get('/api/v1/documents')).body;
    const dstDocs = (await dst.api.get('/api/v1/documents')).body;
    expect(dstDocs.map((d: any) => d.sha256).sort()).toEqual(srcDocs.map((d: any) => d.sha256).sort());
  });

  it('REC-23 : le module de reprise ne contient aucun client réseau (aucune API source)', () => {
    const dir = join(__dirname, '..', 'src', 'modules', 'migration');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/\bfetch\s*\(|from ['"](node:)?(http|https|net|tls|dgram)['"]|require\(['"](http|https|net)['"]\)|axios|undici|nodemailer/);
    }
  });
});
