import { Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ZipFile } from 'yazl';
import { AuditService } from '../../core/audit.service';
import { AllowReadOnly, Ctx, RequestContext, RequirePermission } from '../../core/context';
import { sha256 } from '../../core/crypto';
import { Db, many, one } from '../../core/db';
import { JobsService } from '../../core/jobs.service';
import { StorageService } from '../../core/storage';

export const EXPORT_FORMAT_VERSION = '1.0';

/** Tables exportées (données de l'organisme) ; colonnes secrètes exclues. */
export const EXPORT_TABLES: { table: string; omit?: string[] }[] = [
  { table: 'persons' }, { table: 'person_roles' }, { table: 'clients' }, { table: 'client_contacts' },
  { table: 'programs' }, { table: 'program_versions' }, { table: 'rooms' }, { table: 'training_sessions' }, { table: 'slots' },
  { table: 'enrollments' }, { table: 'funding_allocations' }, { table: 'attendance' },
  { table: 'documents', omit: ['storage_key'] }, { table: 'invoice_series' }, { table: 'quotes' }, { table: 'invoices' }, { table: 'invoice_lines' },
  { table: 'payments' }, { table: 'payment_allocations' }, { table: 'signature_envelopes' }, { table: 'signature_signers' },
  { table: 'questionnaires' }, { table: 'questionnaire_responses' }, { table: 'complaints' },
  { table: 'external_identities' }, { table: 'enrichment_proposals' },
  { table: 'ai_connections', omit: ['secret_enc'] }, { table: 'bank_connections', omit: ['secret_enc', 'sync_cursor'] },
  { table: 'bank_accounts' }, { table: 'bank_transactions' }, { table: 'reconciliation_allocations' },
  { table: 'mail_connections', omit: ['secret_enc'] }, { table: 'mail_messages' },
];

/**
 * Réversibilité (EXP-01) : export complet asynchrone données + documents + preuves + manifeste
 * (hashes SHA-256), inclus dans toutes les offres, disponible en lecture seule.
 */
@Injectable()
export class ExportsService {
  constructor(private db: Db, private storage: StorageService, private jobs: JobsService, private audit: AuditService) {
    this.jobs.register('export.full', (p) => this.build(p.tenantId, p.exportId, p.userId));
  }

  async request(ctx: RequestContext) {
    const exportId = randomUUID();
    await this.jobs.enqueue(null, 'export.full', { tenantId: ctx.tenantId, exportId, userId: ctx.userId }, { tenantId: ctx.tenantId, dedupeKey: `export:${exportId}` });
    await this.audit.log(null, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'export.requested', entityId: exportId });
    return { exportId, status: 'queued' };
  }

  list(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => ({
      exports: await many(tx, `SELECT id, filename, size_bytes, sha256, created_at FROM documents WHERE kind='export' ORDER BY created_at DESC LIMIT 20`),
      pending: await many(tx, `SELECT payload->>'exportId' id, status, attempts, last_error, created_at FROM jobs WHERE type='export.full' AND tenant_id=$1 AND status IN ('pending','running','failed') ORDER BY created_at DESC LIMIT 10`, [ctx.tenantId]),
    }));
  }

  async build(tenantId: string, exportId: string, userId: string) {
    const files: { path: string; data: Buffer }[] = [];
    const counts: Record<string, number> = {};
    await this.db.tenantTx(tenantId, async (tx) => {
      const tenant = await one(tx, `SELECT id, legal_name, siret, nda, timezone, currency, vat_regime, address, created_at FROM tenants WHERE id=$1`, [tenantId]);
      files.push({ path: 'data/organization.json', data: Buffer.from(JSON.stringify(tenant, null, 2)) });
      for (const t of EXPORT_TABLES) {
        let rows = await many(tx, `SELECT * FROM ${t.table}`);
        if (t.table === 'documents') rows = rows.filter((r) => r.kind !== 'export');
        if (t.omit) rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !t.omit!.includes(k))));
        counts[t.table] = rows.length;
        files.push({ path: `data/${t.table}.json`, data: Buffer.from(JSON.stringify(rows, null, 1)) });
      }
      const docs = await many(tx, `SELECT id, filename, storage_key, sha256 FROM documents WHERE kind <> 'export'`);
      for (const d of docs) {
        const data = await this.storage.get(d.storage_key);
        if (sha256(data) !== d.sha256) throw new Error(`Empreinte incohérente pour le document ${d.id}`);
        files.push({ path: `documents/${d.id}/${d.filename}`, data });
      }
    });
    const manifest = {
      format: 'tms-export', version: EXPORT_FORMAT_VERSION, exportId, tenantId, generatedAt: new Date().toISOString(), counts,
      files: files.map((f) => ({ path: f.path, sha256: sha256(f.data), size: f.data.length })),
      note: 'Secrets (clés API, mots de passe, jetons) volontairement exclus. Réimportable par le profil de reprise "native".',
    };
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    for (const f of files) zip.addBuffer(f.data, f.path);
    zip.end();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => { zip.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', resolve).on('error', reject); });
    const data = Buffer.concat(chunks);
    const key = this.storage.key(tenantId, 'exports', exportId);
    if (!(await this.storage.exists(key))) await this.storage.put(key, data);
    await this.db.tenantTx(tenantId, (tx) => tx.query(
      `INSERT INTO documents(id, tenant_id, owner_type, kind, filename, mime, size_bytes, sha256, storage_key, created_by) VALUES ($1,$2,'organization','export',$3,'application/zip',$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`, [exportId, tenantId, `export-${new Date().toISOString().slice(0, 10)}.zip`, data.length, sha256(data), key, userId]));
  }
}

@Controller('api/v1/exports')
export class ExportsController {
  constructor(private e: ExportsService) {}
  @RequirePermission('exports.full') @AllowReadOnly() @Post() request(@Ctx() c: RequestContext) { return this.e.request(c); }
  @RequirePermission('exports.full') @Get() list(@Ctx() c: RequestContext) { return this.e.list(c); }
}

@Module({ controllers: [ExportsController], providers: [ExportsService], exports: [ExportsService] })
export class ExportsModule {}
