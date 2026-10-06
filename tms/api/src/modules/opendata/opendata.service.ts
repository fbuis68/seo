import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { sha256 } from '../../core/crypto';
import { Db, many, one } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { assertPublicHost } from '../../core/ssrf';
import { EntitlementsService } from '../billing/entitlements.service';
import { SOURCES } from './sources';

export interface PublicRecordInput { key: string; searchText: string; data: Record<string, unknown> }

const ALLOWED_HOSTS = ['recherche-entreprises.api.gouv.fr', 'www.data.gouv.fr', 'static.data.gouv.fr', 'object.files.data.gouv.fr'];

/**
 * OpenData : catalogue public mutualisé (lecture seule, sans RLS) + propositions
 * d'enrichissement isolées par organisme. Worker OpenData = seul composant avec accès
 * internet, limité aux domaines autorisés (distinct du worker de migration).
 */
@Injectable()
export class OpenDataService implements OnModuleInit {
  private cache = new Map<string, { at: number; data: unknown }>();
  private breaker = new Map<string, { failures: number; openUntil: number }>();

  constructor(private db: Db, private ent: EntitlementsService, private audit: AuditService) {}

  async onModuleInit() {
    for (const s of SOURCES) {
      await this.db.query(`INSERT INTO opendata_sources(code, producer, name, family, url, license, access_mode, state, priority, cadence, decision_note, adapter_version)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'1') ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, decision_note=EXCLUDED.decision_note`,
        [s.code, s.producer, s.name, s.family, s.url, s.license, s.accessMode, s.state, s.priority, s.cadence, s.decisionNote]);
    }
  }

  sources() {
    return this.db.query(`SELECT s.*, sn.snapshot_date, sn.producer_updated_at, sn.ingested_at, sn.record_count
                            FROM opendata_sources s LEFT JOIN opendata_snapshots sn ON sn.id = s.current_snapshot_id ORDER BY priority, family, code`);
  }

  /**
   * Pipeline d'ingestion : checksum → validation volumes → publication atomique.
   * Un téléchargement vide ou en forte baisse est mis en quarantaine ; le dernier jeu valide reste servi.
   */
  async ingest(sourceCode: string, records: PublicRecordInput[], meta: { producerUpdatedAt?: Date | null; snapshotDate?: string; etag?: string }) {
    const [src] = await this.db.query(`SELECT * FROM opendata_sources WHERE code=$1`, [sourceCode]);
    if (!src) throw notFound('Source');
    const checksum = sha256(JSON.stringify(records.map((r) => [r.key, r.data])));
    return this.db.tx(async (tx) => {
      const cur = src.current_snapshot_id ? await one(tx, `SELECT * FROM opendata_snapshots WHERE id=$1`, [src.current_snapshot_id]) : undefined;
      if (cur?.checksum === checksum) return { status: 'unchanged', snapshotId: cur.id };
      const snap = await one(tx, `INSERT INTO opendata_snapshots(source_code, checksum, etag, producer_updated_at, snapshot_date, record_count, status)
                                  VALUES ($1,$2,$3,$4,$5,$6,'validating') RETURNING id`,
        [sourceCode, checksum, meta.etag ?? null, meta.producerUpdatedAt ?? null, meta.snapshotDate ?? new Date().toISOString().slice(0, 10), records.length]);
      let reason: string | null = null;
      if (!records.length) reason = 'Jeu vide';
      else if (cur && records.length < cur.record_count * 0.5) reason = `Baisse anormale du volume (${cur.record_count} → ${records.length})`;
      else if (new Set(records.map((r) => r.key)).size !== records.length) reason = 'Clés en double';
      if (reason) {
        await tx.query(`UPDATE opendata_snapshots SET status='quarantined', quarantine_reason=$2 WHERE id=$1`, [snap!.id, reason]);
        await tx.query(`UPDATE opendata_sources SET last_error_at=now(), last_error=$2, state = CASE WHEN current_snapshot_id IS NULL THEN 'broken' ELSE 'stale' END WHERE code=$1`, [sourceCode, reason]);
        return { status: 'quarantined', reason, snapshotId: snap!.id };
      }
      for (let i = 0; i < records.length; i += 1000) {
        const chunk = records.slice(i, i + 1000); const vals: unknown[] = [];
        const ph = chunk.map((r, j) => { vals.push(sourceCode, snap!.id, r.key, r.searchText.toLowerCase(), JSON.stringify(r.data)); const o = j * 5; return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`; });
        await tx.query(`INSERT INTO public_records(source_code, snapshot_id, record_key, search_text, data) VALUES ${ph.join(',')}`, vals);
      }
      await tx.query(`UPDATE opendata_snapshots SET status='published' WHERE id=$1`, [snap!.id]);
      if (cur) await tx.query(`UPDATE opendata_snapshots SET status='superseded' WHERE id=$1`, [cur.id]);
      await tx.query(`UPDATE opendata_sources SET current_snapshot_id=$2, last_success_at=now(), last_error=NULL, state='active' WHERE code=$1`, [sourceCode, snap!.id]);
      return { status: 'published', snapshotId: snap!.id, records: records.length };
    });
  }

  /** Recherche dans un référentiel ingéré (snapshot courant), avec provenance et date. */
  async search(ctx: RequestContext, sourceCode: string, q: string, limit = 20) {
    await this.db.tenantTx(ctx.tenantId, (tx) => this.ent.consume(tx, ctx.tenantId, 'opendata_searches', 1, ctx.entitlements));
    if (sourceCode === 'sirene') return this.searchSirene(q, limit);
    const [src] = await this.db.query(`SELECT s.*, sn.snapshot_date, sn.producer_updated_at, sn.ingested_at FROM opendata_sources s LEFT JOIN opendata_snapshots sn ON sn.id=s.current_snapshot_id WHERE s.code=$1`, [sourceCode]);
    if (!src) throw notFound('Source');
    if (!src.current_snapshot_id) return { source: this.provenance(src), results: [], warning: 'Référentiel pas encore chargé.' };
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const where = terms.map((_, i) => `search_text LIKE '%' || $${i + 2} || '%'`).join(' AND ') || 'true';
    const rows = await this.db.query(`SELECT record_key, data FROM public_records WHERE snapshot_id=$1 AND ${where} LIMIT ${Math.min(limit, 50)}`, [src.current_snapshot_id, ...terms]);
    return { source: this.provenance(src), results: rows, warning: src.state === 'stale' ? 'Source en retard : dernier jeu valide affiché.' : undefined };
  }

  private provenance(src: any) {
    return { code: src.code, producer: src.producer, name: src.name, license: src.license, url: src.url, snapshotDate: src.snapshot_date, producerUpdatedAt: src.producer_updated_at, ingestedAt: src.ingested_at, state: src.state };
  }

  /** API publique Recherche d'entreprises (domaine autorisé, cache, disjoncteur, backoff 429). */
  async searchSirene(q: string, limit = 10) {
    if (q.trim().length < 3) throw badRequest('query_too_short', '3 caractères minimum.');
    const key = `sirene:${q.toLowerCase()}:${limit}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 7 * 86400e3) return hit.data;
    const b = this.breaker.get('sirene');
    if (b && b.openUntil > Date.now()) throw new AppError(503, 'source_unavailable', 'Source temporairement indisponible, réessayez plus tard.');
    const url = new URL('https://recherche-entreprises.api.gouv.fr/search');
    url.searchParams.set('q', q); url.searchParams.set('per_page', String(Math.min(limit, 25)));
    await assertPublicHost(url.hostname, ALLOWED_HOSTS);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (res.status === 429) throw Object.assign(new Error('quota source atteint'), { retryAfter: Number(res.headers.get('retry-after') ?? 60) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const data = {
        source: { code: 'sirene', producer: 'INSEE / DINUM', license: 'Licence Ouverte 2.0', url: 'https://recherche-entreprises.api.gouv.fr', fetchedAt: new Date().toISOString() },
        results: (json.results ?? []).map((r: any) => ({
          siren: r.siren, name: r.nom_raison_sociale ?? r.nom_complet, siret: r.siege?.siret, address: r.siege?.adresse, postalCode: r.siege?.code_postal,
          city: r.siege?.libelle_commune, naf: r.activite_principale, active: r.etat_administratif === 'A', diffusion: r.statut_diffusion ?? 'O',
        })),
      };
      this.cache.set(key, { at: Date.now(), data });
      this.breaker.delete('sirene');
      return data;
    } catch (e: any) {
      const cur = this.breaker.get('sirene') ?? { failures: 0, openUntil: 0 };
      cur.failures++;
      if (cur.failures >= 3 || e.retryAfter) cur.openUntil = Date.now() + (e.retryAfter ?? 60) * 1000;
      this.breaker.set('sirene', cur);
      throw new AppError(503, 'source_unavailable', `Recherche d'entreprises indisponible : ${e.message}`);
    }
  }

  /** Proposition d'enrichissement : ancienne/nouvelle valeur, jamais d'écrasement silencieux. */
  async proposeClientEnrichment(ctx: RequestContext, clientId: string, record: { siret?: string; name?: string; address?: string; postalCode?: string; city?: string }, sourceCode = 'sirene') {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const c = await one(tx, `SELECT * FROM clients WHERE id=$1`, [clientId]);
      if (!c) throw notFound('Client');
      const changes: { field: string; current: unknown; proposed: unknown }[] = [];
      const addr = c.billing_address ?? {};
      const cmp = (field: string, current: unknown, proposed: unknown) => { if (proposed && proposed !== current) changes.push({ field, current: current ?? null, proposed }); };
      cmp('siret', c.siret, record.siret); cmp('name', c.name, record.name);
      cmp('billing_address.line1', addr.line1, record.address); cmp('billing_address.postal_code', addr.postal_code, record.postalCode); cmp('billing_address.city', addr.city, record.city);
      if (!changes.length) return { changes: [], message: 'Fiche déjà à jour.' };
      return one(tx, `INSERT INTO enrichment_proposals(tenant_id, target_type, target_id, source_code, record_key, source_date, changes) VALUES ($1,'client',$2,$3,$4,now(),$5) RETURNING *`,
        [ctx.tenantId, clientId, sourceCode, record.siret ?? record.name ?? '', JSON.stringify(changes)]);
    });
  }

  listProposals(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT * FROM enrichment_proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 100`));
  }

  /** Application validée et auditée ; refus si la fiche a changé depuis la proposition. */
  async applyProposal(ctx: RequestContext, id: string, fields?: string[]) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await one(tx, `SELECT * FROM enrichment_proposals WHERE id=$1 FOR UPDATE`, [id]);
      if (!p || p.status !== 'pending') throw notFound('Proposition');
      const c = await one(tx, `SELECT * FROM clients WHERE id=$1 FOR UPDATE`, [p.target_id]);
      const addr = { ...(c.billing_address ?? {}) };
      const current = (f: string) => f.startsWith('billing_address.') ? addr[f.split('.')[1]] : c[f];
      const selected = p.changes.filter((ch: any) => !fields || fields.includes(ch.field));
      for (const ch of selected) {
        if ((current(ch.field) ?? null) !== ch.current) {
          await tx.query(`UPDATE enrichment_proposals SET status='stale' WHERE id=$1`, [id]);
          throw conflict('proposal_stale', `La fiche a été modifiée depuis la proposition (${ch.field}) : relancez la recherche.`);
        }
      }
      for (const ch of selected) if (ch.field.startsWith('billing_address.')) addr[ch.field.split('.')[1]] = ch.proposed;
      const val = (f: string) => selected.find((x: any) => x.field === f)?.proposed;
      await tx.query(`UPDATE clients SET siret=coalesce($2,siret), siren=coalesce(left($2,9),siren), name=coalesce($3,name), billing_address=$4, version=version+1 WHERE id=$1`,
        [c.id, val('siret') ?? null, val('name') ?? null, JSON.stringify(addr)]);
      await tx.query(`UPDATE enrichment_proposals SET status='applied', decided_by=$2, decided_at=now() WHERE id=$1`, [id, ctx.userId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'opendata.enrichment_applied', entityType: 'client', entityId: c.id, data: { source: p.source_code, fields: selected.map((s: any) => s.field) } });
      return { applied: selected.map((s: any) => s.field) };
    });
  }
}
