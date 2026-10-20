import { randomUUID } from 'crypto';
import { Tx } from '../../../core/db';

/** Colonne d'insertion : nom, et éventuellement une expression SQL autour du paramètre ($n). */
export type Col = string | { name: string; expr: (p: string) => string };

/**
 * Écritures groupées de la reprise MCDF : INSERT multi-lignes par paquets, journal des créations
 * (import_changes) pour l'annulation, et identités source (external_identities) pour le réimport.
 */
export class McdfWriter {
  readonly summary: Record<string, { read: number; create: number; update: number; unchanged: number; reject: number; exclude: number; warnings: number }> = {};
  readonly issues: { entity: string; legacyId?: string | null; severity: 'warning' | 'blocking' | 'info'; message: string }[] = [];
  private changes: { entity: string; id: string; legacyId: string | null }[] = [];
  private pending = new Map<string, { cols: Col[]; rows: unknown[][] }>();

  constructor(private tx: Tx, readonly tenantId: string, readonly batchId: string, readonly sourceInstance: string) {}

  stat(entity: string) {
    return (this.summary[entity] ??= { read: 0, create: 0, update: 0, unchanged: 0, reject: 0, exclude: 0, warnings: 0 });
  }
  read(entity: string, n = 1) { this.stat(entity).read += n; }
  unchanged(entity: string) { this.stat(entity).unchanged++; }
  exclude(entity: string) { this.stat(entity).exclude++; }
  reject(entity: string, legacyId: string | null, message: string) {
    this.stat(entity).reject++;
    if (this.issues.length < 5000) this.issues.push({ entity, legacyId, severity: 'blocking', message });
  }
  warn(entity: string, legacyId: string | null, message: string) {
    this.stat(entity).warnings++;
    if (this.issues.length < 5000) this.issues.push({ entity, legacyId, severity: 'warning', message });
  }

  /** Ajoute une ligne à créer ; l'id (uuid) est fourni ou généré. */
  add(entity: string, table: string, cols: Col[], values: unknown[], opts: { id?: string; legacyId?: string | null; journal?: boolean } = {}) {
    const key = `${table}|${cols.map((c) => (typeof c === 'string' ? c : c.name)).join(',')}`;
    let p = this.pending.get(key);
    if (!p) { p = { cols, rows: [] }; this.pending.set(key, p); }
    p.rows.push(values);
    this.stat(entity).create++;
    if (opts.journal !== false && opts.id) this.changes.push({ entity, id: opts.id, legacyId: opts.legacyId ?? null });
    return opts.id;
  }

  newId() { return randomUUID(); }

  /** Écrit tout ce qui est en attente, table par table, dans l'ordre d'ajout (dépendances respectées). */
  async flush() {
    for (const [key, p] of this.pending) {
      const table = key.split('|')[0];
      const names = p.cols.map((c) => (typeof c === 'string' ? c : c.name));
      const per = Math.max(1, Math.floor(30000 / names.length));
      for (let i = 0; i < p.rows.length; i += per) {
        const chunk = p.rows.slice(i, i + per);
        const vals: unknown[] = [];
        const ph = chunk.map((r) => `(${p.cols.map((c, k) => {
          vals.push(r[k] === undefined ? null : r[k]);
          const ref = `$${vals.length}`;
          return typeof c === 'string' ? ref : c.expr(ref);
        }).join(',')})`);
        await this.tx.query(`INSERT INTO ${table}(${names.join(',')}) VALUES ${ph.join(',')}`, vals);
      }
    }
    this.pending.clear();
    await this.journal();
  }

  private async journal() {
    const all = this.changes;
    this.changes = [];
    for (let i = 0; i < all.length; i += 5000) {
      const chunk = all.slice(i, i + 5000);
      await this.tx.query(
        `INSERT INTO import_changes(tenant_id, batch_id, entity_type, entity_id, action)
         SELECT $1, $2, e, id, 'create' FROM unnest($3::text[], $4::uuid[]) AS t(e, id)`,
        [this.tenantId, this.batchId, chunk.map((c) => c.entity), chunk.map((c) => c.id)]);
      const ids = chunk.filter((c) => c.legacyId);
      if (ids.length) await this.tx.query(
        `INSERT INTO external_identities(tenant_id, source_instance_id, entity_type, external_id, internal_id, batch_id)
         SELECT $1, $2, e, x, id, $3 FROM unnest($4::text[], $5::text[], $6::uuid[]) AS t(e, x, id) ON CONFLICT DO NOTHING`,
        [this.tenantId, this.sourceInstance, this.batchId, ids.map((c) => `mcdf.${c.entity}`), ids.map((c) => c.legacyId), ids.map((c) => c.id)]);
    }
  }
}
