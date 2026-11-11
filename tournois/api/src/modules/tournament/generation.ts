/**
 * Génération (§5.1) : phases, poules, rencontres et tableau à partir du format retenu, puis planification
 * sur les terrains et créneaux. Le germe du tirage est conservé (tirage rejouable, auditable).
 */
import { Injectable } from '@nestjs/common';
import { Access } from '../../core/access';
import { randomInt31 } from '../../core/crypto';
import { Tx, many, one } from '../../core/db';
import { badRequest, conflict } from '../../core/errors';
import { audit, LiveEvents, Notifier } from '../../core/services';
import { buildBracket, crossGroupPlacement, distributeGroups, EntrantRef, groupName, roundRobin, rng, shuffle } from '../../engine/draw';
import { schedule } from '../../engine/schedule';
import { Progression } from './progression';
import { loadState, loadTournament, MatchRow, OFFICIAL, TournamentRow } from './state';

/**
 * Registre des formats : chaque format décrit ses phases à partir des phases génériques
 * (toutes-contre-toutes, élimination directe). Un nouveau format (suisse, Americano…) s'ajoute ici
 * avec son propre générateur de phase, sans modifier le moteur de résultats ni de classements.
 */
export const FORMATS = {
  groups: { label: 'Poules', stages: ['round_robin'] },
  league: { label: 'Championnat', stages: ['round_robin'] },
  knockout: { label: 'Élimination directe', stages: ['knockout'] },
  groups_knockout: { label: 'Poules puis tableau final', stages: ['round_robin', 'knockout'] },
} as const;

/** Vérifie la faisabilité du format avec n participants (assistant : message clair avant génération). */
export function checkFormat(t: Pick<TournamentRow, 'format' | 'format_config'>, n: number): string[] {
  const errors: string[] = [];
  if (n < 2) errors.push('Au moins deux participants confirmés sont nécessaires.');
  if (t.format === 'groups' || t.format === 'groups_knockout') {
    const g = t.format_config?.groups;
    if (!g?.count) { errors.push('Nombre de poules à définir.'); return errors; }
    if (n < g.count * 2) errors.push(`${g.count} poules demandent au moins ${g.count * 2} participants (${n} confirmés).`);
    if (t.format === 'groups_knockout') {
      const minSize = Math.floor(n / g.count);
      if ((g.qualifiers ?? 2) > minSize) errors.push(`${g.qualifiers} qualifiés par poule pour des poules de ${minSize} : impossible.`);
      if ((g.qualifiers ?? 2) * g.count < 2) errors.push('Au moins deux qualifiés au total pour le tableau final.');
    }
  }
  return errors;
}

@Injectable()
export class GenerationService {
  constructor(private notifier: Notifier) {}

  async generate(tx: Tx, a: Access, actorId: string, opts: { reason?: string } = {}) {
    const t = await loadTournament(tx, a.tournamentId, true);
    const existing = await many<MatchRow>(tx, 'SELECT id, status FROM matches WHERE tournament_id = $1', [t.id]);
    const played = existing.filter((m) => OFFICIAL.has(m.status) && m.status !== 'bye').length;
    const pendingScores = existing.filter((m) => ['awaiting_confirmation', 'disputed', 'in_progress'].includes(m.status)).length;
    if (played || pendingScores) throw conflict('already_played', `Génération impossible : ${played + pendingScores} rencontre(s) déjà jouée(s) ou en cours. Corrigez les rencontres individuellement.`);
    if (existing.length) await tx.query('DELETE FROM stages WHERE tournament_id = $1', [t.id]);

    const participants = await many(tx,
      `SELECT id, name, rating, seed FROM participants WHERE tournament_id = $1 AND status = 'confirmed'
        ORDER BY seed NULLS LAST, rating DESC NULLS LAST, created_at, id`, [t.id]);
    const errors = checkFormat(t, participants.length);
    if (errors.length) throw badRequest('format_not_feasible', errors.join(' '));
    const ids: string[] = participants.map((p) => p.id);
    const drawSeed = randomInt31();
    const cfg = t.format_config ?? {};

    const insertStage = async (idx: number, kind: string, name: string, config: unknown, source?: string) =>
      (await one(tx, `INSERT INTO stages(org_id, tournament_id, idx, kind, name, config, source_stage_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'running') RETURNING id`,
        [a.orgId, t.id, idx, kind, name, JSON.stringify(config ?? {}), source ?? null]))!.id as string;

    let groupStageId: string | undefined;
    let groupNames: string[] = [];
    if (t.format === 'groups' || t.format === 'groups_knockout' || t.format === 'league') {
      const league = t.format === 'league';
      const gcfg = league ? { count: 1, distribution: 'snake', legs: cfg.league?.legs ?? 1 } : cfg.groups;
      groupStageId = await insertStage(0, 'round_robin', league ? 'Championnat' : 'Phase de poules', { ...gcfg });
      const groups = distributeGroups(ids, gcfg.count, gcfg.distribution ?? 'snake', drawSeed);
      for (let gi = 0; gi < groups.length; gi++) {
        const name = league ? 'Championnat' : groupName(gi);
        groupNames.push(name);
        const g = await one(tx, 'INSERT INTO groups(org_id, stage_id, name, idx) VALUES ($1,$2,$3,$4) RETURNING id', [a.orgId, groupStageId, name, gi]);
        for (let pi = 0; pi < groups[gi].length; pi++) {
          await tx.query('INSERT INTO group_members(org_id, group_id, participant_id, position) VALUES ($1,$2,$3,$4)', [a.orgId, g!.id, groups[gi][pi], pi + 1]);
        }
        const pairings = roundRobin(groups[gi], gcfg.legs ?? 1);
        let n = 0;
        for (const p of pairings) {
          await tx.query(
            `INSERT INTO matches(org_id, tournament_id, stage_id, group_id, key, round, position, leg, home_id, away_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [a.orgId, t.id, groupStageId, g!.id, `${league ? 'J' : name}-${++n}`, p.round, n, p.leg, p.home, p.away]);
        }
      }
    }

    if (t.format === 'knockout' || t.format === 'groups_knockout') {
      const kcfg = cfg.knockout ?? {};
      let bracket;
      if (t.format === 'knockout') {
        const order = kcfg.seeding === 'random' ? shuffle(ids, rng(drawSeed)) : ids;
        bracket = buildBracket(order.map((id): EntrantRef => ({ kind: 'participant', id })), { thirdPlace: !!kcfg.thirdPlace });
      } else {
        const q = cfg.groups.qualifiers ?? 2;
        const placement = crossGroupPlacement(groupNames, q, cfg.groups.avoidSameGroup !== false);
        bracket = buildBracket(placement.filter((p) => p.kind !== 'bye') as EntrantRef[], { thirdPlace: !!kcfg.thirdPlace, placement });
      }
      const koId = await insertStage(t.format === 'knockout' ? 0 : 1, 'knockout', t.format === 'knockout' ? 'Tableau' : 'Tableau final',
        { ...kcfg, size: bracket.size, rounds: bracket.rounds }, groupStageId);
      if (groupStageId) await tx.query("UPDATE stages SET status = 'pending' WHERE id = $1", [koId]);
      for (const m of bracket.matches) {
        const pid = (s: any) => (s.kind === 'participant' ? s.id : null);
        await tx.query(
          `INSERT INTO matches(org_id, tournament_id, stage_id, key, round, position, home_id, away_id, home_source, away_source, next_key, next_slot, loser_next_key, loser_next_slot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [a.orgId, t.id, koId, m.key, m.round, m.position, pid(m.home), pid(m.away), JSON.stringify(m.home), JSON.stringify(m.away),
            m.next?.key ?? null, m.next?.slot ?? null, m.loserNext?.key ?? null, m.loserNext?.slot ?? null]);
      }
      // Exemptions : le participant exempté passe directement au tour suivant.
      const prog = new Progression(tx, a.orgId, t.id, actorId, { notifier: this.notifier });
      const byes = await many<MatchRow>(tx, `SELECT * FROM matches WHERE stage_id = $1 AND round = 1 AND (home_source->>'kind' = 'bye' OR away_source->>'kind' = 'bye') ORDER BY position`, [koId]);
      for (const b of byes) {
        const winner = b.home_id ?? b.away_id;
        if (winner) await prog.complete(b, { score: null, result: null, winnerId: winner, isDraw: false, outcome: 'bye' });
      }
    }

    await tx.query(`UPDATE tournaments SET status = 'running', generated_at = now(), draw_seed = $2, version = version + 1 WHERE id = $1`, [t.id, drawSeed]);
    const plan = await this.autoSchedule(tx, t.id);
    await audit(tx, { orgId: a.orgId, tournamentId: t.id, actorId, entity: 'tournament', entityId: t.id, action: existing.length ? 'regenerated' : 'generated',
      after: { participants: ids.length, drawSeed, format: t.format }, reason: opts.reason });
    // Convocation des joueurs dont la première rencontre est connue.
    const first = await many(tx, `SELECT DISTINCT pm.user_id FROM matches m JOIN participant_members pm ON pm.participant_id IN (m.home_id, m.away_id)
      WHERE m.tournament_id = $1 AND m.home_id IS NOT NULL AND m.away_id IS NOT NULL AND m.status IN ('scheduled','to_schedule') AND pm.user_id IS NOT NULL`, [t.id]);
    await this.notifier.notify(tx, { orgId: a.orgId, tournamentId: t.id, userIds: first.map((r) => r.user_id), type: 'match_announced',
      title: `${t.name} : vos rencontres sont publiées`, body: 'Consultez vos adversaires, terrains et horaires.', link: `/t/${t.id}` });
    await LiveEvents.emit(tx, t.id, 'generated');
    return { matches: (await many(tx, 'SELECT count(*)::int n FROM matches WHERE tournament_id = $1', [t.id]))[0].n, ...plan };
  }

  /**
   * Planification automatique des rencontres non verrouillées : ordre des tours, alternance des poules,
   * dépendances (tour précédent, fin de poule), aucun participant sur deux rencontres au même créneau.
   */
  async autoSchedule(tx: Tx, tournamentId: string) {
    const s = await loadState(tx, tournamentId);
    const slotMs = (s.t.match_minutes + s.t.break_minutes) * 60_000;
    const start = new Date(s.t.starts_at).getTime();
    const maxSlots = s.t.ends_at ? Math.max(1, Math.floor((new Date(s.t.ends_at).getTime() - start) / slotMs)) : undefined;
    const stageIdx = new Map(s.stages.map((x) => [x.id, x.idx]));
    const groupIdx = new Map(s.groups.map((g) => [g.id, g.idx]));
    const candidates = s.matches.filter((m) => m.status !== 'bye' && m.status !== 'cancelled');
    candidates.sort((x, y) => (stageIdx.get(x.stage_id)! - stageIdx.get(y.stage_id)!) || (x.round - y.round)
      || ((groupIdx.get(x.group_id ?? '') ?? 0) - (groupIdx.get(y.group_id ?? '') ?? 0)) || (x.position - y.position));
    const byKey = new Map(s.matches.map((m) => [`${m.stage_id}:${m.key}`, m]));
    const groupByName = new Map(s.groups.map((g) => [`${g.stage_id}:${g.name}`, g.id]));
    const groupStageOf = new Map(s.stages.map((st) => [st.id, st.source_stage_id]));
    const deps = (m: MatchRow): string[] => {
      const out: string[] = [];
      for (const src of [m.home_source, m.away_source]) {
        if (!src) continue;
        if (src.kind === 'winner' || src.kind === 'loser') {
          const d = byKey.get(`${m.stage_id}:${src.match}`);
          if (d && d.status !== 'bye') out.push(d.id);
        }
        if (src.kind === 'group') {
          const gid = groupByName.get(`${groupStageOf.get(m.stage_id)}:${src.group}`);
          out.push(...s.matches.filter((x) => x.group_id === gid).map((x) => x.id));
        }
      }
      return out;
    };
    const fixedOf = (m: MatchRow) => {
      if (!(m.schedule_locked || OFFICIAL.has(m.status) || ['in_progress', 'awaiting_confirmation', 'disputed'].includes(m.status)) || !m.scheduled_at || !m.court) return undefined;
      return { court: m.court, slot: Math.round((new Date(m.scheduled_at).getTime() - start) / slotMs) };
    };
    const res = schedule(candidates.map((m) => ({ id: m.id, participants: [m.home_id, m.away_id].filter((x): x is string => !!x), after: deps(m), fixed: fixedOf(m) })),
      { courts: s.t.courts, maxSlots });
    for (const m of candidates) {
      if (fixedOf(m)) continue;
      const p = res.placed.get(m.id);
      await tx.query(
        `UPDATE matches SET court = $2, scheduled_at = $3,
           status = CASE WHEN status IN ('to_schedule','scheduled') THEN (CASE WHEN $2::int IS NULL THEN 'to_schedule' ELSE 'scheduled' END) ELSE status END
         WHERE id = $1`,
        [m.id, p?.court ?? null, p ? new Date(start + p.slot * slotMs) : null]);
    }
    const lastSlot = Math.max(-1, ...[...res.placed.values()].map((p) => p.slot));
    return {
      scheduled: res.placed.size, unscheduled: res.unplaced.length,
      estimatedEnd: lastSlot >= 0 ? new Date(start + (lastSlot + 1) * slotMs).toISOString() : null,
      warnings: res.unplaced.length ? [`${res.unplaced.length} rencontre(s) hors de la plage horaire : ajoutez des terrains, réduisez la durée des matchs ou prolongez la journée.`] : [],
    };
  }
}
