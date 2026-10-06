import { Controller, Get, Module, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { forbidden, paymentRequired } from '../../core/errors';
import { csvCell } from '../../core/csv';
import { isoDate, parse } from '../../core/validation';
import { AnalyticsService } from './analytics.service';
import { METRICS, MetricKey } from './metrics';

const metricQuery = z.object({
  metric: z.enum(Object.keys(METRICS) as [MetricKey, ...MetricKey[]]),
  from: isoDate, to: isoDate, granularity: z.enum(['day', 'month', 'quarter', 'year']).default('month'),
  currency: z.string().length(3).optional(), programId: z.string().uuid().optional(), clientId: z.string().uuid().optional(),
  compare: z.coerce.boolean().optional(), unit: z.enum(['participants', 'enrollments']).optional(),
});

@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private a: AnalyticsService) {}

  @RequirePermission('analytics.read') @Get('definitions') defs() { return this.a.definitions(); }
  @RequirePermission('analytics.read') @Get('dashboard') dashboard(@Ctx() c: RequestContext) { return this.a.dashboard(c); }

  @RequirePermission('analytics.read') @Get('metrics')
  metrics(@Ctx() c: RequestContext, @Query() q: unknown) {
    const p = parse(metricQuery, q);
    // Comparatif N/N-1 : module "analyses avancées" (offres payantes).
    if (p.compare && !c.entitlements!.features.includes('analytics.advanced')) throw paymentRequired('feature_not_included', 'Le comparatif N/N-1 est disponible dans les offres payantes.');
    return this.a.series(c, p);
  }
  @RequirePermission('analytics.read') @Get('breakdown')
  breakdown(@Ctx() c: RequestContext, @Query() q: unknown) { return this.a.breakdown(c, parse(metricQuery.extend({ dimension: z.enum(['program', 'client', 'source']) }), q)); }
  @RequirePermission('analytics.read') @Get('receivables')
  receivables(@Ctx() c: RequestContext, @Query() q: unknown) { return this.a.receivables(c, parse(z.object({ currency: z.string().length(3).optional() }), q).currency); }
  @RequirePermission('analytics.read') @Get('fill-rate')
  fill(@Ctx() c: RequestContext, @Query() q: unknown) { const p = parse(z.object({ from: isoDate, to: isoDate }), q); return this.a.fillRate(c, p.from, p.to); }
  @RequirePermission('analytics.read') @Get('drilldown')
  drill(@Ctx() c: RequestContext, @Query() q: unknown) { return this.a.drilldown(c, parse(metricQuery, q)); }

  @RequirePermission('analytics.read') @Get('drilldown.csv')
  async csv(@Ctx() c: RequestContext, @Query() q: unknown, @Res() res: any) {
    if (!c.permissions.has('finance.read')) throw forbidden('permission_denied', 'Permission requise : finance.read');
    const d = await this.a.drilldown(c, parse(metricQuery, q));
    const cols = d.rows.length ? Object.keys(d.rows[0]) : ['d', 'value'];
    const body = [cols.join(';'), ...d.rows.map((r: any) => cols.map((k) => csvCell(r[k])).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${d.metric}.csv"`);
    res.end('﻿' + body);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
