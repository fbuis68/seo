/**
 * Saisie et validation des scores (§6) :
 *  - organisateur : résultat directement officiel (et seul habilité à corriger un résultat officiel, motif obligatoire) ;
 *  - arbitre affecté : officiel ou soumis à validation selon le règlement ;
 *  - joueurs : validation contradictoire (saisie d'un côté, confirmation ou contestation de l'autre).
 *
 * Chaque opération verrouille la rencontre (SELECT … FOR UPDATE) : deux saisies simultanées sont
 * sérialisées et confrontées, jamais deux résultats contradictoires validés (CA08).
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Access, AccessService } from '../../core/access';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { rateLimit } from '../../core/rate-limit';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { evaluateScore, ScoreInput, ScoreResult, Side, walkoverScore } from '../../engine/scoring';
import { ScoreSchema } from './schemas';
import { Progression } from './progression';
import { CLOSED, loadTournament, MatchRow, OFFICIAL, TournamentRow } from './state';

const sameScore = (a: ScoreInput, b: ScoreInput) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const normalize = (s: ScoreInput) => ({ sets: s.sets?.map((x) => [x.home, x.away]) ?? null, home: s.home ?? null, away: s.away ?? null, retired: s.retired ?? null });

const SubmitSchema = z.object({ score: ScoreSchema, version: z.number().int().optional() });
const ValidateSchema = z.object({
  submissionId: z.string().uuid().optional(),
  score: ScoreSchema.optional(),
  reason: z.string().trim().max(500).optional(),
  /** Correction : accepter l'annulation des rencontres déjà jouées qui en dépendent. */
  cascade: z.boolean().optional(),
  version: z.number().int().optional(),
});

interface MatchCtx { tx: Tx; a: Access; m: MatchRow; t: TournamentRow; knockout: boolean; }

@Injectable()
export class ResultsService {
  constructor(private db: Db, private access: AccessService, private notifier: Notifier) {}

  private async withMatch<T>(ctx: RequestContext | undefined, matchId: string, fn: (c: MatchCtx) => Promise<T>): Promise<T> {
    const r = await this.access.routeMatch(matchId);
    return this.db.orgTx(r.orgId, async (tx) => {
      const a = await this.access.load(tx, ctx, r.tournamentId, r.orgId);
      const m = await one<MatchRow>(tx, 'SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!m) throw notFound('Rencontre');
      const t = await loadTournament(tx, r.tournamentId);
      const stage = await one(tx, 'SELECT kind FROM stages WHERE id = $1', [m.stage_id]);
      return fn({ tx, a, m, t, knockout: stage?.kind === 'knockout' });
    });
  }

  /** Côté de l'utilisateur (joueur ou capitaine) dans la rencontre. */
  private sideOf(a: Access, m: MatchRow): Side | null {
    if (m.home_id && a.captainOf.includes(m.home_id)) return 'home';
    if (m.away_id && a.captainOf.includes(m.away_id)) return 'away';
    return null;
  }
  private assertPlayable(m: MatchRow) {
    if (!m.home_id || !m.away_id) throw conflict('participants_unknown', 'Les deux participants de la rencontre ne sont pas encore connus.');
    if (CLOSED.has(m.status)) throw conflict('match_closed', 'Rencontre terminée : seule une correction par l’organisateur est possible.');
    if (m.status === 'postponed') throw conflict('match_postponed', 'Rencontre reportée : replanifiez-la avant de saisir le score.');
  }
  private checkVersion(m: MatchRow, v?: number) {
    if (v !== undefined && v !== m.version) throw conflict('stale_version', 'La rencontre a été modifiée entre-temps : rechargez avant de saisir.', { version: m.version });
  }
  private async organizerUsers(tx: Tx, c: MatchCtx) {
    const rows = await many(tx, `SELECT user_id FROM tournament_roles WHERE tournament_id = $1 AND role = 'organizer'
      UNION SELECT user_id FROM org_members WHERE org_id = $2 AND role IN ('owner','manager') UNION SELECT created_by FROM tournaments WHERE id = $1 AND created_by IS NOT NULL`, [c.t.id, c.a.orgId]);
    return [...rows.map((r) => r.user_id), c.m.referee_user_id];
  }

  /** Saisie d'un score (joueur, arbitre ou organisateur). */
  async submit(ctx: RequestContext, matchId: string, body: unknown) {
    const b = SubmitSchema.parse(body);
    await rateLimit(this.db, `score:${ctx.userId}`, 60, 600);
    return this.withMatch(ctx, matchId, async (c) => {
      const { tx, a, m, t } = c;
      this.checkVersion(m, b.version);
      if (a.organizer) return this.makeOfficial(c, ctx, b.score, { reason: 'Saisie organisateur' });
      if (a.referee && m.referee_user_id === ctx.userId) {
        this.assertPlayable(m);
        if (t.referee_official) return this.makeOfficial(c, ctx, b.score, { reason: 'Saisie arbitre', role: 'referee' });
        const ev = this.evaluate(c, b.score);
        await tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status IN ('pending','disputed')", [m.id]);
        const sub = await this.insertSubmission(tx, c, ctx, 'referee', b.score, 'pending', null);
        await tx.query("UPDATE matches SET status = 'awaiting_confirmation', version = version + 1 WHERE id = $1", [m.id]);
        await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: await this.organizerUsers(tx, c), type: 'score_to_confirm', title: 'Score d’arbitre à valider', link: `/matches/${m.id}` });
        await LiveEvents.emit(tx, t.id, 'score_submitted', m.id);
        return { status: 'awaiting_validation', submissionId: sub.id, evaluation: ev };
      }
      const side = this.sideOf(a, m);
      if (!side) {
        if (m.home_id && a.participantIds.includes(m.home_id) || m.away_id && a.participantIds.includes(m.away_id)) throw forbidden('captain_only', 'Seul le capitaine désigné de l’équipe peut saisir le score.');
        throw forbidden('not_a_player', 'Vous n’êtes pas joueur de cette rencontre.');
      }
      if (t.referee_mode === 'required') throw forbidden('referee_required', 'Ce tournoi est arbitré : le score est saisi par l’arbitre.');
      this.assertPlayable(m);
      const ev = this.evaluate(c, b.score);
      const pending = await one(tx, "SELECT * FROM score_submissions WHERE match_id = $1 AND status = 'pending' FOR UPDATE", [m.id]);
      if (pending && pending.submitter_role === side) {
        await tx.query("UPDATE score_submissions SET status = 'superseded', decided_at = now() WHERE id = $1", [pending.id]);
      } else if (pending && (pending.submitter_role === 'home' || pending.submitter_role === 'away')) {
        // Saisie croisée : identique = confirmation ; différente = contestation, arbitrage organisateur.
        if (sameScore(pending.score, b.score)) {
          await tx.query("UPDATE score_submissions SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1", [pending.id, ctx.userId]);
          return this.makeOfficial(c, ctx, b.score, { submissionId: pending.id, reason: 'Saisies identiques des deux côtés', skipOrganizerCheck: true });
        }
        await tx.query("UPDATE score_submissions SET status = 'disputed', decided_by = $2, decided_at = now(), reason = 'Saisie adverse différente' WHERE id = $1", [pending.id, ctx.userId]);
        const sub = await this.insertSubmission(tx, c, ctx, side, b.score, 'disputed', 'Saisie différente de celle de l’adversaire');
        await tx.query("UPDATE matches SET status = 'disputed', version = version + 1 WHERE id = $1", [m.id]);
        await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: await this.organizerUsers(tx, c), type: 'score_disputed',
          title: 'Scores contradictoires à arbitrer', body: 'Les deux équipes ont saisi des scores différents.', link: `/matches/${m.id}` });
        await LiveEvents.emit(tx, t.id, 'score_disputed', m.id);
        return { status: 'disputed', submissionId: sub.id, evaluation: ev };
      }
      if (m.status === 'disputed') await tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status = 'disputed'", [m.id]);
      const sub = await this.insertSubmission(tx, c, ctx, side, b.score, 'pending', null);
      await tx.query("UPDATE matches SET status = 'awaiting_confirmation', version = version + 1 WHERE id = $1", [m.id]);
      const opponent = side === 'home' ? m.away_id : m.home_id;
      const prog = new Progression(tx, a.orgId, t.id, ctx.userId);
      await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: await prog.usersOf([opponent]), type: 'score_to_confirm',
        title: 'Score à confirmer', body: `${ctx.firstName} ${ctx.lastName} a saisi le score de votre rencontre : confirmez ou contestez.`, link: `/matches/${m.id}` });
      await LiveEvents.emit(tx, t.id, 'score_submitted', m.id);
      return { status: 'awaiting_confirmation', submissionId: sub.id, evaluation: ev, expiresAt: sub.expires_at };
    });
  }

  async confirm(ctx: RequestContext, matchId: string, body: unknown) {
    const b = z.object({ submissionId: z.string().uuid() }).parse(body);
    return this.withMatch(ctx, matchId, async (c) => {
      const sub = await one(c.tx, 'SELECT * FROM score_submissions WHERE id = $1 AND match_id = $2 FOR UPDATE', [b.submissionId, matchId]);
      if (!sub) throw notFound('Saisie');
      if (sub.status !== 'pending') throw conflict('submission_not_pending', 'Cette saisie n’est plus en attente de confirmation.');
      const side = this.sideOf(c.a, c.m);
      const opposite = sub.submitter_role === 'home' ? 'away' : sub.submitter_role === 'away' ? 'home' : null;
      if (!side || side !== opposite) {
        if (c.a.organizer || (c.a.referee && c.m.referee_user_id === ctx.userId)) return this.validate(ctx, matchId, { submissionId: sub.id }, c);
        throw forbidden('not_opponent', 'Seul l’adversaire peut confirmer ce score.');
      }
      await c.tx.query("UPDATE score_submissions SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1", [sub.id, ctx.userId]);
      return this.makeOfficial(c, ctx, sub.score, { submissionId: sub.id, reason: 'Confirmé par l’adversaire', skipOrganizerCheck: true });
    });
  }

  async dispute(ctx: RequestContext, matchId: string, body: unknown) {
    const b = z.object({ submissionId: z.string().uuid(), reason: z.string().trim().min(3, 'Motif requis').max(500), score: ScoreSchema.optional() }).parse(body);
    return this.withMatch(ctx, matchId, async (c) => {
      const sub = await one(c.tx, 'SELECT * FROM score_submissions WHERE id = $1 AND match_id = $2 FOR UPDATE', [b.submissionId, matchId]);
      if (!sub) throw notFound('Saisie');
      if (sub.status !== 'pending') throw conflict('submission_not_pending', 'Cette saisie n’est plus en attente de confirmation.');
      const side = this.sideOf(c.a, c.m);
      if (!side || side === sub.submitter_role) throw forbidden('not_opponent', 'Seul l’adversaire peut contester ce score.');
      await c.tx.query("UPDATE score_submissions SET status = 'disputed', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1", [sub.id, ctx.userId, b.reason]);
      if (b.score) { this.evaluate(c, b.score); await this.insertSubmission(c.tx, c, ctx, side, b.score, 'disputed', b.reason); }
      await c.tx.query("UPDATE matches SET status = 'disputed', version = version + 1 WHERE id = $1", [matchId]);
      await audit(c.tx, { orgId: c.a.orgId, tournamentId: c.t.id, actorId: ctx.userId, entity: 'match', entityId: matchId, action: 'score_disputed', after: { submissionId: sub.id, counter: b.score }, reason: b.reason });
      await this.notifier.notify(c.tx, { orgId: c.a.orgId, tournamentId: c.t.id, userIds: await this.organizerUsers(c.tx, c), type: 'score_disputed',
        title: 'Score contesté', body: b.reason, link: `/matches/${matchId}` });
      await LiveEvents.emit(c.tx, c.t.id, 'score_disputed', matchId);
      return { status: 'disputed' };
    });
  }

  /** Validation administrative (organisateur, ou arbitre affecté) : d'une saisie existante ou d'un score fourni. Corrige aussi un résultat officiel. */
  async validate(ctx: RequestContext, matchId: string, body: unknown, inTx?: MatchCtx): Promise<any> {
    const b = ValidateSchema.parse(body);
    const run = async (c: MatchCtx) => {
      const isRef = c.a.referee && c.m.referee_user_id === ctx.userId;
      if (!c.a.organizer && !isRef) throw forbidden('organizer_only', 'Validation réservée à l’organisateur ou à l’arbitre de la rencontre.');
      this.checkVersion(c.m, b.version);
      let score = b.score;
      if (b.submissionId) {
        const sub = await one(c.tx, 'SELECT * FROM score_submissions WHERE id = $1 AND match_id = $2', [b.submissionId, matchId]);
        if (!sub) throw notFound('Saisie');
        score = sub.score;
      }
      if (!score) throw badRequest('score_required', 'Score ou saisie à valider requis', 'score');
      return this.makeOfficial(c, ctx, score, { submissionId: b.submissionId, reason: b.reason, cascade: b.cascade, role: c.a.organizer ? 'organizer' : 'referee' });
    };
    return inTx ? run(inTx) : this.withMatch(ctx, matchId, run);
  }

  /** Forfait sur une rencontre : le côté `loser` perd sur le score de forfait du règlement. */
  async walkover(ctx: RequestContext | null, matchId: string, body: unknown, inTx?: { tx: Tx; a: Access }) {
    const b = z.object({ loser: z.enum(['home', 'away']), reason: z.string().trim().min(2, 'Motif requis').max(500), outcome: z.enum(['walkover', 'disqualified']).default('walkover'), cascade: z.boolean().optional() }).parse(body);
    const run = async (c: MatchCtx) => {
      if (ctx && !c.a.organizer && !(c.a.referee && c.m.referee_user_id === ctx.userId)) throw forbidden('organizer_only', 'Forfait déclaré par l’organisateur ou l’arbitre.');
      if (!c.m.home_id || !c.m.away_id) throw conflict('participants_unknown', 'Participants de la rencontre inconnus.');
      return this.makeOfficial(c, ctx, walkoverScore(c.t.scoring, b.loser), { reason: b.reason, outcome: b.outcome, cascade: b.cascade, role: 'organizer' });
    };
    if (inTx) {
      const m = (await one<MatchRow>(inTx.tx, 'SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]))!;
      const t = await loadTournament(inTx.tx, m.tournament_id);
      const st = await one(inTx.tx, 'SELECT kind FROM stages WHERE id = $1', [m.stage_id]);
      return run({ tx: inTx.tx, a: inTx.a, m, t, knockout: st?.kind === 'knockout' });
    }
    return this.withMatch(ctx!, matchId, run);
  }

  private evaluate(c: MatchCtx, score: ScoreInput): ScoreResult {
    return evaluateScore(c.t.scoring, score, { knockout: c.knockout });
  }

  private async insertSubmission(tx: Tx, c: MatchCtx, ctx: RequestContext | null, role: string, score: ScoreInput, status: string, reason: string | null) {
    return (await one(tx,
      `INSERT INTO score_submissions(org_id, match_id, submitted_by, submitter_role, score, status, reason, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'pending' AND $8 > 0 THEN now() + make_interval(hours => $8) END) RETURNING *`,
      [c.a.orgId, c.m.id, ctx?.userId ?? c.t.created_by, role, JSON.stringify(score), status, reason, c.t.confirmation_hours]))!;
  }

  /** Rend un résultat officiel : historique, propagation (tableau, qualification), recalcul, notifications. */
  private async makeOfficial(c: MatchCtx, ctx: RequestContext | null, score: ScoreInput,
    o: { submissionId?: string; reason?: string; cascade?: boolean; outcome?: 'walkover' | 'disqualified'; role?: 'organizer' | 'referee'; skipOrganizerCheck?: boolean }) {
    const { tx, a, m, t } = c;
    if (!m.home_id || !m.away_id) throw conflict('participants_unknown', 'Les deux participants de la rencontre ne sont pas encore connus.');
    const correction = OFFICIAL.has(m.status) && m.status !== 'bye';
    if (m.status === 'bye') throw conflict('match_bye', 'Rencontre exemptée : aucun score.');
    if (correction) {
      if (!a.organizer) throw forbidden('correction_organizer_only', 'Un résultat officiel ne peut être corrigé que par l’organisateur.');
      if (!o.reason || o.reason.length < 3) throw badRequest('reason_required', 'Motif de correction obligatoire', 'reason');
    }
    if (m.status === 'cancelled') throw conflict('match_closed', 'Rencontre annulée.');
    const ev = o.outcome ? evaluateScore(t.scoring, score, { knockout: false }) : this.evaluate(c, score);
    const winnerId = ev.winner === 'home' ? m.home_id : ev.winner === 'away' ? m.away_id : null;
    const outcome = o.outcome ?? (ev.retired ? 'retired' : 'normal');
    const actor = ctx?.userId ?? null;
    let subId = o.submissionId;
    if (subId) await tx.query("UPDATE score_submissions SET status = 'official', decided_by = coalesce(decided_by, $2), decided_at = coalesce(decided_at, now()) WHERE id = $1", [subId, actor]);
    else if (ctx) subId = (await this.insertSubmission(tx, c, ctx, o.role ?? 'organizer', score, 'official', o.reason ?? null)).id;

    const prog = new Progression(tx, a.orgId, t.id, actor, { cascade: o.cascade, reason: o.reason, notifier: this.notifier });
    await prog.complete(m, { score, result: ev, winnerId, isDraw: ev.winner === null, outcome });
    await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId: actor, entity: 'match', entityId: m.id, action: correction ? 'result_corrected' : 'result_official',
      before: correction ? { score: m.score, winner_id: m.winner_id, outcome: m.outcome } : undefined,
      after: { score, winner_id: winnerId, outcome, submissionId: subId, resetMatches: prog.resetMatches }, reason: o.reason });
    await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: await prog.usersOf([m.home_id, m.away_id]), type: 'score_official',
      title: correction ? 'Résultat corrigé' : 'Résultat validé', link: `/matches/${m.id}` });
    await LiveEvents.emit(tx, t.id, 'score_official', m.id);
    return { status: outcome === 'walkover' ? 'walkover' : 'completed', winnerId, evaluation: ev, correction, resetMatches: prog.resetMatches };
  }

  /** Échéances de confirmation dépassées : validation automatique (si prévue) ou alerte de l'organisateur. */
  async sweepExpired() {
    const due = await this.db.query('SELECT * FROM route_expired_submissions()');
    let validated = 0, flagged = 0;
    for (const d of due) {
      await this.db.orgTx(d.org_id, async (tx) => {
        const sub = await one(tx, "SELECT * FROM score_submissions WHERE id = $1 AND status = 'pending' FOR UPDATE", [d.submission_id]);
        if (!sub) return;
        const m = (await one<MatchRow>(tx, 'SELECT * FROM matches WHERE id = $1 FOR UPDATE', [d.match_id]))!;
        const t = await loadTournament(tx, m.tournament_id);
        const st = await one(tx, 'SELECT kind FROM stages WHERE id = $1', [m.stage_id]);
        const a: Access = { tournamentId: t.id, orgId: d.org_id, organizer: true, referee: false, participantIds: [], captainOf: [] };
        const c: MatchCtx = { tx, a, m, t, knockout: st?.kind === 'knockout' };
        if (t.auto_confirm_on_timeout && (sub.submitter_role === 'home' || sub.submitter_role === 'away')) {
          await tx.query("UPDATE score_submissions SET status = 'confirmed', decided_at = now(), reason = 'Délai de confirmation dépassé' WHERE id = $1", [sub.id]);
          await this.makeOfficial(c, null, sub.score, { submissionId: sub.id, reason: 'Validation automatique : délai de confirmation dépassé' });
          validated++;
        } else {
          await tx.query('UPDATE score_submissions SET expires_at = NULL WHERE id = $1', [sub.id]);
          await this.notifier.notify(tx, { orgId: d.org_id, tournamentId: t.id, userIds: await this.organizerUsers(tx, c), type: 'score_to_confirm',
            title: 'Score non confirmé dans le délai', body: 'Validez ou corrigez le score en attente.', link: `/matches/${m.id}` });
          flagged++;
        }
      }).catch((e) => console.error('[sweep]', e?.message));
    }
    return { validated, flagged };
  }
}

export { AppError };
