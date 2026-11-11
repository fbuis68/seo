import { Tx, many, one } from '../../core/db';
import { notFound } from '../../core/errors';
import type { ScoringRules } from '../../engine/scoring';
import type { PointsTable, Tiebreaker } from '../../engine/standings';

export interface TournamentRow {
  id: string; org_id: string; slug: string; name: string; discipline: string; starts_at: Date; ends_at: Date | null;
  venue_name: string | null; max_participants: number; mode: 'single' | 'double' | 'team';
  format: 'groups' | 'league' | 'knockout' | 'groups_knockout'; format_config: any; scoring: ScoringRules;
  ranking_rules: { points?: PointsTable; tiebreakers?: Tiebreaker[] }; rules_version: number;
  courts: number; match_minutes: number; break_minutes: number; visibility: 'public' | 'private'; registration: any;
  referee_mode: 'none' | 'optional' | 'required'; referee_official: boolean; confirmation_hours: number; auto_confirm_on_timeout: boolean;
  branding: any; status: string; published_at: Date | null; generated_at: Date | null; draw_seed: number | null; created_by: string | null; version: number;
}
export interface StageRow { id: string; idx: number; kind: 'round_robin' | 'knockout'; name: string; config: any; source_stage_id: string | null; status: string; }
export interface GroupRow { id: string; stage_id: string; name: string; idx: number; }
export interface MatchRow {
  id: string; org_id: string; tournament_id: string; stage_id: string; group_id: string | null; key: string; round: number; position: number; leg: number;
  home_id: string | null; away_id: string | null; home_source: any; away_source: any;
  next_key: string | null; next_slot: 'home' | 'away' | null; loser_next_key: string | null; loser_next_slot: 'home' | 'away' | null;
  status: string; court: number | null; scheduled_at: Date | null; schedule_locked: boolean; referee_user_id: string | null;
  score: any; winner_id: string | null; is_draw: boolean; outcome: string | null; result: any; penalty_home: number; penalty_away: number; version: number;
  completed_at: Date | null;
}
export interface ParticipantRow { id: string; name: string; club: string | null; category: string | null; rating: number | null; seed: number | null; status: string; checked_in_at: Date | null; created_at: Date; }

export async function loadTournament(tx: Tx, id: string, forUpdate = false): Promise<TournamentRow> {
  const t = await one<TournamentRow>(tx, `SELECT * FROM tournaments WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!t) throw notFound('Tournoi');
  return t;
}

export interface TournamentState {
  t: TournamentRow;
  stages: StageRow[];
  groups: GroupRow[];
  groupMembers: { group_id: string; participant_id: string; position: number }[];
  matches: MatchRow[];
  participants: ParticipantRow[];
}

export async function loadState(tx: Tx, tournamentId: string): Promise<TournamentState> {
  const t = await loadTournament(tx, tournamentId);
  // Requêtes séquentielles : une seule connexion par transaction.
  const stages = await many<StageRow>(tx, 'SELECT * FROM stages WHERE tournament_id = $1 ORDER BY idx', [tournamentId]);
  const groups = await many<GroupRow>(tx, 'SELECT g.* FROM groups g JOIN stages s ON s.id = g.stage_id WHERE s.tournament_id = $1 ORDER BY g.idx', [tournamentId]);
  const groupMembers = await many(tx, 'SELECT gm.group_id, gm.participant_id, gm.position FROM group_members gm JOIN groups g ON g.id = gm.group_id JOIN stages s ON s.id = g.stage_id WHERE s.tournament_id = $1 ORDER BY gm.position', [tournamentId]);
  const matches = await many<MatchRow>(tx, 'SELECT * FROM matches WHERE tournament_id = $1 ORDER BY round, position, key', [tournamentId]);
  const participants = await many<ParticipantRow>(tx, 'SELECT id, name, club, category, rating, seed, status, checked_in_at, created_at FROM participants WHERE tournament_id = $1 ORDER BY seed NULLS LAST, rating DESC NULLS LAST, created_at', [tournamentId]);
  return { t, stages, groups, groupMembers, matches, participants };
}

/** Statuts d'une rencontre dont le résultat est officiel (comptent au classement et font avancer le tableau). */
export const OFFICIAL = new Set(['completed', 'walkover', 'bye']);
/** Rencontres sans résultat attendu (exclues du calcul de fin de phase). */
export const CLOSED = new Set(['completed', 'walkover', 'bye', 'cancelled']);

export const STATUS_LABELS: Record<string, string> = {
  to_schedule: 'À planifier', scheduled: 'Planifiée', called: 'Joueurs convoqués', in_progress: 'En cours',
  awaiting_confirmation: 'Résultat à confirmer', disputed: 'Résultat contesté', completed: 'Terminée', postponed: 'Reportée',
  cancelled: 'Annulée', walkover: 'Forfait', bye: 'Exempt',
};
