import { gzipSync } from 'zlib';
import { Db } from '../src/core/db';
import { closeApp, getApp, http, signupAndLogin } from './helpers';

let app: any;
beforeAll(async () => { app = await getApp(); });
afterAll(closeApp);

const Y = new Date().getFullYear();
type V = string | number | null;
/** Fausse sauvegarde mysqldump au format MariaDB (INSERT avec liste de colonnes, BIT en b'1'). */
function dump(extra = '') {
  const tables: Record<string, Record<string, V>[]> = {
    entity: [{ ID: 'E1', NAME: 'Centre Alpha', CODE: 'ALPHA' }, { ID: 'E2', NAME: 'Centre Beta', CODE: 'BETA' }],
    vat: [{ ID: 'V1', ENTITY_ID: 'E1', CODE: 'T20', NAME: 'TVA 20 %', RATE: '20.00', ACTIVATED: "b'1'" }],
    absence: [{ ID: 'AB1', ENTITY_ID: 'E1', CODE: 'MAL', NAME: 'Maladie', BILLABLE: "b'0'", ACTIVATED: "b'1'" }],
    payment_type: [{ ID: 'PT1', CODE: 'CHQ', NAME: 'Chèque', ACTIVATED: "b'1'" }],
    company: [
      { ID: 'C1', ENTITY_ID: 'E1', NAME: 'ACME SA', SIRET: '73282932000074', EMAIL: 'compta@acme.test', ADDRESS: '1 rue de Paris', POSTAL_CODE: '75001', CITY: 'Paris', FINANCER: "b'0'", ACTIVATED: "b'1'", CUSTOMIZED_ADDITION_FIELD: '{"Secteur":"BTP"}' },
      { ID: 'C2', ENTITY_ID: 'E1', NAME: 'OPCO Test', FINANCER: "b'1'", ACTIVATED: "b'1'" },
      { ID: 'C9', ENTITY_ID: 'E2', NAME: 'Autre centre SARL', ACTIVATED: "b'1'" },
    ],
    actor: [
      { ID: 'A1', ENTITY_ID: 'E1', COMPANY_ID: 'C1', LASTNAME: "D'Arc", FIRSTNAME: 'Jeanne', ATTENDEE: "b'1'", TRAINER: "b'0'", EMAIL: 'jeanne@acme.test', BIRTH_DATE: '1990-05-14', CIVILITY: 'MME', PASSWORD: 'secret-hash', VITAL_CARD_NUMBER: '2900575001001', ACTIVATED: "b'1'", UNMESSAGABLE: 'E' },
      { ID: 'A2', ENTITY_ID: 'E1', LASTNAME: 'Martin', FIRSTNAME: 'Paul', TRAINER: "b'1'", HOURLY_RATE: '45.0000', SIRET: '12345678900011', COLOR: '#ff0000', ACTIVATED: "b'1'" },
      { ID: 'A3', ENTITY_ID: 'E1', COMPANY_ID: 'C1', LASTNAME: 'Durand', FIRSTNAME: 'Luc', CONTACT: "b'1'", AS_FUNCTION: 'DRH', ACTIVATED: "b'1'" },
      { ID: 'A4', ENTITY_ID: 'E1', LASTNAME: 'Petit', FIRSTNAME: 'Hugo', ATTENDEE: "b'1'", CUSTOMER: "b'1'", ACTIVATED: "b'1'" },
      { ID: 'A9', ENTITY_ID: 'E2', LASTNAME: 'Hors', FIRSTNAME: 'Perimetre', ATTENDEE: "b'1'" },
    ],
    actor_company: [{ ID: 'AC1', ENTITY_ID: 'E1', ACTOR_ID: 'A3', COMPANY_ID: 'C1', INVOICE_RECEIPT: "b'1'", ACTOR: 'CONTACT' }],
    customer: [{ ID: 'CU1', ENTITY_ID: 'E1', COMPANY_ID: 'C1' }, { ID: 'CU2', ENTITY_ID: 'E1', COMPANY_ID: 'C2' }, { ID: 'CU3', ENTITY_ID: 'E1', ACTOR_ID: 'A4' }],
    training: [{ ID: 'T1', ENTITY_ID: 'E1', NAME: 'CACES R489', CODE: 'R489', HOURS: '21.0000', PRICE: '900.0000', VAT_ID: 'V1', ACTIVATED: "b'1'", CERTIFYING: "b'1'" }],
    room: [{ ID: 'R1', ENTITY_ID: 'E1', CODE: 'S1', NAME: 'Salle 1', CITY: 'Lyon', ACTIVATED: "b'1'" }],
    session: [
      { ID: 'SE1', ENTITY_ID: 'E1', NAME: 'CACES mars', CODE: 'CAC-01', TRAINING_ID: 'T1', START_DATE: `${Y - 1}-03-10T00:00:00`, END_DATE: `${Y - 1}-03-12T00:00:00`, HOURS: '21', NUMBER_MAXI: 8, TRAINER_ID: 'A2', ACTIVATED: "b'1'" },
      { ID: 'SE2', ENTITY_ID: 'E1', NAME: 'CACES décembre', CODE: 'CAC-02', TRAINING_ID: 'T1', START_DATE: `${Y + 1}-12-01`, END_DATE: `${Y + 1}-12-03`, ACTIVATED: "b'1'" },
    ],
    convention: [{ ID: 'CV1', ENTITY_ID: 'E1', customer_id: 'CU1', CODE: 'DOS00001', PROPOSAL_CODE: 'DEV00001', CONTACT_ID: 'AC1', OPCA_ID: 'CU2', IS_CONVENTION: "b'1'", IS_PROPOSAL: "b'1'", PROPOSAL_STATUS: 'W', CONVENTION_STATUS: 'CURRENT', START_DATE: `${Y - 1}-03-10`, END_DATE: `${Y - 1}-03-12`, SUPPORT_NUMBER: 'PEC-42', HOURS: '21', ACTIVATED: "b'1'" }],
    convention_payer: [{ ID: 'CP1', ENTITY_ID: 'E1', CONVENTION_ID: 'CV1', OPCA_ID: 'CU2' }],
    // ENTITY_ID erroné (= id de convention) : bogue MCDF connu, la ligne doit quand même être reprise.
    convention_training: [{ ID: 'CT1', ENTITY_ID: 'CV1', CONVENTION_ID: 'CV1', TRAINING_ID: 'T1', session_id: 'SE1', PRICE: '900', QUANTITY: '1', AMOUNT: '900', VAT_RATE: '20.00', PAYER_ID: 'CU2', STATUS: 'CURRENT', SEQUENCE: 1 }],
    convention_attendee: [{ ID: 'CA1', ENTITY_ID: 'E1', CONVENTION_ID: 'CV1', ATTENDEE_ID: 'A1', OBJECTIF: 'Obtenir le CACES 3', ACTIVATED: "b'1'" }],
    timetable: [{ ID: 'TT1', ENTITY_ID: 'E1', CONVENTION_TRAINING_ID: 'CT1', PAYER_ID: 'CU2', BILLING_DATE: `${Y - 1}-03-12`, QUANTITY: '1', PRICE: '900', DISCOUNTED_AMOUNT: '900', INVOICE_LINE_ID: 'IL1' }],
    schedule: [
      { ID: 'S1', ENTITY_ID: 'E1', SESSION_ID: 'SE1', TRAINER_ID: 'A2', ROOM_ID: 'R1', TYPE: 'CONF', STATUS: 'FULFILLED', START_DATE: `${Y - 1}-03-10T09:00:00`, END_DATE: `${Y - 1}-03-10T12:30:00`, TOTAL_HOURS: '3.5', ACTIVATED: "b'1'" },
      { ID: 'S2', ENTITY_ID: 'E1', SESSION_ID: 'SE1', TRAINER_ID: 'A2', TYPE: 'CONF', STATUS: 'FULFILLED', START_DATE: `${Y - 1}-03-10T13:30:00`, END_DATE: `${Y - 1}-03-10T17:00:00`, ACTIVATED: "b'1'" },
      { ID: 'S3', ENTITY_ID: 'E1', TRAINER_ID: 'A2', TYPE: 'CSTR', STATUS: 'CURRENT', START_DATE: `${Y + 1}-01-05T08:00:00`, END_DATE: `${Y + 1}-01-05T18:00:00`, COMMENT: 'Congé' },
      { ID: 'S4', ENTITY_ID: 'E1', TYPE: 'CLOS', START_DATE: `${Y + 1}-05-01T00:00:00`, END_DATE: `${Y + 1}-05-01T23:59:00`, COMMENT: 'Fête du travail' },
    ],
    actor_schedule: [
      { ID: 'AS1', ENTITY_ID: 'E1', ACTOR_ID: 'A1', SCHEDULE_ID: 'S1', ACTOR: 'ATTENDEE', MISSING: "b'0'", BILLABLE: "b'1'" },
      { ID: 'AS2', ENTITY_ID: 'E1', ACTOR_ID: 'A1', SCHEDULE_ID: 'S2', ACTOR: 'ATTENDEE', MISSING: "b'1'", BILLABLE: "b'0'", ABSENCE_ID: 'AB1' },
      { ID: 'AS3', ENTITY_ID: 'E1', ACTOR_ID: 'A2', SCHEDULE_ID: 'S1', ACTOR: 'TRAINER', MISSING: "b'0'" },
    ],
    invoice: [
      { ID: 'I1', ENTITY_ID: 'E1', CODE: 'FA00001', CONVENTION_ID: 'CV1', PAYER_ID: 'CU2', PAYER_NAME: 'OPCO Test', ACCOUNT_ID: 'CU1', ACCOUNT_NAME: 'ACME SA', BILLING_DATE: `${Y - 1}-03-15`, AMOUNT: '900.0000', VAT_AMOUNT: '180.0000', TTC_AMOUNT: '1080.0000', STATUS: 'I', PAYMENT_PERIOD: 30 },
      { ID: 'I2', ENTITY_ID: 'E1', CODE: 'A00001', INVOICE_ID: 'I1', PAYER_ID: 'CU2', BILLING_DATE: `${Y - 1}-03-20`, AMOUNT: '-100.0000', VAT_AMOUNT: '-20.0000', TTC_AMOUNT: '-120.0000', STATUS: 'I' },
      { ID: 'I3', ENTITY_ID: 'E1', CODE: 'PRO00001', PAYER_ID: 'CU1', BILLING_DATE: `${Y - 1}-02-01`, AMOUNT: '50', VAT_AMOUNT: '10', TTC_AMOUNT: '60', STATUS: 'P' },
      { ID: 'I4', ENTITY_ID: 'E1', CODE: 'FA00002', PAYER_ID: 'INCONNU', BILLING_DATE: `${Y - 1}-04-01`, AMOUNT: '10', VAT_AMOUNT: '2', TTC_AMOUNT: '12', STATUS: 'I' },
    ],
    invoice_line: [{ ID: 'IL1', ENTITY_ID: 'E1', INVOICE_ID: 'I1', TRAINING_NAME: 'CACES R489', QUANTITY: '1', PRICE: '900', AMOUNT: '900', VAT_RATE: '20.00', TTC_AMOUNT: '1080', CONVENTION_TRAINING_ID: 'CT1', TRAINING_ID: 'T1', SESSION_ID: 'SE1' }],
    payment: [{ ID: 'P1', ENTITY_ID: 'E1', PAYER_ID: 'CU2', AMOUNT: '960.0000', PAYMENT_DATE: `${Y - 1}-04-10`, PAYMENT_TYPE_ID: 'PT1', PRESENTATION_CODE: 'REM-7' }],
    payment_invoice: [{ ID: 'PI1', ENTITY_ID: 'E1', PAYMENT_ID: 'P1', INVOICE_ID: 'I1', AMOUNT: '960.0000' }],
    session_document: [{ ID: 'D1', ENTITY_ID: 'E1', SESSION_ID: 'SE1', NAME: 'emargement', SUFFIX: 'pdf', CONTENT: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`, TYPE: 'TIMESHEET', ACTIVATED: "b'1'" }],
  };
  const lit = (v: V) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : /^b'[01]'$/.test(v) ? v : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  let out = '-- MariaDB dump 10.19  Distrib 10.5.29-MariaDB, for debian-linux-gnu (x86_64)\n--\n-- Host: localhost    Database: mcdf\n\n/*!40101 SET NAMES utf8mb4 */;\n';
  for (const [t, rows] of Object.entries(tables)) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (!cols.includes('ID')) cols.unshift('ID');
    const type = (c: string) => rows.some((r) => typeof r[c] === 'string' && /^b'[01]'$/.test(r[c] as string)) ? 'bit(1)' : c === 'CONTENT' ? 'mediumtext' : 'varchar(200)';
    out += `DROP TABLE IF EXISTS \`${t}\`;\nCREATE TABLE \`${t}\` (\n${cols.map((c) => `  \`${c}\` ${type(c)} DEFAULT NULL`).join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n`;
    out += `LOCK TABLES \`${t}\` WRITE;\nINSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ${rows.map((r) => `(${cols.map((c) => lit(r[c] ?? null)).join(',')})`).join(',')};\nUNLOCK TABLES;\n`;
  }
  return gzipSync(Buffer.from(out + extra, 'utf8'));
}

async function upload(u: any, data: Buffer) {
  const b = (await u.api.post('/api/v1/imports', { sourceSoftware: 'mcdf', sourceInstanceId: 'mcdf-prod' }).expect(201)).body;
  const up = await http().put(`/api/v1/imports/${b.id}/package`).set(u.auth).set('Content-Type', 'application/octet-stream').set('X-Filename', 'mcdf.sql.gz').send(data);
  expect(up.status).toBe(200);
  return { id: b.id, up: up.body };
}

describe('Reprise MCDF (sauvegarde MariaDB)', () => {
  it('lit la sauvegarde, simule sans écrire, publie avec identifiants MCDF, réimporte sans doublon, annule', async () => {
    const u = await signupAndLogin({ legalName: 'OF MCDF' });
    const { id, up } = await upload(u, dump());
    expect(up.status).not.toBe('rejected');
    const det = (await u.api.post(`/api/v1/imports/${id}/detect`).expect(201)).body;
    expect(det.mcdf.recognized).toBe(true);
    expect(det.mcdf.entities.map((e: any) => e.id).sort()).toEqual(['E1', 'E2']);
    expect(det.mcdf.entities.find((e: any) => e.id === 'E1').persons).toBe(4);
    expect((await u.api.post(`/api/v1/imports/${id}/mapping`, { profile: 'mcdf', entityIds: ['ZZ'] })).status).toBe(400);
    await u.api.post(`/api/v1/imports/${id}/mapping`, { profile: 'mcdf', entityIds: ['E1'] }).expect(201);
    const sim = (await u.api.post(`/api/v1/imports/${id}/simulate`, {}).expect(201)).body;
    expect(sim.summary.person.create).toBe(4);
    expect(sim.summary.client.create).toBe(3); // ACME, OPCO, client particulier Hugo Petit
    expect(sim.summary.invoice.reject).toBe(1); // payeur inconnu
    expect(sim.issues.some((i: any) => i.legacyId === 'I4')).toBe(true);
    expect(sim.canCommit).toBe(true);
    expect((await u.api.get('/api/v1/clients')).body.length).toBe(0); // simulation : rien d'écrit

    const rep = (await u.api.post(`/api/v1/imports/${id}/commit`).expect(201)).body;
    expect(rep.perEntity.slot.created).toBe(2);
    expect(rep.perEntity.attendance.created).toBe(2);
    expect(rep.financial[0].invoices).toBe(3);

    const db: Db = app.get(Db);
    const tenant = u.tenantId;
    const q = (sql: string, p: unknown[] = []) => db.tenantTx(tenant, async (tx): Promise<any[]> => (await tx.query(sql, p)).rows);
    const [jeanne] = await q(`SELECT p.*, c.name employer FROM persons p LEFT JOIN clients c ON c.id=p.employer_client_id WHERE p.tenant_id=$1 AND p.legacy_id='A1'`, [tenant]);
    expect(jeanne.last_name).toBe("D'Arc");
    expect(jeanne.birth_date).toBe('1990-05-14');
    expect(jeanne.employer).toBe('ACME SA');
    expect(jeanne.no_messages).toBe(true);
    expect(JSON.stringify(jeanne.legacy)).not.toMatch(/secret-hash|2900575001001/); // ni mot de passe ni NIR
    const [acme] = await q(`SELECT * FROM clients WHERE tenant_id=$1 AND legacy_id='C1'`, [tenant]);
    expect(acme.custom_fields).toEqual({ Secteur: 'BTP' });
    expect(acme.status).toBe('customer');
    const [conv] = await q(`SELECT c.*, p.last_name contact FROM conventions c LEFT JOIN persons p ON p.id=c.contact_person_id WHERE c.tenant_id=$1 AND c.legacy_id='CV1'`, [tenant]);
    expect(conv.contact).toBe('Durand'); // CONTACT_ID → actor_company → actor
    expect(conv.support_number).toBe('PEC-42');
    expect((await q(`SELECT count(*)::int n FROM convention_lines WHERE tenant_id=$1 AND legacy_id='CT1'`, [tenant]))[0].n).toBe(1);
    const [enr] = await q(`SELECT e.*, c.name client FROM enrollments e JOIN training_sessions s ON s.id=e.session_id LEFT JOIN clients c ON c.id=e.client_id WHERE e.tenant_id=$1 AND s.legacy_id='SE1'`, [tenant]);
    expect(enr.objective).toBe('Obtenir le CACES 3');
    expect(enr.client).toBe('ACME SA');
    const att = await q(`SELECT a.status, a.minutes, r.label FROM attendance a JOIN slots s ON s.id=a.slot_id LEFT JOIN reference_values r ON r.id=a.absence_reason_id WHERE a.tenant_id=$1 ORDER BY s.starts_at`, [tenant]);
    expect(att).toEqual([{ status: 'present', minutes: 210, label: null }, { status: 'absent', minutes: 0, label: 'Maladie' }]);
    const [slot] = await q(`SELECT s.status, to_char(s.starts_at AT TIME ZONE 'Europe/Paris', 'HH24:MI') h, (SELECT count(*)::int FROM slot_resources r WHERE r.slot_id=s.id) rooms FROM slots s WHERE s.tenant_id=$1 AND s.legacy_id='S1'`, [tenant]);
    expect(slot).toEqual({ status: 'done', h: '09:00', rooms: 1 });
    expect((await q(`SELECT count(*)::int n FROM availabilities WHERE tenant_id=$1 AND reason='Congé'`, [tenant]))[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int n FROM closures WHERE tenant_id=$1 AND label='Fête du travail'`, [tenant]))[0].n).toBe(1);
    const inv = await q(`SELECT legacy_id, kind, status, number, total_ttc, due_date, (SELECT sum(amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id)::text paid FROM invoices i WHERE tenant_id=$1 ORDER BY legacy_id`, [tenant]);
    expect(inv.map((i: any) => [i.legacy_id, i.kind, i.status, i.number])).toEqual([['I1', 'invoice', 'issued', 'FA00001'], ['I2', 'credit_note', 'issued', 'A00001'], ['I3', 'invoice', 'draft', null]]);
    expect(inv[0].total_ttc).toBe('1080.00');
    expect(inv[0].paid).toBe('960.00');
    expect((await q(`SELECT count(*)::int n FROM convention_installments WHERE tenant_id=$1 AND invoice_line_id IS NOT NULL`, [tenant]))[0].n).toBe(1);
    const [doc] = await q(`SELECT mime, owner_type FROM documents WHERE tenant_id=$1 AND legacy_id='D1'`, [tenant]);
    expect(doc).toEqual({ mime: 'application/pdf', owner_type: 'session' });
    expect((await q(`SELECT count(*)::int n FROM persons WHERE tenant_id=$1 AND legacy_id='A9'`, [tenant]))[0].n).toBe(0); // autre organisme

    // Réimport de la même sauvegarde : tout reconnu, rien recréé.
    const again = await upload(u, dump());
    await u.api.post(`/api/v1/imports/${again.id}/detect`).expect(201);
    await u.api.post(`/api/v1/imports/${again.id}/mapping`, { profile: 'mcdf', entityIds: ['E1'] }).expect(201);
    const sim2 = (await u.api.post(`/api/v1/imports/${again.id}/simulate`, {}).expect(201)).body;
    expect(sim2.summary.person.create).toBe(0);
    expect(sim2.summary.person.unchanged).toBe(4);
    expect(sim2.summary.slot.create).toBe(0);
    await u.api.post(`/api/v1/imports/${again.id}/cancel`).expect(201);

    // Annulation du lot publié : tout est retiré.
    await u.api.post(`/api/v1/imports/${id}/rollback`).expect(201);
    for (const t of ['persons', 'clients', 'conventions', 'training_sessions', 'slots', 'attendance', 'invoices', 'payments', 'reference_values', 'documents']) {
      expect([t, (await q(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [tenant]))[0].n]).toEqual([t, 0]);
    }
  });

  it('refuse un fichier qui n’est pas une sauvegarde', async () => {
    const u = await signupAndLogin({ legalName: 'OF MCDF 2' });
    const { up } = await upload(u, Buffer.from('nom;prenom\nA;B\n'));
    expect(up.status).toBe('rejected');
  });
});
