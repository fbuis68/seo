import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Entitlements } from '../modules/billing/entitlements';
import type { FeatureKey } from '../modules/billing/catalog';
import { Permission, Role } from './permissions';

export interface RequestContext {
  userId: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
  sessionId: string;
  tenantId: string;              // vide pour les routes @NoTenant
  role?: Role;
  personId?: string | null;
  permissions: Set<Permission>;
  entitlements?: Entitlements;
  ip?: string;
}

export const IS_PUBLIC = 'tms:public';
export const NO_TENANT = 'tms:no-tenant';
export const PERMS = 'tms:perms';
export const FEATURE = 'tms:feature';
export const ALLOW_READ_ONLY = 'tms:allow-read-only';
export const ALLOW_UNVERIFIED = 'tms:allow-unverified';

/** Route accessible sans authentification (site web, webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route authentifiée hors contexte d'organisme (compte utilisateur). */
export const NoTenant = () => SetMetadata(NO_TENANT, true);
/** Permissions requises (toutes). */
export const RequirePermission = (...p: Permission[]) => SetMetadata(PERMS, p);
/** Module fonctionnel requis par l'offre souscrite. */
export const RequireFeature = (f: FeatureKey) => SetMetadata(FEATURE, f);
/** Mutation permise en lecture seule (abonnement, export, réduction de volume). */
export const AllowReadOnly = () => SetMetadata(ALLOW_READ_ONLY, true);
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);

export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): RequestContext => ec.switchToHttp().getRequest().ctx);
