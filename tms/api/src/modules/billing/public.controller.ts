import { Body, Controller, Get, Header, Ip, Post } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { Public } from '../../core/context';
import { AppError } from '../../core/errors';
import { parse } from '../../core/validation';
import { IdentityService } from '../identity/identity.service';
import { passwordSchema } from '../identity/identity.controller';
import { ADDONS, AddonCode, publicCatalog } from './catalog';
import { RateLimiter } from './rate-limit';
import { SubscriptionService } from './subscription.service';

export const signupSchema = z.object({
  email: z.string().email().max(254),
  password: passwordSchema,
  fullName: z.string().min(2).max(120),
  organization: z.object({
    legalName: z.string().min(2).max(200),
    siret: z.string().regex(/^\d{14}$/, 'SIRET à 14 chiffres').optional().or(z.literal('').transform(() => undefined)),
  }),
  acceptTerms: z.literal(true, { message: 'Acceptation des CGV et de la politique de confidentialité requise' }),
  plan: z.enum(['free', 'solo', 'equipe', 'centre']).default('free'),
  interval: z.enum(['month', 'year']).default('month'),
  addons: z.array(z.object({ code: z.enum(Object.keys(ADDONS) as [AddonCode, ...AddonCode[]]), quantity: z.number().int().min(1).max(10) })).default([]),
  trial: z.boolean().default(false),
  /** Champ piège anti-robot : doit rester vide. */
  website: z.string().max(0).optional(),
  source: z.string().max(60).default('website-embed'),
});

/**
 * Endpoints publics consommés par le site web (widget de souscription / plugin WordPress).
 * CORS restreint à PUBLIC_ORIGINS (voir main.ts). Aucun montant n'est accepté du navigateur.
 */
@Controller('api/v1/public')
export class PublicController {
  private signupLimiter = new RateLimiter(5, 60 * 60 * 1000);

  constructor(private identity: IdentityService, private subscriptions: SubscriptionService) {}

  @Public() @Get('catalog')
  @Header('Cache-Control', 'public, max-age=300')
  catalog() {
    return { ...publicCatalog(), trialDays: config.trialDays, termsVersion: config.termsVersion, appUrl: config.appUrl,
      legal: { terms: `${config.appUrl}/legal/cgv`, privacy: `${config.appUrl}/legal/confidentialite`, dpa: `${config.appUrl}/legal/sous-traitance` } };
  }

  /**
   * Inscription depuis le site : crée le compte et l'organisme en Free (sans carte).
   * L'offre payante choisie est mémorisée et proposée au paiement après vérification de l'email.
   */
  @Public() @Post('signup')
  async signup(@Body() body: unknown, @Ip() ip: string) {
    if (!this.signupLimiter.allow(ip)) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessayez plus tard.');
    const b = parse(signupSchema, body);
    if (b.website) throw new AppError(400, 'rejected', 'Requête refusée.');
    const intent = b.plan === 'free' ? null : { plan: b.plan, interval: b.interval, addons: b.addons, trial: b.trial };
    if (intent) this.subscriptions.validateChoice(intent as any);
    const { tenantId } = await this.identity.signup({
      email: b.email, password: b.password, fullName: b.fullName,
      organization: { legalName: b.organization.legalName, siret: b.organization.siret },
      acceptTerms: true, source: b.source, intent,
    });
    return {
      tenantId,
      plan: 'free',
      nextStep: 'verify_email',
      message: intent
        ? `Compte créé en offre Free. Confirmez votre email : vous pourrez ensuite finaliser l'abonnement ${b.plan} en paiement sécurisé.`
        : 'Compte créé en offre Free. Confirmez votre email pour accéder à votre espace.',
      loginUrl: `${config.appUrl}/login`,
    };
  }
}
