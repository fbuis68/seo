import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '../config';

// numeric -> string (jamais de float pour les montants) ; bigint -> number pour les compteurs.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

export type Tx = PoolClient;

/**
 * Accès PostgreSQL. Toute donnée métier passe par tenantTx(), qui positionne app.tenant_id
 * pour la durée de la transaction : les politiques RLS filtrent alors chaque requête.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;
  constructor() {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
  }

  async onModuleDestroy() { await this.pool.end(); }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  /** Transaction sans contexte organisme (tables plateforme uniquement : RLS bloque le reste). */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', '', true)");
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

  /** Transaction dans le contexte d'un organisme : RLS appliquée à toutes les tables métier. */
  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!tenantId) throw new Error('tenantId requis');
    return this.tx(async (tx) => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return fn(tx);
    });
  }
}

export async function one<T extends QueryResultRow = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx.query<T>(sql, params)).rows[0];
}
export async function many<T extends QueryResultRow = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}
/** Verrou transactionnel nommé (quotas, numérotation, crédits) : sérialise les créations concurrentes. */
export async function lock(tx: Tx, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
