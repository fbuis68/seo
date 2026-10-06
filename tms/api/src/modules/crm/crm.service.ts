import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { EntitlementsService } from '../billing/entitlements.service';

export interface PersonInput { firstName: string; lastName: string; email?: string | null; phone?: string | null; roles: ('learner' | 'trainer' | 'contact')[]; skills?: string[] }
export interface ClientInput {
  kind: 'company' | 'person'; name: string; status?: 'prospect' | 'customer'; isFunder?: boolean;
  siren?: string | null; siret?: string | null; personId?: string | null; billingEmail?: string | null; billingAddress?: Record<string, string>;
}

/** Validation de SIRET/SIREN par clé de Luhn (exception La Poste gérée). */
export function isValidSiret(s: string): boolean {
  if (!/^\d{14}$/.test(s)) return false;
  if (s.startsWith('356000000')) return s.split('').reduce((a, c) => a + Number(c), 0) % 5 === 0;
  return luhn(s);
}
export const isValidSiren = (s: string) => /^\d{9}$/.test(s) && luhn(s);
function luhn(s: string) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

@Injectable()
export class CrmService {
  constructor(private db: Db, private ent: EntitlementsService, private audit: AuditService) {}

  // ─── Personnes (apprenants, formateurs, contacts) ─────────────────────────
  async listPersons(ctx: RequestContext, q: { role?: string; q?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT p.*, coalesce(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') roles
        FROM persons p LEFT JOIN person_roles r ON r.person_id = p.id
       WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM person_roles x WHERE x.person_id=p.id AND x.role=$1))
         AND ($2::text IS NULL OR (p.first_name || ' ' || p.last_name || ' ' || coalesce(p.email,'')) ILIKE '%' || $2 || '%')
       GROUP BY p.id ORDER BY p.last_name, p.first_name LIMIT $3 OFFSET $4`, [q.role ?? null, q.q ?? null, q.limit, q.offset]));
  }

  async createPerson(ctx: RequestContext, input: PersonInput, tx?: Tx) {
    const run = async (t: Tx) => {
      const p = await one(t, `INSERT INTO persons(tenant_id, first_name, last_name, email, phone, skills) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, input.firstName.trim(), input.lastName.trim(), input.email?.trim().toLowerCase() || null, input.phone || null, input.skills ?? []]);
      for (const r of new Set(input.roles)) await t.query(`INSERT INTO person_roles(tenant_id, person_id, role) VALUES ($1,$2,$3)`, [ctx.tenantId, p!.id, r]);
      // Homonymes / emails partagés : signalés, jamais fusionnés automatiquement.
      const similar = await many(t, `SELECT id FROM persons WHERE id <> $1 AND ((email IS NOT NULL AND email = $2) OR (lower(first_name)=lower($3) AND lower(last_name)=lower($4)))`,
        [p!.id, p!.email, p!.first_name, p!.last_name]);
      return { ...p, roles: input.roles, possibleDuplicates: similar.map((s) => s.id) };
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  async updatePerson(ctx: RequestContext, id: string, version: number, patch: Partial<PersonInput>) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await one(tx, `UPDATE persons SET first_name=coalesce($3,first_name), last_name=coalesce($4,last_name),
                                 email=CASE WHEN $5::boolean THEN $6 ELSE email END, phone=CASE WHEN $7::boolean THEN $8 ELSE phone END,
                                 version=version+1 WHERE id=$1 AND version=$2 RETURNING *`,
        [id, version, patch.firstName ?? null, patch.lastName ?? null, patch.email !== undefined, patch.email ?? null, patch.phone !== undefined, patch.phone ?? null]);
      if (!p) throw conflict('version_conflict', 'Fiche modifiée entre-temps : rechargez avant de modifier.');
      if (patch.roles) {
        await tx.query(`DELETE FROM person_roles WHERE person_id=$1 AND role <> ALL($2)`, [id, patch.roles]);
        for (const r of patch.roles) await tx.query(`INSERT INTO person_roles(tenant_id, person_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.tenantId, id, r]);
      }
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'person.updated', entityType: 'person', entityId: id, data: { fields: Object.keys(patch) } });
      return p;
    });
  }

  // ─── Clients (personnes morales / physiques payeuses) ────────────────────
  async listClients(ctx: RequestContext, q: { status?: string; archived?: boolean; q?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT * FROM clients WHERE deleted_at IS NULL AND merged_into_id IS NULL
        AND ($1::text IS NULL OR status=$1) AND (($2::boolean AND archived_at IS NOT NULL) OR (NOT $2::boolean AND archived_at IS NULL))
        AND ($3::text IS NULL OR (name || ' ' || coalesce(siret,'') || ' ' || coalesce(siren,'')) ILIKE '%' || $3 || '%')
      ORDER BY name LIMIT $4 OFFSET $5`, [q.status ?? null, !!q.archived, q.q ?? null, q.limit, q.offset]));
  }

  async getClient(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const c = await one(tx, `SELECT * FROM clients WHERE id=$1 AND deleted_at IS NULL`, [id]);
      if (!c) throw notFound('Client');
      c.contacts = await many(tx, `SELECT p.id, p.first_name, p.last_name, p.email, cc.position FROM client_contacts cc JOIN persons p ON p.id=cc.person_id WHERE cc.client_id=$1`, [id]);
      return c;
    });
  }

  async createClient(ctx: RequestContext, input: ClientInput, tx?: Tx) {
    if (input.siret && !isValidSiret(input.siret)) throw badRequest('invalid_siret', 'SIRET invalide', 'siret');
    if (input.siren && !isValidSiren(input.siren)) throw badRequest('invalid_siren', 'SIREN invalide', 'siren');
    const run = async (t: Tx) => {
      const status = input.status ?? 'prospect';
      await this.ent.assertQuota(t, ctx.tenantId, status === 'customer' ? 'billedClients' : 'crmProspects');
      const siren = input.siren ?? (input.siret ? input.siret.slice(0, 9) : null);
      const c = await one(t, `INSERT INTO clients(tenant_id, kind, status, is_funder, name, siren, siret, person_id, billing_email, billing_address)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.tenantId, input.kind, status, !!input.isFunder, input.name.trim(), siren, input.siret ?? null, input.personId ?? null,
          input.billingEmail ?? null, JSON.stringify(input.billingAddress ?? {})]);
      // SIRET identique : candidat à fusion signalé (aucune fusion automatique).
      const dup = input.siret ? await many(t, `SELECT id, name FROM clients WHERE siret=$1 AND id<>$2 AND deleted_at IS NULL AND merged_into_id IS NULL`, [input.siret, c!.id]) : [];
      await this.audit.log(t, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'client.created', entityType: 'client', entityId: c!.id, data: { status } });
      return { ...c, mergeCandidates: dup };
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  async updateClient(ctx: RequestContext, id: string, version: number, patch: Partial<ClientInput>) {
    if (patch.siret && !isValidSiret(patch.siret)) throw badRequest('invalid_siret', 'SIRET invalide', 'siret');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const c = await one(tx, `UPDATE clients SET name=coalesce($3,name), siret=coalesce($4,siret), siren=coalesce($5,siren),
                                 billing_email=coalesce($6,billing_email), billing_address=coalesce($7,billing_address), is_funder=coalesce($8,is_funder),
                                 version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING *`,
        [id, version, patch.name ?? null, patch.siret ?? null, patch.siren ?? null, patch.billingEmail ?? null,
          patch.billingAddress ? JSON.stringify(patch.billingAddress) : null, patch.isFunder ?? null]);
      if (!c) throw conflict('version_conflict', 'Fiche modifiée entre-temps : rechargez avant de modifier.');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'client.updated', entityType: 'client', entityId: id });
      return c;
    });
  }

  /** Prospect → client facturé : consomme le quota clients (Free : 10, archivés compris). */
  async promoteToCustomer(tx: Tx, tenantId: string, clientId: string) {
    const c = await one(tx, `SELECT status FROM clients WHERE id=$1 FOR UPDATE`, [clientId]);
    if (!c) throw notFound('Client');
    if (c.status === 'customer') return;
    await this.ent.assertQuota(tx, tenantId, 'billedClients');
    await tx.query(`UPDATE clients SET status='customer', version=version+1 WHERE id=$1`, [clientId]);
  }

  async setStatus(ctx: RequestContext, id: string, status: 'customer') {
    return this.db.tenantTx(ctx.tenantId, async (tx) => { await this.promoteToCustomer(tx, ctx.tenantId, id); return one(tx, `SELECT * FROM clients WHERE id=$1`, [id]); });
  }

  /** Archivage : masque la fiche, ne libère pas de place dans le quota Free. */
  async archiveClient(ctx: RequestContext, id: string, archived: boolean) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const c = await one(tx, `UPDATE clients SET archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END, version=version+1 WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [id, archived]);
      if (!c) throw notFound('Client');
      return c;
    });
  }

  /** Suppression autorisée seulement sans pièce ni dépendance conservée. */
  async deleteClient(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const deps = await one(tx, `SELECT
          (SELECT count(*) FROM invoices WHERE client_id=$1) inv, (SELECT count(*) FROM enrollments WHERE client_id=$1) enr,
          (SELECT count(*) FROM payments WHERE client_id=$1) pay, (SELECT count(*) FROM quotes WHERE client_id=$1) quo`, [id]);
      if (Number(deps!.inv) + Number(deps!.enr) + Number(deps!.pay) + Number(deps!.quo) > 0) {
        throw conflict('client_has_records', 'Client lié à des pièces conservées (factures, inscriptions, règlements) : suppression impossible, archivage possible.', deps);
      }
      await tx.query(`DELETE FROM client_contacts WHERE client_id=$1`, [id]);
      const r = await one(tx, `UPDATE clients SET deleted_at=now(), name='[supprimé]', billing_email=NULL, billing_address='{}' WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
      if (!r) throw notFound('Client');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'client.deleted', entityType: 'client', entityId: id });
      return { deleted: true };
    });
  }

  /** Fusion validée de doublons : réaffecte les références modifiables, libère une place de quota. */
  async mergeClients(ctx: RequestContext, sourceId: string, targetId: string) {
    if (sourceId === targetId) throw badRequest('invalid_merge', 'Fusion impossible sur la même fiche.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const issued = await one(tx, `SELECT count(*) n FROM invoices WHERE client_id=$1 AND status='issued'`, [sourceId]);
      if (Number(issued!.n) > 0) throw conflict('merge_blocked', 'La fiche source porte des factures émises (immuables) : fusion impossible, archivage possible.');
      const [s, t] = [await one(tx, `SELECT * FROM clients WHERE id=$1 FOR UPDATE`, [sourceId]), await one(tx, `SELECT * FROM clients WHERE id=$1 FOR UPDATE`, [targetId])];
      if (!s || !t || s.deleted_at || t.deleted_at || s.merged_into_id || t.merged_into_id) throw notFound('Client');
      for (const sql of [
        `UPDATE enrollments SET client_id=$2 WHERE client_id=$1`, `UPDATE invoices SET client_id=$2 WHERE client_id=$1 AND status='draft'`,
        `UPDATE payments SET client_id=$2 WHERE client_id=$1`, `UPDATE quotes SET client_id=$2 WHERE client_id=$1`,
        `UPDATE funding_allocations SET funder_client_id=$2 WHERE funder_client_id=$1`, `UPDATE training_sessions SET client_id=$2 WHERE client_id=$1`,
        `INSERT INTO client_contacts(tenant_id, client_id, person_id, position) SELECT tenant_id, $2, person_id, position FROM client_contacts WHERE client_id=$1 ON CONFLICT DO NOTHING`,
      ]) await tx.query(sql, [sourceId, targetId]);
      if (s.status === 'customer' && t.status !== 'customer') await tx.query(`UPDATE clients SET status='customer' WHERE id=$1`, [targetId]);
      await tx.query(`UPDATE clients SET merged_into_id=$2, version=version+1 WHERE id=$1`, [sourceId, targetId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'client.merged', entityType: 'client', entityId: sourceId, data: { into: targetId } });
      return { merged: true, targetId };
    });
  }

  async addContact(ctx: RequestContext, clientId: string, personId: string, position?: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`INSERT INTO client_contacts(tenant_id, client_id, person_id, position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.tenantId, clientId, personId, position ?? null]);
      await tx.query(`INSERT INTO person_roles(tenant_id, person_id, role) VALUES ($1,$2,'contact') ON CONFLICT DO NOTHING`, [ctx.tenantId, personId]);
      return { ok: true };
    });
  }
}
