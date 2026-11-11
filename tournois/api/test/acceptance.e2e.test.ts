/**
 * Critères d'acceptation du cahier des charges (§19, CA01 à CA15) — bout en bout sur PostgreSQL.
 */
import { Client } from 'pg';
import { config } from '../src/config';
import { LiveEvents } from '../src/core/services';
import { ResultsService } from '../src/modules/tournament/results';
import { account, closeApp, expectStatus, getApp, http, padelTournament, pair, solo, win } from './helpers';

jest.setTimeout(120_000);
let app: any;
beforeAll(async () => { process.env.DEFAULT_PLAN = 'club'; app = await getApp(); });
afterAll(closeApp);

type Org = Awaited<ReturnType<typeof account>>;
const view = async (api: Org, id: string) => expectStatus(await api.get(`/api/tournaments/${id}`), 200);

async function create16(org: Org, over: Record<string, unknown> = {}) {
  const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, over)), 201);
  for (let i = 1; i <= 16; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
  return t.id as string;
}

/** L'organisateur valide toutes les rencontres jouables d'une phase (vainqueur : domicile, sauf règle donnée). */
async function playAll(org: Org, id: string, filter: (m: any) => boolean, winner: (m: any) => 'home' | 'away' = () => 'home') {
  for (let guard = 0; guard < 10; guard++) {
    const v = await view(org, id);
    const todo = v.matches.filter((m: any) => filter(m) && !['completed', 'walkover', 'bye', 'cancelled'].includes(m.status) && m.home.id && m.away.id);
    if (!todo.length) return v;
    for (const m of todo) expectStatus(await org.post(`/api/matches/${m.id}/validate-score`, { score: win(winner(m)) }), 201);
  }
  throw new Error('phase non terminée');
}

/** Associe un compte joueur au 1er membre d'un participant via son QR Code individuel. */
async function linkPlayer(org: Org, tournamentId: string, participantName: string) {
  const parts = expectStatus(await org.get(`/api/tournaments/${tournamentId}/participants`), 200);
  const p = parts.find((x: any) => x.name === participantName);
  const inv = expectStatus(await org.post(`/api/members/${p.members[0].id}/invite`, {}), 201);
  const player = await account();
  expectStatus(await player.post('/api/join/claim', { token: inv.token }), 201);
  return { player, participantId: p.id as string, token: inv.token as string };
}

describe('Parcours organisateur : padel 16 équipes, 4 poules de 4, tableau final de 8', () => {
  let org: Org; let id: string;

  it('CA01 — création et publication d’un tournoi de 16 participants', async () => {
    org = await account({ org: 'Padel Club Lyon' });
    id = await create16(org);
    const pub = expectStatus(await org.post(`/api/tournaments/${id}/publish`, {}), 201);
    expect(pub.published).toBe(true);
    expect(pub.registrationToken).toHaveLength(43);
    const gen = expectStatus(await org.post(`/api/tournaments/${id}/generate`, {}), 201);
    expect(gen.matches).toBe(24 + 8);
    expect(gen.unscheduled).toBe(0);
    const v = await view(org, id);
    expect(v.tournament).toMatchObject({ published: true, generated: true, status: 'running' });
    expect(v.dashboard).toMatchObject({ participants: 16, matches: 32, completed: 0 });
  });

  it('CA02 — 4 poules de 4 : répartition et rencontres cohérentes, planning sans conflit', async () => {
    const v = await view(org, id);
    const groups = v.stages[0].groups;
    expect(groups.map((g: any) => g.rows.length)).toEqual([4, 4, 4, 4]);
    expect(new Set(groups.flatMap((g: any) => g.rows.map((r: any) => r.participantId))).size).toBe(16);
    // Serpentin par niveau : têtes de série 1 à 4 dans des poules différentes.
    const seedsGroup = ['Paire 01', 'Paire 02', 'Paire 03', 'Paire 04'].map((n) => groups.findIndex((g: any) => g.rows.some((r: any) => r.name === n)));
    expect(new Set(seedsGroup).size).toBe(4);
    for (const g of groups) {
      const ms = v.matches.filter((m: any) => m.group === g.name);
      expect(ms).toHaveLength(6);
      expect(new Set(ms.map((m: any) => [m.home.id, m.away.id].sort().join())).size).toBe(6);
    }
    // Aucun participant sur deux rencontres au même horaire, aucun terrain doublement occupé.
    const slots = new Map<string, string[]>();
    for (const m of v.matches.filter((x: any) => x.scheduledAt)) {
      const k = m.scheduledAt;
      slots.set(k, [...(slots.get(k) ?? []), `c${m.court}`, ...[m.home.id, m.away.id].filter(Boolean)]);
    }
    for (const list of slots.values()) expect(new Set(list).size).toBe(list.length);
    // Le tableau final attend ses qualifiés (cases « 1er poule A »…), quarts croisés.
    const qf = v.matches.filter((m: any) => m.stageKind === 'knockout' && m.round === 1);
    expect(qf).toHaveLength(4);
    expect(qf.every((m: any) => m.home.placeholder && /poule/.test(m.home.name))).toBe(true);
    expect(v.matches.find((m: any) => m.key === 'P3')).toBeTruthy();
  });

  let player: Org, opponent: Org, matchId: string, submissionId: string;
  it('CA03 — score soumis par un joueur : confirmation adverse demandée', async () => {
    const v = await view(org, id);
    const m = v.matches.find((x: any) => x.group === 'A');
    ({ player } = await linkPlayer(org, id, m.home.name));
    ({ player: opponent } = await linkPlayer(org, id, m.away.name));
    matchId = m.id;
    const r = expectStatus(await player.post(`/api/matches/${m.id}/scores`, { score: win('home', [[6, 4], [7, 6]]) }), 201);
    expect(r.status).toBe('awaiting_confirmation');
    submissionId = r.submissionId;
    const notifs = expectStatus(await opponent.get('/api/me/notifications'), 200);
    expect(notifs.some((n: any) => n.type === 'score_to_confirm')).toBe(true);
    const mine = expectStatus(await opponent.get('/api/me/matches'), 200);
    expect(mine.matches.find((x: any) => x.id === m.id).toConfirm).toBe(true);
    // Le joueur ne peut pas confirmer sa propre saisie.
    expect((await player.post(`/api/matches/${m.id}/confirm-score`, { submissionId })).status).toBe(403);
  });

  it('CA04 — score confirmé : classement recalculé automatiquement (et diffusé en temps réel)', async () => {
    const live = app.get(LiveEvents) as LiveEvents;
    const event = live.next(id);
    expectStatus(await opponent.post(`/api/matches/${matchId}/confirm-score`, { submissionId }), 201);
    expect((await event).tournamentId).toBe(id);
    const v = await view(org, id);
    const m = v.matches.find((x: any) => x.id === matchId);
    expect(m.status).toBe('completed');
    const row = v.stages[0].groups[0].rows.find((r: any) => r.participantId === m.home.id);
    expect(row).toMatchObject({ played: 1, wins: 1, points: 3, setsWon: 2, gamesWon: 13 });
    const pub = expectStatus(await http().get(`/api/public/tournaments/${v.tournament.slug}`), 200);
    expect(pub.matches.find((x: any) => x.id === matchId).status).toBe('completed');
  });

  it('CA05 — égalité de points : départage conforme aux règles (confrontation directe, puis arbitrage si parfaite)', async () => {
    const v = await view(org, id);
    // Poule B : cycle a>b (2-0), b>c (2-1), c>a (2-1), tous battent d → mini-championnat : a (+1), c (0), b (-1).
    const gB = v.stages[0].groups[1];
    const [a, b, c, d] = gB.rows.map((r: any) => r.participantId).sort();
    const res: Record<string, { w: string; sets: [number, number][] }> = {
      [[a, b].sort().join()]: { w: a, sets: [[6, 1], [6, 1]] },
      [[b, c].sort().join()]: { w: b, sets: [[6, 1], [1, 6], [10, 8]] },
      [[a, c].sort().join()]: { w: c, sets: [[6, 1], [1, 6], [10, 8]] },
    };
    for (const m of v.matches.filter((x: any) => x.group === 'B')) {
      const k = [m.home.id, m.away.id].sort().join();
      const rule = res[k] ?? { w: m.home.id === d ? m.away.id : m.home.id, sets: [[6, 0], [6, 0]] };
      expectStatus(await org.post(`/api/matches/${m.id}/validate-score`, { score: win(rule.w === m.home.id ? 'home' : 'away', rule.sets) }), 201);
    }
    const after = (await view(org, id)).stages[0].groups[1];
    expect(after.complete).toBe(true);
    expect(after.rows.slice(0, 3).map((r: any) => r.participantId)).toEqual([a, c, b]);
    expect(after.rows.map((r: any) => r.qualification)).toEqual(['qualified', 'qualified', 'eliminated', 'eliminated']);

    // Poule C : cycle parfait (scores identiques) → égalité non départagée, arbitrage de l'organisateur.
    const gC = v.stages[0].groups[2];
    const [x, y, z, w] = gC.rows.map((r: any) => r.participantId).sort();
    const beats = new Map([[[x, y].sort().join(), x], [[y, z].sort().join(), y], [[x, z].sort().join(), z]]);
    for (const m of v.matches.filter((q: any) => q.group === 'C')) {
      const k = [m.home.id, m.away.id].sort().join();
      const winner = beats.get(k) ?? (m.home.id === w ? m.away.id : m.home.id);
      expectStatus(await org.post(`/api/matches/${m.id}/validate-score`, { score: win(winner === m.home.id ? 'home' : 'away') }), 201);
    }
    const tied = (await view(org, id)).stages[0].groups[2];
    expect(tied.rows.filter((r: any) => r.tied)).toHaveLength(3);
    expect(tied.rows.filter((r: any) => r.qualification === 'tie')).toHaveLength(3);
    expect((await view(org, id)).dashboard.anomalies.some((q: any) => q.type === 'tie')).toBe(true);
    expectStatus(await org.post(`/api/tournaments/${id}/stages/${v.stages[0].id}/tiebreak`, { group: 'C', order: [z, x, y], reason: 'Tirage au sort public (règlement art. 7)' }), 201);
    const resolved = (await view(org, id)).stages[0].groups[2];
    expect(resolved.rows.slice(0, 3).map((r: any) => r.participantId)).toEqual([z, x, y]);
    expect(resolved.rows[0].qualification).toBe('qualified');
  });

  it('CA06 — fin des poules : 8 qualifiés placés dans le tableau final, sans revanche de poule en quart', async () => {
    await playAll(org, id, (m) => m.stageKind === 'round_robin');
    const v = await view(org, id);
    const qf = v.matches.filter((m: any) => m.stageKind === 'knockout' && m.round === 1);
    const qualified = qf.flatMap((m: any) => [m.home.id, m.away.id]);
    expect(qualified.filter(Boolean)).toHaveLength(8);
    const groupOf = new Map<string, string>(v.stages[0].groups.flatMap((g: any) => g.rows.map((r: any) => [r.participantId, g.name])));
    for (const m of qf) expect(groupOf.get(m.home.id)).not.toBe(groupOf.get(m.away.id));
    const expected = v.stages[0].groups.flatMap((g: any) => g.rows.filter((r: any) => r.rank <= 2).map((r: any) => r.participantId));
    expect(new Set(qualified)).toEqual(new Set(expected));
    expect(v.stages[1].status).toBe('running');
  });

  it('CA09 — correction d’un résultat officiel : historique conservé, phases suivantes vérifiées et recalculées', async () => {
    // Quarts et demi-finales jouées (domicile gagne).
    await playAll(org, id, (m) => m.stageKind === 'knockout' && m.round <= 2 && m.key !== 'P3');
    let v = await view(org, id);
    const qf1 = v.matches.find((m: any) => m.key === 'R1-1');
    const sf1 = v.matches.find((m: any) => m.key === 'R2-1');
    expect(sf1.status).toBe('completed');
    expect(sf1.home.id).toBe(qf1.home.id);
    // Inverser le vainqueur du quart : la demi-finale jouée en dépend.
    const noReason = await org.post(`/api/matches/${qf1.id}/validate-score`, { score: win('away') });
    expect(noReason.status).toBe(400);
    const blocked = await org.post(`/api/matches/${qf1.id}/validate-score`, { score: win('away'), reason: 'Erreur de saisie : feuille de match' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('downstream_played');
    const ok = expectStatus(await org.post(`/api/matches/${qf1.id}/validate-score`, { score: win('away'), reason: 'Erreur de saisie : feuille de match', cascade: true }), 201);
    expect(ok.correction).toBe(true);
    expect(ok.resetMatches).toContain(sf1.id);
    v = await view(org, id);
    const sf1b = v.matches.find((m: any) => m.key === 'R2-1');
    expect(sf1b.home.id).toBe(qf1.away.id);
    expect(sf1b.status).not.toBe('completed');
    expect(v.matches.find((m: any) => m.key === 'R3-1').home.id).toBeNull();
    const detail = expectStatus(await org.get(`/api/matches/${qf1.id}`), 200);
    const actions = detail.history.map((h: any) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['result_official', 'result_corrected']));
    const corr = detail.history.find((h: any) => h.action === 'result_corrected');
    expect(corr.before.winner_id).toBe(qf1.home.id);
    expect(corr.reason).toMatch(/Erreur de saisie/);
    const sfHistory = expectStatus(await org.get(`/api/matches/${sf1.id}`), 200).history.map((h: any) => h.action);
    expect(sfHistory).toContain('result_reset');
    expect(expectStatus(await org.get(`/api/tournaments/${id}/integrity`), 200).ok).toBe(true);
  });

  it('Fin du tournoi : classement final (petite finale), exports CSV', async () => {
    await playAll(org, id, () => true);
    const v = await view(org, id);
    expect(v.tournament.status).toBe('finished');
    expect(v.ranking.complete).toBe(true);
    expect(v.ranking.rows.slice(0, 4).map((r: any) => r.rank)).toEqual([1, 2, 3, 4]);
    // 5e ex æquo : perdants des quarts ; puis 3es et 4es de poule.
    expect(v.ranking.rows.filter((r: any) => r.rank === 5)).toHaveLength(4);
    expect(v.ranking.rows).toHaveLength(16);
    const csv = await org.get(`/api/tournaments/${id}/export/ranking.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')[1]).toMatch(/^1;/);
    const xlsx = await org.get(`/api/tournaments/${id}/export/results.xlsx`);
    expect(xlsx.status).toBe(200);
    const stats = expectStatus(await org.get(`/api/tournaments/${id}/stats`), 200);
    expect(stats.playedMatches).toBe(32);
  });
});

describe('Inscription, QR Codes et sécurité', () => {
  it('CA07 — scan du QR Code : inscription autonome et association sécurisée', async () => {
    const org = await account({ org: 'Club QR' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { maxParticipants: 2, visibility: 'private', registration: { open: true } })), 201);
    // Inscription fermée tant que le tournoi n'est pas publié.
    const qr = expectStatus(await org.post(`/api/tournaments/${t.id}/qr-codes`, {}), 201);
    const p1 = await account({ first: 'Lina', last: 'Martin' });
    const team = { members: [{ firstName: 'x', lastName: 'x' }, { firstName: 'Hugo', lastName: 'Bernard' }] };
    expect((await p1.post('/api/join/register', { token: qr.registration.token, participant: team })).body.code).toBe('registration_closed');
    expectStatus(await org.post(`/api/tournaments/${t.id}/publish`, {}), 201);
    const landing = expectStatus(await http().get(`/api/join/${qr.registration.token}`), 200);
    expect(landing).toMatchObject({ kind: 'tournament', invalid: null, tournament: { name: 'Open de padel', registrationOpen: true } });
    // Tournoi privé : pas d'inscription par simple lien public.
    expect((await p1.post('/api/join/register', { slug: t.slug, participant: team })).status).toBe(403);
    const r1 = expectStatus(await p1.post('/api/join/register', { token: qr.registration.token, participant: team }), 201);
    expect(r1.status).toBe('confirmed');
    expect(r1.invites).toHaveLength(1);
    expect((await p1.post('/api/join/register', { token: qr.registration.token, participant: team })).body.code).toBe('already_registered');
    // Partenaire de double : rejoint son équipe avec l'invitation individuelle (usage unique).
    const partner = await account({ first: 'Hugo', last: 'Bernard' });
    const inviteToken = r1.invites[0].url.split('/join/')[1];
    expect(expectStatus(await http().get(`/api/join/${inviteToken}`), 200).member).toMatchObject({ firstName: 'Hugo', linked: false });
    expectStatus(await partner.post('/api/join/claim', { token: inviteToken }), 201);
    const intruder = await account();
    expect((await intruder.post('/api/join/claim', { token: inviteToken })).body.code).toBe('token_used');
    expect((await intruder.post('/api/join/claim', { token: 'x'.repeat(43) })).status).toBe(404);
    // Capacité atteinte : liste d'attente.
    const p2 = await account(); const p3 = await account();
    expect(expectStatus(await p2.post('/api/join/register', { token: qr.registration.token, participant: team }), 201).status).toBe('confirmed');
    const r3 = expectStatus(await p3.post('/api/join/register', { token: qr.registration.token, participant: team }), 201);
    expect(r3).toMatchObject({ status: 'waitlist', waitlistPosition: 1 });
    // Association à un joueur créé par l'organisateur : jeton révoqué → refus ; sans jeton → validation organisateur.
    const created = expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, { ...pair(9), status: 'waitlist' }), 201);
    const inv = expectStatus(await org.post(`/api/members/${created.members[0].id}/invite`, {}), 201);
    const tokens = expectStatus(await org.get(`/api/tournaments/${t.id}/qr-codes`), 200);
    expectStatus(await org.del(`/api/tournaments/${t.id}/qr-codes/${tokens.find((x: any) => x.target_id === created.members[0].id).id}`), 200);
    expect((await intruder.post('/api/join/claim', { token: inv.token })).body.code).toBe('token_revoked');
    expectStatus(await intruder.post(`/api/tournaments/${t.id}/claim-requests`, { memberId: created.members[1].id }), 201);
    let list = expectStatus(await org.get(`/api/tournaments/${t.id}/participants`), 200);
    expect(list.find((p: any) => p.id === created.id).members[1]).toMatchObject({ linked: false, claim_pending: true });
    expectStatus(await org.post(`/api/members/${created.members[1].id}/claim-decision`, { tournamentId: t.id, approve: true }), 201);
    list = expectStatus(await org.get(`/api/tournaments/${t.id}/participants`), 200);
    expect(list.find((p: any) => p.id === created.id).members[1].linked).toBe(true);
    // Désistement d'un confirmé : le premier de la liste d'attente est promu.
    const reg1 = list.find((p: any) => p.id === r1.participantId);
    const st = expectStatus(await org.post(`/api/participants/${reg1.id}/status`, { status: 'withdrawn' }), 201);
    expect(st.promoted).toBe(r3.participantId);
    // Présence : scan du QR participant par l'organisateur.
    const inv2 = expectStatus(await org.post(`/api/members/${list.find((p: any) => p.id === r3.participantId).members[1].id}/invite`, {}), 201);
    expect(expectStatus(await org.post('/api/join/check-in', { token: inv2.token }), 201).checked_in_at).toBeTruthy();
    expect((await intruder.post('/api/join/check-in', { token: inv2.token })).status).toBe(403); // joueur du tournoi, pas organisateur
  });

  it('CA08 — deux joueurs saisissent simultanément : aucun résultat contradictoire validé', async () => {
    const org = await account({ org: 'Club simultané' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { format: 'league', maxParticipants: 4, formatConfig: { league: { legs: 1 } } })), 201);
    for (let i = 1; i <= 4; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    const v = await view(org, t.id);
    const [m1, m2] = v.matches;
    const h1 = await linkPlayer(org, t.id, m1.home.name), a1 = await linkPlayer(org, t.id, m1.away.name);
    // Scores différents, envoyés en même temps : contestation, jamais validé.
    const [r1, r2] = await Promise.all([
      h1.player.post(`/api/matches/${m1.id}/scores`, { score: win('home') }),
      a1.player.post(`/api/matches/${m1.id}/scores`, { score: win('away') }),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect([r1.body.status, r2.body.status].sort()).toEqual(['awaiting_confirmation', 'disputed']);
    let d = expectStatus(await org.get(`/api/matches/${m1.id}`), 200);
    expect(d.match.status).toBe('disputed');
    expect(d.match.winnerId).toBeNull();
    expect((await view(org, t.id)).dashboard.awaitingValidation).toBe(1);
    // Arbitrage organisateur.
    const choice = d.submissions.find((s: any) => s.submitter_role === 'home');
    expectStatus(await org.post(`/api/matches/${m1.id}/validate-score`, { submissionId: choice.id }), 201);
    d = expectStatus(await org.get(`/api/matches/${m1.id}`), 200);
    expect(d.match.status).toBe('completed');
    expect(d.submissions.filter((s: any) => s.status === 'official')).toHaveLength(1);

    // Scores identiques simultanés : un seul résultat officiel.
    const h2 = await linkPlayer(org, t.id, m2.home.name), a2 = await linkPlayer(org, t.id, m2.away.name);
    await Promise.all([
      h2.player.post(`/api/matches/${m2.id}/scores`, { score: win('away') }),
      a2.player.post(`/api/matches/${m2.id}/scores`, { score: win('away') }),
    ]);
    d = expectStatus(await org.get(`/api/matches/${m2.id}`), 200);
    expect(d.match.status).toBe('completed');
    expect(d.match.winnerId).toBe(m2.away.id);
    expect(d.submissions.filter((s: any) => s.status === 'official')).toHaveLength(1);
    // Version périmée refusée (verrou optimiste).
    expect((await org.post(`/api/matches/${v.matches[2].id}/scores`, { score: win('home'), version: 0 })).body.code).toBe('stale_version');
    // Score incohérent avec les règles du padel.
    const bad = await org.post(`/api/matches/${v.matches[2].id}/scores`, { score: { sets: [{ home: 6, away: 5 }, { home: 6, away: 0 }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_score');
  });

  it('CA10 — consultation joueur sur mobile : tournoi, prochaine rencontre et page publique sans connexion', async () => {
    const org = await account({ org: 'Club mobile' });
    const id = await create16(org);
    expectStatus(await org.post(`/api/tournaments/${id}/publish`, {}), 201);
    expectStatus(await org.post(`/api/tournaments/${id}/generate`, {}), 201);
    const v = await view(org, id);
    const { player, participantId } = await linkPlayer(org, id, v.matches[0].home.name);
    const me = expectStatus(await player.get('/api/me/matches'), 200);
    expect(me.next).toMatchObject({ tournament: { id } });
    expect(me.next.court).toBeGreaterThan(0);
    expect(me.next.scheduledAt).toBeTruthy();
    expect([me.next.home.id, me.next.away.id]).toContain(participantId);
    expect(me.matches).toHaveLength(3);
    const mine = expectStatus(await player.get('/api/me/tournaments'), 200);
    expect(mine[0]).toMatchObject({ id, participant: v.matches[0].home.name, registration_status: 'confirmed' });
    // Joueur : vue du tournoi sans coordonnées des autres participants.
    const pv = await view(player, id);
    expect(pv.access).toMatchObject({ organizer: false, participantIds: [participantId] });
    expect(pv.dashboard).toBeUndefined();
    const pub = expectStatus(await http().get(`/api/public/tournaments/${v.tournament.slug}`), 200);
    expect(JSON.stringify(pub)).not.toMatch(/@|email|phone/i);
    expect(pub.stages[0].groups).toHaveLength(4);
    expect(pub.matches).toHaveLength(32);
    const svg = await http().get(`/api/qr.svg?data=${encodeURIComponent(`/p/${v.tournament.slug}`)}`);
    expect(svg.status).toBe(200);
    expect(String(svg.body ?? svg.text)).toBeTruthy();
    expect((await http().get('/api/qr.svg?data=https://evil.example/x')).status).toBe(400);
  });

  it('CA11 — joueur non autorisé : modification de score refusée', async () => {
    const org = await account({ org: 'Club sécurité' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { format: 'league', maxParticipants: 4, visibility: 'private', formatConfig: { league: { legs: 1 } } })), 201);
    for (let i = 1; i <= 4; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    const v = await view(org, t.id);
    const m = v.matches[0];
    const other = v.matches.find((x: any) => ![m.home.id, m.away.id].includes(x.home.id) && ![m.home.id, m.away.id].includes(x.away.id));
    const { player } = await linkPlayer(org, t.id, other.home.name); // joueur du tournoi, pas de cette rencontre
    const stranger = await account();
    expect((await player.post(`/api/matches/${m.id}/scores`, { score: win('home') })).body.code).toBe('not_a_player');
    expect((await player.post(`/api/matches/${m.id}/validate-score`, { score: win('home') })).status).toBe(403);
    expect((await stranger.post(`/api/matches/${m.id}/scores`, { score: win('home') })).status).toBe(403);
    expect((await stranger.get(`/api/tournaments/${t.id}`)).status).toBe(404);
    expect((await http().post(`/api/matches/${m.id}/scores`).send({ score: win('home') })).status).toBe(401);
    expect((await stranger.patch(`/api/tournaments/${t.id}`, { name: 'Piraté' })).status).toBe(404);
    expect((await player.patch(`/api/tournaments/${t.id}`, { name: 'Piraté' })).status).toBe(403);
    expect((await player.patch(`/api/matches/${m.id}/schedule`, { court: 1 })).status).toBe(403);
    // Résultat officiel : un joueur ne peut plus le modifier.
    expectStatus(await org.post(`/api/matches/${other.id}/validate-score`, { score: win('home') }), 201);
    expect((await player.post(`/api/matches/${other.id}/scores`, { score: win('away') })).body.code).toBe('match_closed');
    expect((await http().get(`/api/public/tournaments/${t.slug}`)).status).toBe(404); // privé
  });

  it('CA12 — rencontre avec arbitre : validation selon les droits et le règlement', async () => {
    const org = await account({ org: 'Club arbitré' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { format: 'league', maxParticipants: 4, refereeMode: 'required', formatConfig: { league: { legs: 1 } } })), 201);
    for (let i = 1; i <= 4; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    const ref = await account({ first: 'Arbitre', last: 'Officiel' });
    const other = await account({ first: 'Autre', last: 'Arbitre' });
    expectStatus(await org.post(`/api/tournaments/${t.id}/referees`, { email: ref.email }), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/referees`, { email: other.email }), 201);
    const v = await view(org, t.id);
    const [m1, m2] = v.matches;
    expectStatus(await org.patch(`/api/matches/${m1.id}/schedule`, { refereeUserId: ref.userId }), 200);
    expectStatus(await org.patch(`/api/matches/${m2.id}/schedule`, { refereeUserId: ref.userId }), 200);
    // Arbitrage obligatoire : les joueurs ne saisissent pas.
    const { player } = await linkPlayer(org, t.id, m1.home.name);
    expect((await player.post(`/api/matches/${m1.id}/scores`, { score: win('home') })).body.code).toBe('referee_required');
    // Arbitre non affecté : refus.
    expect((await other.post(`/api/matches/${m1.id}/scores`, { score: win('home') })).status).toBe(403);
    const refMatches = expectStatus(await ref.get('/api/me/matches'), 200);
    expect(refMatches.matches.filter((x: any) => x.role === 'referee')).toHaveLength(2);
    // Arbitre affecté : résultat officiel directement (règlement par défaut).
    expectStatus(await ref.post(`/api/matches/${m1.id}/status`, { status: 'in_progress' }), 201);
    expect(expectStatus(await ref.post(`/api/matches/${m1.id}/scores`, { score: win('home') }), 201).status).toBe('completed');
    // Règlement : score d'arbitre soumis à validation de l'organisateur.
    expectStatus(await org.patch(`/api/tournaments/${t.id}`, { refereeOfficial: false }), 200);
    const r = expectStatus(await ref.post(`/api/matches/${m2.id}/scores`, { score: win('away') }), 201);
    expect(r.status).toBe('awaiting_validation');
    expect((await player.post(`/api/matches/${m2.id}/confirm-score`, { submissionId: r.submissionId })).status).toBe(403);
    expectStatus(await org.post(`/api/matches/${m2.id}/validate-score`, { submissionId: r.submissionId }), 201);
    expect(expectStatus(await org.get(`/api/matches/${m2.id}`), 200).match.status).toBe('completed');
    // L'arbitre ne peut pas corriger un résultat officiel.
    expect((await ref.post(`/api/matches/${m1.id}/validate-score`, { score: win('away'), reason: 'erreur' })).body.code).toBe('correction_organizer_only');
  });

  it('CA13 — participant forfait : résultats et classement cohérents', async () => {
    const org = await account({ org: 'Club forfait' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, {
      maxParticipants: 8, rankingRules: { points: { win: 3, draw: 1, loss: 1, forfeitLoss: 0 } },
      formatConfig: { groups: { count: 2, distribution: 'snake', legs: 1, qualifiers: 2 }, knockout: { thirdPlace: false } } })), 201);
    for (let i = 1; i <= 8; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    let v = await view(org, t.id);
    const gA = v.stages[0].groups[0];
    const quitter = gA.rows[0].participantId;
    // Une rencontre jouée (défaite normale du futur forfait : 1 point), puis forfait.
    const played = v.matches.find((m: any) => m.group === 'A' && (m.home.id === quitter || m.away.id === quitter));
    expectStatus(await org.post(`/api/matches/${played.id}/validate-score`, { score: win(played.home.id === quitter ? 'away' : 'home') }), 201);
    const ff = expectStatus(await org.post(`/api/participants/${quitter}/status`, { status: 'forfeit', reason: 'Blessure' }), 201);
    expect(ff.walkovers).toBe(2);
    v = await view(org, t.id);
    const rows = v.stages[0].groups[0].rows;
    const q = rows.find((r: any) => r.participantId === quitter);
    expect(q).toMatchObject({ played: 3, wins: 0, losses: 3, forfeits: 2, points: 1 });
    expect(q.rank).toBe(4);
    const wo = v.matches.filter((m: any) => m.status === 'walkover');
    expect(wo).toHaveLength(2);
    expect(wo.every((m: any) => m.winnerId !== quitter && m.score.sets[0][m.home.id === quitter ? 'away' : 'home'] === 6)).toBe(true);
    expect(rows.filter((r: any) => r.participantId !== quitter).every((r: any) => r.played >= 1)).toBe(true);
  });

  it('CA14 — deux tournois simultanés de deux clubs : données isolées', async () => {
    const orgA = await account({ org: 'Club A' });
    const orgB = await account({ org: 'Club B' });
    const idA = await create16(orgA);
    const idB = await create16(orgB, { name: 'Tournoi B' });
    await Promise.all([orgA.post(`/api/tournaments/${idA}/generate`, {}), orgB.post(`/api/tournaments/${idB}/generate`, {})]);
    const vA = await view(orgA, idA);
    expect((await orgB.get(`/api/tournaments/${idA}`)).status).toBe(404);
    expect((await orgB.get(`/api/tournaments/${idA}/participants`)).status).toBe(404);
    expect((await orgB.post(`/api/matches/${vA.matches[0].id}/validate-score`, { score: win('home') })).status).toBe(403);
    expect((await orgB.get(`/api/tournaments?orgId=${orgA.orgId}`)).status).toBe(404);
    expect((await orgB.get(`/api/organizations/${orgA.orgId}/players`)).status).toBe(404);
    const listB = expectStatus(await orgB.get(`/api/tournaments?orgId=${orgB.orgId}`), 200);
    expect(listB.map((x: any) => x.id)).toEqual([idB]);
    // Isolation en base : le rôle applicatif ne voit que l'organisation positionnée.
    const c = new Client({ connectionString: config.databaseUrl });
    await c.connect();
    try {
      expect((await c.query('SELECT count(*)::int n FROM matches')).rows[0].n).toBe(0);
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgB.orgId]);
      const rows = (await c.query('SELECT DISTINCT tournament_id FROM matches')).rows;
      expect(rows.map((r) => r.tournament_id)).toEqual([idB]);
      await expect(c.query("INSERT INTO participants(org_id, tournament_id, name) VALUES ($1, $2, 'intrus')", [orgA.orgId, idA])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });

  it('CA15 — tableau incomplet (11 joueurs) : exemptions correctes jusqu’au vainqueur', async () => {
    const org = await account({ org: 'Club tennis' });
    const t = expectStatus(await org.post('/api/tournaments', {
      orgId: org.orgId, name: 'Tournoi interne', discipline: 'tennis', startsAt: '2026-12-06T09:00:00+01:00', maxParticipants: 16,
      mode: 'single', format: 'knockout', courts: 3, formatConfig: { knockout: { thirdPlace: true, seeding: 'seeded' } } }), 201);
    for (let i = 1; i <= 11; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, solo(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    let v = await view(org, t.id);
    const r1 = v.matches.filter((m: any) => m.round === 1);
    expect(r1).toHaveLength(8);
    const byes = r1.filter((m: any) => m.status === 'bye');
    expect(byes).toHaveLength(5);
    const seeds = new Map(v.participants.map((p: any) => [p.id, p.name]));
    expect(byes.map((m: any) => seeds.get(m.winnerId)).sort()).toEqual(['J1 Solo1', 'J2 Solo2', 'J3 Solo3', 'J4 Solo4', 'J5 Solo5']);
    // Les exemptés sont déjà placés au 2e tour ; aucun match d'exempt n'est planifié.
    expect(byes.every((m: any) => !m.scheduledAt)).toBe(true);
    const r2 = v.matches.filter((m: any) => m.round === 2);
    expect(r2.flatMap((m: any) => [m.home.id, m.away.id]).filter(Boolean)).toHaveLength(5);
    await playAll(org, t.id, () => true, (m) => ((m.home.name as string) < (m.away.name as string) ? 'home' : 'away'));
    v = await view(org, t.id);
    expect(v.tournament.status).toBe('finished');
    expect(v.ranking.rows).toHaveLength(11);
    expect(v.ranking.rows[0]).toMatchObject({ rank: 1, name: 'J1 Solo1' });
    expect(v.ranking.rows.filter((r: any) => r.rank === 5)).toHaveLength(4);
    expect(v.ranking.rows.filter((r: any) => r.rank === 9)).toHaveLength(3);
  });
});

describe('Compléments', () => {
  it('délai de confirmation dépassé : validation automatique selon le règlement', async () => {
    const org = await account({ org: 'Club délai' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { format: 'league', maxParticipants: 4, confirmationHours: 1, autoConfirmOnTimeout: true, formatConfig: { league: { legs: 1 } } })), 201);
    for (let i = 1; i <= 4; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    expectStatus(await org.post(`/api/tournaments/${t.id}/generate`, {}), 201);
    const m = (await view(org, t.id)).matches[0];
    const { player } = await linkPlayer(org, t.id, m.home.name);
    expectStatus(await player.post(`/api/matches/${m.id}/scores`, { score: win('home') }), 201);
    const c = new Client({ connectionString: config.migrationDatabaseUrl });
    await c.connect();
    await c.query("UPDATE score_submissions SET expires_at = now() - interval '1 minute' WHERE match_id = $1", [m.id]);
    await c.end();
    const r = await app.get(ResultsService).sweepExpired();
    expect(r.validated).toBe(1);
    expect(expectStatus(await org.get(`/api/matches/${m.id}`), 200).match.status).toBe('completed');
  });

  it('import CSV avec rapport ligne à ligne, quotas d’offre', async () => {
    const org = await account({ org: 'Club import' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { mode: 'single', discipline: 'badminton', format: 'knockout', formatConfig: { knockout: {} } })), 201);
    const csv = 'Nom;Prénom;Email;Club;Niveau\nDupont;Marie;marie@example.test;BC Lyon;1200\nMartin;Paul;mauvais-email;BC Lyon;900\n;Sans nom;;;\nDupont;Marie;marie@example.test;BC Lyon;1200\n';
    const sim = expectStatus(await org.post(`/api/tournaments/${t.id}/participants/import`, { csv, dryRun: true }), 201);
    expect(sim).toMatchObject({ dryRun: true, created: 1, errors: 2, duplicates: 1 });
    expect(expectStatus(await org.get(`/api/tournaments/${t.id}/participants`), 200)).toHaveLength(0);
    const imp = expectStatus(await org.post(`/api/tournaments/${t.id}/participants/import`, { csv }), 201);
    expect(imp.created).toBe(1);
    expect(imp.results[1]).toMatchObject({ line: 3, status: 'error' });
    expect(expectStatus(await org.get(`/api/organizations/${org.orgId}/players?q=marie`), 200)[0]).toMatchObject({ firstName: 'Marie', club: 'BC Lyon' });
    // Offre gratuite : quota de participants.
    process.env.DEFAULT_PLAN = 'free';
    const free = await account({ org: 'Petit club' });
    process.env.DEFAULT_PLAN = 'club';
    expect((await free.post('/api/tournaments', padelTournament(free.orgId!, { maxParticipants: 64 }))).status).toBe(402);
  });

  it('RGPD : export et anonymisation du compte joueur, résultats conservés', async () => {
    const org = await account({ org: 'Club RGPD' });
    const t = expectStatus(await org.post('/api/tournaments', padelTournament(org.orgId!, { format: 'league', maxParticipants: 4, formatConfig: { league: { legs: 1 } } })), 201);
    for (let i = 1; i <= 4; i++) expectStatus(await org.post(`/api/tournaments/${t.id}/participants`, pair(i)), 201);
    const { player } = await linkPlayer(org, t.id, 'Paire 01');
    const exp = expectStatus(await player.get('/api/me/export'), 200);
    expect(exp.tournaments).toHaveLength(1);
    expectStatus(await player.del('/api/me'), 200);
    expect((await player.get('/api/me')).status).toBe(401);
    const list = expectStatus(await org.get(`/api/tournaments/${t.id}/participants`), 200);
    expect(list.find((p: any) => p.name === 'Paire 01').members[0].email).toBeNull();
  });
});
