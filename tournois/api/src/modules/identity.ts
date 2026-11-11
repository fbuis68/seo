import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { orgRole } from '../core/access';
import { Ctx, Public, RequestContext } from '../core/context';
import { hashPassword, randomToken, sha256, verifyPassword } from '../core/crypto';
import { Db, many, one } from '../core/db';
import { AppError, badRequest, forbidden, notFound } from '../core/errors';
import { PLANS, planOf } from '../core/plans';
import { rateLimit } from '../core/rate-limit';

const email = z.string().trim().toLowerCase().email('Adresse email invalide').max(200);
const password = z.string().min(10, 'Mot de passe : 10 caractères minimum').max(200);
const name = z.string().trim().min(1, 'Champ obligatoire').max(80);

const SignupSchema = z.object({
  email, password, firstName: name, lastName: name,
  phone: z.string().trim().max(30).optional(),
  birthYear: z.number().int().min(1900).max(2100).optional(),
  guardianConsent: z.boolean().optional(),
  /** Création d'un club / organisateur en même temps (sinon : simple profil joueur). */
  organization: z.object({ name: z.string().trim().min(2).max(120) }).optional(),
  acceptTerms: z.literal(true, { error: 'Acceptation de la politique de confidentialité requise' }),
});

@Injectable()
export class IdentityService {
  constructor(private db: Db) {}

  async signup(body: unknown, ip?: string) {
    const b = SignupSchema.parse(body);
    await rateLimit(this.db, `signup:${ip}`, 20, 3600);
    // RGPD — mineurs de moins de 15 ans : consentement du titulaire de l'autorité parentale.
    const age = b.birthYear ? new Date().getFullYear() - b.birthYear : undefined;
    if (age !== undefined && age < 15 && !b.guardianConsent) throw badRequest('guardian_consent_required', 'Moins de 15 ans : le consentement d’un parent est requis', 'guardianConsent');
    const hash = await hashPassword(b.password);
    return this.db.tx(async (tx) => {
      if (await one(tx, 'SELECT 1 FROM users WHERE lower(email) = $1', [b.email])) {
        throw new AppError(409, 'email_taken', 'Un compte existe déjà avec cet email : connectez-vous.', 'email');
      }
      const u = await one(tx,
        `INSERT INTO users(email, password_hash, first_name, last_name, phone, birth_year, guardian_consent_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN now() END) RETURNING id`,
        [b.email, hash, b.firstName, b.lastName, b.phone ?? null, b.birthYear ?? null, !!b.guardianConsent]);
      let orgId: string | undefined;
      if (b.organization) {
        const o = await one(tx, 'INSERT INTO organizations(name, plan) VALUES ($1, $2) RETURNING id', [b.organization.name, process.env.DEFAULT_PLAN ?? 'free']);
        orgId = o!.id;
        await tx.query("INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,'owner')", [orgId, u!.id]);
      }
      const token = await this.openSession(tx, u!.id);
      return { userId: u!.id, orgId, token };
    });
  }

  private async openSession(tx: any, userId: string) {
    const token = randomToken();
    await tx.query(`INSERT INTO auth_sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`, [userId, sha256(token), config.sessionDays]);
    return token;
  }

  async login(body: unknown, ip?: string) {
    const b = z.object({ email, password: z.string().min(1).max(200) }).parse(body);
    await rateLimit(this.db, `login:${ip}`, 30, 900);
    await rateLimit(this.db, `login:${b.email}`, 10, 900);
    const [u] = await this.db.query('SELECT id, password_hash, locked_until, anonymized_at FROM users WHERE lower(email) = $1', [b.email]);
    const fail = new AppError(401, 'invalid_credentials', 'Email ou mot de passe incorrect');
    if (!u || u.anonymized_at) { await hashPassword(b.password); throw fail; } // temps constant : pas d'énumération
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError(423, 'locked', 'Compte temporairement verrouillé (trop d’essais) : réessayez dans 15 minutes.');
    if (!(await verifyPassword(b.password, u.password_hash))) {
      await this.db.query(`UPDATE users SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes' END WHERE id = $1`, [u.id]);
      throw fail;
    }
    return this.db.tx(async (tx) => {
      await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      return { token: await this.openSession(tx, u.id) };
    });
  }

  async me(ctx: RequestContext) {
    const [u] = await this.db.query('SELECT id, email, first_name, last_name, phone, birth_year, created_at FROM users WHERE id = $1', [ctx.userId]);
    const orgs = await this.db.query(
      `SELECT o.id, o.name, o.plan, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.closed_at IS NULL ORDER BY o.created_at`, [ctx.userId]);
    return {
      user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, phone: u.phone, birthYear: u.birth_year },
      organizations: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, plan: o.plan, planLabel: planOf(o.plan).label, limits: planOf(o.plan) })),
      isPlatformAdmin: ctx.isPlatformAdmin,
    };
  }

  async updateMe(ctx: RequestContext, body: unknown) {
    const b = z.object({ firstName: name.optional(), lastName: name.optional(), phone: z.string().trim().max(30).nullable().optional() }).parse(body);
    await this.db.query('UPDATE users SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name), phone = CASE WHEN $5 THEN $4 ELSE phone END WHERE id = $1',
      [ctx.userId, b.firstName ?? null, b.lastName ?? null, b.phone ?? null, b.phone !== undefined]);
    return this.me(ctx);
  }

  /** RGPD : export des données personnelles de l'utilisateur, toutes organisations. */
  async exportMe(ctx: RequestContext) {
    const [u] = await this.db.query('SELECT email, first_name, last_name, phone, birth_year, created_at FROM users WHERE id = $1', [ctx.userId]);
    const routes = await this.db.query('SELECT * FROM route_user_tournaments($1)', [ctx.userId]);
    const tournaments: unknown[] = [];
    for (const orgId of [...new Set(routes.map((r) => r.org_id))]) {
      tournaments.push(...await this.db.orgTx(orgId, (tx) => many(tx,
        `SELECT t.name tournament, t.starts_at, p.name participant, p.status, pm.email, pm.phone, pm.first_name, pm.last_name
           FROM participant_members pm JOIN participants p ON p.id = pm.participant_id JOIN tournaments t ON t.id = pm.tournament_id
          WHERE pm.user_id = $1`, [ctx.userId])));
    }
    return { exportedAt: new Date().toISOString(), account: u, tournaments };
  }

  /**
   * RGPD : suppression du compte. Les résultats sportifs sont conservés (intégrité des classements),
   * l'identité est anonymisée et les coordonnées effacées.
   */
  async deleteMe(ctx: RequestContext) {
    const owned = await this.db.query("SELECT org_id FROM org_members WHERE user_id = $1 AND role = 'owner'", [ctx.userId]);
    for (const o of owned) {
      const [{ n }] = await this.db.query("SELECT count(*)::int n FROM org_members WHERE org_id = $1 AND role = 'owner' AND user_id <> $2", [o.org_id, ctx.userId]);
      if (!n) throw new AppError(409, 'last_owner', 'Vous êtes le seul responsable d’un club : transférez la responsabilité avant de supprimer votre compte.');
    }
    const routes = await this.db.query('SELECT * FROM route_user_tournaments($1)', [ctx.userId]);
    for (const orgId of [...new Set(routes.map((r) => r.org_id))]) {
      await this.db.orgTx(orgId, (tx) => tx.query('UPDATE participant_members SET email = NULL, phone = NULL WHERE user_id = $1', [ctx.userId]));
    }
    await this.db.tx(async (tx) => {
      await tx.query(`UPDATE users SET email = 'anonyme+' || id || '@invalid', first_name = 'Joueur', last_name = 'anonymisé', phone = NULL, birth_year = NULL,
        password_hash = 'x', anonymized_at = now() WHERE id = $1`, [ctx.userId]);
      await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1', [ctx.userId]);
      await tx.query('DELETE FROM org_members WHERE user_id = $1', [ctx.userId]);
    });
    return { deleted: true };
  }

  async createOrg(ctx: RequestContext, body: unknown) {
    const b = z.object({ name: z.string().trim().min(2).max(120) }).parse(body);
    return this.db.tx(async (tx) => {
      const o = await one(tx, 'INSERT INTO organizations(name, plan) VALUES ($1,$2) RETURNING id', [b.name, process.env.DEFAULT_PLAN ?? 'free']);
      await tx.query("INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,'owner')", [o!.id, ctx.userId]);
      return { id: o!.id };
    });
  }

  async members(ctx: RequestContext, orgId: string) {
    const role = await orgRole(this.db, ctx.userId, orgId);
    if (!role && !ctx.isPlatformAdmin) throw notFound('Organisation');
    return this.db.query(`SELECT u.id, u.email, u.first_name, u.last_name, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`, [orgId]);
  }

  /** Responsable de club : ajoute un organisateur ou un co-responsable (compte existant). */
  async addMember(ctx: RequestContext, orgId: string, body: unknown) {
    const b = z.object({ email, role: z.enum(['manager', 'organizer']) }).parse(body);
    const role = await orgRole(this.db, ctx.userId, orgId);
    if (role !== 'owner' && role !== 'manager' && !ctx.isPlatformAdmin) throw forbidden('club_manager_only', 'Réservé aux responsables du club');
    const [org] = await this.db.query('SELECT plan FROM organizations WHERE id = $1', [orgId]);
    const [{ n }] = await this.db.query('SELECT count(*)::int n FROM org_members WHERE org_id = $1', [orgId]);
    if (n >= 2 && !planOf(org.plan).features.includes('multi_organizers')) {
      throw new AppError(402, 'feature_not_in_plan', 'Plusieurs organisateurs : disponible à partir de l’offre Club.');
    }
    const [u] = await this.db.query('SELECT id FROM users WHERE lower(email) = $1 AND anonymized_at IS NULL', [b.email]);
    if (!u) throw notFound('Compte (la personne doit d’abord créer son compte)');
    await this.db.query('INSERT INTO org_members(org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role', [orgId, u.id, b.role]);
    return this.members(ctx, orgId);
  }

  async removeMember(ctx: RequestContext, orgId: string, userId: string) {
    const role = await orgRole(this.db, ctx.userId, orgId);
    if (role !== 'owner' && role !== 'manager' && !ctx.isPlatformAdmin) throw forbidden('club_manager_only', 'Réservé aux responsables du club');
    await this.db.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2 AND role <> 'owner'", [orgId, userId]);
    return this.members(ctx, orgId);
  }
}

@Controller('api')
export class IdentityController {
  constructor(private s: IdentityService, private db: Db) {}

  @Public() @Post('auth/signup') signup(@Body() b: unknown, @Req() req: any) { return this.s.signup(b, req.ip); }
  @Public() @Post('auth/login') login(@Body() b: unknown, @Req() req: any) { return this.s.login(b, req.ip); }
  @Post('auth/logout') async logout(@Ctx() ctx: RequestContext) {
    await this.db.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [ctx.sessionId]);
    return { ok: true };
  }
  @Get('me') me(@Ctx() ctx: RequestContext) { return this.s.me(ctx); }
  @Patch('me') updateMe(@Ctx() ctx: RequestContext, @Body() b: unknown) { return this.s.updateMe(ctx, b); }
  @Get('me/export') exportMe(@Ctx() ctx: RequestContext) { return this.s.exportMe(ctx); }
  @Delete('me') deleteMe(@Ctx() ctx: RequestContext) { return this.s.deleteMe(ctx); }

  @Post('organizations') createOrg(@Ctx() ctx: RequestContext, @Body() b: unknown) { return this.s.createOrg(ctx, b); }
  @Get('organizations/:id/members') members(@Ctx() ctx: RequestContext, @Param('id') id: string) { return this.s.members(ctx, id); }
  @Post('organizations/:id/members') addMember(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() b: unknown) { return this.s.addMember(ctx, id, b); }
  @Delete('organizations/:id/members/:userId') removeMember(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('userId') u: string) { return this.s.removeMember(ctx, id, u); }

  // ── Super administrateur ──
  @Get('admin/organizations') async adminOrgs(@Ctx() ctx: RequestContext) {
    if (!ctx.isPlatformAdmin) throw notFound();
    return this.db.query(`SELECT o.id, o.name, o.plan, o.created_at, (SELECT count(*)::int FROM org_members m WHERE m.org_id = o.id) members FROM organizations o ORDER BY o.created_at DESC LIMIT 500`);
  }
  @Patch('admin/organizations/:id') async adminSetPlan(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    if (!ctx.isPlatformAdmin) throw notFound();
    const b = z.object({ plan: z.enum(Object.keys(PLANS) as [string, ...string[]]) }).parse(body);
    await this.db.query('UPDATE organizations SET plan = $2 WHERE id = $1', [id, b.plan]);
    return { id, plan: b.plan };
  }
}
