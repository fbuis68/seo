import { Tx, lock, one } from '../../core/db';

/** Périodes calculées dans le fuseau de l'organisme. */
export function monthPeriod(now = new Date(), tz = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
}
export function dayPeriod(now = new Date(), tz = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function yearOf(now = new Date(), tz = 'Europe/Paris'): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(now));
}

export type QuotaKey =
  | 'billedClients' | 'crmProspects' | 'learnersPerYear' | 'activeSessions' | 'draftSessions' | 'sessionsPerMonth'
  | 'managers' | 'storageBytes' | 'smtpMailboxes' | 'bankAccounts' | 'bankInstitutions';

/**
 * Mesures d'usage calculées depuis les données (jamais depuis le navigateur).
 * Doivent être appelées dans une transaction tenantTx.
 */
export const USAGE_QUERIES: Record<QuotaKey, (tx: Tx, tenantId: string, year: number) => Promise<number>> = {
  // Clients payeurs présents, archivés compris ; fusionnés/supprimés exclus.
  billedClients: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM clients WHERE status='customer' AND deleted_at IS NULL AND merged_into_id IS NULL`))!.n),
  crmProspects: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM clients WHERE status='prospect' AND deleted_at IS NULL AND merged_into_id IS NULL`))!.n),
  // Personnes distinctes inscrites à une session débutant dans l'année civile ; l'annulation ne libère pas.
  // Historique repris terminé avant ouverture exclu.
  learnersPerYear: async (tx, _t, year) => Number((await one(tx,
    `SELECT count(DISTINCT e.person_id) n FROM enrollments e JOIN training_sessions s ON s.id = e.session_id
      WHERE NOT s.is_historical AND s.starts_on >= make_date($1,1,1) AND s.starts_on < make_date($1+1,1,1)`, [year]))!.n),
  activeSessions: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM training_sessions WHERE status IN ('planned','confirmed','in_progress')`))!.n),
  // Mois civil en cours (fuseau de l'organisme).
  sessionsPerMonth: async (tx, tenantId) => sessionsInMonth(tx, monthPeriod(new Date(), (await one(tx, `SELECT timezone FROM tenants WHERE id=$1`, [tenantId]))?.timezone ?? 'Europe/Paris')),
  draftSessions: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM training_sessions WHERE status = 'draft'`))!.n),
  managers: async (tx, tenantId) => Number((await one(tx,
    `SELECT count(*) n FROM memberships WHERE tenant_id=$1 AND role IN ('owner','manager','accountant','importer')
       AND (expires_at IS NULL OR expires_at > now())`, [tenantId]))!.n),
  storageBytes: async (tx) => Number((await one(tx, `SELECT coalesce(sum(size_bytes),0) n FROM documents`))!.n),
  smtpMailboxes: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM mail_connections WHERE kind='smtp' AND status <> 'disabled'`))!.n),
  bankInstitutions: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM bank_connections WHERE status <> 'revoked'`))!.n),
  bankAccounts: async (tx) => Number((await one(tx,
    `SELECT count(*) n FROM bank_accounts a JOIN bank_connections c ON c.id=a.connection_id
      WHERE a.selected AND c.status <> 'revoked'`))!.n),
};

/**
 * Sessions comptées dans le quota mensuel : débutant dans le mois (AAAA-MM), hors brouillon,
 * annulées et historique repris. `excludeId` : la session en cours de planification.
 */
export async function sessionsInMonth(tx: Tx, month: string, excludeId?: string | null): Promise<number> {
  return Number((await one(tx,
    `SELECT count(*) n FROM training_sessions WHERE status NOT IN ('draft','cancelled') AND NOT is_historical
        AND starts_on >= ($1 || '-01')::date AND starts_on < ($1 || '-01')::date + interval '1 month' AND ($2::uuid IS NULL OR id <> $2)`,
    [month, excludeId ?? null]))!.n);
}

/** Mois (à partir de `fromMonth`) le plus chargé en sessions, avec ajouts projetés éventuels. */
export async function busiestMonth(tx: Tx, fromMonth: string, extra = new Map<string, number>()): Promise<{ month: string | null; n: number }> {
  const rows = await tx.query(`SELECT to_char(starts_on, 'YYYY-MM') m, count(*)::int n FROM training_sessions
     WHERE status NOT IN ('draft','cancelled') AND NOT is_historical AND starts_on >= ($1 || '-01')::date GROUP BY 1`, [fromMonth]);
  const all = new Map<string, number>(rows.rows.map((r: any) => [r.m, r.n]));
  for (const [m, n] of extra) if (m >= fromMonth) all.set(m, (all.get(m) ?? 0) + n);
  let best: { month: string | null; n: number } = { month: null, n: 0 };
  for (const [m, n] of all) if (n > best.n) best = { month: m, n };
  return best;
}

/** Sérialise les créations concurrentes d'un même quota dans un organisme. */
export const lockQuota = (tx: Tx, tenantId: string, key: string) => lock(tx, `quota:${tenantId}:${key}`);

/** Incrémente un compteur périodique ; retourne la nouvelle valeur. */
export async function incrementCounter(tx: Tx, tenantId: string, metric: string, period: string, by = 1): Promise<number> {
  const row = await one(tx,
    `INSERT INTO usage_counters(tenant_id, metric, period, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + EXCLUDED.value
     RETURNING value`, [tenantId, metric, period, by]);
  return Number(row!.value);
}
export async function readCounter(tx: Tx, tenantId: string, metric: string, period: string): Promise<number> {
  const row = await one(tx, `SELECT value FROM usage_counters WHERE tenant_id=$1 AND metric=$2 AND period=$3`, [tenantId, metric, period]);
  return Number(row?.value ?? 0);
}
