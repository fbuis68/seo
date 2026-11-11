/**
 * Classements (§8) calculés à partir des seuls résultats officiels : poules/championnat, statut de
 * qualification (provisoire tant que la poule n'est pas terminée), classement général du tournoi.
 */
import { computeStandings, DEFAULT_POINTS, DEFAULT_TIEBREAKERS, PlayedMatch, StandingRow } from '../../engine/standings';
import { roundLabel } from '../../engine/draw';
import { CLOSED, MatchRow, OFFICIAL, StageRow, TournamentState } from './state';

export type QualificationStatus = 'qualified' | 'provisional' | 'tie' | 'eliminated' | null;
export interface GroupStanding extends StandingRow { name: string; qualification: QualificationStatus; manual?: boolean; }
export interface GroupTable { groupId: string; name: string; complete: boolean; rows: GroupStanding[]; pendingMatches: number; }

export function toPlayed(m: MatchRow): PlayedMatch | null {
  if (!OFFICIAL.has(m.status) || m.status === 'bye' || !m.home_id || !m.away_id || !m.result) return null;
  const r = m.result;
  return {
    home: m.home_id, away: m.away_id, winner: m.is_draw ? null : m.winner_id === m.home_id ? 'home' : 'away',
    setsHome: r.setsHome ?? 0, setsAway: r.setsAway ?? 0, gamesHome: r.gamesHome ?? 0, gamesAway: r.gamesAway ?? 0,
    walkover: m.outcome === 'walkover', penaltyHome: m.penalty_home, penaltyAway: m.penalty_away,
  };
}

export function groupTables(s: TournamentState, stage: StageRow): GroupTable[] {
  const names = new Map(s.participants.map((p) => [p.id, p.name]));
  const seeds = new Map(s.participants.map((p, i) => [p.id, p.seed ?? i + 1]));
  const qualifiers = s.t.format === 'groups_knockout' ? Number(s.t.format_config?.groups?.qualifiers ?? 2) : 0;
  const manual: Record<string, string[]> = stage.config?.manualOrder ?? {};
  return s.groups.filter((g) => g.stage_id === stage.id).map((g) => {
    const ids = s.groupMembers.filter((x) => x.group_id === g.id).map((x) => x.participant_id);
    const ms = s.matches.filter((m) => m.group_id === g.id);
    const played = ms.map(toPlayed).filter((x): x is PlayedMatch => !!x);
    const pending = ms.filter((m) => !CLOSED.has(m.status)).length;
    let rows: GroupStanding[] = computeStandings(ids, played, {
      points: s.t.ranking_rules?.points ?? DEFAULT_POINTS,
      tiebreakers: s.t.ranking_rules?.tiebreakers ?? DEFAULT_TIEBREAKERS,
      seeds,
    }).map((r) => ({ ...r, name: names.get(r.participantId) ?? '?', qualification: null }));
    rows = applyManualOrder(rows, manual[g.name]);
    const complete = pending === 0 && ms.length > 0;
    if (qualifiers) {
      for (const r of rows) {
        // Égalité non départagée sur une place qualificative : la place dans le tableau dépend du rang,
        // l'organisateur arbitre (règlement, tirage au sort) avant le passage au tour suivant.
        if (r.tied && r.rank <= qualifiers) r.qualification = complete ? 'tie' : 'provisional';
        else if (r.rank <= qualifiers) r.qualification = complete ? 'qualified' : 'provisional';
        else r.qualification = complete ? 'eliminated' : null;
      }
    }
    return { groupId: g.id, name: g.name, complete, rows, pendingMatches: pending };
  });
}

/** Ordre imposé par l'organisateur (tirage au sort, règlement) pour départager des ex æquo. */
function applyManualOrder(rows: GroupStanding[], order?: string[]): GroupStanding[] {
  if (!order?.length) return rows;
  const out = [...rows];
  const byRank = new Map<number, GroupStanding[]>();
  for (const r of out) byRank.set(r.rank, [...(byRank.get(r.rank) ?? []), r]);
  for (const [rank, bucket] of byRank) {
    if (bucket.length < 2 || !bucket.every((r) => order.includes(r.participantId))) continue;
    bucket.sort((a, b) => order.indexOf(a.participantId) - order.indexOf(b.participantId));
    bucket.forEach((r, i) => { r.rank = rank + i; r.tied = false; r.manual = true; });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** Participant classé à un rang d'une poule, seulement si la poule est terminée et le rang départagé. */
export function qualifierAt(tables: GroupTable[], group: string, rank: number): string | null {
  const t = tables.find((x) => x.name === group);
  if (!t || !t.complete) return null;
  const at = t.rows.filter((r) => r.rank === rank);
  return at.length === 1 ? at[0].participantId : null; // rang partagé : en attente d'arbitrage
}

export interface FinalRow { rank: number; tied: boolean; participantId: string; name: string; reached?: string; }

/**
 * Classement général (§8.2) : tableau final (tour atteint, petite finale) puis non-qualifiés par rang de poule ;
 * ex æquo affichés lorsqu'aucun départage sportif n'existe (perdants d'un même tour).
 */
export function finalRanking(s: TournamentState): { complete: boolean; rows: FinalRow[] } {
  const names = new Map(s.participants.map((p) => [p.id, p.name]));
  const rows: FinalRow[] = [];
  const ko = s.stages.find((x) => x.kind === 'knockout');
  const rr = s.stages.find((x) => x.kind === 'round_robin');
  const placed = new Set<string>();
  let complete = s.matches.length > 0 && s.matches.every((m) => CLOSED.has(m.status));
  if (ko) {
    const ms = s.matches.filter((m) => m.stage_id === ko.id);
    const rounds = Math.max(...ms.filter((m) => m.key !== 'P3').map((m) => m.round));
    const final = ms.find((m) => m.round === rounds && m.key !== 'P3');
    const p3 = ms.find((m) => m.key === 'P3');
    const push = (id: string | null, rank: number, tied: boolean, reached: string) => {
      if (!id || placed.has(id)) return;
      placed.add(id); rows.push({ rank, tied, participantId: id, name: names.get(id) ?? '?', reached });
    };
    const loser = (m?: MatchRow) => (m && OFFICIAL.has(m.status) && m.winner_id ? (m.winner_id === m.home_id ? m.away_id : m.home_id) : null);
    if (final && OFFICIAL.has(final.status)) { push(final.winner_id, 1, false, 'Vainqueur'); push(loser(final), 2, false, 'Finaliste'); }
    let rank = 3;
    if (p3 && OFFICIAL.has(p3.status)) { push(p3.winner_id, 3, false, 'Petite finale'); push(loser(p3), 4, false, 'Petite finale'); rank = 5; }
    for (let r = rounds - 1; r >= 1; r--) {
      if (r === rounds - 1 && p3) continue; // demi-finalistes déjà classés par la petite finale
      const losers = ms.filter((m) => m.round === r && m.status !== 'bye').map(loser).filter((x): x is string => !!x && !placed.has(x));
      for (const l of losers) push(l, rank, losers.length > 1, roundLabel(r, rounds));
      rank += losers.length;
    }
  }
  if (rr) {
    const tables = groupTables(s, rr);
    complete = complete && tables.every((t) => t.complete);
    const start = rows.length + 1;
    // Non-qualifiés : par rang de poule ; même rang dans des poules différentes = ex æquo.
    const maxRank = Math.max(0, ...tables.flatMap((t) => t.rows.map((r) => r.rank)));
    let rank = start;
    for (let r = 1; r <= maxRank; r++) {
      const atRank = tables.flatMap((t) => t.rows.filter((x) => x.rank === r && !placed.has(x.participantId)));
      if (!atRank.length) continue;
      const single = tables.length === 1 && atRank.length === 1 && !atRank[0].tied;
      for (const x of atRank) { placed.add(x.participantId); rows.push({ rank, tied: !single && atRank.length > 1, participantId: x.participantId, name: x.name, reached: tables.length > 1 ? `${r}e de poule` : undefined }); }
      rank += atRank.length;
    }
  }
  return { complete, rows };
}
