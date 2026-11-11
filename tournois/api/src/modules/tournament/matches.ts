/**
 * Rencontres (§5.2, §5.3) : planification manuelle (terrain, horaire, glisser-déposer), statuts,
 * affectation d'arbitre, pénalités et fiche détaillée avec historique des saisies.
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../../core/access';
import { RequestContext } from '../../core/context';
import { Db, many, one } from '../../core/db';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { Progression } from './progression';
import { CLOSED, loadState, loadTournament, MatchRow } from './state';
import { matchView } from './views';

const ScheduleSchema = z.object({
  court: z.number().int().min(1).max(200).nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  locked: z.boolean().optional(),
  refereeUserId: z.string().uuid().nullable().optional(),
  version: z.number().int().optional(),
  /** Glisser-déposer : échange avec la rencontre occupant déjà la case cible. */
  swapWith: z.string().uuid().optional(),
});

const TRANSITIONS: Record<string, string[]> = {
  called: ['to_schedule', 'scheduled', 'postponed'],
  in_progress: ['to_schedule', 'scheduled', 'called', 'postponed'],
  postponed: ['to_schedule', 'scheduled', 'called', 'in_progress'],
  scheduled: ['postponed', 'called', 'in_progress', 'to_schedule'],
  cancelled: ['to_schedule', 'scheduled', 'called', 'postponed', 'in_progress', 'awaiting_confirmation', 'disputed'],
};

@Injectable()
export class MatchesService {
  constructor(private db: Db, private access: AccessService, private notifier: Notifier) {}

  private async withMatch<T>(ctx: RequestContext, id: string, fn: (tx: any, a: any, m: MatchRow) => Promise<T>) {
    const r = await this.access.routeMatch(id);
    return this.db.orgTx(r.orgId, async (tx) => {
      const a = await this.access.load(tx, ctx, r.tournamentId, r.orgId);
      const m = await one<MatchRow>(tx, 'SELECT * FROM matches WHERE id = $1 FOR UPDATE', [id]);
      if (!m) throw notFound('Rencontre');
      return fn(tx, a, m);
    });
  }

  async detail(ctx: RequestContext | undefined, id: string) {
    const r = await this.access.routeMatch(id);
    const route = await this.access.route(r.tournamentId);
    return this.db.orgTx(r.orgId, async (tx) => {
      const a = await this.access.load(tx, ctx, r.tournamentId, r.orgId);
      const s = await loadState(tx, r.tournamentId);
      const m = s.matches.find((x) => x.id === id)!;
      const isPlayer = [m.home_id, m.away_id].some((p) => p && a.participantIds.includes(p));
      const isRef = a.referee && m.referee_user_id === ctx?.userId;
      if (!a.organizer && !isPlayer && !isRef && !(route.published && route.visibility === 'public') && !a.referee && !a.participantIds.length) throw notFound('Rencontre');
      const subs = await many(tx, `SELECT s.id, s.submitter_role, s.score, s.status, s.reason, s.created_at, s.decided_at, s.expires_at,
          u.first_name || ' ' || u.last_name submitted_by_name, d.first_name || ' ' || d.last_name decided_by_name, s.submitted_by = $2 mine
        FROM score_submissions s JOIN users u ON u.id = s.submitted_by LEFT JOIN users d ON d.id = s.decided_by WHERE s.match_id = $1 ORDER BY s.created_at`, [id, ctx?.userId ?? null]);
      const history = a.organizer ? await many(tx, `SELECT l.action, l.before, l.after, l.reason, l.at, u.first_name || ' ' || u.last_name actor FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.entity_id = $1 ORDER BY l.id`, [id]) : undefined;
      const side = m.home_id && a.captainOf.includes(m.home_id) ? 'home' : m.away_id && a.captainOf.includes(m.away_id) ? 'away' : null;
      const members = await many(tx, `SELECT participant_id, first_name, last_name FROM participant_members WHERE participant_id = ANY($1) ORDER BY position`, [[m.home_id, m.away_id].filter(Boolean)]);
      const referee = m.referee_user_id ? await one(tx, 'SELECT first_name, last_name FROM users WHERE id = $1', [m.referee_user_id]) : null;
      const pending = subs.find((x) => x.status === 'pending');
      return {
        match: matchView(s, m), tournament: { id: s.t.id, name: s.t.name, slug: s.t.slug, scoring: s.t.scoring, refereeMode: s.t.referee_mode, mode: s.t.mode },
        players: { home: members.filter((x) => x.participant_id === m.home_id).map((x) => `${x.first_name} ${x.last_name}`), away: members.filter((x) => x.participant_id === m.away_id).map((x) => `${x.first_name} ${x.last_name}`) },
        referee: referee ? `${referee.first_name} ${referee.last_name}` : null,
        submissions: isPlayer || a.organizer || isRef ? subs : subs.filter((x) => x.status === 'official'),
        history,
        me: {
          side, organizer: a.organizer, referee: !!isRef,
          canSubmit: !CLOSED.has(m.status) && !!m.home_id && !!m.away_id && (a.organizer || !!isRef || (!!side && s.t.referee_mode !== 'required')),
          canConfirm: !!pending && !!side && pending.submitter_role !== side && ['home', 'away'].includes(pending.submitter_role),
          pendingSubmissionId: pending?.id ?? null,
        },
      };
    });
  }

  /** Planification manuelle ; renvoie les conflits détectés (terrain occupé, participant sur deux rencontres). */
  async schedule(ctx: RequestContext, id: string, body: unknown) {
    const b = ScheduleSchema.parse(body);
    return this.withMatch(ctx, id, async (tx, a, m) => {
      if (!a.organizer) throw forbidden('organizer_only', 'Planification réservée à l’organisateur.');
      if (b.version !== undefined && b.version !== m.version) throw conflict('stale_version', 'Rencontre modifiée entre-temps : rechargez.');
      const t = await loadTournament(tx, m.tournament_id);
      if (b.swapWith) {
        const o = await one<MatchRow>(tx, 'SELECT * FROM matches WHERE id = $1 AND tournament_id = $2 FOR UPDATE', [b.swapWith, m.tournament_id]);
        if (!o) throw notFound('Rencontre cible');
        await tx.query('UPDATE matches SET court = $2, scheduled_at = $3, schedule_locked = true, version = version + 1 WHERE id = $1', [o.id, m.court, m.scheduled_at]);
        b.court = o.court; b.scheduledAt = o.scheduled_at ? new Date(o.scheduled_at).toISOString() : null;
      }
      if (b.refereeUserId) {
        const ok = await one(tx, "SELECT 1 FROM tournament_roles WHERE tournament_id = $1 AND user_id = $2 AND role = 'referee'", [m.tournament_id, b.refereeUserId]);
        if (!ok) throw badRequest('not_a_referee', 'Cette personne n’est pas arbitre du tournoi', 'refereeUserId');
      }
      if (b.court !== undefined && b.court !== null && b.court > t.courts) throw badRequest('court_unknown', `Terrain ${b.court} inexistant (${t.courts} terrains)`, 'court');
      const court = b.court !== undefined ? b.court : m.court;
      const at = b.scheduledAt !== undefined ? (b.scheduledAt ? new Date(b.scheduledAt) : null) : m.scheduled_at;
      const warnings: string[] = [];
      if (court && at) {
        const dur = `${t.match_minutes} minutes`;
        const overlaps = await many(tx, `SELECT key, court, home_id, away_id FROM matches WHERE tournament_id = $1 AND id <> $2 AND id <> coalesce($6::uuid, '00000000-0000-0000-0000-000000000000')
            AND scheduled_at IS NOT NULL AND status NOT IN ('cancelled','bye') AND scheduled_at < $3::timestamptz + $4::interval AND scheduled_at + $4::interval > $3::timestamptz
            AND (court = $5 OR home_id = ANY($7) OR away_id = ANY($7))`, [m.tournament_id, id, at, dur, court, b.swapWith ?? null, [m.home_id, m.away_id].filter(Boolean)]);
        for (const o of overlaps) {
          if (o.court === court) warnings.push(`Terrain ${court} déjà occupé par ${o.key}`);
          else warnings.push(`Un participant joue déjà ${o.key} sur ce créneau`);
        }
      }
      const status = CLOSED.has(m.status) || !['to_schedule', 'scheduled'].includes(m.status) ? m.status : court && at ? 'scheduled' : 'to_schedule';
      await tx.query(`UPDATE matches SET court = $2, scheduled_at = $3, schedule_locked = coalesce($4, schedule_locked OR $6), referee_user_id = CASE WHEN $7 THEN $5 ELSE referee_user_id END, status = $8, version = version + 1 WHERE id = $1`,
        [id, court ?? null, at, b.locked ?? null, b.refereeUserId ?? null, b.court !== undefined || b.scheduledAt !== undefined, b.refereeUserId !== undefined, status]);
      await audit(tx, { orgId: a.orgId, tournamentId: m.tournament_id, actorId: ctx.userId, entity: 'match', entityId: id, action: 'scheduled', before: { court: m.court, scheduled_at: m.scheduled_at, referee: m.referee_user_id }, after: { court, scheduled_at: at, referee: b.refereeUserId }, reason: warnings.join(' ; ') || undefined });
      const prog = new Progression(tx, a.orgId, m.tournament_id, ctx.userId);
      const timeChanged = (m.court !== court || String(m.scheduled_at ?? '') !== String(at ?? '')) && m.scheduled_at;
      if (timeChanged) await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: m.tournament_id, userIds: await prog.usersOf([m.home_id, m.away_id]), type: 'match_changed',
        title: 'Changement d’horaire ou de terrain', body: at ? `Nouvelle convocation : terrain ${court ?? '?'} à ${at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}.` : 'Rencontre à replanifier.', link: `/matches/${id}` });
      if (b.refereeUserId && b.refereeUserId !== m.referee_user_id) await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: m.tournament_id, userIds: [b.refereeUserId], type: 'referee_assigned', title: `Rencontre ${m.key} à arbitrer`, link: `/matches/${id}` });
      await LiveEvents.emit(tx, m.tournament_id, 'schedule', id);
      return { id, court, scheduledAt: at, status, warnings };
    });
  }

  /** Statut opérationnel : convocation, début, report, annulation (motif requis pour l'annulation). */
  async setStatus(ctx: RequestContext, id: string, body: unknown) {
    const b = z.object({ status: z.enum(['called', 'in_progress', 'postponed', 'scheduled', 'cancelled']), reason: z.string().trim().max(500).optional() }).parse(body);
    return this.withMatch(ctx, id, async (tx, a, m) => {
      const isRef = a.referee && m.referee_user_id === ctx.userId;
      if (!a.organizer && !isRef) throw forbidden('organizer_only', 'Réservé à l’organisateur ou à l’arbitre de la rencontre.');
      if (!TRANSITIONS[b.status]?.includes(m.status)) throw conflict('invalid_transition', `Passage de « ${m.status} » à « ${b.status} » impossible.`);
      if (b.status === 'cancelled') {
        if (!a.organizer) throw forbidden('organizer_only', 'Annulation réservée à l’organisateur.');
        if (!b.reason) throw badRequest('reason_required', 'Motif d’annulation obligatoire', 'reason');
        const st = await one(tx, 'SELECT kind FROM stages WHERE id = $1', [m.stage_id]);
        if (st.kind === 'knockout') throw conflict('cannot_cancel_knockout', 'En élimination directe, déclarez un forfait plutôt qu’une annulation.');
      }
      await tx.query(`UPDATE matches SET status = $2, started_at = CASE WHEN $2 = 'in_progress' THEN coalesce(started_at, now()) ELSE started_at END, version = version + 1 WHERE id = $1`, [id, b.status]);
      if (b.status === 'cancelled') await tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status IN ('pending','disputed')", [id]);
      await audit(tx, { orgId: a.orgId, tournamentId: m.tournament_id, actorId: ctx.userId, entity: 'match', entityId: id, action: `status_${b.status}`, before: { status: m.status }, reason: b.reason });
      const prog = new Progression(tx, a.orgId, m.tournament_id, ctx.userId, { notifier: this.notifier });
      if (b.status === 'called') await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: m.tournament_id, userIds: await prog.usersOf([m.home_id, m.away_id]), type: 'match_changed',
        title: `Convocation : ${m.court ? `terrain ${m.court}` : 'rendez-vous à la table de marque'}`, body: 'Présentez-vous maintenant pour votre rencontre.', link: `/matches/${id}` });
      if (b.status === 'postponed') await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: m.tournament_id, userIds: await prog.usersOf([m.home_id, m.away_id]), type: 'match_changed', title: 'Rencontre reportée', body: b.reason, link: `/matches/${id}` });
      if (b.status === 'cancelled') { const st = await one(tx, 'SELECT * FROM stages WHERE id = $1', [m.stage_id]); await prog.refreshStage(st); }
      await LiveEvents.emit(tx, m.tournament_id, 'status', id);
      return { id, status: b.status };
    });
  }

  /** Pénalité de points au classement (sanction disciplinaire), tracée et motivée. */
  async penalty(ctx: RequestContext, id: string, body: unknown) {
    const b = z.object({ home: z.number().int().min(0).max(100).default(0), away: z.number().int().min(0).max(100).default(0), reason: z.string().trim().min(3).max(500) }).parse(body);
    return this.withMatch(ctx, id, async (tx, a, m) => {
      if (!a.organizer && !(a.referee && m.referee_user_id === ctx.userId)) throw forbidden('organizer_only', 'Pénalité réservée à l’organisateur ou à l’arbitre.');
      await tx.query('UPDATE matches SET penalty_home = $2, penalty_away = $3, version = version + 1 WHERE id = $1', [id, b.home, b.away]);
      await audit(tx, { orgId: a.orgId, tournamentId: m.tournament_id, actorId: ctx.userId, entity: 'match', entityId: id, action: 'penalty', before: { home: m.penalty_home, away: m.penalty_away }, after: { home: b.home, away: b.away }, reason: b.reason });
      const st = await one(tx, 'SELECT * FROM stages WHERE id = $1', [m.stage_id]);
      await new Progression(tx, a.orgId, m.tournament_id, ctx.userId, { notifier: this.notifier }).refreshStage(st);
      return { id, penaltyHome: b.home, penaltyAway: b.away };
    });
  }
}
