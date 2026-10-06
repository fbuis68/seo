import { Body, Controller, Get, Headers, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { AllowReadOnly, AllowUnverified, Ctx, NoTenant, Public, RequestContext, RequirePermission } from '../../core/context';
import { parse } from '../../core/validation';
import { IdentityService } from './identity.service';

export const passwordSchema = z.string().min(10, 'Mot de passe : 10 caractères minimum').max(200);

@Controller('api/v1')
export class IdentityController {
  constructor(private identity: IdentityService) {}

  @Public() @Post('auth/login')
  login(@Body() body: unknown, @Headers('user-agent') ua?: string) {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), body);
    return this.identity.login(b.email, b.password, ua);
  }

  @Public() @Post('auth/verify-email')
  verify(@Body() body: unknown) {
    return this.identity.verifyEmail(parse(z.object({ token: z.string().min(10) }), body).token);
  }

  @NoTenant() @Post('auth/resend-verification')
  resend(@Ctx() ctx: RequestContext) { return this.identity.resendVerification(ctx.userId).then(() => ({ sent: true })); }

  @NoTenant() @Post('auth/logout')
  logout(@Ctx() ctx: RequestContext) { return this.identity.logout(ctx.sessionId).then(() => ({ ok: true })); }

  @NoTenant() @Post('auth/logout-all')
  logoutAll(@Ctx() ctx: RequestContext) { return this.identity.revokeAllSessions(ctx.userId).then(() => ({ ok: true })); }

  @NoTenant() @Get('me')
  me(@Ctx() ctx: RequestContext) { return this.identity.me(ctx.userId); }

  /** Un compte existant peut créer un organisme supplémentaire (Free). */
  @NoTenant() @Post('tenants')
  async createTenant(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(z.object({ legalName: z.string().min(2).max(200), siret: z.string().regex(/^\d{14}$/).optional() }), body);
    const id = await this.identity.createAdditionalTenant(ctx.userId, b);
    return { tenantId: id };
  }

  @NoTenant() @Post('invitations/accept')
  accept(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.identity.acceptInvitation(ctx.userId, parse(z.object({ token: z.string().min(10) }), body).token);
  }

  @AllowUnverified() @Get('organization')
  org(@Ctx() ctx: RequestContext) {
    return this.identity.getTenant(ctx.tenantId).then((t) => ({ ...t, role: ctx.role, permissions: [...ctx.permissions], entitlements: ctx.entitlements }));
  }

  @RequirePermission('org.manage') @Patch('organization')
  updateOrg(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(z.object({
      legal_name: z.string().min(2).max(200).optional(), siret: z.string().regex(/^\d{14}$/).nullable().optional(),
      nda: z.string().max(20).nullable().optional(), timezone: z.string().max(64).optional(),
      vat_regime: z.enum(['to_confirm', 'subject', 'exempt_261_4_4']).optional(), address: z.record(z.string(), z.string()).optional(),
    }), body);
    return this.identity.updateTenant(ctx.tenantId, ctx.userId, b);
  }

  @RequirePermission('users.manage') @Get('members')
  members(@Ctx() ctx: RequestContext) { return this.identity.listMembers(ctx.tenantId); }

  @RequirePermission('users.manage') @Post('invitations')
  invite(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), role: z.enum(['manager', 'trainer', 'learner']), personId: z.string().uuid().optional() }), body);
    return this.identity.invite(ctx.tenantId, ctx.userId, b.email, b.role, b.personId);
  }

  @RequirePermission('users.manage') @AllowReadOnly() @Post('support-access')
  support(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), hours: z.number().int().min(1).max(72), justification: z.string().min(5) }), body);
    return this.identity.grantSupportAccess(ctx.tenantId, ctx.userId, b.email, b.hours, b.justification).then(() => ({ granted: true }));
  }
}
