import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { inspectJpeg, inspectPng } from '../../core/branding';
import { Ctx, Public, RequestContext, RequirePermission } from '../../core/context';
import { Db, one } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { parse } from '../../core/validation';

const MAX = 600_000;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur #RRVVBB attendue').nullable().optional();

/**
 * Identité visuelle : logo (PNG pour l'interface, JPEG pour les PDF, produits par le navigateur
 * qui redimensionne l'image) et préférences de couleurs de l'interface et des documents.
 */
@Injectable()
export class BrandingService {
  constructor(private db: Db, private audit: AuditService) {}

  get(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const b = await one(tx, `SELECT accent_color, sidebar_color, doc_color, theme, logo_png IS NOT NULL AS has_logo, logo_width, logo_height, updated_at FROM tenant_branding`);
      return {
        accentColor: b?.accent_color ?? null, sidebarColor: b?.sidebar_color ?? null, docColor: b?.doc_color ?? null, theme: b?.theme ?? 'auto',
        logoUrl: b?.has_logo ? `/api/v1/public/logos/${tenantId}.png?v=${new Date(b.updated_at).getTime()}` : null,
        logoWidth: b?.logo_width ?? null, logoHeight: b?.logo_height ?? null,
      };
    });
  }

  saveColors(ctx: RequestContext, b: { accentColor?: string | null; sidebarColor?: string | null; docColor?: string | null; theme?: 'auto' | 'light' | 'dark' }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`INSERT INTO tenant_branding(tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.tenantId]);
      await tx.query(`UPDATE tenant_branding SET
          accent_color = CASE WHEN $1::boolean THEN $2 ELSE accent_color END, sidebar_color = CASE WHEN $3::boolean THEN $4 ELSE sidebar_color END,
          doc_color = CASE WHEN $5::boolean THEN $6 ELSE doc_color END, theme = coalesce($7, theme), updated_at = now()`,
        [b.accentColor !== undefined, b.accentColor ?? null, b.sidebarColor !== undefined, b.sidebarColor ?? null, b.docColor !== undefined, b.docColor ?? null, b.theme ?? null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'branding.colors_updated', data: b });
    }).then(() => this.get(ctx.tenantId));
  }

  saveLogo(ctx: RequestContext, b: { png: string; jpeg: string }) {
    const png = Buffer.from(b.png, 'base64'); const jpeg = Buffer.from(b.jpeg, 'base64');
    if (png.length > MAX || jpeg.length > MAX) throw badRequest('logo_too_large', 'Logo trop volumineux (600 Ko maximum).', 'png');
    const dims = inspectPng(png); inspectJpeg(jpeg);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`INSERT INTO tenant_branding(tenant_id, logo_png, logo_jpeg, logo_width, logo_height) VALUES ($1,$2,$3,$4,$5)
                      ON CONFLICT (tenant_id) DO UPDATE SET logo_png = EXCLUDED.logo_png, logo_jpeg = EXCLUDED.logo_jpeg,
                        logo_width = EXCLUDED.logo_width, logo_height = EXCLUDED.logo_height, updated_at = now()`, [ctx.tenantId, png, jpeg, dims.width, dims.height]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'branding.logo_updated', data: dims });
    }).then(() => this.get(ctx.tenantId));
  }

  deleteLogo(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`UPDATE tenant_branding SET logo_png = NULL, logo_jpeg = NULL, logo_width = NULL, logo_height = NULL, updated_at = now()`);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'branding.logo_deleted' });
    }).then(() => this.get(ctx.tenantId));
  }

  /** Logo public (affiché dans l'interface et partageable) : aucune autre donnée exposée. */
  logo(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => (await one(tx, `SELECT logo_png FROM tenant_branding WHERE tenant_id = $1`, [tenantId]))?.logo_png as Buffer | undefined);
  }
}

@Controller('api/v1')
export class BrandingController {
  constructor(private s: BrandingService) {}

  @Get('organization/branding')
  get(@Ctx() c: RequestContext) { return this.s.get(c.tenantId); }

  @RequirePermission('org.manage') @Put('organization/branding')
  colors(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.saveColors(c, parse(z.object({ accentColor: color, sidebarColor: color, docColor: color, theme: z.enum(['auto', 'light', 'dark']).optional() }), b));
  }

  @RequirePermission('org.manage') @Put('organization/logo')
  logo(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.saveLogo(c, parse(z.object({ png: z.string().max(MAX * 1.4), jpeg: z.string().max(MAX * 1.4) }), b));
  }

  @RequirePermission('org.manage') @Delete('organization/logo')
  deleteLogo(@Ctx() c: RequestContext) { return this.s.deleteLogo(c); }

  @Public() @Get('public/logos/:file')
  async publicLogo(@Param('file') file: string, @Res() res: Response) {
    const id = file.replace(/\.png$/, '');
    parse(z.string().uuid(), id);
    const png = await this.s.logo(id);
    if (!png) throw notFound('Logo');
    res.type('image/png').setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(png);
  }
}

@Module({ controllers: [BrandingController], providers: [BrandingService], exports: [BrandingService] })
export class BrandingModule {}
