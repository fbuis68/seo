import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from '../modules/billing/entitlements.service';
import { FeatureKey } from '../modules/billing/catalog';
import { Db } from './db';
import { sha256 } from './crypto';
import { ALLOW_READ_ONLY, ALLOW_UNVERIFIED, FEATURE, IS_PUBLIC, NO_TENANT, PERMS, RequestContext } from './context';
import { AppError, forbidden, paymentRequired } from './errors';
import { Permission, Role, effectivePermissions } from './permissions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Garde globale : authentification, contexte d'organisme explicite (X-Tenant-Id) vérifié
 * par adhésion, permissions, module de l'offre et mode lecture seule.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db, private entitlements: EntitlementsService) {}

  private meta<T>(key: string, ec: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ec.getHandler(), ec.getClass()]);
  }

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    if (this.meta<boolean>(IS_PUBLIC, ec)) return true;
    const req = ec.switchToHttp().getRequest();
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new AppError(401, 'unauthenticated', 'Authentification requise');

    const [row] = await this.db.query(
      `SELECT s.id sid, u.id, u.email, u.full_name, u.email_verified_at FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
    if (!row) throw new AppError(401, 'unauthenticated', 'Session expirée ou révoquée');

    const ctx: RequestContext = {
      userId: row.id, email: row.email, fullName: row.full_name, emailVerified: !!row.email_verified_at,
      sessionId: row.sid, tenantId: '', permissions: new Set(), ip: req.ip,
    };
    req.ctx = ctx;
    if (this.meta<boolean>(NO_TENANT, ec)) return true;

    const tenantId = String(req.headers['x-tenant-id'] ?? '');
    if (!UUID.test(tenantId)) throw new AppError(400, 'tenant_required', 'En-tête X-Tenant-Id requis');
    const [m] = await this.db.query(
      `SELECT m.role, m.extra_permissions, m.revoked_permissions, m.person_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND (m.expires_at IS NULL OR m.expires_at > now()) AND t.closed_at IS NULL`,
      [tenantId, ctx.userId]);
    // Même réponse que pour un organisme inexistant : aucune divulgation.
    if (!m) throw forbidden('tenant_forbidden', 'Organisme inaccessible');
    ctx.tenantId = tenantId;
    ctx.role = m.role as Role;
    ctx.personId = m.person_id;
    ctx.permissions = effectivePermissions(ctx.role, m.extra_permissions, m.revoked_permissions);
    ctx.entitlements = await this.entitlements.get(tenantId);

    if (!ctx.emailVerified && !this.meta<boolean>(ALLOW_UNVERIFIED, ec)) {
      throw forbidden('email_not_verified', 'Vérifiez votre adresse email pour continuer.');
    }
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && ctx.entitlements.readOnly && !this.meta<boolean>(ALLOW_READ_ONLY, ec)) {
      throw paymentRequired('read_only', 'Compte en lecture seule : choisissez une offre adaptée ou réduisez le volume. Lecture et export restent disponibles.');
    }
    const perms = this.meta<Permission[]>(PERMS, ec) ?? [];
    for (const p of perms) if (!ctx.permissions.has(p)) throw forbidden('permission_denied', `Permission requise : ${p}`);
    const feature = this.meta<FeatureKey>(FEATURE, ec);
    if (feature) this.entitlements.requireFeature(ctx.entitlements, feature);
    return true;
  }
}
