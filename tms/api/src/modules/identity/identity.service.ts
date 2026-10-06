import { Injectable } from '@nestjs/common';
import { config } from '../../config';
import { AuditService } from '../../core/audit.service';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../core/crypto';
import { Db, Tx, one } from '../../core/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { Role } from '../../core/permissions';
import { SystemMailer } from '../../core/system-mail';
import { EntitlementsService } from '../billing/entitlements.service';

export interface SignupInput {
  email: string; password: string; fullName: string;
  organization: { legalName: string; siret?: string; timezone?: string };
  acceptTerms: true;
  source?: string;
  intent?: { plan: string; interval: string; addons: { code: string; quantity: number }[]; trial?: boolean } | null;
}

const SESSION_DAYS = 14;
const MAX_FAILED = 5;

@Injectable()
export class IdentityService {
  constructor(private db: Db, private mailer: SystemMailer, private audit: AuditService, private entitlements: EntitlementsService) {}

  /** Création compte + organisme en Free (sans carte, sans durée), propriétaire unique, une seule fois. */
  async signup(input: SignupInput): Promise<{ userId: string; tenantId: string }> {
    const passwordHash = await hashPassword(input.password);
    const verifyToken = randomToken();
    const out = await this.db.tx(async (tx) => {
      const existing = await one(tx, `SELECT id FROM users WHERE lower(email)=lower($1)`, [input.email]);
      // Pas d'énumération : même message, mais aucun second compte créé.
      if (existing) throw conflict('email_taken', 'Un compte existe déjà pour cet email. Connectez-vous pour créer un organisme.');
      const user = await one(tx, `INSERT INTO users(email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [input.email.trim(), passwordHash, input.fullName.trim()]);
      const tenantId = await this.createTenant(tx, user!.id, input.organization, input.source ?? 'app', input.intent ?? null);
      await tx.query(`UPDATE subscriptions SET terms_version=$2, terms_accepted_at=now() WHERE tenant_id=$1`, [tenantId, config.termsVersion]);
      await tx.query(`INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '48 hours')`,
        [sha256(verifyToken), user!.id]);
      await this.audit.log(tx, { tenantId, actor: user!.id, action: 'account.signup', data: { source: input.source, terms: config.termsVersion } });
      return { userId: user!.id as string, tenantId };
    });
    await this.mailer.send({
      to: input.email,
      subject: 'Confirmez votre adresse email',
      text: `Bonjour ${input.fullName},\n\nConfirmez votre adresse pour activer votre espace :\n${config.appUrl}/verify-email?token=${verifyToken}\n\nCe lien expire dans 48 heures.`,
    });
    return out;
  }

  async createTenant(tx: Tx, userId: string, org: SignupInput['organization'], source: string, intent: unknown): Promise<string> {
    const t = await one(tx, `INSERT INTO tenants(legal_name, siret, timezone, signup_source, signup_intent) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org.legalName.trim(), org.siret ?? null, org.timezone ?? 'Europe/Paris', source, intent ? JSON.stringify(intent) : null]);
    await tx.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [t!.id, userId]);
    await tx.query(`INSERT INTO subscriptions(tenant_id, plan_code, status) VALUES ($1,'free','free')`, [t!.id]);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [t!.id]);
    await tx.query(`INSERT INTO invoice_series(tenant_id, code, prefix) VALUES ($1,'FAC','FAC-'),($1,'AV','AV-'),($1,'DEV','DEV-')`, [t!.id]);
    return t!.id;
  }

  async createAdditionalTenant(userId: string, org: SignupInput['organization']) {
    return this.db.tx((tx) => this.createTenant(tx, userId, org, 'app', null));
  }

  async verifyEmail(token: string) {
    return this.db.tx(async (tx) => {
      const row = await one(tx, `SELECT * FROM email_verifications WHERE token_hash=$1 FOR UPDATE`, [sha256(token)]);
      if (!row || row.used_at || row.expires_at < new Date()) throw badRequest('invalid_token', 'Lien invalide ou expiré.');
      await tx.query(`UPDATE email_verifications SET used_at=now() WHERE token_hash=$1`, [sha256(token)]);
      await tx.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id=$1`, [row.user_id]);
      const m = await one(tx, `SELECT t.id, t.signup_intent FROM memberships m JOIN tenants t ON t.id=m.tenant_id
                               WHERE m.user_id=$1 AND m.role='owner' ORDER BY t.created_at LIMIT 1`, [row.user_id]);
      return { verified: true, tenantId: m?.id ?? null, intent: m?.signup_intent ?? null };
    });
  }

  async resendVerification(userId: string) {
    const token = randomToken();
    const [u] = await this.db.query(`SELECT email, full_name, email_verified_at FROM users WHERE id=$1`, [userId]);
    if (u.email_verified_at) return;
    await this.db.query(`INSERT INTO email_verifications(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '48 hours')`, [sha256(token), userId]);
    await this.mailer.send({ to: u.email, subject: 'Confirmez votre adresse email', text: `${config.appUrl}/verify-email?token=${token}` });
  }

  /** Connexion avec protection force brute (verrouillage progressif). */
  async login(email: string, password: string, userAgent?: string) {
    const [u] = await this.db.query(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email]);
    const fail = () => new AppError(401, 'invalid_credentials', 'Email ou mot de passe incorrect.');
    if (!u) { await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==').catch(() => false); throw fail(); }
    if (u.locked_until && u.locked_until > new Date()) throw new AppError(429, 'account_locked', 'Trop de tentatives. Réessayez dans quelques minutes.');
    if (!(await verifyPassword(password, u.password_hash))) {
      const n = u.failed_logins + 1;
      await this.db.query(`UPDATE users SET failed_logins=$2, locked_until = CASE WHEN $2 >= $3 THEN now() + interval '15 minutes' ELSE NULL END WHERE id=$1`,
        [u.id, n >= MAX_FAILED ? 0 : n, MAX_FAILED]);
      throw fail();
    }
    await this.db.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [u.id]);
    const token = randomToken();
    await this.db.query(`INSERT INTO auth_sessions(user_id, token_hash, expires_at, user_agent) VALUES ($1,$2, now() + ($3 || ' days')::interval, $4)`,
      [u.id, sha256(token), String(SESSION_DAYS), userAgent?.slice(0, 300) ?? null]);
    return { token, user: { id: u.id, email: u.email, fullName: u.full_name, emailVerified: !!u.email_verified_at } };
  }

  async logout(sessionId: string) {
    await this.db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [sessionId]);
  }
  async revokeAllSessions(userId: string) {
    await this.db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  }

  async me(userId: string) {
    const [u] = await this.db.query(`SELECT id, email, full_name, email_verified_at FROM users WHERE id=$1`, [userId]);
    const memberships = await this.db.query(
      `SELECT t.id tenant_id, t.legal_name, m.role, s.plan_code, s.status, t.signup_intent
         FROM memberships m JOIN tenants t ON t.id=m.tenant_id LEFT JOIN subscriptions s ON s.tenant_id=t.id
        WHERE m.user_id=$1 AND t.closed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) ORDER BY t.created_at`, [userId]);
    return { id: u.id, email: u.email, fullName: u.full_name, emailVerified: !!u.email_verified_at, memberships };
  }

  async getTenant(tenantId: string) {
    const [t] = await this.db.query(`SELECT id, legal_name, siret, nda, timezone, currency, vat_regime, address, created_at FROM tenants WHERE id=$1`, [tenantId]);
    return t;
  }

  async updateTenant(tenantId: string, actor: string, patch: Record<string, unknown>) {
    const cols = ['legal_name', 'siret', 'nda', 'timezone', 'vat_regime', 'address'];
    const sets: string[] = []; const vals: unknown[] = [tenantId];
    for (const c of cols) if (patch[c] !== undefined) { vals.push(c === 'address' ? JSON.stringify(patch[c]) : patch[c]); sets.push(`${c}=$${vals.length}`); }
    if (!sets.length) return this.getTenant(tenantId);
    await this.db.query(`UPDATE tenants SET ${sets.join(',')} WHERE id=$1`, vals);
    await this.audit.log(null, { tenantId, actor, action: 'tenant.updated', data: { fields: Object.keys(patch) } });
    return this.getTenant(tenantId);
  }

  /** Invitation : quota gestionnaires vérifié pour owner/manager ; formateurs/apprenants non comptés. */
  async invite(tenantId: string, actor: string, email: string, role: Role, personId?: string) {
    if (role === 'owner' || role === 'support') throw badRequest('invalid_role', 'Rôle non invitable.');
    const token = randomToken();
    await this.db.tenantTx(tenantId, async (tx) => {
      if (role === 'manager') await this.entitlements.assertQuota(tx, tenantId, 'managers');
      await tx.query(`INSERT INTO invitations(tenant_id, email, role, person_id, token_hash, invited_by, expires_at)
                      VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')`, [tenantId, email, role, personId ?? null, sha256(token), actor]);
      await this.audit.log(tx, { tenantId, actor, action: 'invitation.created', data: { email, role } });
    });
    const t = await this.getTenant(tenantId);
    await this.mailer.send({ to: email, subject: `Invitation : ${t.legal_name}`, text: `Rejoignez l'espace ${t.legal_name} : ${config.appUrl}/accept-invitation?token=${token}` });
    return { invited: true };
  }

  async acceptInvitation(userId: string, token: string) {
    return this.db.tx(async (tx) => {
      const inv = await one(tx, `SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE`, [sha256(token)]);
      if (!inv || inv.accepted_at || inv.expires_at < new Date()) throw badRequest('invalid_invitation', 'Invitation invalide ou expirée.');
      const [u] = (await tx.query(`SELECT email FROM users WHERE id=$1`, [userId])).rows;
      // Rattachement uniquement à l'adresse invitée (pas de fusion implicite).
      if (u.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden('invitation_email_mismatch', "Cette invitation concerne une autre adresse email.");
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [inv.tenant_id]);
      if (inv.role === 'manager') await this.entitlements.assertQuota(tx, inv.tenant_id, 'managers');
      await tx.query(`INSERT INTO memberships(tenant_id, user_id, role, person_id) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (tenant_id, user_id) DO NOTHING`, [inv.tenant_id, userId, inv.role, inv.person_id]);
      await tx.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [inv.id]);
      return { tenantId: inv.tenant_id, role: inv.role };
    });
  }

  async listMembers(tenantId: string) {
    return this.db.query(`SELECT m.id, m.role, m.expires_at, u.email, u.full_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at`, [tenantId]);
  }

  /** Accès support éditeur : nominatif, temporaire, justifié, journalisé, accordé par le propriétaire. */
  async grantSupportAccess(tenantId: string, actor: string, supportEmail: string, hours: number, justification: string) {
    const [u] = await this.db.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [supportEmail]);
    if (!u) throw notFound('Compte support');
    await this.db.query(`INSERT INTO memberships(tenant_id, user_id, role, expires_at, justification)
                         VALUES ($1,$2,'support', now() + ($3 || ' hours')::interval, $4)
                         ON CONFLICT (tenant_id, user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, justification=EXCLUDED.justification
                         WHERE memberships.role='support'`, [tenantId, u.id, String(Math.min(hours, 72)), justification]);
    await this.audit.log(null, { tenantId, actor, action: 'support.access_granted', data: { supportEmail, hours, justification } });
  }
}
