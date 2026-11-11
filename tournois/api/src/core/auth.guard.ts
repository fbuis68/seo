import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { config } from '../config';
import { sha256 } from './crypto';
import { Db } from './db';
import { IS_PUBLIC, OPTIONAL_AUTH, RequestContext } from './context';
import { AppError } from './errors';

/** Garde globale : session (jeton Bearer) vérifiée côté serveur sur chaque requête. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const meta = (k: string) => this.reflector.getAllAndOverride<boolean>(k, [ec.getHandler(), ec.getClass()]);
    const isPublic = meta(IS_PUBLIC), optional = meta(OPTIONAL_AUTH);
    const req = ec.switchToHttp().getRequest();
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query?.access_token ?? '');
    if (!token) {
      if (isPublic || optional) return true;
      throw new AppError(401, 'unauthenticated', 'Authentification requise');
    }
    const [row] = await this.db.query(
      `SELECT s.id sid, u.id, u.email, u.first_name, u.last_name FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.anonymized_at IS NULL`, [sha256(token)]);
    if (!row) {
      if (isPublic || optional) return true;
      throw new AppError(401, 'unauthenticated', 'Session expirée ou révoquée');
    }
    const ctx: RequestContext = {
      userId: row.id, email: row.email, firstName: row.first_name, lastName: row.last_name, sessionId: row.sid,
      isPlatformAdmin: config.platformAdmins.includes(String(row.email).toLowerCase()), ip: req.ip,
    };
    req.ctx = ctx;
    return true;
  }
}
