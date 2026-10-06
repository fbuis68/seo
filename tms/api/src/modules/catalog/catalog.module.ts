import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { Db, many, one } from '../../core/db';
import { notFound } from '../../core/errors';
import { money, page, parse } from '../../core/validation';

const versionSchema = z.object({
  objectives: z.string().max(5000).default(''), prerequisites: z.string().max(5000).default(''),
  audience: z.string().max(2000).default(''), durationMinutes: z.number().int().min(1).max(100000),
  modality: z.enum(['onsite', 'remote', 'blended']), evaluation: z.string().max(5000).default(''),
  priceHt: money.nullable().optional(), vatRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullable().optional(),
});
const programSchema = versionSchema.extend({
  title: z.string().min(2).max(200), code: z.string().max(40).optional(), isPublic: z.boolean().default(false),
  rncpCode: z.string().max(20).optional(), rsCode: z.string().max(20).optional(),
});

/** Programmes versionnés : une version utilisée par une session est figée (trigger SQL). */
@Injectable()
export class CatalogService {
  constructor(private db: Db, private audit: AuditService) {}

  list(ctx: RequestContext, q: { q?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT p.*, v.id current_version_id, v.version current_version, v.duration_minutes, v.modality, v.price_ht
        FROM programs p JOIN LATERAL (SELECT * FROM program_versions WHERE program_id=p.id ORDER BY version DESC LIMIT 1) v ON true
       WHERE p.archived_at IS NULL AND ($1::text IS NULL OR p.title ILIKE '%'||$1||'%') ORDER BY p.title LIMIT $2 OFFSET $3`, [q.q ?? null, q.limit, q.offset]));
  }

  get(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await one(tx, `SELECT * FROM programs WHERE id=$1`, [id]);
      if (!p) throw notFound('Programme');
      p.versions = await many(tx, `SELECT * FROM program_versions WHERE program_id=$1 ORDER BY version DESC`, [id]);
      return p;
    });
  }

  create(ctx: RequestContext, b: z.infer<typeof programSchema>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await one(tx, `INSERT INTO programs(tenant_id, code, title, is_public, rncp_code, rs_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, b.code ?? null, b.title, b.isPublic, b.rncpCode ?? null, b.rsCode ?? null]);
      const v = await this.insertVersion(tx, ctx.tenantId, p!.id, 1, b);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'program.created', entityType: 'program', entityId: p!.id });
      return { ...p, versions: [v] };
    });
  }

  /** Toute modification crée une nouvelle version ; les sessions et documents existants restent sur l'ancienne. */
  newVersion(ctx: RequestContext, programId: string, b: z.infer<typeof versionSchema>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const last = await one(tx, `SELECT max(version) v FROM program_versions WHERE program_id=$1`, [programId]);
      if (!last?.v) throw notFound('Programme');
      return this.insertVersion(tx, ctx.tenantId, programId, last.v + 1, b);
    });
  }

  private insertVersion(tx: any, tenantId: string, programId: string, version: number, b: z.infer<typeof versionSchema>) {
    return one(tx, `INSERT INTO program_versions(tenant_id, program_id, version, objectives, prerequisites, audience, duration_minutes, modality, evaluation, price_ht, vat_rate)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tenantId, programId, version, b.objectives, b.prerequisites, b.audience, b.durationMinutes, b.modality, b.evaluation, b.priceHt ?? null, b.vatRate ?? null]);
  }

  /** Catalogue public minimal : programmes publiés volontairement (pour le site de l'organisme). */
  publicPrograms(tenantId: string) {
    return this.db.tenantTx(tenantId, (tx) => many(tx, `
      SELECT p.id, p.title, p.code, p.rncp_code, p.rs_code, v.objectives, v.prerequisites, v.audience, v.duration_minutes, v.modality, v.price_ht
        FROM programs p JOIN LATERAL (SELECT * FROM program_versions WHERE program_id=p.id ORDER BY version DESC LIMIT 1) v ON true
       WHERE p.is_public AND p.archived_at IS NULL ORDER BY p.title`));
  }
}

@Controller('api/v1/programs')
export class CatalogController {
  constructor(private s: CatalogService) {}
  @RequirePermission('catalog.read') @Get() list(@Ctx() c: RequestContext, @Query() q: unknown) { return this.s.list(c, parse(page, q)); }
  @RequirePermission('catalog.read') @Get(':id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.get(c, id); }
  @RequirePermission('catalog.write') @Post() create(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.create(c, parse(programSchema, b)); }
  @RequirePermission('catalog.write') @Post(':id/versions')
  version(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.s.newVersion(c, id, parse(versionSchema, b)); }
}

@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
