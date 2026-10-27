import { Body, Controller, Get, Headers, Module, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequireFeature, RequirePermission } from '../../core/context';
import { AppError } from '../../core/errors';
import { isoDate, page, parse } from '../../core/validation';
import { CANONICAL, ENTITY_ORDER } from './canonical';
import { MigrationService } from './migration.service';
import { templateXlsx } from './template';
import { QuickImportService } from './quick';

/** Lecture du corps brut, bornée. */
function readBody(req: NodeJS.ReadableStream & { body?: unknown }, max: number): Promise<Buffer> {
  if (Buffer.isBuffer((req as any).body)) return Promise.resolve((req as any).body);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { reject(new AppError(413, 'file_too_large', 'Fichier trop volumineux (10 Mo maximum).')); (req as any).destroy?.(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}

const entity = z.enum(ENTITY_ORDER as unknown as [string, ...string[]]);

@Controller('api/v1/imports')
export class MigrationController {
  constructor(private m: MigrationService, private quick: QuickImportService) {}

  /** Import rapide (clients ou apprenants) : corps = fichier ; en-têtes X-Filename, X-Mapping (JSON, une entrée par colonne). */
  @RequireFeature('migration.self') @RequirePermission('imports.manage') @Post('quick/:entity/:step')
  async quickImport(@Ctx() c: RequestContext, @Param('entity') ent: string, @Param('step') step: string, @Req() req: any,
    @Headers('x-filename') filename?: string, @Headers('x-mapping') mapping?: string, @Query() q?: any) {
    const e = parse(z.enum(['client', 'person']), ent);
    const st = parse(z.enum(['preview', 'commit']), step);
    const o = parse(z.object({ sheet: z.string().max(300).optional(), role: z.enum(['learner', 'trainer', 'contact']).optional() }), q ?? {});
    const buf = await readBody(req, 10 * 1024 * 1024);
    const name = decodeURIComponent(filename ?? 'fichier.csv');
    const opts = { mapping: mapping ? decodeURIComponent(mapping) : undefined, sheet: o.sheet, role: o.role };
    return st === 'preview' ? this.quick.preview(c, buf, name, e, opts) : this.quick.commit(c, buf, name, e, opts);
  }

  /** Procédures d'obtention des sauvegardes et état de compatibilité par logiciel. */
  @RequirePermission('imports.manage') @Get('profiles') profiles() { return this.m.profiles(); }
  /** Champs cibles par objet (association manuelle des colonnes). */
  @RequirePermission('imports.manage') @Get('fields') fields() { return CANONICAL; }
  /** Modèle Excel de reprise (onglets Clients et Apprenants) ; ?vide=1 sans lignes d'exemple. */
  @RequirePermission('imports.manage') @Get('templates/clients-apprenants.xlsx')
  async template(@Query('vide') empty: string | undefined, @Res() res: any) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="modele-reprise-clients-apprenants.xlsx"');
    res.end(await templateXlsx(empty !== '1'));
  }

  @RequirePermission('imports.manage') @Get() list(@Ctx() c: RequestContext) { return this.m.list(c); }
  @RequirePermission('imports.manage') @Get(':id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.get(c, id); }

  @RequireFeature('migration.self') @RequirePermission('imports.manage') @Post()
  create(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.m.create(c, parse(z.object({ sourceSoftware: z.enum(['dendreo', 'digiforma', 'agate', 'generic', 'native', 'mcdf', 'other']), sourceInstanceId: z.string().min(1).max(120) }), b));
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
      entityIds: z.array(z.string().min(1).max(20)).max(50).optional(),
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

  /** Résultat ligne à ligne : filtre erreurs / alertes / importées, référence ligne et colonne. */
  @RequirePermission('imports.manage') @Get(':id/results')
  results(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.m.results(c, id, parse(page.extend({ filter: z.enum(['all', 'errors', 'warnings', 'ok']).optional(), entity: entity.optional(), q: z.string().max(100).optional() }), q));
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
  @RequirePermission('imports.manage') @Post(':id/delete') remove(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.remove(c, id); }
  @RequireFeature('migration.self') @RequirePermission('imports.manage') @Post(':id/relaunch') relaunch(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.relaunch(c, id); }
  @RequirePermission('imports.manage') @Get(':id/report') report(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.report(c, id); }
}

@Module({ controllers: [MigrationController], providers: [MigrationService, QuickImportService] })
export class MigrationModule {}
