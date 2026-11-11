import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '../config';

types.setTypeParser(20, (v) => Number(v));       // bigint -> number (compteurs)
types.setTypeParser(1700, (v) => Number(v));     // numeric -> number (niveaux de jeu)

export type Tx = PoolClient;

/**
 * Accès PostgreSQL. Toute donnée de tournoi passe par orgTx(), qui positionne app.org_id pour la
 * transaction : les politiques RLS filtrent alors chaque requête sur l'organisation.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL ?? 20) });
  async onModuleDestroy() { await this.pool.end(); }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  /** Transaction hors organisation : tables plateforme uniquement (la RLS masque le reste). */
  async tx<T>(fn: (tx: Tx) => Promise<T>, orgId = ''): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Transaction dans le périmètre d'une organisation. */
  orgTx<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!orgId) throw new Error('orgId requis');
    return this.tx(fn, orgId);
  }
}

export async function one<T extends QueryResultRow = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx.query<T>(sql, params)).rows[0];
}
export async function many<T extends QueryResultRow = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}
/** Verrou transactionnel nommé : sérialise les opérations concurrentes sur une même ressource. */
export async function lock(tx: Tx, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
