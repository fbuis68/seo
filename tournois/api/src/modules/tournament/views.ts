/**
 * Vues de lecture (organisateur, joueur, public) construites à partir de l'état du tournoi.
 * La vue publique n'expose que les informations nécessaires à la compétition (§16.2) : aucun contact.
 */
import { roundLabel } from '../../engine/draw';
import { TIEBREAKER_LABELS } from '../../engine/standings';
import { finalRanking, groupTables } from './rankings';
import { MatchRow, STATUS_LABELS, TournamentState } from './state';

const ordinal = (n: number) => (n === 1 ? '1er' : `${n}e`);

/** Index de l'état (évite les recherches linéaires pour chaque rencontre). */
const indexes = new WeakMap<TournamentState, { names: Map<string, string>; byKey: Map<string, MatchRow> }>();
function idx(s: TournamentState) {
  let i = indexes.get(s);
  if (!i) {
    i = { names: new Map(s.participants.map((p) => [p.id, p.name])), byKey: new Map(s.matches.map((m) => [`${m.stage_id}:${m.key}`, m])) };
    indexes.set(s, i);
  }
  return i;
}

export function placeholder(src: any, s: TournamentState, m: MatchRow): string {
  if (!src) return 'À déterminer';
  if (src.kind === 'bye') return 'Exempt';
  if (src.kind === 'group') return `${ordinal(src.rank)} poule ${src.group}`;
  const rounds = s.stages.find((x) => x.id === m.stage_id)?.config?.rounds ?? 1;
  const ref = idx(s).byKey.get(`${m.stage_id}:${src.match}`);
  const label = ref ? `${roundLabel(ref.round, rounds, ref.key)} ${ref.position}` : src.match;
  return `${src.kind === 'winner' ? 'Vainqueur' : 'Perdant'} ${label}`;
}

export function matchView(s: TournamentState, m: MatchRow) {
  const names = idx(s).names;
  const stage = s.stages.find((x) => x.id === m.stage_id);
  const group = s.groups.find((g) => g.id === m.group_id);
  const rounds = stage?.config?.rounds ?? 1;
  const side = (id: string | null, src: any) => (id ? { id, name: names.get(id) ?? '?' } : { id: null, name: placeholder(src, s, m), placeholder: true });
  return {
    id: m.id, key: m.key, stageId: m.stage_id, stageKind: stage?.kind, stageName: stage?.name, group: group?.name ?? null,
    round: m.round, position: m.position, leg: m.leg,
    roundLabel: stage?.kind === 'knockout' ? roundLabel(m.round, rounds, m.key) : group?.name === 'Championnat' ? `Journée ${m.round}` : `Poule ${group?.name} — tour ${m.round}`,
    home: side(m.home_id, m.home_source), away: side(m.away_id, m.away_source),
    status: m.status, statusLabel: STATUS_LABELS[m.status] ?? m.status,
    court: m.court, scheduledAt: m.scheduled_at, locked: m.schedule_locked, refereeUserId: m.referee_user_id,
    score: m.score, result: m.result, winnerId: m.winner_id, isDraw: m.is_draw, outcome: m.outcome, version: m.version,
    penaltyHome: m.penalty_home, penaltyAway: m.penalty_away, completedAt: m.completed_at,
  };
}

export function tournamentView(s: TournamentState, opts: { public?: boolean } = {}) {
  const t = s.t;
  const rr = s.stages.filter((x) => x.kind === 'round_robin');
  const visibleParticipants = opts.public ? s.participants.filter((p) => ['confirmed', 'forfeit'].includes(p.status)) : s.participants;
  return {
    tournament: {
      id: t.id, slug: t.slug, name: t.name, discipline: t.discipline, startsAt: t.starts_at, endsAt: t.ends_at, venueName: t.venue_name,
      maxParticipants: t.max_participants, mode: t.mode, format: t.format, formatConfig: t.format_config, scoring: t.scoring,
      rankingRules: t.ranking_rules, tiebreakerLabels: (t.ranking_rules?.tiebreakers ?? ['points', 'head_to_head', 'set_diff', 'game_diff', 'games_won']).map((k) => TIEBREAKER_LABELS[k]),
      courts: t.courts, matchMinutes: t.match_minutes, breakMinutes: t.break_minutes, visibility: t.visibility, status: t.status,
      published: !!t.published_at, generated: !!t.generated_at, branding: t.branding, refereeMode: t.referee_mode, rulesVersion: t.rules_version,
      ...(opts.public ? {} : { registration: t.registration, refereeOfficial: t.referee_official, confirmationHours: t.confirmation_hours, autoConfirmOnTimeout: t.auto_confirm_on_timeout, orgId: t.org_id, drawSeed: t.draw_seed }),
    },
    participants: visibleParticipants.map((p) => ({ id: p.id, name: p.name, club: p.club, category: p.category, seed: p.seed, status: p.status, ...(opts.public ? {} : { rating: p.rating, checkedIn: !!p.checked_in_at }) })),
    stages: s.stages.map((st) => ({
      id: st.id, kind: st.kind, name: st.name, status: st.status, config: st.config,
      groups: st.kind === 'round_robin' ? groupTables(s, st) : undefined,
    })),
    matches: s.matches.map((m) => matchView(s, m)),
    ranking: finalRanking(s),
    hasGroups: rr.length > 0,
  };
}

export function dashboard(s: TournamentState) {
  const now = Date.now();
  const ms = s.matches.filter((m) => m.status !== 'bye');
  const late = ms.filter((m) => m.scheduled_at && !['completed', 'walkover', 'cancelled', 'in_progress', 'awaiting_confirmation', 'disputed'].includes(m.status)
    && new Date(m.scheduled_at).getTime() + 10 * 60_000 < now);
  const inProgress = ms.filter((m) => m.status === 'in_progress' || m.status === 'called');
  const busyCourts = new Set(inProgress.map((m) => m.court).filter(Boolean));
  const anomalies: { type: string; message: string; matchId?: string }[] = [];
  for (const m of ms.filter((x) => x.status === 'disputed')) anomalies.push({ type: 'disputed', message: `Score contesté : ${m.key}`, matchId: m.id });
  for (const m of late) anomalies.push({ type: 'late', message: `Retard : ${m.key} prévue à ${new Date(m.scheduled_at!).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}`, matchId: m.id });
  for (const st of s.stages.filter((x) => x.kind === 'round_robin')) {
    for (const g of groupTables(s, st)) if (g.rows.some((r) => r.qualification === 'tie')) anomalies.push({ type: 'tie', message: `Égalité à départager en poule ${g.name}` });
  }
  const unscheduled = ms.filter((m) => m.status === 'to_schedule' && m.home_id && m.away_id).length;
  if (unscheduled) anomalies.push({ type: 'unscheduled', message: `${unscheduled} rencontre(s) sans terrain ni horaire` });
  return {
    participants: s.participants.filter((p) => p.status === 'confirmed').length,
    pendingRegistrations: s.participants.filter((p) => p.status === 'pending').length,
    waitlist: s.participants.filter((p) => p.status === 'waitlist').length,
    checkedIn: s.participants.filter((p) => p.checked_in_at && p.status === 'confirmed').length,
    matches: ms.length,
    completed: ms.filter((m) => ['completed', 'walkover'].includes(m.status)).length,
    inProgress: inProgress.length,
    remaining: ms.filter((m) => !['completed', 'walkover', 'cancelled'].includes(m.status)).length,
    awaitingValidation: ms.filter((m) => m.status === 'awaiting_confirmation' || m.status === 'disputed').length,
    late: late.length,
    courtsAvailable: Math.max(0, s.t.courts - busyCourts.size),
    courts: s.t.courts,
    anomalies,
  };
}

export function statistics(s: TournamentState) {
  const done = s.matches.filter((m) => ['completed', 'walkover'].includes(m.status));
  const names = new Map(s.participants.map((p) => [p.id, p.name]));
  const per = new Map<string, { name: string; played: number; wins: number; losses: number; draws: number; setsWon: number; setsLost: number }>();
  const row = (id: string) => per.get(id) ?? per.set(id, { name: names.get(id) ?? '?', played: 0, wins: 0, losses: 0, draws: 0, setsWon: 0, setsLost: 0 }).get(id)!;
  const byCourt = new Map<number, number>();
  for (const m of done) {
    if (!m.home_id || !m.away_id) continue;
    const h = row(m.home_id), a = row(m.away_id);
    h.played++; a.played++;
    if (m.is_draw) { h.draws++; a.draws++; } else if (m.winner_id === m.home_id) { h.wins++; a.losses++; } else { a.wins++; h.losses++; }
    h.setsWon += m.result?.setsHome ?? 0; h.setsLost += m.result?.setsAway ?? 0; a.setsWon += m.result?.setsAway ?? 0; a.setsLost += m.result?.setsHome ?? 0;
    if (m.court) byCourt.set(m.court, (byCourt.get(m.court) ?? 0) + 1);
  }
  const durations = s.matches.filter((m: any) => m.started_at && m.completed_at).map((m: any) => (new Date(m.completed_at).getTime() - new Date(m.started_at).getTime()) / 60000);
  const confirmed = s.participants.filter((p) => ['confirmed', 'forfeit'].includes(p.status));
  return {
    totalMatches: s.matches.filter((m) => m.status !== 'bye').length,
    playedMatches: done.length,
    walkovers: done.filter((m) => m.status === 'walkover').length,
    averageDurationMinutes: durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : null,
    participationRate: confirmed.length ? Math.round((confirmed.filter((p) => p.checked_in_at).length / confirmed.length) * 100) : null,
    homeWins: done.filter((m) => m.winner_id && m.winner_id === m.home_id).length,
    awayWins: done.filter((m) => m.winner_id && m.winner_id === m.away_id).length,
    draws: done.filter((m) => m.is_draw).length,
    byParticipant: [...per.entries()].map(([id, v]) => ({ id, ...v })).sort((x, y) => y.wins - x.wins || x.losses - y.losses),
    byCourt: [...byCourt.entries()].map(([court, matches]) => ({ court, matches })).sort((x, y) => x.court - y.court),
  };
}
