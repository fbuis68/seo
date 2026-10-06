import { Injectable } from '@nestjs/common';
import { Db, Tx } from './db';

export type JobHandler = (payload: any, job: { id: string; tenantId: string | null; attempts: number }) => Promise<unknown>;

/**
 * File de travaux PostgreSQL (FOR UPDATE SKIP LOCKED) : enqueue dans la transaction métier
 * = outbox transactionnelle. Retries avec plafond et backoff, puis état failed.
 */
@Injectable()
export class JobsService {
  private handlers = new Map<string, JobHandler>();
  constructor(private db: Db) {}

  register(type: string, handler: JobHandler) { this.handlers.set(type, handler); }

  async enqueue(tx: Tx | null, type: string, payload: unknown, opts: { tenantId?: string; dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}) {
    const sql = `INSERT INTO jobs(type, payload, tenant_id, dedupe_key, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (dedupe_key) DO NOTHING`;
    const params = [type, JSON.stringify(payload), opts.tenantId ?? null, opts.dedupeKey ?? null, opts.runAt ?? new Date(), opts.maxAttempts ?? 5];
    if (tx) await tx.query(sql, params); else await this.db.query(sql, params);
  }

  /** Traite au plus `limit` travaux prêts ; retourne le nombre traité. */
  async runOnce(limit = 10, types?: string[]): Promise<number> {
    let n = 0;
    for (; n < limit; n++) {
      const [job] = await this.db.query(
        `UPDATE jobs SET status='running', locked_at=now(), attempts = attempts + 1
          WHERE id = (SELECT id FROM jobs WHERE status='pending' AND run_at <= now() ${types ? 'AND type = ANY($1)' : ''}
                      ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING *`, types ? [types] : []);
      if (!job) break;
      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw new Error(`aucun gestionnaire pour ${job.type}`);
        await handler(job.payload, { id: job.id, tenantId: job.tenant_id, attempts: job.attempts });
        await this.db.query(`UPDATE jobs SET status='done', locked_at=NULL WHERE id=$1`, [job.id]);
      } catch (e) {
        const failed = job.attempts >= job.max_attempts;
        const backoff = Math.min(3600, 2 ** job.attempts * 15);
        await this.db.query(
          `UPDATE jobs SET status=$2, locked_at=NULL, last_error=$3, run_at = now() + ($4 || ' seconds')::interval WHERE id=$1`,
          [job.id, failed ? 'failed' : 'pending', String((e as Error).message).slice(0, 2000), String(backoff)]);
      }
    }
    return n;
  }

  /** Remet en file les travaux bloqués (worker arrêté en cours de traitement). */
  async releaseStale(minutes = 15) {
    await this.db.query(`UPDATE jobs SET status='pending', locked_at=NULL WHERE status='running' AND locked_at < now() - ($1 || ' minutes')::interval`, [String(minutes)]);
  }
}
