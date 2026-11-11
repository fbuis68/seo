/**
 * Test de charge indicatif (§20) : tournoi de 500 participants (64 poules + tableau final), puis
 * lectures concurrentes et saisies de scores. Usage : API démarrée, puis
 *   API=http://localhost:4100 CONCURRENCY=50 npx ts-node scripts/load.ts
 */
const API = process.env.API ?? 'http://localhost:4100';
const C = Number(process.env.CONCURRENCY ?? 50);
async function call(method: string, path: string, token?: string, body?: unknown) {
  const t0 = performance.now();
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(data)}`);
  return { data: data as any, ms: performance.now() - t0 };
}
const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))].toFixed(0);
(async () => {
  const s = await call('POST', '/api/auth/signup', undefined, { email: `load${Date.now()}@example.test`, password: 'motdepasse-solide', firstName: 'Charge', lastName: 'Test', acceptTerms: true, organization: { name: 'Club charge' } });
  const tok = s.data.token;
  const t = await call('POST', '/api/tournaments', tok, { orgId: s.data.orgId, name: 'Charge 500', discipline: 'padel', startsAt: new Date().toISOString(), maxParticipants: 500, mode: 'single', format: 'groups_knockout', courts: 40,
    formatConfig: { groups: { count: 64, distribution: 'snake', legs: 1, qualifiers: 2 }, knockout: {} } });
  const csv = 'Nom;Prénom;Niveau\n' + Array.from({ length: 500 }, (_, i) => `Joueur${i};P${i};${1000 - i}`).join('\n');
  console.log('import 500 :', (await call('POST', `/api/tournaments/${t.data.id}/participants/import`, tok, { csv })).ms.toFixed(0), 'ms');
  const g = await call('POST', `/api/tournaments/${t.data.id}/generate`, tok);
  console.log(`génération ${g.data.matches} rencontres :`, g.ms.toFixed(0), 'ms');
  const v = await call('GET', `/api/tournaments/${t.data.id}`, tok);
  console.log('vue complète organisateur :', v.ms.toFixed(0), 'ms');
  const slug = v.data.tournament.slug;
  await call('POST', `/api/tournaments/${t.data.id}/publish`, tok);
  const lat: number[] = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: C }, async () => { for (let i = 0; i < 10; i++) lat.push((await call('GET', `/api/public/tournaments/${slug}`)).ms); }));
  console.log(`${lat.length} lectures publiques (${C} clients) : p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, ${(lat.length / ((performance.now() - t0) / 1000)).toFixed(0)} req/s`);
  const ms = v.data.matches.filter((m: any) => m.stageKind === 'round_robin').slice(0, 200);
  const sl: number[] = [];
  await Promise.all(Array.from({ length: 10 }, async (_, k) => { for (let i = k; i < ms.length; i += 10) sl.push((await call('POST', `/api/matches/${ms[i].id}/validate-score`, tok, { score: { sets: [{ home: 6, away: 2 }, { home: 6, away: 3 }] } })).ms); }));
  console.log(`${sl.length} scores validés (recalcul inclus) : p50 ${pct(sl, 0.5)} ms, p95 ${pct(sl, 0.95)} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
