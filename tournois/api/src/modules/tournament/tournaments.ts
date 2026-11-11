import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../../core/access';
import { RequestContext } from '../../core/context';
import { Db, many, one } from '../../core/db';
import { badRequest, conflict, forbidden, notFound, paymentRequired } from '../../core/errors';
import { planOf } from '../../core/plans';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { DISCIPLINE_PRESETS } from '../../engine/scoring';
import { GenerationService } from './generation';
import { Progression } from './progression';
import { ParticipantsService } from './participants';
import { TournamentPatchSchema, TournamentSchema } from './schemas';
import { loadState, loadTournament, OFFICIAL } from './state';
import { dashboard, statistics, tournamentView } from './views';

const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tournoi';

/** Format par défaut proposé par l'assistant selon le nombre de participants. */
export function suggestFormat(n: number) {
  if (n <= 5) return { format: 'league', formatConfig: { league: { legs: 1 } } };
  const count = n >= 24 ? Math.round(n / 4) : n >= 12 ? Math.round(n / 4) : 2;
  const groups = Math.max(2, 2 ** Math.round(Math.log2(count)));
  return { format: 'groups_knockout', formatConfig: { groups: { count: groups, distribution: 'snake', legs: 1, qualifiers: 2, avoidSameGroup: true }, knockout: { thirdPlace: false, seeding: 'seeded' } } };
}

@Injectable()
export class TournamentsService {
  constructor(private db: Db, private access: AccessService, private generation: GenerationService, private notifier: Notifier, private participants: ParticipantsService) {}

  async create(ctx: RequestContext, body: unknown) {
    const b = TournamentSchema.parse(body);
    const [m] = await this.db.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [b.orgId, ctx.userId]);
    if (!m && !ctx.isPlatformAdmin) throw forbidden('not_org_member', 'Vous n’êtes pas organisateur de ce club');
    const preset = DISCIPLINE_PRESETS[b.discipline];
    this.checkConfig(b.format, b.formatConfig);
    return this.db.orgTx(b.orgId, async (tx) => {
      const org = await one(tx, 'SELECT plan FROM organizations WHERE id = $1', [b.orgId]);
      const plan = planOf(org.plan);
      if (b.maxParticipants > plan.maxParticipants) throw paymentRequired('participants_quota', `Offre ${plan.label} : ${plan.maxParticipants} participants maximum par tournoi.`);
      if (plan.activeTournaments !== null) {
        const [{ n }] = await many(tx, "SELECT count(*)::int n FROM tournaments WHERE org_id = $1 AND status NOT IN ('finished','archived')", [b.orgId]);
        if (n >= plan.activeTournaments) throw paymentRequired('tournaments_quota', `Offre ${plan.label} : ${plan.activeTournaments} tournois actifs maximum. Archivez un tournoi terminé ou changez d’offre.`);
      }
      if (b.refereeMode !== 'none' && !plan.features.includes('referees')) throw paymentRequired('feature_not_in_plan', 'Arbitrage non inclus dans votre offre.');
      const slug = `${slugify(b.name)}-${Math.random().toString(36).slice(2, 7)}`;
      const t = await one(tx,
        `INSERT INTO tournaments(org_id, slug, name, discipline, starts_at, ends_at, venue_name, max_participants, mode, format, format_config, scoring, ranking_rules,
           courts, match_minutes, break_minutes, visibility, registration, referee_mode, referee_official, confirmation_hours, auto_confirm_on_timeout, branding, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id, slug`,
        [b.orgId, slug, b.name, b.discipline, b.startsAt, b.endsAt ?? null, b.venueName ?? null, b.maxParticipants, b.mode, b.format, JSON.stringify(b.formatConfig),
          JSON.stringify(b.scoring ?? preset.scoring), JSON.stringify(b.rankingRules), b.courts, b.matchMinutes ?? preset.matchMinutes, b.breakMinutes, b.visibility,
          JSON.stringify(b.registration), b.refereeMode, b.refereeOfficial, b.confirmationHours, b.autoConfirmOnTimeout, JSON.stringify(b.branding), ctx.userId]);
      await tx.query("INSERT INTO tournament_roles(org_id, tournament_id, user_id, role) VALUES ($1,$2,$3,'organizer')", [b.orgId, t!.id, ctx.userId]);
      await audit(tx, { orgId: b.orgId, tournamentId: t!.id, actorId: ctx.userId, entity: 'tournament', entityId: t!.id, action: 'created', after: b });
      return t;
    });
  }

  private checkConfig(format: string, cfg: any) {
    if ((format === 'groups' || format === 'groups_knockout') && !cfg?.groups) throw badRequest('groups_config_required', 'Paramètres des poules requis (nombre de poules, qualifiés)', 'formatConfig.groups');
  }

  async update(ctx: RequestContext, id: string, body: unknown) {
    const b = TournamentPatchSchema.parse(body);
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const t = await loadTournament(tx, id, true);
      const structural = ['format', 'formatConfig', 'mode'].filter((k) => (b as any)[k] !== undefined);
      if (structural.length && t.generated_at) throw conflict('already_generated', 'Format et mode non modifiables après génération : régénérez le tournoi (avant tout résultat).');
      const rulesChanged = b.scoring !== undefined || b.rankingRules !== undefined;
      if (rulesChanged) {
        const played = await one(tx, "SELECT count(*)::int n FROM matches WHERE tournament_id = $1 AND status IN ('completed','walkover')", [id]);
        if (b.scoring && played.n) throw conflict('results_exist', 'Règles de score non modifiables après la saisie de résultats.');
      }
      if (b.format) this.checkConfig(b.format, b.formatConfig ?? t.format_config);
      if (b.maxParticipants) {
        const org = await one(tx, 'SELECT plan FROM organizations WHERE id = $1', [a.orgId]);
        if (b.maxParticipants > planOf(org.plan).maxParticipants) throw paymentRequired('participants_quota', `Offre ${planOf(org.plan).label} : ${planOf(org.plan).maxParticipants} participants maximum.`);
      }
      const map: Record<string, [string, (v: any) => unknown]> = {
        name: ['name', (v) => v], discipline: ['discipline', (v) => v], startsAt: ['starts_at', (v) => v], endsAt: ['ends_at', (v) => v], venueName: ['venue_name', (v) => v],
        maxParticipants: ['max_participants', (v) => v], mode: ['mode', (v) => v], format: ['format', (v) => v], formatConfig: ['format_config', JSON.stringify],
        scoring: ['scoring', JSON.stringify], rankingRules: ['ranking_rules', JSON.stringify], courts: ['courts', (v) => v], matchMinutes: ['match_minutes', (v) => v],
        breakMinutes: ['break_minutes', (v) => v], visibility: ['visibility', (v) => v], registration: ['registration', JSON.stringify], refereeMode: ['referee_mode', (v) => v],
        refereeOfficial: ['referee_official', (v) => v], confirmationHours: ['confirmation_hours', (v) => v], autoConfirmOnTimeout: ['auto_confirm_on_timeout', (v) => v], branding: ['branding', JSON.stringify],
      };
      const sets: string[] = [], vals: unknown[] = [id];
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined || !map[k]) continue;
        vals.push(map[k][1](v)); sets.push(`${map[k][0]} = $${vals.length}`);
      }
      if (rulesChanged) sets.push('rules_version = rules_version + 1');
      if (!sets.length) return this.view(ctx, id);
      await tx.query(`UPDATE tournaments SET ${sets.join(', ')}, version = version + 1 WHERE id = $1`, vals);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament', entityId: id, action: rulesChanged ? 'rules_updated' : 'updated',
        before: rulesChanged ? { scoring: t.scoring, ranking_rules: t.ranking_rules, rules_version: t.rules_version } : undefined, after: b });
      // Les classements sont recalculés à la lecture : un changement de barème/départage s'applique immédiatement.
      if (b.rankingRules) {
        const prog = new Progression(tx, a.orgId, id, ctx.userId, { notifier: this.notifier });
        for (const st of await many(tx, "SELECT * FROM stages WHERE tournament_id = $1 AND kind = 'round_robin'", [id])) await prog.refreshStage(st);
      }
      await LiveEvents.emit(tx, id, 'tournament');
      return { updated: true };
    });
  }

  async list(ctx: RequestContext, orgId: string) {
    const [m] = await this.db.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, ctx.userId]);
    if (!m && !ctx.isPlatformAdmin) throw notFound('Organisation');
    return this.db.orgTx(orgId, (tx) => many(tx,
      `SELECT t.id, t.slug, t.name, t.discipline, t.starts_at, t.venue_name, t.status, t.format, t.mode, t.visibility, t.published_at IS NOT NULL published, t.max_participants,
         (SELECT count(*)::int FROM participants p WHERE p.tournament_id = t.id AND p.status = 'confirmed') participants,
         (SELECT count(*)::int FROM matches x WHERE x.tournament_id = t.id AND x.status <> 'bye') matches,
         (SELECT count(*)::int FROM matches x WHERE x.tournament_id = t.id AND x.status IN ('completed','walkover')) completed
       FROM tournaments t
      WHERE t.org_id = $1 AND ($2 IN ('owner','manager') OR t.created_by = $3 OR EXISTS (SELECT 1 FROM tournament_roles r WHERE r.tournament_id = t.id AND r.user_id = $3 AND r.role = 'organizer') OR $4)
      ORDER BY t.starts_at DESC`, [orgId, m?.role, ctx.userId, ctx.isPlatformAdmin]));
  }

  async view(ctx: RequestContext | undefined, id: string) {
    return this.access.withTournament(ctx, id, async (tx, a, r) => {
      if (!a.organizer && !a.referee && !a.participantIds.length && !(r.published && r.visibility === 'public')) throw notFound('Tournoi');
      const s = await loadState(tx, id);
      const v = tournamentView(s, { public: !a.organizer });
      return { ...v, access: { organizer: a.organizer, referee: a.referee, participantIds: a.participantIds, captainOf: a.captainOf }, dashboard: a.organizer ? dashboard(s) : undefined };
    });
  }

  async dashboard(ctx: RequestContext, id: string) {
    return this.access.asOrganizer(ctx, id, async (tx) => dashboard(await loadState(tx, id)));
  }
  async stats(ctx: RequestContext, id: string) {
    return this.access.asOrganizer(ctx, id, async (tx) => statistics(await loadState(tx, id)));
  }
  async audit(ctx: RequestContext, id: string, entityId?: string) {
    return this.access.asOrganizer(ctx, id, (tx) => many(tx,
      `SELECT l.id, l.entity, l.entity_id, l.action, l.before, l.after, l.reason, l.at, u.first_name || ' ' || u.last_name actor
         FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.tournament_id = $1 AND ($2::uuid IS NULL OR l.entity_id = $2) ORDER BY l.id DESC LIMIT 500`, [id, entityId ?? null]));
  }

  async publish(ctx: RequestContext, id: string, body: unknown) {
    const b = z.object({ published: z.boolean().default(true) }).parse(body ?? {});
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const t = await loadTournament(tx, id, true);
      await tx.query(`UPDATE tournaments SET published_at = CASE WHEN $2 THEN coalesce(published_at, now()) END,
        status = CASE WHEN $2 AND status = 'draft' THEN (CASE WHEN generated_at IS NULL THEN 'registration' ELSE 'running' END) ELSE status END WHERE id = $1`, [id, b.published]);
      const token = await this.participants.tournamentToken(tx, a, ctx.userId);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament', entityId: id, action: b.published ? 'published' : 'unpublished', before: { published: !!t.published_at } });
      await LiveEvents.emit(tx, id, 'tournament');
      return { published: b.published, slug: t.slug, registrationToken: token };
    });
  }

  async generate(ctx: RequestContext, id: string, body: unknown) {
    const b = z.object({ reason: z.string().max(500).optional() }).parse(body ?? {});
    return this.access.asOrganizer(ctx, id, (tx, a) => this.generation.generate(tx, a, ctx.userId, b));
  }
  async reschedule(ctx: RequestContext, id: string) {
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const r = await this.generation.autoSchedule(tx, id);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament', entityId: id, action: 'rescheduled', after: r });
      await LiveEvents.emit(tx, id, 'schedule');
      return r;
    });
  }

  async remove(ctx: RequestContext, id: string) {
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const played = await one(tx, "SELECT count(*)::int n FROM matches WHERE tournament_id = $1 AND status IN ('completed','walkover')", [id]);
      if (played.n) {
        await tx.query("UPDATE tournaments SET status = 'archived', published_at = NULL WHERE id = $1", [id]);
        await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament', entityId: id, action: 'archived' });
        return { archived: true };
      }
      await tx.query('DELETE FROM qr_tokens WHERE tournament_id = $1', [id]);
      await tx.query('DELETE FROM notifications WHERE tournament_id = $1', [id]);
      await tx.query('DELETE FROM tournaments WHERE id = $1', [id]);
      return { deleted: true };
    });
  }

  /** Rôles sur le tournoi : arbitres et co-organisateurs (compte existant ou créé ensuite). */
  async addRole(ctx: RequestContext, id: string, body: unknown) {
    const b = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['referee', 'organizer']) }).parse(body);
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const t = await loadTournament(tx, id);
      const org = await one(tx, 'SELECT plan FROM organizations WHERE id = $1', [a.orgId]);
      if (b.role === 'referee' && !planOf(org.plan).features.includes('referees')) throw paymentRequired('feature_not_in_plan', 'Arbitrage non inclus dans votre offre.');
      const u = await one(tx, 'SELECT id, first_name, last_name FROM users WHERE lower(email) = $1 AND anonymized_at IS NULL', [b.email]);
      if (!u) throw notFound('Compte (la personne doit d’abord créer son compte, puis être ajoutée)');
      await tx.query('INSERT INTO tournament_roles(org_id, tournament_id, user_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [a.orgId, id, u.id, b.role]);
      if (b.role === 'referee' && t.referee_mode === 'none') await tx.query("UPDATE tournaments SET referee_mode = 'optional' WHERE id = $1", [id]);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament_role', entityId: u.id, action: `${b.role}_added` });
      await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: id, userIds: [u.id], type: 'referee_assigned', title: b.role === 'referee' ? `Vous êtes arbitre de ${t.name}` : `Vous êtes organisateur de ${t.name}`, link: `/t/${id}` });
      return this.roles(ctx, id, tx);
    });
  }
  async removeRole(ctx: RequestContext, id: string, userId: string, role: string) {
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      await tx.query('DELETE FROM tournament_roles WHERE tournament_id = $1 AND user_id = $2 AND role = $3', [id, userId, role]);
      if (role === 'referee') await tx.query("UPDATE matches SET referee_user_id = NULL WHERE tournament_id = $1 AND referee_user_id = $2 AND status NOT IN ('completed','walkover','bye')", [id, userId]);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'tournament_role', entityId: userId, action: `${role}_removed` });
      return this.roles(ctx, id, tx);
    });
  }
  async roles(ctx: RequestContext, id: string, tx?: any) {
    const q = (t: any) => many(t, `SELECT r.user_id, r.role, u.first_name, u.last_name, u.email FROM tournament_roles r JOIN users u ON u.id = r.user_id WHERE r.tournament_id = $1 ORDER BY r.role, u.last_name`, [id]);
    return tx ? q(tx) : this.access.asOrganizer(ctx, id, (t) => q(t));
  }

  /** Arbitrage d'une égalité non départagée en poule (règlement, tirage au sort) : ordre imposé, tracé. */
  async tiebreak(ctx: RequestContext, id: string, stageId: string, body: unknown) {
    const b = z.object({ group: z.string().min(1).max(10), order: z.array(z.string().uuid()).min(2).max(64), reason: z.string().trim().min(3).max(500), cascade: z.boolean().optional() }).parse(body);
    return this.access.asOrganizer(ctx, id, async (tx, a) => {
      const st = await one(tx, 'SELECT * FROM stages WHERE id = $1 AND tournament_id = $2 FOR UPDATE', [stageId, id]);
      if (!st || st.kind !== 'round_robin') throw notFound('Phase de poules');
      const config = { ...st.config, manualOrder: { ...(st.config?.manualOrder ?? {}), [b.group]: b.order } };
      await tx.query('UPDATE stages SET config = $2 WHERE id = $1', [stageId, JSON.stringify(config)]);
      await audit(tx, { orgId: a.orgId, tournamentId: id, actorId: ctx.userId, entity: 'stage', entityId: stageId, action: 'tiebreak_manual', before: st.config?.manualOrder?.[b.group] ?? null, after: b.order, reason: b.reason });
      await new Progression(tx, a.orgId, id, ctx.userId, { cascade: b.cascade, reason: b.reason, notifier: this.notifier }).refreshStage({ ...st, config });
      return { ok: true };
    });
  }

  /** Vérification d'intégrité : aucun passage de tour sans résultat officiel (indicateur §22). */
  async integrity(ctx: RequestContext, id: string) {
    return this.access.asOrganizer(ctx, id, async (tx) => {
      const s = await loadState(tx, id);
      const issues: string[] = [];
      for (const m of s.matches) {
        for (const [src, pid] of [[m.home_source, m.home_id], [m.away_source, m.away_id]] as const) {
          if (!pid || !src || (src.kind !== 'winner' && src.kind !== 'loser')) continue;
          const from = s.matches.find((x) => x.stage_id === m.stage_id && x.key === src.match);
          const expected = from && OFFICIAL.has(from.status) ? (src.kind === 'winner' ? from.winner_id : from.winner_id === from.home_id ? from.away_id : from.home_id) : null;
          if (expected !== pid) issues.push(`${m.key} : place occupée sans résultat officiel de ${src.match}`);
        }
      }
      return { ok: issues.length === 0, issues };
    });
  }
}
