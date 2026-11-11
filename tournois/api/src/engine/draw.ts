/**
 * Tirage : rencontres toutes-contre-toutes (méthode du cercle), répartition en poules,
 * tableaux à élimination directe avec têtes de série et exemptions (BYE), croisement des qualifiés.
 */

/** Générateur pseudo-aléatoire reproductible (le germe est conservé : tirage rejouable et auditable). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export interface RRPairing { round: number; leg: number; home: string; away: string; }

/**
 * Toutes-contre-toutes par la méthode du cercle : chaque participant joue au plus une fois par journée,
 * alternance domicile/extérieur. `legs` = 2 pour l'aller-retour (journées retour inversées).
 */
export function roundRobin(ids: string[], legs = 1): RRPairing[] {
  if (ids.length < 2) return [];
  const list: (string | null)[] = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, rounds = n - 1, out: RRPairing[] = [];
  const arr = [...list];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a === null || b === null) continue;
      // Alternance : le pivot change de côté une journée sur deux, les autres selon la parité.
      const swap = i === 0 ? r % 2 === 1 : i % 2 === 1;
      out.push({ round: r + 1, leg: 1, home: swap ? b : a, away: swap ? a : b });
    }
    arr.splice(1, 0, arr.pop()!); // rotation, le premier reste fixe
  }
  if (legs >= 2) {
    const first = out.length;
    for (let k = 0; k < first; k++) out.push({ round: out[k].round + rounds, leg: 2, home: out[k].away, away: out[k].home });
  }
  return out;
}

export type GroupDistribution = 'snake' | 'random' | 'seeded';

/**
 * Répartition en poules. `ids` est trié par niveau (meilleur d'abord).
 *  - snake : serpentin par niveau (A B C D D C B A …) ;
 *  - seeded : une tête de série par poule, le reste tiré au sort ;
 *  - random : tirage intégral.
 */
export function distributeGroups(ids: string[], groupCount: number, mode: GroupDistribution, seed = 1): string[][] {
  if (groupCount < 1) throw new Error('Au moins une poule');
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  const rand = rng(seed);
  const snake = (list: string[], startRow = 0) => list.forEach((id, i) => {
    const row = Math.floor(i / groupCount) + startRow, col = i % groupCount;
    groups[row % 2 === 0 ? col : groupCount - 1 - col].push(id);
  });
  if (mode === 'snake') snake(ids);
  else if (mode === 'random') snake(shuffle(ids, rand));
  else {
    ids.slice(0, groupCount).forEach((id, i) => groups[i].push(id));
    // Le reste est tiré au sort, puis réparti ligne par ligne pour équilibrer les tailles.
    shuffle(ids.slice(groupCount), rand).forEach((id, i) => groups[i % groupCount].push(id));
  }
  return groups;
}

/** Nom de poule : A, B, … Z, AA, AB… */
export const groupName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : groupName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export const nextPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return Math.max(p, 2); };

/** Ordre de placement des têtes de série dans un tableau de taille `size` : 1, size, size/2+1… (1 et 2 en finale). */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const s = order.length * 2;
    order = order.flatMap((x) => [x, s + 1 - x]);
  }
  return order;
}

export type EntrantRef =
  | { kind: 'participant'; id: string }
  | { kind: 'group'; group: string; rank: number };

export type SlotSource =
  | EntrantRef
  | { kind: 'bye' }
  | { kind: 'winner'; match: string }
  | { kind: 'loser'; match: string };

export interface BracketMatch {
  key: string;           // R{tour}-{position} ; P3 pour la petite finale
  round: number;         // 1 = premier tour
  position: number;      // 1..n dans le tour
  home: SlotSource; away: SlotSource;
  /** Match suivant du vainqueur (et du perdant pour la petite finale). */
  next?: { key: string; slot: 'home' | 'away' };
  loserNext?: { key: string; slot: 'home' | 'away' };
  bye: boolean;
}

export function roundLabel(round: number, totalRounds: number, key?: string): string {
  if (key === 'P3') return 'Petite finale';
  const left = totalRounds - round;
  if (left === 0) return 'Finale';
  if (left === 1) return 'Demi-finales';
  if (left === 2) return 'Quarts de finale';
  return `${2 ** left}es de finale`;
}

/**
 * Tableau à élimination directe. `entrants` est trié par tête de série (1 = meilleur) ;
 * les places manquantes jusqu'à la puissance de 2 supérieure sont des exemptions attribuées aux meilleures têtes de série.
 */
export function buildBracket(entrants: EntrantRef[], opts: { thirdPlace?: boolean; placement?: SlotSource[] } = {}): { size: number; rounds: number; matches: BracketMatch[] } {
  if (entrants.length < 2) throw new Error('Au moins deux participants pour un tableau');
  const size = nextPow2(entrants.length);
  const rounds = Math.log2(size);
  // Placement explicite (croisement des poules) ou placement standard par têtes de série.
  const slots: SlotSource[] = opts.placement
    ? Array.from({ length: size }, (_, i) => opts.placement![i] ?? { kind: 'bye' })
    : seedOrder(size).map((s) => entrants[s - 1] ?? { kind: 'bye' });
  const matches: BracketMatch[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let p = 1; p <= count; p++) {
      const home: SlotSource = r === 1 ? slots[(p - 1) * 2] : { kind: 'winner', match: `R${r - 1}-${p * 2 - 1}` };
      const away: SlotSource = r === 1 ? slots[(p - 1) * 2 + 1] : { kind: 'winner', match: `R${r - 1}-${p * 2}` };
      matches.push({
        key: `R${r}-${p}`, round: r, position: p, home, away,
        next: r < rounds ? { key: `R${r + 1}-${Math.ceil(p / 2)}`, slot: p % 2 ? 'home' : 'away' } : undefined,
        bye: r === 1 && (home.kind === 'bye' || away.kind === 'bye'),
      });
    }
  }
  if (opts.thirdPlace && rounds >= 2) {
    const semis = matches.filter((m) => m.round === rounds - 1);
    semis.forEach((m, i) => { m.loserNext = { key: 'P3', slot: i === 0 ? 'home' : 'away' }; });
    matches.push({ key: 'P3', round: rounds, position: 2, home: { kind: 'loser', match: semis[0].key }, away: { kind: 'loser', match: semis[1].key }, bye: false });
  }
  return { size, rounds, matches };
}

/** Tour (1 = premier) où deux positions du tableau peuvent se rencontrer. */
const meetRound = (i: number, j: number) => Math.floor(Math.log2(i ^ j)) + 1;

/**
 * Placement des qualifiés de poules dans le tableau final (§4.4, §8.3) :
 * les 1ers occupent les places des meilleures têtes de série, les suivants sont permutés entre eux
 * pour que deux équipes d'une même poule se retrouvent le plus tard possible (moitiés opposées si possible).
 */
export function crossGroupPlacement(groupNames: string[], qualifiersPerGroup: number, avoidSameGroup = true): SlotSource[] {
  const entrants: EntrantRef[] = [];
  for (let r = 1; r <= qualifiersPerGroup; r++) {
    // Rangs pairs : ordre décalé (B, A, D, C…) pour croiser les poules voisines.
    const order = r % 2 === 1 ? groupNames : groupNames.map((_, i) => groupNames[i ^ 1] ?? groupNames[i]);
    for (const g of order) entrants.push({ kind: 'group', group: g, rank: r });
  }
  const size = nextPow2(entrants.length);
  const placed: (EntrantRef | null)[] = seedOrder(size).map((s) => entrants[s - 1] ?? null);
  if (!avoidSameGroup) return placed.map((e): SlotSource => e ?? { kind: 'bye' });
  const rounds = Math.log2(size);
  const cost = (arr: (EntrantRef | null)[]) => {
    let c = 0;
    for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) {
      const a = arr[i], b = arr[j];
      if (a?.kind === 'group' && b?.kind === 'group' && a.group === b.group) c += 4 ** (rounds - meetRound(i, j));
    }
    return c;
  };
  // Amélioration locale : échanges entre qualifiés de même rang uniquement (l'avantage sportif des 1ers est conservé).
  let best = cost(placed), improved = true;
  while (improved && best > 0) {
    improved = false;
    for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) {
      const a = placed[i], b = placed[j];
      if (!a || !b || a.kind !== 'group' || b.kind !== 'group' || a.rank !== b.rank) continue;
      [placed[i], placed[j]] = [b, a];
      const c = cost(placed);
      if (c < best) { best = c; improved = true; } else [placed[i], placed[j]] = [a, b];
    }
  }
  return placed.map((e): SlotSource => e ?? { kind: 'bye' });
}
