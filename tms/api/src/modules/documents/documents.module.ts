import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { parse } from '../../core/validation';
import { DocumentsService } from './documents.service';

@Controller('api/v1/documents')
export class DocumentsController {
  constructor(private d: DocumentsService) {}

  @RequirePermission('documents.read') @Get()
  list(@Ctx() c: RequestContext, @Query() q: unknown) {
    const p = parse(z.object({ ownerType: z.string().max(40).optional(), ownerId: z.string().uuid().optional() }), q);
    return this.d.list(c, p.ownerType, p.ownerId);
  }

  @RequirePermission('documents.write') @Post('generate')
  generate(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.d.generate(c, parse(z.object({
      template: z.enum(['convention', 'convocation', 'attestation', 'attendance_sheet', 'invoice']),
      sessionId: z.string().uuid().optional(), enrollmentId: z.string().uuid().optional(), invoiceId: z.string().uuid().optional(),
    }), b));
  }

  /** Dépôt d'un document (ex. convention signée hors plateforme en offre Free). */
  @RequirePermission('documents.write') @Post()
  upload(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.d.upload(c, parse(z.object({
      ownerType: z.enum(['session', 'enrollment', 'client', 'invoice', 'quality', 'organization']), ownerId: z.string().uuid().optional(),
      kind: z.string().min(2).max(40), filename: z.string().min(1).max(150), mime: z.string(), base64: z.string().max(1_400_000),
    }), b));
  }

  @RequirePermission('documents.read') @Get(':id/download')
  async download(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: any) {
    const { meta, data } = await this.d.read(c, id);
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    res.setHeader('X-Content-SHA256', meta.sha256);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(data);
  }
}

@Module({ controllers: [DocumentsController], providers: [DocumentsService], exports: [DocumentsService] })
export class DocumentsModule {}
