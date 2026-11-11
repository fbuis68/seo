import { buildBracket, crossGroupPlacement, distributeGroups, roundRobin, seedOrder } from '../src/engine/draw';
import { DISCIPLINE_PRESETS, evaluateScore, walkoverScore } from '../src/engine/scoring';
import { computeStandings, PlayedMatch } from '../src/engine/standings';
import { schedule } from '../src/engine/schedule';

const padel = DISCIPLINE_PRESETS.padel.scoring;
const badminton = DISCIPLINE_PRESETS.badminton.scoring;

describe('scores', () => {
  it('padel : 2 sets gagnants, tie-break, super tie-break au 3e', () => {
    expect(evaluateScore(padel, { sets: [{ home: 6, away: 4 }, { home: 7, away: 6 }] })).toMatchObject({ winner: 'home', setsHome: 2, setsAway: 0, gamesHome: 13, gamesAway: 10 });
    expect(evaluateScore(padel, { sets: [{ home: 6, away: 4 }, { home: 3, away: 6 }, { home: 8, away: 10 }] }).winner).toBe('away');
    expect(() => evaluateScore(padel, { sets: [{ home: 6, away: 5 }, { home: 6, away: 0 }] })).toThrow(/Manche 1/);
    expect(() => evaluateScore(padel, { sets: [{ home: 6, away: 4 }] })).toThrow(/incomplet/);
    expect(() => evaluateScore(padel, { sets: [{ home: 6, away: 4 }, { home: 6, away: 4 }, { home: 6, away: 4 }] })).toThrow(/superflue|Au plus/);
    expect(() => evaluateScore(padel, { sets: [{ home: 6, away: 4 }, { home: 3, away: 6 }, { home: 10, away: 9 }] })).toThrow(/Manche 3/);
  });
  it('badminton : 21 points, écart de 2, plafond 30', () => {
    expect(evaluateScore(badminton, { sets: [{ home: 21, away: 19 }, { home: 30, away: 29 }] }).winner).toBe('home');
    expect(evaluateScore(badminton, { sets: [{ home: 24, away: 22 }, { home: 21, away: 10 }] }).winner).toBe('home');
    expect(() => evaluateScore(badminton, { sets: [{ home: 21, away: 20 }, { home: 21, away: 10 }] })).toThrow();
    expect(() => evaluateScore(badminton, { sets: [{ home: 25, away: 21 }, { home: 21, away: 10 }] })).toThrow();
  });
  it('mode points : nul selon règlement, interdit en élimination directe', () => {
    const foot = DISCIPLINE_PRESETS.football.scoring;
    expect(evaluateScore(foot, { home: 1, away: 1 }).winner).toBeNull();
    expect(() => evaluateScore(foot, { home: 1, away: 1 }, { knockout: true })).toThrow(/élimination/);
    expect(() => evaluateScore(DISCIPLINE_PRESETS.petanque.scoring, { home: 12, away: 10 })).toThrow(/13/);
  });
  it('abandon et forfait', () => {
    expect(evaluateScore(padel, { sets: [{ home: 6, away: 2 }, { home: 2, away: 1 }], retired: 'away' }).winner).toBe('home');
    expect(walkoverScore(padel, 'home')).toEqual({ sets: [{ home: 0, away: 6 }, { home: 0, away: 6 }] });
  });
});

describe('tirage', () => {
  it('toutes-contre-toutes : chaque paire une fois, un match par journée', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const m = roundRobin(ids);
    expect(m).toHaveLength(10);
    const pairs = new Set(m.map((x) => [x.home, x.away].sort().join()));
    expect(pairs.size).toBe(10);
    for (let r = 1; r <= 5; r++) {
      const inRound = m.filter((x) => x.round === r).flatMap((x) => [x.home, x.away]);
      expect(new Set(inRound).size).toBe(inRound.length);
    }
    expect(roundRobin(['a', 'b', 'c', 'd'], 2)).toHaveLength(12);
  });
  it('poules : serpentin équilibré', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `p${i + 1}`);
    const g = distributeGroups(ids, 4, 'snake');
    expect(g.map((x) => x.length)).toEqual([4, 4, 4, 4]);
    expect(g[0]).toEqual(['p1', 'p8', 'p9', 'p16']);
    const s = distributeGroups(ids, 4, 'seeded', 42);
    expect(s.map((x) => x[0])).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(new Set(s.flat()).size).toBe(16);
  });
  it('tableau : ordre des têtes de série et exemptions (11 joueurs)', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const entrants = Array.from({ length: 11 }, (_, i) => ({ kind: 'participant' as const, id: `s${i + 1}` }));
    const b = buildBracket(entrants, { thirdPlace: true });
    expect(b.size).toBe(16);
    const byes = b.matches.filter((m) => m.bye);
    expect(byes).toHaveLength(5);
    // Les exemptions vont aux 5 meilleures têtes de série.
    const exempted = byes.map((m) => (m.home.kind === 'participant' ? m.home.id : (m.away as any).id)).sort();
    expect(exempted).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(b.matches.find((m) => m.key === 'P3')).toBeTruthy();
    expect(b.matches.filter((m) => m.round === 4 && m.key !== 'P3')).toHaveLength(1);
  });
  it('croisement 4 poules × 2 : pas de revanche avant la finale', () => {
    const placement = crossGroupPlacement(['A', 'B', 'C', 'D'], 2) as any[];
    const label = placement.map((e) => `${e.group}${e.rank}`);
    // Quarts : jamais deux équipes de la même poule.
    for (let i = 0; i < 8; i += 2) expect(label[i][0]).not.toBe(label[i + 1][0]);
    // Moitiés opposées pour chaque poule.
    for (const g of 'ABCD') {
      const pos = label.map((l, i) => (l[0] === g ? i : -1)).filter((i) => i >= 0);
      expect(Math.floor(pos[0] / 4)).not.toBe(Math.floor(pos[1] / 4));
    }
    // Les 1ers restent sur les places de têtes de série.
    expect(label.filter((_, i) => i % 2 === 0).every((l) => l.endsWith('1'))).toBe(true);
  });
});

describe('classements', () => {
  const win = (home: string, away: string, sh = 2, sa = 0, gh = 12, ga = 4): PlayedMatch => ({ home, away, winner: sh > sa ? 'home' : 'away', setsHome: sh, setsAway: sa, gamesHome: gh, gamesAway: ga });
  it('égalité de points : confrontation directe puis différence', () => {
    // a, b, c à 2 victoires chacun contre d ; a bat b, b bat c, c bat a : cycle -> différence de sets du mini-championnat.
    const ms = [win('a', 'd'), win('b', 'd'), win('c', 'd'), win('a', 'b', 2, 1, 15, 12), win('b', 'c', 2, 0, 12, 5), win('c', 'a', 2, 1, 14, 13)];
    const st = computeStandings(['a', 'b', 'c', 'd'], ms);
    expect(st.map((r) => r.participantId)).toEqual(['b', 'a', 'c', 'd']);
    expect(st[3].points).toBe(0);
  });
  it('confrontation directe entre deux ex æquo', () => {
    // Cycle parfait : tout le monde à égalité, mini-championnat identique -> ex æquo.
    const cyc = [win('a', 'b'), win('b', 'c'), win('c', 'a')];
    expect(computeStandings(['a', 'b', 'c'], cyc).every((r) => r.rank === 1 && r.tied)).toBe(true);
    // Deux à égalité de points : le vainqueur de leur rencontre passe devant malgré une moins bonne différence.
    const ms = [win('a', 'b', 2, 1, 13, 12), win('b', 'c', 2, 0, 12, 0), win('a', 'c', 2, 0, 12, 0), win('c', 'd'), win('d', 'a', 2, 0, 12, 0), win('b', 'd', 2, 0, 12, 0)];
    const st = computeStandings(['a', 'b', 'c', 'd'], ms, { tiebreakers: ['points', 'head_to_head', 'game_diff'] });
    expect(st.slice(0, 2).map((r) => r.participantId)).toEqual(['a', 'b']);
    expect(st[0].gameDiff).toBeLessThan(st[1].gameDiff);
  });
  it('forfait : barème spécifique', () => {
    const st = computeStandings(['a', 'b'], [{ ...win('a', 'b'), walkover: true }], { points: { win: 3, draw: 1, loss: 1, forfeitLoss: -1 } });
    expect(st.find((r) => r.participantId === 'b')!.points).toBe(-1);
  });
});

describe('planification', () => {
  it('aucun participant sur deux terrains au même créneau', () => {
    const rr = roundRobin(['a', 'b', 'c', 'd']);
    const res = schedule(rr.map((m, i) => ({ id: `m${i}`, participants: [m.home, m.away], after: [] })), { courts: 4 });
    expect(res.unplaced).toEqual([]);
    const bySlot = new Map<number, string[]>();
    rr.forEach((m, i) => { const s = res.placed.get(`m${i}`)!.slot; bySlot.set(s, [...(bySlot.get(s) ?? []), m.home, m.away]); });
    for (const ps of bySlot.values()) expect(new Set(ps).size).toBe(ps.length);
    expect(bySlot.size).toBe(3);
  });
  it('dépendances respectées', () => {
    const res = schedule([{ id: 'sf', participants: [], after: ['q1', 'q2'] }, { id: 'q1', participants: ['a', 'b'], after: [] }, { id: 'q2', participants: ['c', 'd'], after: [] }].reverse(), { courts: 2 });
    expect(res.placed.get('sf')!.slot).toBe(1);
  });
});
