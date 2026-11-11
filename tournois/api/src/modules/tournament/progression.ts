/**
 * Enchaînement des phases (§4.3, §4.4, §6.6, §8.3) : passage des vainqueurs, exemptions,
 * qualification depuis les poules, et vérification des phases suivantes lors d'une correction.
 *
 * Tout se fait dans la transaction du résultat : un passage de tour n'existe jamais sans le résultat
 * officiel qui le justifie (et disparaît avec lui en cas d'annulation).
 */
import { Tx, many, one } from '../../core/db';
import { conflict } from '../../core/errors';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { evaluateScore, walkoverScore } from '../../engine/scoring';
import { finalRanking, groupTables, qualifierAt } from './rankings';
import { CLOSED, loadState, MatchRow, OFFICIAL, StageRow } from './state';

export interface OfficialResult {
  score: unknown; result: unknown; winnerId: string | null; isDraw: boolean;
  outcome: 'normal' | 'walkover' | 'retired' | 'disqualified' | 'bye';
}

export class Progression {
  /** Rencontres réinitialisées par une correction en cascade (rapport à l'organisateur). */
  readonly resetMatches: string[] = [];

  constructor(private tx: Tx, private orgId: string, private tournamentId: string, private actorId: string | null,
    private opts: { cascade?: boolean; reason?: string; notifier?: Notifier } = {}) {}

  private async match(stageId: string, key: string) {
    return one<MatchRow>(this.tx, 'SELECT * FROM matches WHERE stage_id = $1 AND key = $2 FOR UPDATE', [stageId, key]);
  }

  /** Enregistre un résultat officiel puis propage ses conséquences. */
  async complete(m: MatchRow, r: OfficialResult) {
    const status = r.outcome === 'walkover' ? 'walkover' : r.outcome === 'bye' ? 'bye' : 'completed';
    await this.tx.query(
      `UPDATE matches SET score = $2, result = $3, winner_id = $4, is_draw = $5, outcome = $6, status = $7,
         completed_at = now(), version = version + 1 WHERE id = $1`,
      [m.id, JSON.stringify(r.score ?? null), JSON.stringify(r.result ?? null), r.winnerId, r.isDraw, r.outcome, status]);
    await this.tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status IN ('pending','disputed')", [m.id]);
    const updated = (await one<MatchRow>(this.tx, 'SELECT * FROM matches WHERE id = $1', [m.id]))!;
    await this.after(updated);
  }

  /** Place (ou retire) un participant dans une case d'une rencontre du tableau. */
  async place(stageId: string, key: string, slot: 'home' | 'away', pid: string | null) {
    const m = await this.match(stageId, key);
    if (!m) return;
    const col = slot === 'home' ? 'home_id' : 'away_id';
    if ((m as any)[col] === pid) return;
    if (OFFICIAL.has(m.status)) {
      if (m.status !== 'bye' && !this.opts.cascade) {
        throw conflict('downstream_played', `La rencontre ${key} de la phase suivante est déjà jouée : confirmez la correction en cascade (ses résultats seront annulés).`, { matchId: m.id, key });
      }
      await this.reset(m);
    }
    await this.tx.query(`UPDATE matches SET ${col} = $2, version = version + 1 WHERE id = $1`, [m.id, pid]);
    await this.tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status IN ('pending','disputed')", [m.id]);
    const fresh = (await one<MatchRow>(this.tx, 'SELECT * FROM matches WHERE id = $1', [m.id]))!;
    if (fresh.status === 'awaiting_confirmation' || fresh.status === 'disputed') {
      await this.tx.query(`UPDATE matches SET status = CASE WHEN scheduled_at IS NULL THEN 'to_schedule' ELSE 'scheduled' END WHERE id = $1`, [m.id]);
    }
    const other = slot === 'home' ? fresh.away_source : fresh.home_source;
    if (pid && other?.kind === 'bye') {
      await this.complete(fresh, { score: null, result: null, winnerId: pid, isDraw: false, outcome: 'bye' });
      return;
    }
    // Participant déclaré forfait avant d'être placé : la rencontre est gagnée par forfait par l'adversaire.
    if (fresh.home_id && fresh.away_id) {
      const ff = await many(this.tx, "SELECT id FROM participants WHERE id = ANY($1) AND status = 'forfeit'", [[fresh.home_id, fresh.away_id]]);
      if (ff.length === 1) {
        const loser: 'home' | 'away' = ff[0].id === fresh.home_id ? 'home' : 'away';
        const t = await one(this.tx, 'SELECT scoring FROM tournaments WHERE id = $1', [this.tournamentId]);
        const score = walkoverScore(t.scoring, loser);
        await this.complete(fresh, { score, result: evaluateScore(t.scoring, score), winnerId: loser === 'home' ? fresh.away_id : fresh.home_id, isDraw: false, outcome: 'walkover' });
        return;
      }
    }
    if (fresh.home_id && fresh.away_id && this.opts.notifier) {
      const users = await this.usersOf([fresh.home_id, fresh.away_id]);
      await this.opts.notifier.notify(this.tx, { orgId: this.orgId, tournamentId: this.tournamentId, userIds: users, type: 'match_announced',
        title: 'Prochaine rencontre annoncée', body: 'Votre adversaire est connu : consultez l’horaire et le terrain.', link: `/matches/${fresh.id}` });
    }
  }

  /** Annule un résultat (correction en cascade) et retire ses conséquences des tours suivants. */
  async reset(m: MatchRow) {
    if (m.winner_id && m.next_key) await this.place(m.stage_id, m.next_key, m.next_slot!, null);
    if (m.winner_id && m.loser_next_key) await this.place(m.stage_id, m.loser_next_key, m.loser_next_slot!, null);
    await this.tx.query(
      `UPDATE matches SET score = NULL, result = NULL, winner_id = NULL, is_draw = false, outcome = NULL, completed_at = NULL,
         status = CASE WHEN scheduled_at IS NULL THEN 'to_schedule' ELSE 'scheduled' END, version = version + 1 WHERE id = $1`, [m.id]);
    await this.tx.query("UPDATE score_submissions SET status = 'superseded' WHERE match_id = $1 AND status IN ('pending','disputed','official')", [m.id]);
    if (m.status !== 'bye') {
      this.resetMatches.push(m.id);
      await audit(this.tx, { orgId: this.orgId, tournamentId: this.tournamentId, actorId: this.actorId, entity: 'match', entityId: m.id, action: 'result_reset',
        before: { score: m.score, winner_id: m.winner_id, status: m.status }, reason: this.opts.reason ?? 'Correction en cascade d’un tour précédent' });
    }
  }

  private async after(m: MatchRow) {
    const stage = (await one<StageRow>(this.tx, 'SELECT * FROM stages WHERE id = $1', [m.stage_id]))!;
    if (stage.kind === 'knockout') {
      const loser = m.winner_id ? (m.winner_id === m.home_id ? m.away_id : m.home_id) : null;
      if (m.next_key) await this.place(stage.id, m.next_key, m.next_slot!, m.winner_id);
      if (m.loser_next_key) await this.place(stage.id, m.loser_next_key, m.loser_next_slot!, m.status === 'bye' ? null : loser);
    }
    await this.refreshStage(stage);
  }

  /** Statut de phase ; une phase de poules terminée remplit le tableau final. */
  async refreshStage(stage: StageRow) {
    const [{ open, total }] = await many(this.tx,
      `SELECT count(*) FILTER (WHERE status NOT IN ('completed','walkover','bye','cancelled'))::int open, count(*)::int total FROM matches WHERE stage_id = $1`, [stage.id]);
    const status = total && open === 0 ? 'completed' : 'running';
    if (status !== stage.status) await this.tx.query('UPDATE stages SET status = $2 WHERE id = $1', [stage.id, status]);
    const next = await one<StageRow>(this.tx, 'SELECT * FROM stages WHERE source_stage_id = $1', [stage.id]);
    if (next && stage.kind === 'round_robin') await this.fillFromGroups(stage, next);
    await this.refreshTournament();
  }

  /**
   * Qualification automatique : chaque case « Ne de poule X » reçoit le participant classé, uniquement si la
   * poule est terminée et le rang départagé (sinon la case reste vide : qualification en attente).
   */
  async fillFromGroups(groupStage: StageRow, ko: StageRow) {
    const s = await loadState(this.tx, this.tournamentId);
    const tables = groupTables(s, groupStage);
    const newlyQualified: string[] = [];
    for (const m of s.matches.filter((x) => x.stage_id === ko.id && x.round === 1)) {
      for (const slot of ['home', 'away'] as const) {
        const src = slot === 'home' ? m.home_source : m.away_source;
        if (src?.kind !== 'group') continue;
        const pid = qualifierAt(tables, src.group, src.rank);
        const current = slot === 'home' ? m.home_id : m.away_id;
        if (pid !== current) {
          await this.place(ko.id, m.key, slot, pid);
          if (pid) newlyQualified.push(pid);
        }
      }
    }
    if (newlyQualified.length && this.opts.notifier) {
      await this.opts.notifier.notify(this.tx, { orgId: this.orgId, tournamentId: this.tournamentId, userIds: await this.usersOf(newlyQualified),
        type: 'qualified', title: 'Qualifié pour la phase finale', body: 'Félicitations, vous êtes qualifié pour le tableau final.', link: `/t/${this.tournamentId}` });
    }
    const [{ n }] = await many(this.tx, `SELECT count(*)::int n FROM matches WHERE stage_id = $1 AND status NOT IN ('completed','walkover','bye','cancelled')`, [ko.id]);
    await this.tx.query('UPDATE stages SET status = $2 WHERE id = $1', [ko.id, n === 0 ? 'completed' : tables.every((t) => t.complete) ? 'running' : 'pending']);
  }

  /** Tournoi terminé quand toutes les rencontres sont closes : publication du classement final. */
  async refreshTournament() {
    const t = await one(this.tx, 'SELECT status FROM tournaments WHERE id = $1', [this.tournamentId]);
    const [{ open, total }] = await many(this.tx,
      `SELECT count(*) FILTER (WHERE status NOT IN ('completed','walkover','bye','cancelled'))::int open, count(*)::int total FROM matches WHERE tournament_id = $1`, [this.tournamentId]);
    const finished = total > 0 && open === 0;
    if (finished && t.status === 'running') {
      const s = await loadState(this.tx, this.tournamentId);
      if (!finalRanking(s).complete) return;
      await this.tx.query("UPDATE tournaments SET status = 'finished' WHERE id = $1", [this.tournamentId]);
      if (this.opts.notifier) {
        const users = (await many(this.tx, 'SELECT DISTINCT user_id FROM participant_members WHERE tournament_id = $1 AND user_id IS NOT NULL', [this.tournamentId])).map((r) => r.user_id);
        await this.opts.notifier.notify(this.tx, { orgId: this.orgId, tournamentId: this.tournamentId, userIds: users, type: 'final_ranking',
          title: 'Classement final publié', body: 'Le tournoi est terminé : consultez le classement final.', link: `/t/${this.tournamentId}` });
      }
    } else if (!finished && t.status === 'finished') {
      await this.tx.query("UPDATE tournaments SET status = 'running' WHERE id = $1", [this.tournamentId]);
    }
    await LiveEvents.emit(this.tx, this.tournamentId, 'progress');
  }

  async usersOf(participantIds: (string | null)[]): Promise<string[]> {
    const ids = participantIds.filter((x): x is string => !!x);
    if (!ids.length) return [];
    return (await many(this.tx, 'SELECT user_id FROM participant_members WHERE participant_id = ANY($1) AND user_id IS NOT NULL', [ids])).map((r) => r.user_id);
  }
}

export const isClosed = (status: string) => CLOSED.has(status);
