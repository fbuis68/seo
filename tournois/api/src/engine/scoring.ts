/**
 * Règles de comptabilisation des scores (§6.5) et contrôle de cohérence d'un résultat.
 *
 * Deux familles :
 *  - « sets » : le match se joue en manches (tennis/padel en jeux, badminton/tennis de table/volley en points) ;
 *  - « points » : un score unique (football, handball, pétanque, basket…), match nul éventuellement autorisé.
 */
export type Side = 'home' | 'away';

export interface SetRule {
  /** 'games' : jeux à la tennis (6/7 avec tie-break) ; 'points' : manche aux points avec écart de 2. */
  kind: 'games' | 'points';
  /** Jeux ou points nécessaires pour gagner la manche (6 au tennis/padel, 21 au badminton…). */
  target: number;
  /** Écart minimal (2 par défaut). */
  winBy?: number;
  /** Plafond : à ce score la manche est gagnée même avec 1 point d'écart (30 au badminton). */
  cap?: number;
  /** Tie-break à target-target (games uniquement) : manche gagnée target+1 / target. */
  tiebreak?: boolean;
}

export interface ScoringRules {
  mode: 'sets' | 'points';
  /** Nombre de manches gagnantes (2 = au meilleur des 3). */
  setsToWin?: number;
  set?: SetRule;
  /** Dernière manche décisive jouée en super tie-break (manche aux points, 10 par défaut). */
  superTiebreak?: boolean;
  superTiebreakPoints?: number;
  /** Règle de la manche décisive si différente (ex. volley : 15 points). */
  decidingSet?: SetRule;
  /** Mode points : match nul autorisé (championnat de football…). Jamais en élimination directe. */
  drawAllowed?: boolean;
  /** Mode points : score à atteindre pour gagner (pétanque 13) ; absent = libre. */
  pointsTarget?: number;
  /** Score attribué au vainqueur d'un forfait. */
  walkover?: { sets?: Array<[number, number]>; points?: [number, number] };
}

export interface ScoreInput {
  sets?: Array<{ home: number; away: number }>;
  home?: number;
  away?: number;
  /** Abandon en cours de match : le côté indiqué abandonne, le score partiel est conservé. */
  retired?: Side;
}

export interface ScoreResult {
  winner: Side | null; // null = match nul
  setsHome: number; setsAway: number;
  /** Jeux/points cumulés (différence de jeux ou de points au classement). */
  gamesHome: number; gamesAway: number;
  retired?: Side;
}

export class ScoreError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}

const intOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 999;

/** Vainqueur d'une manche selon sa règle, ou null si la manche n'est pas terminée / incohérente (message). */
export function setWinner(rule: SetRule, h: number, a: number): { winner: Side } | { error: string } {
  const winBy = rule.winBy ?? 2;
  const hi = Math.max(h, a), lo = Math.min(h, a);
  const winner: Side = h > a ? 'home' : 'away';
  if (h === a) return { error: `manche à égalité (${h}-${a})` };
  if (rule.kind === 'games') {
    const t = rule.target;
    if (hi === t && lo <= t - 2) return { winner };
    if (hi === t + 1 && lo === t - 1) return { winner }; // 7-5
    if (rule.tiebreak !== false && hi === t + 1 && lo === t) return { winner }; // 7-6 au tie-break
    if (rule.tiebreak === false && hi > t && hi - lo === 2) return { winner }; // jeu décisif à l'avantage
    return { error: `score de manche ${h}-${a} impossible (manche en ${t} jeux${rule.tiebreak !== false ? ', tie-break à ' + t + '-' + t : ''})` };
  }
  const t = rule.target;
  if (rule.cap && hi === rule.cap && lo >= rule.cap - winBy) return hi - lo >= 1 ? { winner } : { error: 'égalité' };
  if (hi < t) return { error: `manche ${h}-${a} non terminée (${t} points)` };
  if (hi === t && hi - lo >= winBy) return { winner };
  if (hi > t && hi - lo === winBy) return { winner }; // prolongation : exactement l'écart requis
  return { error: `score de manche ${h}-${a} impossible (${t} points, ${winBy} d'écart${rule.cap ? `, plafond ${rule.cap}` : ''})` };
}

/** Contrôle la cohérence du score et calcule le vainqueur. `knockout` interdit le nul. */
export function evaluateScore(rules: ScoringRules, input: ScoreInput, opts: { knockout?: boolean } = {}): ScoreResult {
  if (rules.mode === 'points') {
    const h = input.home, a = input.away;
    if (!intOk(h) || !intOk(a)) throw new ScoreError('Score attendu : deux entiers positifs', 'home');
    if (input.retired) return { winner: input.retired === 'home' ? 'away' : 'home', setsHome: 0, setsAway: 0, gamesHome: h, gamesAway: a, retired: input.retired };
    if (rules.pointsTarget) {
      const hi = Math.max(h, a);
      if (hi !== rules.pointsTarget) throw new ScoreError(`Le vainqueur doit atteindre exactement ${rules.pointsTarget} points`, 'home');
      if (h === a) throw new ScoreError('Égalité impossible', 'home');
    }
    if (h === a) {
      if (opts.knockout) throw new ScoreError('Match nul impossible en élimination directe : saisir le vainqueur (prolongation, tirs au but…)', 'home');
      if (!rules.drawAllowed) throw new ScoreError('Match nul non autorisé par le règlement', 'home');
      return { winner: null, setsHome: 0, setsAway: 0, gamesHome: h, gamesAway: a };
    }
    return { winner: h > a ? 'home' : 'away', setsHome: 0, setsAway: 0, gamesHome: h, gamesAway: a };
  }

  const toWin = rules.setsToWin ?? 2;
  const maxSets = toWin * 2 - 1;
  const sets = input.sets ?? [];
  if (!Array.isArray(sets) || sets.length === 0) throw new ScoreError('Au moins une manche est requise', 'sets');
  if (sets.length > maxSets) throw new ScoreError(`Au plus ${maxSets} manches`, 'sets');
  const base = rules.set ?? { kind: 'games', target: 6, tiebreak: true };
  let sh = 0, sa = 0, gh = 0, ga = 0;
  for (let i = 0; i < sets.length; i++) {
    const { home, away } = sets[i] ?? ({} as any);
    if (!intOk(home) || !intOk(away)) throw new ScoreError(`Manche ${i + 1} : entiers positifs attendus`, `sets.${i}`);
    if (sh === toWin || sa === toWin) throw new ScoreError(`Manche ${i + 1} superflue : le match était déjà gagné`, `sets.${i}`);
    const deciding = sh === toWin - 1 && sa === toWin - 1;
    const rule: SetRule = deciding && rules.superTiebreak
      ? { kind: 'points', target: rules.superTiebreakPoints ?? 10, winBy: 2 }
      : deciding && rules.decidingSet ? rules.decidingSet : base;
    gh += home; ga += away;
    const last = i === sets.length - 1;
    if (last && input.retired) break; // manche interrompue par l'abandon
    const r = setWinner(rule, home, away);
    if ('error' in r) throw new ScoreError(`Manche ${i + 1} : ${r.error}`, `sets.${i}`);
    if (r.winner === 'home') sh++; else sa++;
  }
  if (input.retired) {
    if (sh === toWin || sa === toWin) throw new ScoreError('Abandon impossible : le match est déjà terminé', 'retired');
    return { winner: input.retired === 'home' ? 'away' : 'home', setsHome: sh, setsAway: sa, gamesHome: gh, gamesAway: ga, retired: input.retired };
  }
  if (sh !== toWin && sa !== toWin) throw new ScoreError(`Match incomplet : ${toWin} manche(s) gagnante(s) requise(s)`, 'sets');
  return { winner: sh === toWin ? 'home' : 'away', setsHome: sh, setsAway: sa, gamesHome: gh, gamesAway: ga };
}

/** Score de forfait : le côté `loser` perd sur le score de forfait du règlement. */
export function walkoverScore(rules: ScoringRules, loser: Side): ScoreInput {
  const flip = <T extends [number, number]>([w, l]: T) => (loser === 'home' ? { home: l, away: w } : { home: w, away: l });
  if (rules.mode === 'points') return flip(rules.walkover?.points ?? [rules.pointsTarget ?? 3, 0]);
  const toWin = rules.setsToWin ?? 2;
  const sets = rules.walkover?.sets ?? Array.from({ length: toWin }, () => [rules.set?.target ?? 6, 0] as [number, number]);
  return { sets: sets.map((s) => flip(s)) };
}

/** Préréglages par discipline : point de départ modifiable dans l'assistant. */
export const DISCIPLINE_PRESETS: Record<string, { label: string; scoring: ScoringRules; defaultMode: 'single' | 'double' | 'team'; matchMinutes: number }> = {
  padel: { label: 'Padel', defaultMode: 'double', matchMinutes: 60,
    scoring: { mode: 'sets', setsToWin: 2, set: { kind: 'games', target: 6, tiebreak: true }, superTiebreak: true, superTiebreakPoints: 10 } },
  tennis: { label: 'Tennis', defaultMode: 'single', matchMinutes: 90,
    scoring: { mode: 'sets', setsToWin: 2, set: { kind: 'games', target: 6, tiebreak: true } } },
  badminton: { label: 'Badminton', defaultMode: 'single', matchMinutes: 40,
    scoring: { mode: 'sets', setsToWin: 2, set: { kind: 'points', target: 21, winBy: 2, cap: 30 } } },
  tennis_de_table: { label: 'Tennis de table', defaultMode: 'single', matchMinutes: 30,
    scoring: { mode: 'sets', setsToWin: 3, set: { kind: 'points', target: 11, winBy: 2 } } },
  volley: { label: 'Volley-ball', defaultMode: 'team', matchMinutes: 60,
    scoring: { mode: 'sets', setsToWin: 3, set: { kind: 'points', target: 25, winBy: 2 }, decidingSet: { kind: 'points', target: 15, winBy: 2 } } },
  beach_volley: { label: 'Beach-volley', defaultMode: 'double', matchMinutes: 45,
    scoring: { mode: 'sets', setsToWin: 2, set: { kind: 'points', target: 21, winBy: 2 }, decidingSet: { kind: 'points', target: 15, winBy: 2 } } },
  football: { label: 'Football', defaultMode: 'team', matchMinutes: 20, scoring: { mode: 'points', drawAllowed: true, walkover: { points: [3, 0] } } },
  futsal: { label: 'Futsal', defaultMode: 'team', matchMinutes: 20, scoring: { mode: 'points', drawAllowed: true, walkover: { points: [3, 0] } } },
  handball: { label: 'Handball', defaultMode: 'team', matchMinutes: 30, scoring: { mode: 'points', drawAllowed: true, walkover: { points: [10, 0] } } },
  basket: { label: 'Basket-ball', defaultMode: 'team', matchMinutes: 30, scoring: { mode: 'points', drawAllowed: false, walkover: { points: [20, 0] } } },
  petanque: { label: 'Pétanque', defaultMode: 'double', matchMinutes: 45, scoring: { mode: 'points', pointsTarget: 13, walkover: { points: [13, 0] } } },
  autre: { label: 'Autre (score libre)', defaultMode: 'single', matchMinutes: 30, scoring: { mode: 'points', drawAllowed: true } },
};
