/**
 * Classements de poule et de championnat (§4.1, §4.2, §8.1) : barème configurable et départage
 * successif ; la confrontation directe est calculée sur le mini-championnat des seuls ex æquo.
 */
import type { Side } from './scoring';

export interface PointsTable { win: number; draw: number; loss: number; forfeitLoss: number; }
export const DEFAULT_POINTS: PointsTable = { win: 3, draw: 1, loss: 0, forfeitLoss: 0 };

export type Tiebreaker = 'points' | 'wins' | 'head_to_head' | 'set_diff' | 'game_diff' | 'sets_won' | 'games_won' | 'seed';
export const DEFAULT_TIEBREAKERS: Tiebreaker[] = ['points', 'head_to_head', 'set_diff', 'game_diff', 'games_won'];
export const TIEBREAKER_LABELS: Record<Tiebreaker, string> = {
  points: 'Points', wins: 'Victoires', head_to_head: 'Confrontation directe', set_diff: 'Différence de sets/manches',
  game_diff: 'Différence de jeux/points', sets_won: 'Sets gagnés', games_won: 'Jeux/points marqués', seed: 'Classement initial',
};

/** Rencontre officielle telle que l'utilise le classement. */
export interface PlayedMatch {
  home: string; away: string;
  winner: Side | null;
  setsHome: number; setsAway: number; gamesHome: number; gamesAway: number;
  /** Forfait : le perdant reçoit `forfeitLoss` au lieu de `loss`. */
  walkover?: boolean;
  /** Pénalité de points (ex. sanction disciplinaire) par côté. */
  penaltyHome?: number; penaltyAway?: number;
}

export interface StandingRow {
  participantId: string;
  rank: number;
  /** Égalité parfaite non départagée : rang partagé (ex æquo). */
  tied: boolean;
  played: number; wins: number; draws: number; losses: number; forfeits: number;
  points: number;
  setsWon: number; setsLost: number; gamesWon: number; gamesLost: number;
  setDiff: number; gameDiff: number;
}

function emptyRow(id: string): StandingRow {
  return { participantId: id, rank: 0, tied: false, played: 0, wins: 0, draws: 0, losses: 0, forfeits: 0, points: 0, setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0, setDiff: 0, gameDiff: 0 };
}

export function tally(participants: string[], matches: PlayedMatch[], pts: PointsTable = DEFAULT_POINTS): Map<string, StandingRow> {
  const rows = new Map(participants.map((p) => [p, emptyRow(p)]));
  for (const m of matches) {
    const h = rows.get(m.home), a = rows.get(m.away);
    if (!h || !a) continue;
    for (const [me, side, sw, sl, gw, gl, pen] of [
      [h, 'home', m.setsHome, m.setsAway, m.gamesHome, m.gamesAway, m.penaltyHome ?? 0],
      [a, 'away', m.setsAway, m.setsHome, m.gamesAway, m.gamesHome, m.penaltyAway ?? 0],
    ] as const) {
      me.played++;
      me.setsWon += sw; me.setsLost += sl; me.gamesWon += gw; me.gamesLost += gl;
      me.points -= pen;
      if (m.winner === null) { me.draws++; me.points += pts.draw; }
      else if (m.winner === side) { me.wins++; me.points += pts.win; }
      else if (m.walkover) { me.losses++; me.forfeits++; me.points += pts.forfeitLoss; }
      else { me.losses++; me.points += pts.loss; }
    }
  }
  for (const r of rows.values()) { r.setDiff = r.setsWon - r.setsLost; r.gameDiff = r.gamesWon - r.gamesLost; }
  return rows;
}

function metric(r: StandingRow, t: Exclude<Tiebreaker, 'head_to_head' | 'seed'>): number {
  switch (t) {
    case 'points': return r.points;
    case 'wins': return r.wins;
    case 'set_diff': return r.setDiff;
    case 'game_diff': return r.gameDiff;
    case 'sets_won': return r.setsWon;
    case 'games_won': return r.gamesWon;
  }
}

/**
 * Ordonne un groupe d'ex æquo en appliquant les critères à partir de `from`.
 * Renvoie des « paquets » ordonnés : un paquet de plusieurs éléments est une égalité non départagée.
 */
function resolve(ids: string[], rows: Map<string, StandingRow>, matches: PlayedMatch[], criteria: Tiebreaker[], from: number,
  pts: PointsTable, seeds: Map<string, number>): string[][] {
  if (ids.length <= 1 || from >= criteria.length) return [ids];
  const c = criteria[from];
  let score: (id: string) => number;
  if (c === 'head_to_head') {
    const set = new Set(ids);
    const mini = tally(ids, matches.filter((m) => set.has(m.home) && set.has(m.away)), pts);
    // Confrontation directe : points puis différence de sets puis de jeux dans le mini-championnat.
    score = (id) => { const r = mini.get(id)!; return r.points * 1e8 + r.setDiff * 1e4 + r.gameDiff; };
  } else if (c === 'seed') {
    score = (id) => -(seeds.get(id) ?? Number.MAX_SAFE_INTEGER); // meilleure tête de série = plus petit numéro
  } else {
    score = (id) => metric(rows.get(id)!, c);
  }
  const buckets = new Map<number, string[]>();
  for (const id of ids) { const s = score(id); buckets.set(s, [...(buckets.get(s) ?? []), id]); }
  const ordered = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
  if (ordered.length === 1) return resolve(ids, rows, matches, criteria, from + 1, pts, seeds);
  // Sous-groupe encore à égalité : la confrontation directe est recalculée sur le sous-groupe restreint,
  // les autres critères passent au suivant (même valeur sur le sous-groupe). Terminaison : taille décroissante.
  return ordered.flatMap((g) => (g.length > 1 ? resolve(g, rows, matches, criteria, c === 'head_to_head' ? from : from + 1, pts, seeds) : [g]));
}

export interface StandingsOptions {
  points?: PointsTable;
  tiebreakers?: Tiebreaker[];
  /** Numéro de tête de série / classement initial (1 = meilleur) pour le critère 'seed'. */
  seeds?: Map<string, number>;
}

export function computeStandings(participants: string[], matches: PlayedMatch[], opts: StandingsOptions = {}): StandingRow[] {
  const pts = opts.points ?? DEFAULT_POINTS;
  const criteria = opts.tiebreakers?.length ? opts.tiebreakers : DEFAULT_TIEBREAKERS;
  const rows = tally(participants, matches, pts);
  // Le critère principal est toujours appliqué en premier sur l'ensemble : points par défaut.
  const groups = resolve([...participants], rows, matches, criteria[0] === 'points' ? criteria : ['points', ...criteria], 0, pts, opts.seeds ?? new Map());
  const out: StandingRow[] = [];
  let rank = 1;
  for (const g of groups) {
    // Ordre d'affichage stable des ex æquo (nom/identifiant) ; même rang.
    for (const id of [...g].sort()) out.push({ ...rows.get(id)!, rank, tied: g.length > 1 });
    rank += g.length;
  }
  return out;
}
