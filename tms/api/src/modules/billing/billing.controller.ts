import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AllowReadOnly, Ctx, Public, RequestContext, RequirePermission } from '../../core/context';
import { parse } from '../../core/validation';
import { ADDONS, AddonCode } from './catalog';
import { SubscriptionService } from './subscription.service';

const choiceSchema = z.object({
  plan: z.enum(['solo', 'equipe', 'centre']),
  interval: z.enum(['month', 'year']),
  addons: z.array(z.object({ code: z.enum(Object.keys(ADDONS) as [AddonCode, ...AddonCode[]]), quantity: z.number().int().min(1).max(10) })).default([]),
});

@Controller('api/v1/billing')
export class BillingController {
  constructor(private subs: SubscriptionService) {}

  @RequirePermission('billing.manage') @Get()
  state(@Ctx() ctx: RequestContext) { return this.subs.getState(ctx.tenantId); }

  /** Lecture des quotas pour tout gestionnaire (bandeau d'usage). */
  @Get('usage')
  usage(@Ctx() ctx: RequestContext) { return this.subs.getState(ctx.tenantId).then((s) => ({ plan: s.plan, status: s.status, quotas: s.quotas, entitlements: s.entitlements })); }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('checkout')
  checkout(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(choiceSchema.extend({ trial: z.boolean().default(false) }), body);
    return this.subs.startCheckout(ctx.tenantId, { userId: ctx.userId, email: ctx.email }, b);
  }

  @RequirePermission('billing.manage') @Post('signature-pack')
  pack(@Ctx() ctx: RequestContext) { return this.subs.buySignaturePack(ctx.tenantId, { userId: ctx.userId, email: ctx.email }); }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('preview-change')
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown) { return this.subs.previewChange(ctx.tenantId, parse(choiceSchema, body)); }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('change')
  change(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(choiceSchema.extend({ confirm: z.object({ direction: z.enum(['upgrade', 'downgrade']), newAmountCents: z.number().int() }) }), body);
    return this.subs.changePlan(ctx.tenantId, ctx.userId, b, b.confirm);
  }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('cancel')
  cancel(@Ctx() ctx: RequestContext) { return this.subs.cancel(ctx.tenantId, ctx.userId, true); }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('resume')
  resume(@Ctx() ctx: RequestContext) { return this.subs.cancel(ctx.tenantId, ctx.userId, false); }

  /** Après réduction de volume : retour à Free si les quotas sont respectés. */
  @RequirePermission('billing.manage') @AllowReadOnly() @Post('reevaluate')
  reevaluate(@Ctx() ctx: RequestContext) { return this.subs.reevaluate(ctx.tenantId); }

  @RequirePermission('billing.manage') @AllowReadOnly() @Post('portal')
  portal(@Ctx() ctx: RequestContext) { return this.subs.portalUrl(ctx.tenantId); }
}

@Controller('api/v1/webhooks')
export class PaymentWebhookController {
  constructor(private subs: SubscriptionService) {}

  @Public() @Post('payment')
  payment(@Req() req: any) { return this.subs.handleWebhook(req.rawBody ?? Buffer.from(''), req.headers); }
}
