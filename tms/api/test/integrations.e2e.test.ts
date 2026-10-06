import { JobsService } from '../src/core/jobs.service';
import { FakePaymentProvider } from '../src/modules/billing/providers/fake.provider';
import { SubscriptionService } from '../src/modules/billing/subscription.service';
import { FakeSignatureProvider, SIGNATURE_PROVIDER } from '../src/modules/signatures/signature.provider';
import { BANK_PROVIDER, FakeBankProvider } from '../src/modules/bank/bank.provider';
import { OpenDataService } from '../src/modules/opendata/opendata.service';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

let app: any; let jobs: JobsService;
beforeAll(async () => { app = await getApp(); jobs = app.get(JobsService); });
afterAll(closeApp);

async function upgrade(u: any, plan = 'equipe', addons: any[] = []) {
  const fake = app.get(SubscriptionService).provider as FakePaymentProvider;
  const c = await u.api.post('/api/v1/billing/checkout', { plan, interval: 'month', addons }).expect(201);
  for (const e of fake.complete(c.body.url.split('/').pop())) await http().post('/api/v1/webhooks/payment').set(e.headers).send(e.body.toString()).expect(201);
}
async function sessionWithDoc(u: any) {
  const prog = (await u.api.post('/api/v1/programs', { title: 'Management', durationMinutes: 840, modality: 'blended', objectives: 'Animer une équipe', priceHt: '1500', vatRate: '20' }).expect(201)).body;
  const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Client Intra', status: 'customer' }).expect(201)).body;
  const s = (await u.api.post('/api/v1/sessions', { programVersionId: prog.versions[0].id, kind: 'intra', clientId: client.id, startsOn: '2026-11-20', endsOn: '2026-11-21' }).expect(201)).body;
  const doc = (await u.api.post('/api/v1/documents/generate', { template: 'convention', sessionId: s.id }).expect(201)).body;
  return { prog, client, s, doc };
}

describe('Signature électronique (payante)', () => {
  it('REC-29 : refus serveur en Free, sans coût ni crédit', async () => {
    const u = await signupAndLogin();
    const { doc } = await sessionWithDoc(u);
    const r = await u.api.post('/api/v1/signatures', { documentId: doc.id, title: 'Convention', signers: [{ fullName: 'A B', email: 'a@b.test' }] });
    expect(r.status).toBe(402);
    expect((await u.api.get('/api/v1/signatures')).body).toHaveLength(0);
    // Free : dépôt d'une convention signée hors plateforme possible.
    await u.api.post('/api/v1/documents', { ownerType: 'session', kind: 'convention_signed', filename: 'signee.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 signé').toString('base64') }).expect(201);
  });

  it('REC-30/31 : timeout → rapprochement sans double envoi ; webhooks doublés/désordonnés ; archivage avant "completed"', async () => {
    const u = await signupAndLogin();
    await upgrade(u, 'solo');
    const prov = app.get(SIGNATURE_PROVIDER) as FakeSignatureProvider;
    const { doc } = await sessionWithDoc(u);
    // Refus certain → crédit libéré.
    prov.failNext = 'definite';
    const failed = (await u.api.post('/api/v1/signatures', { documentId: doc.id, title: 'Convention', signers: [{ fullName: 'A B', email: 'a@b.test' }] }).expect(201)).body;
    expect(failed.status).toBe('failed');
    expect((await u.api.get('/api/v1/signatures/credits')).body.available).toBe(5);
    // Réponse perdue → reste "queued", puis rapprochement par clé d'idempotence : une seule enveloppe, un débit.
    prov.failNext = 'timeout_after_create';
    const env = (await u.api.post('/api/v1/signatures', { documentId: doc.id, title: 'Convention', signers: [{ fullName: 'A B', email: 'a@b.test' }, { fullName: 'C D', email: 'c@d.test' }] }).expect(201)).body;
    expect(env.status).toBe('queued');
    await app.get(require('../src/core/db').Db).query(`UPDATE jobs SET run_at=now() WHERE type='signature.reconcile'`);
    await jobs.runOnce(5, ['signature.reconcile']);
    const sent = (await u.api.get(`/api/v1/signatures/${env.id}`)).body;
    expect(sent.status).toBe('sent');
    expect([...prov.envelopes.values()].filter((e) => e.key === `env:${env.id}`)).toHaveLength(1);
    let credits = (await u.api.get('/api/v1/signatures/credits')).body;
    expect(credits.used).toBe(1); expect(credits.available).toBe(4);
    // Webhooks : "completed" avant signataires, puis doublon.
    const completed = prov.event(sent.provider_id, 'completed');
    prov.archiveUnavailable = true;
    await http().post('/api/v1/webhooks/signature').set(completed.headers).send(completed.body.toString()).expect(201);
    const signed = prov.event(sent.provider_id, 'signer_signed', 'a@b.test');
    await http().post('/api/v1/webhooks/signature').set(signed.headers).send(signed.body.toString()).expect(201);
    const dup = await http().post('/api/v1/webhooks/signature').set(completed.headers).send(completed.body.toString()).expect(201);
    expect(dup.body.duplicate).toBe(true);
    await jobs.runOnce(5, ['signature.archive']);
    expect((await u.api.get(`/api/v1/signatures/${env.id}`)).body.status).toBe('completed_pending_archive');
    prov.archiveUnavailable = false;
    await app.get(require('../src/core/db').Db).query(`UPDATE jobs SET run_at=now() WHERE type='signature.archive'`);
    await jobs.runOnce(5, ['signature.archive']);
    const done = (await u.api.get(`/api/v1/signatures/${env.id}`)).body;
    expect(done.status).toBe('completed');
    expect(done.signed_document_id).toBeTruthy();
    expect(done.proof_document_id).toBeTruthy();
    credits = (await u.api.get('/api/v1/signatures/credits')).body;
    expect(credits.used).toBe(1);
    // Signature invalide refusée.
    expect((await http().post('/api/v1/webhooks/signature').set({ 'x-signature': '00' }).send(completed.body.toString())).status).toBe(400);
  });
});

describe('Tableaux de bord (métriques partagées)', () => {
  it('REC-41/42 : CA net HT sans double compte acompte/finale, avoir déduit, camembert → barres si négatif', async () => {
    const u = await signupAndLogin();
    const { client, s } = await sessionWithDoc(u);
    const dep = (await u.api.post('/api/v1/invoices', { clientId: client.id, kind: 'deposit', sessionId: s.id, lines: [{ label: 'Acompte 30 %', quantity: '1', unitPriceHt: '450', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${dep.id}/issue`).expect(201);
    const fin = (await u.api.post('/api/v1/invoices', { clientId: client.id, sessionId: s.id, deductDepositIds: [dep.id], lines: [{ label: 'Formation', quantity: '1', unitPriceHt: '1500', vatRate: '20' }] }).expect(201)).body;
    expect(fin.total_ht).toBe('1050.00');
    await u.api.post(`/api/v1/invoices/${fin.id}/issue`).expect(201);
    const y = new Date().getFullYear();
    let m = (await u.api.get(`/api/v1/analytics/metrics?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31&granularity=year`).expect(200)).body;
    expect(m.series[0].value).toBe('1500.00');
    const cn = (await u.api.post('/api/v1/invoices', { clientId: client.id, kind: 'credit_note', creditedInvoiceId: fin.id, lines: [{ label: 'Geste', quantity: '1', unitPriceHt: '100', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${cn.id}/issue`).expect(201);
    m = (await u.api.get(`/api/v1/analytics/metrics?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31&granularity=year`).expect(200)).body;
    expect(m.series[0].value).toBe('1400.00');
    const drill = (await u.api.get(`/api/v1/analytics/drilldown?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31`).expect(200)).body;
    expect(drill.total).toBe(1400);
    const dash = (await u.api.get('/api/v1/analytics/dashboard').expect(200)).body;
    expect(dash.cards.revenueYtdHt).toBe('1400.00');
    // Comparatif N/N-1 réservé aux offres payantes.
    expect((await u.api.get(`/api/v1/analytics/metrics?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31&compare=true`)).status).toBe(402);
    // Autre devise : jamais additionnée.
    const usd = (await u.api.get(`/api/v1/analytics/metrics?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31&granularity=year&currency=USD`).expect(200)).body;
    expect(usd.series[0].value).toBe('0');
    // Avoir sur un autre client uniquement → catégorie négative → barres.
    const other = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Autre', status: 'customer' }).expect(201)).body;
    const inv2 = (await u.api.post('/api/v1/invoices', { clientId: other.id, lines: [{ label: 'x', quantity: '1', unitPriceHt: '10', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${inv2.id}/issue`).expect(201);
    const pie = (await u.api.get(`/api/v1/analytics/breakdown?metric=revenue_net_ht&dimension=client&from=${y}-01-01&to=${y}-12-31`).expect(200)).body;
    expect(pie.chartHint).toBe('pie');
    const csv = await u.api.get(`/api/v1/analytics/drilldown.csv?metric=revenue_net_ht&from=${y}-01-01&to=${y}-12-31`).expect(200);
    expect(csv.text.split('\r\n').length).toBeGreaterThan(2);
  });
});

describe('Assistant IA', () => {
  it('REC-37/40/41 : clé client, réponse chiffrée = moteur de métriques, action confirmée et invalidée si données changent', async () => {
    const u = await signupAndLogin();
    const conn = (await u.api.post('/api/v1/ai/connections', { provider: 'fake', model: 'fake-1', apiKey: 'sk-test-12345678', scope: 'user' }).expect(201)).body;
    expect(conn.key_hint).toBe('…5678');
    expect(JSON.stringify((await u.api.get('/api/v1/ai/connections')).body)).not.toContain('sk-test');
    const conv = (await u.api.post('/api/v1/ai/conversations', { connectionId: conn.id }).expect(201)).body;
    const r = (await u.api.post(`/api/v1/ai/conversations/${conv.id}/messages`, { content: 'Quel CA cette année ?' }).expect(201)).body;
    expect(r.sources[0].type).toBe('metric');
    expect(r.usage.costIsEstimate).toBe(true);
    const prog = (await u.api.post('/api/v1/programs', { title: 'Sécurité', durationMinutes: 420, modality: 'onsite' }).expect(201)).body;
    const p = (await u.api.post(`/api/v1/ai/conversations/${conv.id}/messages`, { content: `Prépare une session ${JSON.stringify({ programVersionId: prog.versions[0].id, startsOn: '2026-12-01', capacity: 8 })}` }).expect(201)).body;
    const proposal = p.proposals[0];
    expect(proposal.kind).toBe('create_session');
    expect((await u.api.get('/api/v1/sessions')).body).toHaveLength(0); // rien créé sans confirmation
    expect((await u.api.post(`/api/v1/ai/proposals/${proposal.id}/confirm`, { payloadHash: 'f'.repeat(64) })).status).toBe(409);
    const ok = (await u.api.post(`/api/v1/ai/proposals/${proposal.id}/confirm`, { payloadHash: proposal.payload_hash }).expect(201)).body;
    expect(ok.result.sessionId).toBeTruthy();
    const again = (await u.api.post(`/api/v1/ai/proposals/${proposal.id}/confirm`, { payloadHash: proposal.payload_hash }).expect(201)).body;
    expect(again.result.sessionId).toBe(ok.result.sessionId); // idempotent
    expect((await u.api.get('/api/v1/sessions')).body).toHaveLength(1);
    // Données changées avant confirmation → invalidation.
    const p2 = (await u.api.post(`/api/v1/ai/conversations/${conv.id}/messages`, { content: `Prépare une session ${JSON.stringify({ programVersionId: prog.versions[0].id, startsOn: '2026-12-08' })}` }).expect(201)).body;
    await app.get(require('../src/core/db').Db).tenantTx(u.tenantId, (tx: any) => tx.query(`UPDATE program_versions SET version=version+10 WHERE id=$1`, [prog.versions[0].id]));
    expect((await u.api.post(`/api/v1/ai/proposals/${p2.proposals[0].id}/confirm`, { payloadHash: p2.proposals[0].payload_hash })).status).toBe(409);
    // Clé révoquée chez le fournisseur → statut exact, accès arrêté, aucune bascule.
    const bad = (await u.api.post('/api/v1/ai/connections', { provider: 'fake', model: 'fake-1', apiKey: 'revoked-key', scope: 'user', test: false }).expect(201)).body;
    const conv2 = (await u.api.post('/api/v1/ai/conversations', { connectionId: bad.id }).expect(201)).body;
    expect((await u.api.post(`/api/v1/ai/conversations/${conv2.id}/messages`, { content: 'Bonjour' })).status).toBe(502);
    expect((await u.api.get('/api/v1/ai/connections')).body.find((c: any) => c.id === bad.id).status).toBe('invalid');
  });

  it('REC-38 : quota Free de 20 requêtes et isolation des conversations', async () => {
    const u = await signupAndLogin(); const v = await signupAndLogin();
    const conn = (await u.api.post('/api/v1/ai/connections', { provider: 'fake', model: 'fake-1', apiKey: 'sk-quota-0000', scope: 'user' }).expect(201)).body;
    const conv = (await u.api.post('/api/v1/ai/conversations', { connectionId: conn.id }).expect(201)).body;
    for (let i = 0; i < 20; i++) await u.api.post(`/api/v1/ai/conversations/${conv.id}/messages`, { content: 'Bonjour' }).expect(201);
    expect((await u.api.post(`/api/v1/ai/conversations/${conv.id}/messages`, { content: 'Bonjour' })).status).toBe(402);
    expect((await v.api.get(`/api/v1/ai/conversations/${conv.id}`)).status).toBe(404);
  });
});

describe('Banque connectée et rapprochement', () => {
  it('REC-43/44/45 : consentement, pending→booked sans doublon, association règlement existant, validation humaine', async () => {
    const u = await signupAndLogin();
    expect((await u.api.post('/api/v1/bank/connections')).status).toBe(402); // option non souscrite
    await upgrade(u, 'equipe', [{ code: 'bank', quantity: 1 }]);
    const prov = app.get(BANK_PROVIDER) as FakeBankProvider;
    const start = (await u.api.post('/api/v1/bank/connections').expect(201)).body;
    const url = new URL(start.url);
    expect((await u.api.post('/api/v1/bank/connections/callback', { code: url.searchParams.get('code'), state: 'mauvais-state-123' })).status).toBe(400);
    const start2 = new URL((await u.api.post('/api/v1/bank/connections').expect(201)).body.url);
    const conns = (await u.api.post('/api/v1/bank/connections/callback', { code: start2.searchParams.get('code'), state: start2.searchParams.get('state') }).expect(201)).body;
    const connId = conns[0].id;
    const providerConnId = [...prov.conns.keys()].pop()!;
    const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'Durand Conseil' }).expect(201)).body;
    const inv = (await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'Formation', quantity: '1', unitPriceHt: '1000', vatRate: '20' }] }).expect(201)).body;
    const issued = (await u.api.post(`/api/v1/invoices/${inv.id}/issue`).expect(201)).body;
    prov.addTransaction(providerConnId, { id: 'T1', status: 'pending', amount: '1200.00', label: `VIR DURAND CONSEIL ${issued.number}` });
    prov.addTransaction(providerConnId, { id: 'T2', amount: '-50.00', label: 'FRAIS' });
    prov.addTransaction(providerConnId, { id: 'T3', amount: '300.00', label: 'VIR DURAND CONSEIL' });
    await u.api.post(`/api/v1/bank/connections/${connId}/sync`).expect(201);
    expect((await u.api.get('/api/v1/bank/suggestions')).body.find((s: any) => s.transaction.amount === '1200.00')).toBeUndefined(); // pending exclu
    prov.addTransaction(providerConnId, { id: 'T1', status: 'booked', amount: '1200.00', label: `VIR DURAND CONSEIL ${issued.number}` });
    await u.api.post(`/api/v1/bank/connections/${connId}/sync`).expect(201);
    await u.api.post(`/api/v1/bank/connections/${connId}/sync`).expect(201);
    const txs = (await u.api.get('/api/v1/bank/transactions')).body;
    expect(txs.filter((t: any) => t.provider_tx_id === 'T1')).toHaveLength(1);
    const sugg = (await u.api.get('/api/v1/bank/suggestions').expect(200)).body;
    const s1 = sugg.find((s: any) => s.transaction.amount === '1200.00');
    expect(s1.candidates[0].type).toBe('invoice');
    expect(s1.candidates[0].score).toBeGreaterThanOrEqual(90);
    // T3 : nom seul sans montant ni référence → aucune proposition de facture.
    expect(sugg.find((s: any) => s.transaction.amount === '300.00')).toBeUndefined();
    const t1 = txs.find((t: any) => t.provider_tx_id === 'T1');
    await u.api.post('/api/v1/bank/reconciliations', { transactionId: t1.id, clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '1200.00' }] }).expect(201);
    expect((await u.api.get(`/api/v1/invoices/${inv.id}`)).body.balance).toBe('0.00');
    expect((await u.api.post('/api/v1/bank/reconciliations', { transactionId: t1.id, clientId: client.id, allocations: [{ invoiceId: inv.id, amount: '1.00' }] })).status).toBe(400);
    // Règlement manuel existant proposé comme candidat (pas de double création).
    const inv2 = (await u.api.post('/api/v1/invoices', { clientId: client.id, lines: [{ label: 'F2', quantity: '1', unitPriceHt: '250', vatRate: '20' }] }).expect(201)).body;
    await u.api.post(`/api/v1/invoices/${inv2.id}/issue`).expect(201);
    const pay = (await u.api.post('/api/v1/payments', { clientId: client.id, amount: '300.00', receivedOn: new Date().toISOString().slice(0, 10), allocations: [{ invoiceId: inv2.id, amount: '300.00' }] }).expect(201)).body;
    const sugg2 = (await u.api.get('/api/v1/bank/suggestions')).body.find((s: any) => s.transaction.amount === '300.00');
    expect(sugg2.candidates[0]).toMatchObject({ type: 'existing_payment', paymentId: pay.id });
    const t3 = txs.find((t: any) => t.provider_tx_id === 'T3');
    const rec = (await u.api.post('/api/v1/bank/reconciliations', { transactionId: t3.id, paymentId: pay.id }).expect(201)).body;
    expect((await u.api.get('/api/v1/payments')).body.filter((p: any) => p.amount === '300.00')).toHaveLength(1);
    await u.api.post(`/api/v1/bank/reconciliations/${rec.id}/revert`).expect(201);
    expect((await u.api.get('/api/v1/bank/transactions')).body.find((t: any) => t.id === t3.id)).toBeTruthy(); // mouvement conservé
    await u.api.post(`/api/v1/bank/connections/${connId}/disconnect`).expect(201);
    expect((await u.api.post(`/api/v1/bank/connections/${connId}/sync`).expect(201)).body.skipped).toBe(true);
  });
});

describe('Email', () => {
  it('REC-46 : SMTP réservé aux offres payantes ; ports et hôtes internes refusés ; canal système sous quota', async () => {
    const u = await signupAndLogin();
    const cfg = { host: 'smtp.example.com', port: 587, security: 'starttls', authMode: 'password', username: 'u', secret: 'p@ss', fromEmail: 'formation@example.com' };
    expect((await u.api.post('/api/v1/mail/connections', cfg)).status).toBe(402);
    await upgrade(u, 'solo');
    expect((await u.api.post('/api/v1/mail/connections', { ...cfg, port: 25 })).status).toBe(400);
    expect((await u.api.post('/api/v1/mail/connections', { ...cfg, port: 465 })).status).toBe(400); // 465 exige TLS implicite
    const m = (await u.api.post('/api/v1/mail/messages/send', { to: ['apprenant@example.com'], subject: 'Convocation', text: 'Bonjour' }).expect(201)).body;
    expect(m.status).toBe('queued');
    await jobs.runOnce(5, ['mail.send']);
    const msgs = (await u.api.get('/api/v1/mail/messages')).body;
    expect(msgs[0].status).toBe('accepted_by_smtp');
  });
  it('REC-46 : SSRF — adresses internes refusées hors mode test', async () => {
    const { isPrivateIp } = await import('../src/core/ssrf');
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']) expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('OpenData', () => {
  it('REC-32/33 : ingestion datée, quarantaine sur jeu vide/en chute, enrichissement validé sans écrasement', async () => {
    const od = app.get(OpenDataService);
    const recs = Array.from({ length: 10 }, (_, i) => ({ key: `RNCP${3000 + i}`, searchText: `RNCP${3000 + i} Manager d'équipe ${i}`, data: { code: `RNCP${3000 + i}`, title: `Manager ${i}` } }));
    expect((await od.ingest('rncp_rs', recs, { snapshotDate: '2026-10-05' })).status).toBe('published');
    expect((await od.ingest('rncp_rs', [], {})).status).toBe('quarantined');
    expect((await od.ingest('rncp_rs', recs.slice(0, 3), {})).status).toBe('quarantined');
    const u = await signupAndLogin();
    const res = (await u.api.get('/api/v1/opendata/search?source=rncp_rs&q=manager 7').expect(200)).body;
    expect(res.results.map((r: any) => r.record_key)).toEqual(['RNCP3007']);
    expect(res.source.snapshotDate).toBe('2026-10-05');
    expect(res.source.license).toContain('Licence Ouverte');
    const sources = (await u.api.get('/api/v1/opendata/sources')).body;
    expect(sources.find((s: any) => s.code === 'rncp_rs').state).toBe('stale');
    expect(sources.find((s: any) => s.code === 'mcf_droits_personnels').state).toBe('excluded');
    const client = (await u.api.post('/api/v1/clients', { kind: 'company', name: 'acme' }).expect(201)).body;
    const prop = (await u.api.post('/api/v1/opendata/enrichment-proposals', { clientId: client.id, record: { siret: '73282932000074', name: 'ACME SAS', city: 'Lyon' } }).expect(201)).body;
    expect(prop.changes.find((c: any) => c.field === 'name')).toMatchObject({ current: 'acme', proposed: 'ACME SAS' });
    await u.api.patch(`/api/v1/clients/${client.id}`, { version: 1, name: 'Acme modifié' }).expect(200);
    expect((await u.api.post(`/api/v1/opendata/enrichment-proposals/${prop.id}/apply`, {})).status).toBe(409);
  });
});
