import { Injectable } from '@nestjs/common';
import { Db, Tx } from './db';

/** Journal d'audit (sans secret, sans IBAN complet ni document personnel). */
@Injectable()
export class AuditService {
  constructor(private db: Db) {}
  async log(tx: Tx | null, e: { tenantId?: string | null; actor?: string | null; action: string; entityType?: string; entityId?: string; data?: unknown }) {
    const sql = `INSERT INTO audit_events(tenant_id, actor_user_id, action, entity_type, entity_id, data) VALUES ($1,$2,$3,$4,$5,$6)`;
    const params = [e.tenantId ?? null, e.actor ?? null, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.data ?? {})];
    if (tx) await tx.query(sql, params); else await this.db.query(sql, params);
  }
}
