import { Body, Controller, Get, Headers, Module, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequireFeature, RequirePermission } from '../../core/context';
import { isoDate, page, parse } from '../../core/validation';
import { ENTITY_ORDER } from './canonical';
import { MigrationService } from './migration.service';

const entity = z.enum(ENTITY_ORDER as unknown as [string, ...string[]]);

@Controller('api/v1/imports')
export class MigrationController {
  constructor(private m: MigrationService) {}

  /** Procédures d'obtention des sauvegardes et état de compatibilité par logiciel. */
  @RequirePermission('imports.manage') @Get('profiles') profiles() { return this.m.profiles(); }
  @RequirePermission('imports.manage') @Get() list(@Ctx() c: RequestContext) { return this.m.list(c); }
  @RequirePermission('imports.manage') @Get(':id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.get(c, id); }

  @RequireFeature('migration.self') @RequirePermission('imports.manage') @Post()
  create(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.m.create(c, parse(z.object({ sourceSoftware: z.enum(['dendreo', 'digiforma', 'agate', 'generic', 'native', 'other']), sourceInstanceId: z.string().min(1).max(120) }), b));
  }

  /** Dépôt du paquet en flux binaire (application/zip, text/csv, xlsx). */
  @RequirePermission('imports.manage') @Put(':id/package')
  upload(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: any, @Headers('x-filename') filename?: string) {
    return this.m.upload(c, id, req, decodeURIComponent(filename ?? 'paquet.zip'));
  }

  @RequirePermission('imports.manage') @Post(':id/detect') detect(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.detect(c, id); }

  @RequirePermission('imports.manage') @Post(':id/mapping')
  mapping(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.m.confirmProfile(c, id, parse(z.object({
      profile: z.string().max(40),
      files: z.array(z.object({ path: z.string().max(500), entity, columns: z.record(z.string(), z.string().max(200)) })).max(100).optional(),
    }), b) as any);
  }

  @RequirePermission('imports.manage') @Post(':id/simulate')
  simulate(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.m.simulate(c, id, parse(z.object({
      mode: z.enum(['create_only', 'create_update']).optional(), partial: z.boolean().optional(),
      scope: z.object({ entities: z.array(entity).optional(), sessionsFrom: isoDate.optional() }).optional(),
    }), b) as any);
  }

  @RequirePermission('imports.manage') @Get(':id/rows')
  rows(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.m.rows(c, id, parse(page.extend({ severity: z.enum(['ok', 'info', 'warning', 'fix', 'blocking']).optional(), entity: entity.optional() }), q));
  }

  @RequirePermission('imports.manage') @Get(':id/anomalies.csv')
  async anomalies(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: any) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="anomalies-${id.slice(0, 8)}.csv"`);
    res.end(await this.m.anomaliesCsv(c, id));
  }

  @RequirePermission('imports.manage') @Post(':id/commit') commit(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.commit(c, id); }
  @RequirePermission('imports.manage') @Post(':id/rollback') rollback(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.rollback(c, id); }
  @RequirePermission('imports.manage') @Post(':id/cancel') cancel(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.cancel(c, id); }
  @RequirePermission('imports.manage') @Get(':id/report') report(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.report(c, id); }
}

@Module({ controllers: [MigrationController], providers: [MigrationService] })
export class MigrationModule {}
