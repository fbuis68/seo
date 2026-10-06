import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { Ctx, Public, RequestContext, RequireFeature, RequirePermission } from '../../core/context';
import { parse } from '../../core/validation';
import { DocumentsModule } from '../documents/documents.module';
import { FakeSignatureProvider, SIGNATURE_PROVIDER } from './signature.provider';
import { SignaturesService } from './signatures.service';

@Controller('api/v1')
export class SignaturesController {
  constructor(private s: SignaturesService) {}

  @RequirePermission('documents.read') @Get('signatures') list(@Ctx() c: RequestContext) { return this.s.list(c); }
  @RequirePermission('documents.read') @Get('signatures/credits') credits(@Ctx() c: RequestContext) { return this.s.balance(c); }
  @RequirePermission('documents.read') @Get('signatures/:id') get(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.get(c, id); }

  /** Envoi réservé aux offres payantes : contrôle serveur du module et des crédits. */
  @RequireFeature('signatures') @RequirePermission('signatures.send') @Post('signatures')
  send(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.send(c, parse(z.object({
      documentId: z.string().uuid(), title: z.string().min(2).max(200), ordered: z.boolean().optional(), expiresInDays: z.number().int().min(1).max(60).optional(),
      signers: z.array(z.object({ fullName: z.string().min(2).max(120), email: z.string().email(), role: z.string().max(80).optional() })).min(1).max(3),
    }), b));
  }

  @RequirePermission('signatures.send') @Post('signatures/:id/cancel') cancel(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.s.cancel(c, id); }

  @Public() @Post('webhooks/signature')
  webhook(@Req() req: any) { return this.s.handleWebhook(req.rawBody ?? Buffer.from(''), req.headers); }
}

@Module({
  imports: [DocumentsModule],
  controllers: [SignaturesController],
  providers: [SignaturesService, { provide: SIGNATURE_PROVIDER, useFactory: () => new FakeSignatureProvider(config.signature.fakeWebhookSecret) }],
  exports: [SignaturesService],
})
export class SignaturesModule {}
