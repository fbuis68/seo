import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { Db } from '../../core/db';
import { JobsService } from '../../core/jobs.service';
import { parse } from '../../core/validation';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MailModule } from '../mail/mail.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AiService } from './ai.service';

@Controller('api/v1/ai')
export class AiController {
  constructor(private ai: AiService) {}

  @RequirePermission('ai.use') @Get('providers') providers() { return this.ai.providers(); }
  @RequirePermission('ai.use') @Get('connections') list(@Ctx() c: RequestContext) { return this.ai.listConnections(c); }
  @RequirePermission('ai.use') @Post('connections')
  connect(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.ai.connect(c, parse(z.object({
      provider: z.enum(['openai', 'gemini', 'fake']), model: z.string().min(2).max(80).regex(/^[\w.\-:]+$/), apiKey: z.string().min(8).max(500),
      scope: z.enum(['user', 'tenant']).default('user'), monthlyBudgetCents: z.number().int().min(0).max(10_000_000).optional(),
      allowSensitive: z.boolean().optional(), test: z.boolean().default(true),
    }), b));
  }
  @RequirePermission('ai.use') @Post('connections/:id/revoke') revoke(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.ai.revoke(c, id); }
  @RequirePermission('ai.use') @Get('usage') usage(@Ctx() c: RequestContext) { return this.ai.usage(c); }

  @RequirePermission('ai.use') @Post('conversations')
  start(@Ctx() c: RequestContext, @Body() b: unknown) { return this.ai.startConversation(c, parse(z.object({ connectionId: z.string().uuid() }), b).connectionId); }
  @RequirePermission('ai.use') @Get('conversations/:id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.ai.conversation(c, id); }

  /** L'arrêt côté client (fermeture de requête) interrompt l'appel fournisseur ; un coût déjà engagé peut subsister. */
  @RequirePermission('ai.use') @Post('conversations/:id/messages')
  message(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown, @Req() req: any) {
    const ac = new AbortController();
    req.on('close', () => { if (!req.complete) ac.abort(); });
    return this.ai.send(c, id, parse(z.object({ content: z.string().min(1).max(4000) }), b).content, ac.signal);
  }

  @RequirePermission('ai.use') @Post('proposals/:id/confirm')
  confirm(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) { return this.ai.confirm(c, id, parse(z.object({ payloadHash: z.string().length(64) }), b).payloadHash); }
  @RequirePermission('ai.use') @Post('proposals/:id/reject') reject(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.ai.reject(c, id); }
}

@Module({ imports: [SessionsModule, AnalyticsModule, MailModule], controllers: [AiController], providers: [AiService] })
export class AiModule {
  constructor(jobs: JobsService, db: Db) {
    // Purge des conversations échues (et de leurs messages) organisme par organisme (RLS).
    jobs.register('ai.purge', async () => {
      for (const t of await db.query(`SELECT id FROM tenants`)) {
        await db.tenantTx(t.id, (tx) => tx.query(`DELETE FROM ai_conversations WHERE purge_after < now()`));
      }
    });
  }
}
