import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { JobsService } from '../../core/jobs.service';
import { assertPublicHost } from '../../core/ssrf';
import { parse } from '../../core/validation';
import { ADAPTERS } from './adapters';
import { OpenDataService } from './opendata.service';

@Controller('api/v1/opendata')
export class OpenDataController {
  constructor(private o: OpenDataService) {}

  @RequirePermission('crm.read') @Get('sources') sources() { return this.o.sources(); }

  @RequirePermission('crm.read') @Get('search')
  search(@Ctx() c: RequestContext, @Query() q: unknown) {
    const p = parse(z.object({ source: z.enum(['sirene', 'dgefp_of', 'rncp_rs', 'mcf_offre']), q: z.string().min(2).max(120), limit: z.coerce.number().int().min(1).max(50).default(10) }), q);
    return this.o.search(c, p.source, p.q, p.limit);
  }

  @RequirePermission('opendata.enrich') @Post('enrichment-proposals')
  propose(@Ctx() c: RequestContext, @Body() b: unknown) {
    const p = parse(z.object({ clientId: z.string().uuid(), record: z.object({ siret: z.string().regex(/^\d{14}$/).optional(), name: z.string().max(200).optional(), address: z.string().max(300).optional(), postalCode: z.string().max(10).optional(), city: z.string().max(100).optional() }) }), b);
    return this.o.proposeClientEnrichment(c, p.clientId, p.record);
  }
  @RequirePermission('opendata.enrich') @Get('enrichment-proposals') proposals(@Ctx() c: RequestContext) { return this.o.listProposals(c); }
  @RequirePermission('opendata.enrich') @Post('enrichment-proposals/:id/apply')
  apply(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.o.applyProposal(c, id, parse(z.object({ fields: z.array(z.string()).optional() }), b).fields);
  }
}

@Module({ controllers: [OpenDataController], providers: [OpenDataService], exports: [OpenDataService] })
export class OpenDataModule {
  constructor(jobs: JobsService, svc: OpenDataService) {
    /**
     * Rafraîchissement d'un référentiel fichier : URL de ressource administrée par variable
     * d'environnement (OPENDATA_URL_<CODE>), domaines data.gouv.fr uniquement.
     */
    jobs.register('opendata.refresh', async ({ source }) => {
      const url = process.env[`OPENDATA_URL_${String(source).toUpperCase()}`];
      if (!url || !ADAPTERS[source]) throw new Error(`Source ${source} non configurée`);
      const u = new URL(url);
      await assertPublicHost(u.hostname, ['www.data.gouv.fr', 'static.data.gouv.fr', 'object.files.data.gouv.fr']);
      const res = await fetch(u, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const records = ADAPTERS[source](buf);
      return svc.ingest(source, records, { producerUpdatedAt: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')!) : null, etag: res.headers.get('etag') ?? undefined });
    });
  }
}
