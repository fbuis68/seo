import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequireFeature, RequirePermission } from '../../core/context';
import { page, parse } from '../../core/validation';
import { MailService } from './mail.service';

@Controller('api/v1/mail')
export class MailController {
  constructor(private m: MailService) {}

  @RequirePermission('mail.configure') @Get('connections') list(@Ctx() c: RequestContext) { return this.m.listConnections(c); }

  @RequireFeature('smtp.custom') @RequirePermission('mail.configure') @Post('connections')
  create(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.m.createSmtp(c, parse(z.object({
      host: z.string().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/), port: z.union([z.literal(465), z.literal(587)]), security: z.enum(['tls', 'starttls']),
      authMode: z.enum(['password', 'oauth2']), username: z.string().min(1).max(254), secret: z.string().min(1).max(4096),
      fromEmail: z.string().email(), fromName: z.string().max(120).optional(), replyTo: z.string().email().optional(),
    }), b) as any);
  }
  @RequirePermission('mail.configure') @Post('connections/:id/test') test(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.test(c, id); }
  @RequirePermission('mail.configure') @Post('connections/:id/disable') disable(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.m.disable(c, id); }

  /** Envoi explicite (aperçu des destinataires côté interface). */
  @RequirePermission('mail.send') @Post('messages/send')
  send(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.m.queue(c, parse(z.object({
      to: z.array(z.string().email()).min(1).max(50), subject: z.string().min(1).max(200), text: z.string().min(1).max(50000), html: z.string().max(200000).optional(),
      connectionId: z.string().uuid().nullable().optional(), attachments: z.array(z.string().uuid()).max(10).optional(),
      relatedType: z.string().max(40).optional(), relatedId: z.string().uuid().optional(), scheduledAt: z.string().datetime({ offset: true }).optional(),
    }), b));
  }
  @RequirePermission('mail.send') @Get('messages')
  messages(@Ctx() c: RequestContext, @Query() q: unknown) { return this.m.messages(c, parse(page.extend({ relatedId: z.string().uuid().optional() }), q)); }
}

@Module({ controllers: [MailController], providers: [MailService], exports: [MailService] })
export class MailModule {}
