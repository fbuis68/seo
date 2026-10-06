import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { sha256, stableHash } from '../../core/crypto';
import { Db, Tx, lock, many, one } from '../../core/db';
import { AppError, badRequest, conflict, notFound, paymentRequired } from '../../core/errors';
import { StorageService } from '../../core/storage';
import { csvCell } from '../../core/csv';
import { EntitlementsService } from '../billing/entitlements.service';
import { USAGE_QUERIES, yearOf } from '../billing/usage';
import { isZip, readZip, classify, Rejection, InventoryEntry } from './archive';
import { CANONICAL, ENTITY_ORDER, EntityType, REFS } from './canonical';
import { nativeRows } from './native';
import { CanonRow, buildRows, severityOf, validateRows } from './pipeline';
import { FileMapping, NATIVE_PROFILE, PROFILES, detectProfiles, requiredFields } from './profiles';
import { Table, parseTableFile } from './tabular';

const HARD_PACKAGE_LIMIT = 1024 ** 3;

const TABLE_OF: Record<EntityType, string> = {
  client: 'clients', person: 'persons', program: 'programs', session: 'training_sessions', enrollment: 'enrollments',
  attendance: 'attendance', invoice: 'invoices', payment: 'payments', document: 'documents',
};

/**
 * Reprise par fichiers de sauvegarde (§6). Ce module n'importe AUCUN client HTTP :
 * il ne lit que des octets déposés par le client (vérifié par test de recette REC-23).
 * Simulation sans écriture métier → publication transactionnelle → compensation par journal.
 */
@Injectable()
export class MigrationService {
  constructor(private db: Db, private storage: StorageService, private ent: EntitlementsService, private audit: AuditService) {}

  profiles() {
    return [...PROFILES.map(({ rules, ...p }) => ({ ...p, objects: [...new Set(rules.map((r) => r.entity))] })), NATIVE_PROFILE];
  }

  private async batch(tx: Tx, id: string, forUpdate = false) {
    const b = await one(tx, `SELECT * FROM import_batches WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
    if (!b) throw notFound('Lot de reprise');
    return b;
  }

  list(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT id, source_software, source_instance_id, profile_code, profile_version, status, package_sha256, package_size, created_at, published_at FROM import_batches ORDER BY created_at DESC LIMIT 50`));
  }
  get(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id);
      b.files = await many(tx, `SELECT path, kind, sha256, size_bytes, columns, row_count FROM import_files WHERE batch_id=$1 ORDER BY path`, [id]);
      return b;
    });
  }

  create(ctx: RequestContext, b: { sourceSoftware: string; sourceInstanceId: string }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const active = await one(tx, `SELECT id FROM import_batches WHERE status IN ('uploaded','detected','mapped','simulated','committing')`);
      if (active) throw conflict('batch_active', 'Un lot de reprise est déjà en cours : terminez-le ou annulez-le.', { batchId: active.id });
      return one(tx, `INSERT INTO import_batches(tenant_id, source_software, source_instance_id, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [ctx.tenantId, b.sourceSoftware, b.sourceInstanceId.trim(), ctx.userId]);
    });
  }

  cancel(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id, true);
      if (!['uploaded', 'detected', 'mapped', 'simulated', 'rejected', 'failed'].includes(b.status)) throw conflict('not_cancellable', 'Lot non annulable dans cet état.');
      await tx.query(`DELETE FROM import_rows WHERE batch_id=$1`, [id]); // purge du staging
      await tx.query(`UPDATE import_batches SET status='cancelled' WHERE id=$1`, [id]);
      return { cancelled: true };
    });
  }

  /** Dépôt du paquet (flux) : taille bornée par l'offre, empreinte SHA-256, inventaire sécurisé. */
  async upload(ctx: RequestContext, id: string, stream: NodeJS.ReadableStream, filename: string) {
    const e = await this.ent.get(ctx.tenantId);
    const limit = Math.min(e.limits.importPackageBytes, HARD_PACKAGE_LIMIT);
    const chunks: Buffer[] = []; let size = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { reject(new AppError(413, 'package_too_large', `Paquet supérieur à la limite de votre offre (${Math.round(limit / 1024 ** 2)} Mo). Sélectionnez un sous-périmètre ou passez à une offre payante.`)); (stream as any).destroy?.(); return; }
        chunks.push(c);
      });
      stream.on('end', resolve); stream.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw badRequest('empty_package', 'Paquet vide.');
    const hash = sha256(buf);
    let inventory: InventoryEntry[] = [];
    let rejections: Rejection[] = [];
    const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'paquet';
    if (isZip(buf)) {
      try { ({ entries: inventory, rejections } = await readZip(buf, undefined, false)); }
      catch (err: any) { rejections = [{ code: err.code ?? 'invalid_zip', message: err.message }]; }
    } else {
      const k = classify(safeName);
      if (typeof k !== 'string') rejections = [k];
      else if (k !== 'table') rejections = [{ code: 'unsupported_file', message: 'Déposez une archive ZIP ou un fichier CSV/XLSX.' }];
      else inventory = [{ path: safeName, size: buf.length, kind: 'table', ext: safeName.split('.').pop()! }];
    }
    if (buf.subarray(0, 4).toString('hex') === 'd0cf11e0') rejections.push({ code: 'legacy_office', message: 'Format Office binaire (XLS/DOC) : enregistrez en XLSX ou CSV (aucune macro exécutée).' });

    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id, true);
      if (b.status !== 'uploaded' || b.package_sha256) throw conflict('package_already_uploaded', 'Paquet déjà déposé pour ce lot : créez un nouveau lot.');
      const key = this.storage.key(ctx.tenantId, 'imports', `${id}/${hash}`);
      if (!(await this.storage.exists(key))) await this.storage.put(key, buf);
      const previous = await one(tx, `SELECT id, published_at FROM import_batches WHERE package_sha256=$1 AND source_instance_id=$2 AND status='published'`, [hash, b.source_instance_id]);
      const diagnostic = {
        filename: safeName, rejections, previousBatch: previous ?? null, entries: inventory.length,
        note: previous ? 'Paquet identique déjà publié : un nouveau passage ne créera pas de doublon (identités source).' : undefined,
      };
      if (rejections.length) {
        await tx.query(`UPDATE import_batches SET status='rejected', package_sha256=$2, package_size=$3, diagnostic=$4 WHERE id=$1`, [id, hash, buf.length, JSON.stringify(diagnostic)]);
      } else {
        for (const f of inventory) {
          await tx.query(`INSERT INTO import_files(tenant_id, batch_id, path, kind, sha256, size_bytes) VALUES ($1,$2,$3,$4,'',$5)`, [ctx.tenantId, id, f.path, f.kind, f.size]);
        }
        await tx.query(`UPDATE import_batches SET package_sha256=$2, package_size=$3, diagnostic=$4, options=jsonb_set(options,'{filename}',to_jsonb($5::text)) WHERE id=$1`,
          [id, hash, buf.length, JSON.stringify(diagnostic), safeName]);
      }
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'import.package_uploaded', entityType: 'import', entityId: id, data: { sha256: hash, size: buf.length, rejected: rejections.length > 0 } });
      return this.getIn(tx, id);
    });
  }

  private async getIn(tx: Tx, id: string) {
    const b = await this.batch(tx, id);
    b.files = await many(tx, `SELECT path, kind, sha256, size_bytes, columns, row_count FROM import_files WHERE batch_id=$1 ORDER BY path`, [id]);
    return b;
  }

  /** Recharge le paquet depuis le stockage privé (fichiers locaux uniquement). */
  private async loadPackage(tenantId: string, b: any): Promise<{ files: Map<string, Buffer>; tables: Table[] }> {
    const buf = await this.storage.get(this.storage.key(tenantId, 'imports', `${b.id}/${b.package_sha256}`));
    if (sha256(buf) !== b.package_sha256) throw new AppError(500, 'package_altered', 'Empreinte du paquet incohérente.');
    const files = new Map<string, Buffer>();
    if (isZip(buf)) {
      const { entries, rejections } = await readZip(buf);
      if (rejections.length) throw badRequest(rejections[0].code, rejections[0].message);
      for (const e of entries) files.set(e.path, e.data!);
    } else files.set(b.options.filename ?? 'paquet.csv', buf);
    const tables: Table[] = [];
    for (const [path, data] of files) {
      if (classify(path) !== 'table' || path.startsWith('data/')) continue;
      try { tables.push(...(await parseTableFile(path, data))); }
      catch (err: any) { throw badRequest(err.code ?? 'unreadable_table', `${path} : ${err.message}`); }
    }
    return { files, tables };
  }

  /** Détection du profil/version : affichée avec niveau de confiance, confirmation obligatoire. */
  async detect(ctx: RequestContext, id: string) {
    const b = await this.db.tenantTx(ctx.tenantId, (tx) => this.batch(tx, id));
    if (!['uploaded', 'detected', 'mapped', 'simulated'].includes(b.status) || !b.package_sha256) throw conflict('invalid_state', 'Déposez d’abord un paquet valide.');
    const { files, tables } = await this.loadPackage(ctx.tenantId, b);
    let candidates: any[];
    const manifest = files.get('manifest.json');
    if (manifest && JSON.parse(manifest.toString('utf8')).format === 'tms-export') {
      candidates = [{ profile: 'native', version: NATIVE_PROFILE.version, status: 'validated', label: NATIVE_PROFILE.label, confidence: 1, files: [] }];
    } else {
      candidates = detectProfiles(tables.map((t) => ({ path: t.name, columns: t.columns })));
      // À confiance égale, privilégier le logiciel déclaré par le client.
      candidates.sort((x, y) => y.confidence - x.confidence || Number(y.profile === b.source_software) - Number(x.profile === b.source_software));
    }
    const unknownTables = tables.filter((t) => !candidates[0]?.files?.some((f: FileMapping) => f.path === t.name)).map((t) => t.name);
    const diagnostic = {
      ...b.diagnostic, candidates, tables: tables.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows.length })), unknownTables,
      verdict: !candidates[0] || candidates[0].confidence === 0 ? 'unrecognized' : candidates[0].status === 'provisional' ? 'provisional_profile' : 'recognized',
      message: !candidates[0] || candidates[0].confidence === 0
        ? 'Profil non reconnu : association manuelle possible pour les tables structurées lisibles. Aucun succès complet ne sera annoncé.'
        : candidates[0].status === 'provisional' ? 'Profil provisoire : couverture non garantie tant que le profil n’est pas validé sur des sauvegardes réelles.' : undefined,
    };
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      for (const t of tables) await tx.query(`UPDATE import_files SET columns=$3, row_count=$4 WHERE batch_id=$1 AND path=$2`, [id, t.name.split('#')[0], t.columns, t.rows.length]);
      await tx.query(`UPDATE import_batches SET status='detected', diagnostic=$2, profile_confidence=$3 WHERE id=$1`, [id, JSON.stringify(diagnostic), candidates[0]?.confidence ?? 0]);
      return { batchId: id, ...diagnostic };
    });
  }

  /** Confirmation utilisateur du profil et des associations de colonnes. */
  async confirmProfile(ctx: RequestContext, id: string, body: { profile: string; files?: FileMapping[] }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id, true);
      if (!['detected', 'mapped', 'simulated'].includes(b.status)) throw conflict('invalid_state', 'Lancez d’abord la détection.');
      const isNative = body.profile === 'native';
      const profile = isNative ? NATIVE_PROFILE : PROFILES.find((p) => p.code === body.profile);
      if (!profile) throw badRequest('unknown_profile', 'Profil inconnu.');
      const candidate = b.diagnostic?.candidates?.find((c: any) => c.profile === body.profile);
      const files: FileMapping[] = isNative ? [] : body.files ?? candidate?.files ?? [];
      const tables: { name: string; columns: string[] }[] = b.diagnostic?.tables ?? [];
      for (const f of files) {
        const t = tables.find((x) => x.name === f.path);
        if (!t) throw badRequest('unknown_file', `Fichier inconnu dans le paquet : ${f.path}`);
        if (!CANONICAL[f.entity]) throw badRequest('unknown_entity', `Objet inconnu : ${f.entity}`);
        for (const [field, col] of Object.entries(f.columns)) {
          if (!CANONICAL[f.entity][field]) throw badRequest('unknown_field', `Champ ${field} inconnu pour ${f.entity}`);
          if (!t.columns.includes(col)) throw badRequest('unknown_column', `Colonne « ${col} » absente de ${f.path}`);
        }
      }
      if (!isNative && !files.length) throw badRequest('empty_mapping', 'Aucun fichier associé.');
      const mapping = { profile: profile.code, version: profile.version, files };
      const mappingHash = stableHash(mapping);
      await tx.query(`UPDATE import_batches SET status='mapped', profile_code=$2, profile_version=$3, mapping=$4, mapping_hash=$5, profile_confirmed_at=now(), simulation=NULL WHERE id=$1`,
        [id, profile.code, profile.version, JSON.stringify(mapping), mappingHash]);
      await tx.query(`DELETE FROM import_rows WHERE batch_id=$1`, [id]);
      return { batchId: id, mapping, mappingHash, missingRequired: files.map((f) => ({ path: f.path, entity: f.entity, missing: requiredFields(f.entity).filter((r) => !f.columns[r]) })).filter((x) => x.missing.length) };
    });
  }

  // ─── Simulation ───────────────────────────────────────────────────────────
  async simulate(ctx: RequestContext, id: string, opts: { mode?: 'create_only' | 'create_update'; partial?: boolean; scope?: { entities?: EntityType[]; sessionsFrom?: string } }) {
    const b0 = await this.db.tenantTx(ctx.tenantId, (tx) => this.batch(tx, id));
    if (!['mapped', 'simulated'].includes(b0.status)) throw conflict('invalid_state', 'Confirmez d’abord le profil et les associations.');
    const { files, tables } = await this.loadPackage(ctx.tenantId, b0);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id, true);
      if (b.mapping_hash !== b0.mapping_hash) throw conflict('mapping_changed', 'Associations modifiées pendant la simulation : relancez.');
      const tz = (await one(tx, `SELECT timezone FROM tenants WHERE id=$1`, [ctx.tenantId]))!.timezone;
      const rows = b.profile_code === 'native' ? nativeRows(files) : buildRows(tables, b.mapping.files, tz);
      const mode = opts.mode ?? 'create_only';
      const idents = await many(tx, `SELECT entity_type, external_id, internal_id FROM external_identities WHERE source_instance_id=$1`, [b.source_instance_id]);
      const identMap = new Map(idents.map((i) => [`${i.entity_type}:${i.external_id}`, i.internal_id]));
      const existing = (entity: EntityType, key: string) => identMap.has(`${entity}:${key}`);

      // Périmètre choisi (sous-périmètre cohérent) : exclusions explicites et motivées.
      for (const r of rows) {
        if (opts.scope?.entities && !opts.scope.entities.includes(r.entity)) { r.action = 'exclude'; r.issues.push({ severity: 'info', code: 'out_of_scope', message: 'Hors périmètre sélectionné' }); }
        if (opts.scope?.sessionsFrom && r.entity === 'session' && r.data.starts_on && r.data.starts_on < opts.scope.sessionsFrom) {
          r.action = 'exclude'; r.issues.push({ severity: 'info', code: 'out_of_scope', message: `Session antérieure au ${opts.scope.sessionsFrom}` });
        }
      }
      validateRows(rows, existing);
      // Pièces : présence physique dans le paquet ; liens externes jamais téléchargés.
      for (const r of rows) {
        const p = r.entity === 'document' ? r.data.path : r.entity === 'invoice' ? r.data.pdf_path : null;
        if (p && /^https?:\/\//i.test(p)) r.issues.push({ severity: 'warning', code: 'external_link', message: `Lien externe conservé en diagnostic, jamais téléchargé : incluez le fichier dans une nouvelle sauvegarde.` });
        else if (p && !files.has(p)) r.issues.push({ severity: r.entity === 'document' ? 'blocking' : 'warning', code: 'missing_file', message: `Fichier absent du paquet : ${p}` });
      }

      // Actions planifiées.
      const localClientsBySiret = new Map((await many(tx, `SELECT id, siret FROM clients WHERE siret IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL`)).map((c) => [c.siret, c.id]));
      const personEmails = new Set((await many(tx, `SELECT email FROM persons WHERE email IS NOT NULL`)).map((p) => p.email));
      const lastVersions = new Map((await many(tx, `SELECT DISTINCT ON (entity_id) entity_id, after_version FROM import_changes ORDER BY entity_id, id DESC`)).map((c) => [c.entity_id, c.after_version]));
      for (const r of rows) {
        if (r.action === 'exclude') continue;
        if (severityOf(r.issues) === 'blocking') { r.action = 'reject'; continue; }
        const known = r.key ? identMap.get(`${r.entity}:${r.key}`) : undefined;
        if (known) {
          r.targetId = known;
          if (mode === 'create_update' && ['client', 'person', 'program', 'session'].includes(r.entity)) {
            const cur = r.entity === 'program' ? undefined : await one(tx, `SELECT version FROM ${TABLE_OF[r.entity]} WHERE id=$1`, [known]);
            if (r.entity !== 'program' && cur && lastVersions.has(known) && cur.version !== lastVersions.get(known)) {
              r.action = 'unchanged';
              r.issues.push({ severity: 'warning', code: 'local_change_preserved', message: 'Valeur modifiée localement depuis le dernier import : conservée (décision manuelle requise).' });
            } else r.action = 'update';
          } else r.action = 'unchanged';
          continue;
        }
        if (r.entity === 'client' && r.data.siret && localClientsBySiret.has(r.data.siret)) {
          r.action = 'unchanged'; r.targetId = localClientsBySiret.get(r.data.siret);
          r.issues.push({ severity: 'warning', code: 'linked_by_siret', message: 'SIRET identique à une fiche existante : rattachée sans création (candidat fusion, à vérifier).' });
          continue;
        }
        if (r.entity === 'person' && r.data.email && personEmails.has(r.data.email)) {
          r.issues.push({ severity: 'warning', code: 'email_shared', message: 'Email déjà utilisé par une autre personne : aucune fusion automatique par email.' });
        }
        r.action = 'create';
      }
      // Rejet propagé aux dépendants (validation totale par défaut ; partiel sur choix explicite).
      this.propagate(rows);

      const quota = await this.projectQuotas(tx, ctx.tenantId, rows, files);
      const summary = this.summarize(rows);
      const blocking = rows.filter((r) => r.action === 'reject').length;
      const simulation = {
        mode, partial: !!opts.partial, scope: opts.scope ?? null, mappingHash: b.mapping_hash, summary, quota, blocking,
        canCommit: quota.fits && (blocking === 0 || !!opts.partial),
        financial: this.financialTotals(rows.filter((r) => r.action !== 'reject' && r.action !== 'exclude')),
        computedAt: new Date().toISOString(),
      };
      await tx.query(`DELETE FROM import_rows WHERE batch_id=$1`, [id]);
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const vals: unknown[] = [];
        const ph = chunk.map((r, j) => {
          vals.push(ctx.tenantId, id, r.entity, r.file, r.line, r.key, JSON.stringify(r.data), severityOf(r.issues), JSON.stringify(r.issues), r.action, r.targetId ?? null);
          const o = j * 11;
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
        });
        await tx.query(`INSERT INTO import_rows(tenant_id, batch_id, entity_type, file_path, line_no, external_id, data, severity, issues, planned_action, target_id) VALUES ${ph.join(',')}`, vals);
      }
      await tx.query(`UPDATE import_batches SET status='simulated', options=options || $2, simulation=$3 WHERE id=$1`, [id, JSON.stringify({ mode, partial: !!opts.partial, scope: opts.scope ?? null }), JSON.stringify(simulation)]);
      return { batchId: id, ...simulation };
    });
  }

  private propagate(rows: CanonRow[]) {
    const dropped = new Map<EntityType, Set<string>>();
    for (const e of ENTITY_ORDER) dropped.set(e, new Set());
    for (const entity of ENTITY_ORDER) {
      for (const r of rows.filter((x) => x.entity === entity)) {
        for (const [field, target] of Object.entries(REFS[entity] ?? {})) {
          const v = r.data[field];
          if (v != null && dropped.get(target)!.has(String(v)) && r.action !== 'reject' && r.action !== 'exclude') {
            const excluded = rows.find((x) => x.entity === target && x.key === String(v))?.action === 'exclude';
            r.action = excluded ? 'exclude' : 'reject';
            r.issues.push({ severity: excluded ? 'info' : 'blocking', code: 'dependency_dropped', field, message: `Dépend d'un objet ${target} ${excluded ? 'exclu' : 'rejeté'} : ${v}` });
          }
        }
        if ((r.action === 'reject' || r.action === 'exclude') && r.key) dropped.get(entity)!.add(r.key);
        if (entity === 'invoice' && (r.action === 'reject' || r.action === 'exclude') && r.data.number) dropped.get(entity)!.add(String(r.data.number));
      }
    }
  }

  private summarize(rows: CanonRow[]) {
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      out[r.entity] ??= { read: 0, create: 0, update: 0, unchanged: 0, reject: 0, exclude: 0, warnings: 0 };
      out[r.entity].read++;
      out[r.entity][r.action!]++;
      if (r.issues.some((i) => i.severity === 'warning' || i.severity === 'fix')) out[r.entity].warnings++;
    }
    return out;
  }

  private financialTotals(rows: CanonRow[]) {
    const t: Record<string, { invoices: number; invoicesTtcCents: number; paymentsCents: number; incomplete: number }> = {};
    for (const r of rows) {
      const cur = (r.data.currency ?? 'EUR').toUpperCase();
      t[cur] ??= { invoices: 0, invoicesTtcCents: 0, paymentsCents: 0, incomplete: 0 };
      if (r.entity === 'invoice') {
        t[cur].invoices++;
        if (r.data.total_ttc != null) t[cur].invoicesTtcCents += Math.round(Number(r.data.total_ttc) * 100) * (r.data.kind === 'credit_note' ? -1 : 1);
        else t[cur].incomplete++;
      }
      if (r.entity === 'payment') t[cur].paymentsCents += Math.round(Number(r.data.amount) * 100);
    }
    return t;
  }

  /** Projection des quotas après import ; rien n'est tronqué silencieusement. */
  private async projectQuotas(tx: Tx, tenantId: string, rows: CanonRow[], files: Map<string, Buffer>) {
    const e = await this.ent.get(tenantId, tx);
    const tz = (await one(tx, `SELECT timezone FROM tenants WHERE id=$1`, [tenantId]))!.timezone;
    const year = yearOf(new Date(), tz);
    const today = new Date().toISOString().slice(0, 10);
    const live = rows.filter((r) => r.action === 'create');
    const billedRefs = new Set(rows.filter((r) => (r.entity === 'invoice' || r.entity === 'payment') && r.action !== 'reject' && r.action !== 'exclude').map((r) => String(r.data.client_ref)));
    const newBilled = live.filter((r) => r.entity === 'client' && (r.data.is_customer || billedRefs.has(String(r.key)))).length;
    const currentSessions = new Set(live.filter((r) => r.entity === 'session' && (r.data.ends_on ?? r.data.starts_on) >= today && String(r.data.starts_on).startsWith(String(year))).map((r) => r.key));
    const newLearners = new Set(live.filter((r) => r.entity === 'enrollment' && currentSessions.has(String(r.data.session_ref))).map((r) => r.data.person_ref)).size;
    const newActive = live.filter((r) => r.entity === 'session' && (r.data.ends_on ?? r.data.starts_on) >= today && !['draft', 'cancelled', 'completed'].includes(r.data.status ?? 'planned')).length;
    const docPaths = new Set(live.filter((r) => r.entity === 'document').map((r) => r.data.path).concat(live.filter((r) => r.entity === 'invoice' && r.data.pdf_path).map((r) => r.data.pdf_path)));
    const newBytes = [...docPaths].reduce((a, p) => a + (files.get(p)?.length ?? 0), 0);
    const checks: [string, number, number | null][] = [
      ['billedClients', (await USAGE_QUERIES.billedClients(tx, tenantId, year)) + newBilled, e.limits.billedClients],
      ['learnersPerYear', (await USAGE_QUERIES.learnersPerYear(tx, tenantId, year)) + newLearners, e.limits.learnersPerYear],
      ['activeSessions', (await USAGE_QUERIES.activeSessions(tx, tenantId, year)) + newActive, e.limits.activeSessions],
      ['storageBytes', (await USAGE_QUERIES.storageBytes(tx, tenantId, year)) + newBytes, e.limits.storageBytes],
    ];
    const over = checks.filter(([, v, l]) => l !== null && v > l).map(([quota, projected, limit]) => ({ quota, projected, limit }));
    return { fits: over.length === 0, over, plan: e.planCode, message: over.length ? 'Volume au-delà de votre offre : sélectionnez un sous-périmètre cohérent ou passez à une offre payante. Aucune publication tronquée.' : undefined };
  }

  /** Export des anomalies (CSV ; cellules neutralisées contre l'injection de formules). */
  async anomaliesCsv(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.batch(tx, id);
      const rows = await many(tx, `SELECT file_path, line_no, entity_type, external_id, severity, issues, planned_action FROM import_rows WHERE batch_id=$1 AND severity <> 'ok' ORDER BY file_path, line_no`, [id]);
      const lines = ['fichier;ligne;objet;identifiant;gravite;code;colonne;message;action'];
      for (const r of rows) for (const i of r.issues) lines.push([r.file_path, r.line_no, r.entity_type, r.external_id, i.severity, i.code, i.field, i.message, r.planned_action].map(csvCell).join(';'));
      return '﻿' + lines.join('\r\n');
    });
  }

  // ─── Publication ────────────────────────────────────────────────────────
  async commit(ctx: RequestContext, id: string) {
    const b0 = await this.db.tenantTx(ctx.tenantId, (tx) => this.batch(tx, id));
    if (b0.status === 'published') return this.report(ctx, id); // idempotent
    if (b0.status !== 'simulated') throw conflict('invalid_state', 'Simulation requise avant publication.');
    if (!b0.simulation?.canCommit) {
      if (!b0.simulation?.quota?.fits) throw paymentRequired('quota_exceeded', b0.simulation.quota.message, b0.simulation.quota);
      throw conflict('blocking_issues', 'Anomalies bloquantes : corrigez le paquet ou choisissez explicitement un import partiel.', { blocking: b0.simulation?.blocking });
    }
    const { files } = await this.loadPackage(ctx.tenantId, b0);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id, true);
      if (b.status !== 'simulated' || b.mapping_hash !== b0.mapping_hash || b.simulation.computedAt !== b0.simulation.computedAt) throw conflict('batch_changed', 'Le lot a changé : relancez la simulation.');
      await lock(tx, `import:${ctx.tenantId}`);
      // Quotas revérifiés au moment de la publication (données vivantes).
      const recheck = await this.projectQuotas(tx, ctx.tenantId, (await many(tx, `SELECT entity_type entity, external_id key, data, planned_action action FROM import_rows WHERE batch_id=$1`, [id])) as any, files);
      if (!recheck.fits) throw paymentRequired('quota_exceeded', recheck.message!, recheck);
      await tx.query(`UPDATE import_batches SET status='committing' WHERE id=$1`, [id]);
      const resolved = new Map<string, string>(); // entity:key -> id interne
      for (const i of await many(tx, `SELECT entity_type, external_id, internal_id FROM external_identities WHERE source_instance_id=$1`, [b.source_instance_id])) resolved.set(`${i.entity_type}:${i.external_id}`, i.internal_id);
      const invoiceByNumber = new Map<string, string>();
      const tz = (await one(tx, `SELECT timezone FROM tenants WHERE id=$1`, [ctx.tenantId]))!.timezone;
      const today = new Date().toISOString().slice(0, 10);
      const histSeries = `HIST-${b.source_software}`.toUpperCase().slice(0, 30);
      await tx.query(`INSERT INTO invoice_series(tenant_id, code, prefix, is_historical) VALUES ($1,$2,'',true) ON CONFLICT DO NOTHING`, [ctx.tenantId, histSeries]);
      const billedRefs = new Set((await many(tx, `SELECT data->>'client_ref' r FROM import_rows WHERE batch_id=$1 AND entity_type IN ('invoice','payment') AND planned_action IN ('create','unchanged','update')`, [id])).map((x) => x.r));
      const ref = (entity: EntityType, key: any) => (key == null ? null : resolved.get(`${entity}:${key}`) ?? (entity === 'invoice' ? invoiceByNumber.get(String(key)) : undefined) ?? null);

      const record = async (r: any, entityId: string, action: 'create' | 'update', before: unknown, afterVersion: number | null) => {
        await tx.query(`INSERT INTO import_changes(tenant_id, batch_id, entity_type, entity_id, action, before, after_version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.tenantId, id, r.entity_type, entityId, action, before ? JSON.stringify(before) : null, afterVersion]);
      };
      const identify = async (r: any, entityId: string) => {
        if (!r.external_id) return;
        await tx.query(`INSERT INTO external_identities(tenant_id, source_instance_id, entity_type, external_id, internal_id, batch_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [ctx.tenantId, b.source_instance_id, r.entity_type, r.external_id, entityId, id]);
        resolved.set(`${r.entity_type}:${r.external_id}`, entityId);
      };

      for (const entity of ENTITY_ORDER) {
        const rows = await many(tx, `SELECT * FROM import_rows WHERE batch_id=$1 AND entity_type=$2 AND planned_action IN ('create','update','unchanged') ORDER BY id`, [id, entity]);
        for (const r of rows) {
          const d = r.data;
          if (r.planned_action === 'unchanged') {
            if (r.target_id) { await identify(r, r.target_id); if (entity === 'invoice' && d.number) invoiceByNumber.set(String(d.number), r.target_id); }
            continue;
          }
          if (r.planned_action === 'update') {
            const table = TABLE_OF[entity as EntityType];
            const before = await one(tx, `SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [r.target_id]);
            if (!before) continue;
            const after = entity === 'client' ? await one(tx, `UPDATE clients SET name=$2, siret=coalesce($3,siret), billing_email=coalesce($4,billing_email), version=version+1 WHERE id=$1 RETURNING version`, [r.target_id, d.name, d.siret, d.email])
              : entity === 'person' ? await one(tx, `UPDATE persons SET first_name=$2, last_name=$3, email=coalesce($4,email), phone=coalesce($5,phone), version=version+1 WHERE id=$1 RETURNING version`, [r.target_id, d.first_name, d.last_name, d.email, d.phone])
                : entity === 'program' ? await one(tx, `UPDATE programs SET title=$2 WHERE id=$1 RETURNING 1 AS version`, [r.target_id, d.title])
                  : await one(tx, `UPDATE training_sessions SET title=coalesce($2,title), capacity=coalesce($3,capacity), location=coalesce($4,location), version=version+1 WHERE id=$1 RETURNING version`, [r.target_id, d.title, d.capacity, d.location]);
            await record(r, r.target_id, 'update', before, after?.version ?? null);
            await tx.query(`UPDATE import_rows SET done=true WHERE id=$1`, [r.id]);
            continue;
          }
          const newId = randomUUID();
          let version: number | null = 1;
          switch (entity) {
            case 'client':
              await tx.query(`INSERT INTO clients(id, tenant_id, kind, status, is_funder, name, siren, siret, billing_email, billing_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [newId, ctx.tenantId, d.kind ?? 'company', d.is_customer || billedRefs.has(String(r.external_id)) ? 'customer' : 'prospect', !!d.is_funder, d.name,
                  d.siret ? String(d.siret).slice(0, 9) : null, d.siret, d.email, JSON.stringify({ line1: d.address ?? '', postal_code: d.postal_code ?? '', city: d.city ?? '' })]);
              break;
            case 'person': {
              await tx.query(`INSERT INTO persons(id, tenant_id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5,$6)`, [newId, ctx.tenantId, d.first_name, d.last_name, d.email, d.phone]);
              await tx.query(`INSERT INTO person_roles(tenant_id, person_id, role) VALUES ($1,$2,$3)`, [ctx.tenantId, newId, d.role ?? 'learner']);
              const client = ref('client', d.client_ref);
              if (client && d.role === 'contact') await tx.query(`INSERT INTO client_contacts(tenant_id, client_id, person_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.tenantId, client, newId]);
              break;
            }
            case 'program':
              await tx.query(`INSERT INTO programs(id, tenant_id, code, title, rncp_code) VALUES ($1,$2,$3,$4,$5)`, [newId, ctx.tenantId, d.code, d.title, d.rncp_code]);
              await tx.query(`INSERT INTO program_versions(tenant_id, program_id, version, objectives, duration_minutes, modality, price_ht, vat_rate) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
                [ctx.tenantId, newId, d.objectives ?? '', Math.max(1, Math.round(Number(d.duration_hours ?? 1) * 60)), d.modality ?? 'onsite', d.price_ht, d.vat_rate]);
              version = null;
              break;
            case 'session': {
              const pv = await one(tx, `SELECT id FROM program_versions WHERE program_id=$1 ORDER BY version DESC LIMIT 1`, [ref('program', d.program_ref)]);
              await tx.query(`UPDATE program_versions SET locked_at=coalesce(locked_at, now()) WHERE id=$1`, [pv!.id]);
              const end = d.ends_on ?? d.starts_on;
              const historical = end < today;
              const status = d.status === 'cancelled' ? 'cancelled' : historical ? 'completed' : d.status ?? 'planned';
              await tx.query(`INSERT INTO training_sessions(id, tenant_id, program_version_id, kind, client_id, title, status, capacity, timezone, starts_on, ends_on, location, is_historical)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [newId, ctx.tenantId, pv!.id, d.kind ?? (d.client_ref ? 'intra' : 'inter'), ref('client', d.client_ref), d.title ?? 'Session reprise', status, d.capacity, tz, d.starts_on, d.ends_on, d.location, historical]);
              break;
            }
            case 'enrollment':
              await tx.query(`INSERT INTO enrollments(id, tenant_id, session_id, person_id, client_id, status) VALUES ($1,$2,$3,$4,$5,$6)`,
                [newId, ctx.tenantId, ref('session', d.session_ref), ref('person', d.person_ref), ref('client', d.client_ref), d.status ?? 'confirmed']);
              resolved.set(`enrollment:${d.session_ref}|${d.person_ref}`, newId);
              version = null;
              break;
            case 'attendance': {
              const sessionId = ref('session', d.session_ref);
              const enr = ref('enrollment', `${d.session_ref}|${d.person_ref}`) ?? (await one(tx, `SELECT id FROM enrollments WHERE session_id=$1 AND person_id=$2`, [sessionId, ref('person', d.person_ref)]))?.id;
              let slot = await one(tx, `SELECT id FROM slots WHERE session_id=$1 AND starts_at=$2 AND ends_at=$3`, [sessionId, d.starts_at, d.ends_at]);
              if (!slot) slot = await one(tx, `INSERT INTO slots(tenant_id, session_id, starts_at, ends_at) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, sessionId, d.starts_at, d.ends_at]);
              const dur = (Date.parse(d.ends_at) - Date.parse(d.starts_at)) / 60000;
              const status = d.status ?? (d.minutes === 0 ? 'absent' : 'present');
              const minutes = Math.min(dur, d.minutes ?? (status === 'absent' ? 0 : dur));
              await tx.query(`INSERT INTO attendance(id, tenant_id, enrollment_id, slot_id, status, minutes, method, proof) VALUES ($1,$2,$3,$4,$5,$6,'import',$7)`,
                [newId, ctx.tenantId, enr, slot!.id, status, minutes, JSON.stringify({ batch: id, file: r.file_path, line: r.line_no })]);
              version = null;
              break;
            }
            case 'invoice': {
              // Historique : numéro, date, état et références conservés ; jamais réémis ni renvoyé.
              const incomplete = d.total_ttc == null || d.total_ht == null;
              await tx.query(`INSERT INTO invoices(id, tenant_id, kind, client_id, session_id, status, currency, total_ht, total_vat, total_ttc, is_historical, is_incomplete, external_ref)
                              VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,true,$10,$11)`,
                [newId, ctx.tenantId, d.kind ?? 'invoice', ref('client', d.client_ref), ref('session', d.session_ref), (d.currency ?? 'EUR').toUpperCase(),
                  d.total_ht ?? 0, d.total_vat ?? 0, d.total_ttc ?? 0, incomplete, r.external_id]);
              await tx.query(`UPDATE invoices SET status='issued', series_code=$2, number=$3, issue_date=$4, due_date=$5 WHERE id=$1`, [newId, histSeries, d.number, d.issue_date, d.due_date ?? d.issue_date]);
              invoiceByNumber.set(String(d.number), newId);
              if (d.pdf_path && files.has(d.pdf_path)) await this.storeImportedDoc(tx, ctx.tenantId, id, d.pdf_path, files.get(d.pdf_path)!, 'invoice', newId, 'invoice_original');
              version = null;
              break;
            }
            case 'payment': {
              await tx.query(`INSERT INTO payments(id, tenant_id, client_id, amount, currency, received_on, method, reference, source) VALUES ($1,$2,$3,$4,'EUR',$5,$6,$7,'import')`,
                [newId, ctx.tenantId, ref('client', d.client_ref), d.amount, d.received_on, d.method ?? 'transfer', d.reference]);
              const inv = ref('invoice', d.invoice_ref);
              if (inv && Number(d.amount) > 0) {
                const bal = await one(tx, `SELECT i.total_ttc - coalesce((SELECT sum(amount) FROM payment_allocations WHERE invoice_id=i.id),0) b, i.client_id FROM invoices i WHERE id=$1`, [inv]);
                const amt = Math.min(Number(d.amount), Number(bal!.b));
                if (amt > 0 && bal!.client_id === ref('client', d.client_ref)) await tx.query(`INSERT INTO payment_allocations(tenant_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, newId, inv, amt.toFixed(2)]);
              }
              version = null;
              break;
            }
            case 'document': {
              const owner = d.owner_type && d.owner_ref ? ref(d.owner_type, d.owner_ref) : null;
              await this.storeImportedDoc(tx, ctx.tenantId, id, d.path, files.get(d.path)!, owner ? d.owner_type : 'organization', owner, d.kind ?? 'imported', newId);
              version = null;
              break;
            }
          }
          await identify(r, newId);
          await record(r, newId, 'create', null, version);
          await tx.query(`UPDATE import_rows SET done=true, target_id=$2 WHERE id=$1`, [r.id, newId]);
        }
      }
      const report = await this.buildReport(tx, id);
      await tx.query(`UPDATE import_batches SET status='published', published_at=now(), report=$2 WHERE id=$1`, [id, JSON.stringify(report)]);
      // Aucun email, relance, facture ou tâche déclenché par l'historique repris.
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'import.published', entityType: 'import', entityId: id, data: report.totals });
      return report;
    });
  }

  private async storeImportedDoc(tx: Tx, tenantId: string, batchId: string, path: string, data: Buffer, ownerType: string, ownerId: string | null, kind: string, id = randomUUID()) {
    const key = this.storage.key(tenantId, 'documents', id);
    await this.storage.put(key, data);
    const mime = /\.pdf$/i.test(path) ? 'application/pdf' : /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'application/octet-stream';
    await tx.query(`INSERT INTO documents(id, tenant_id, owner_type, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, tenantId, ownerType, ownerId, kind, path.split('/').pop()!.slice(0, 150), mime, data.length, sha256(data), key, JSON.stringify({ importBatch: batchId, sourcePath: path, original: true })]);
    return id;
  }

  private async buildReport(tx: Tx, id: string) {
    const b = await this.batch(tx, id);
    const counts = await many(tx, `SELECT entity_type, planned_action, count(*)::int n FROM import_rows WHERE batch_id=$1 GROUP BY 1,2`, [id]);
    const perEntity: Record<string, Record<string, number>> = {};
    for (const c of counts) {
      perEntity[c.entity_type] ??= { read: 0, created: 0, updated: 0, unchanged: 0, rejected: 0, excluded: 0 };
      const k = { create: 'created', update: 'updated', unchanged: 'unchanged', reject: 'rejected', exclude: 'excluded' }[c.planned_action as string]!;
      perEntity[c.entity_type][k] += c.n; perEntity[c.entity_type].read += c.n;
    }
    const totals = Object.values(perEntity).reduce((a, e) => { for (const k of Object.keys(e)) a[k] = (a[k] ?? 0) + e[k]; return a; }, {} as Record<string, number>);
    // Contrôle : lues = créées + mises à jour + inchangées + rejetées + exclues (100 % des lignes classées).
    const balanced = Object.values(perEntity).every((e) => e.read === e.created + e.updated + e.unchanged + e.rejected + e.excluded);
    const fin = await many(tx, `SELECT i.currency, count(*)::int invoices, coalesce(sum(CASE WHEN i.kind='credit_note' THEN -i.total_ttc ELSE i.total_ttc END),0)::text ttc,
                                       count(*) FILTER (WHERE i.is_incomplete)::int incomplete
                                  FROM import_changes c JOIN invoices i ON i.id=c.entity_id WHERE c.batch_id=$1 AND c.entity_type='invoice' AND c.action='create' GROUP BY 1`, [id]);
    const pay = await one(tx, `SELECT coalesce(sum(p.amount),0)::text s FROM import_changes c JOIN payments p ON p.id=c.entity_id WHERE c.batch_id=$1 AND c.entity_type='payment'`, [id]);
    const expected = b.simulation?.financial ?? {};
    const financial = fin.map((f) => {
      const exp = expected[f.currency];
      const diffCents = exp ? Math.round(Number(f.ttc) * 100) - exp.invoicesTtcCents : null;
      return { currency: f.currency, invoices: f.invoices, totalTtc: f.ttc, incomplete: f.incomplete, expectedTtcCents: exp?.invoicesTtcCents ?? null, differenceCents: diffCents };
    });
    const unmapped = (b.diagnostic?.tables ?? []).map((t: any) => {
      const m = (b.mapping?.files ?? []).find((f: FileMapping) => f.path === t.name);
      return { file: t.name, ignoredColumns: m ? t.columns.filter((c: string) => !Object.values(m.columns).includes(c)) : t.columns, mapped: !!m };
    });
    return {
      batchId: id, profile: `${b.profile_code} ${b.profile_version}`, source: { software: b.source_software, instance: b.source_instance_id, sha256: b.package_sha256 },
      perEntity, totals, balanced, financial, paymentsImported: pay!.s, coverage: unmapped,
      historicalNotice: 'Historique repris : aucune facture réémise, aucune convention renvoyée, aucun email déclenché. Données incomplètes exclues des agrégats certifiés.',
    };
  }

  report(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const b = await this.batch(tx, id);
      return b.report ?? (await this.buildReport(tx, id));
    });
  }

  rows(ctx: RequestContext, id: string, q: { severity?: string; entity?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT id, entity_type, file_path, line_no, external_id, data, severity, issues, planned_action, target_id FROM import_rows
      WHERE batch_id=$1 AND ($2::text IS NULL OR severity=$2) AND ($3::text IS NULL OR entity_type=$3) ORDER BY entity_type, file_path, line_no LIMIT $4 OFFSET $5`,
      [id, q.severity ?? null, q.entity ?? null, q.limit, q.offset]));
  }

  // ─── Compensation (rollback) ────────────────────────────────────────────
  /**
   * Après publication : compensations depuis le journal du lot. Suppression d'un objet créé
   * seulement s'il n'est pas utilisé ailleurs ; restauration d'une mise à jour seulement si
   * la version est inchangée. Tout conflit bloque l'annulation entière (aucune cascade silencieuse).
   */
  async rollback(ctx: RequestContext, id: string) {
    const storageKeys: string[] = [];
    const result = await this.db.tenantTx(ctx.tenantId, async (tx) => {
        const b = await this.batch(tx, id, true);
        if (b.status !== 'published') throw conflict('invalid_state', 'Seul un lot publié peut être compensé.');
        await tx.query(`SELECT set_config('app.import_rollback', 'on', true)`);
        const changes = await many(tx, `SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id DESC`, [id]);
        const conflicts: { entity: string; id: string; reason: string }[] = [];
        for (const c of changes) {
          const table = TABLE_OF[c.entity_type as EntityType];
          if (c.action === 'update') {
            const cur = await one(tx, `SELECT version FROM ${table} WHERE id=$1`, [c.entity_id]);
            if (c.after_version != null && cur && cur.version !== c.after_version) { conflicts.push({ entity: c.entity_type, id: c.entity_id, reason: 'modifié localement après import' }); continue; }
            const before = c.before;
            if (c.entity_type === 'client') await tx.query(`UPDATE clients SET name=$2, siret=$3, billing_email=$4, version=version+1 WHERE id=$1`, [c.entity_id, before.name, before.siret, before.billing_email]);
            else if (c.entity_type === 'person') await tx.query(`UPDATE persons SET first_name=$2, last_name=$3, email=$4, phone=$5, version=version+1 WHERE id=$1`, [c.entity_id, before.first_name, before.last_name, before.email, before.phone]);
            else if (c.entity_type === 'program') await tx.query(`UPDATE programs SET title=$2 WHERE id=$1`, [c.entity_id, before.title]);
            else await tx.query(`UPDATE training_sessions SET title=$2, capacity=$3, location=$4, version=version+1 WHERE id=$1`, [c.entity_id, before.title, before.capacity, before.location]);
            continue;
          }
          if (c.after_version != null) {
            const cur = await one(tx, `SELECT version FROM ${table} WHERE id=$1`, [c.entity_id]);
            if (cur && cur.version !== c.after_version) { conflicts.push({ entity: c.entity_type, id: c.entity_id, reason: 'modifié localement après import' }); continue; }
          }
          await tx.query('SAVEPOINT rb');
          try {
            if (c.entity_type === 'person') await tx.query(`DELETE FROM person_roles WHERE person_id=$1`, [c.entity_id]);
            if (c.entity_type === 'person') await tx.query(`DELETE FROM client_contacts WHERE person_id=$1`, [c.entity_id]);
            if (c.entity_type === 'program') await tx.query(`DELETE FROM program_versions WHERE program_id=$1`, [c.entity_id]);
            if (c.entity_type === 'session') await tx.query(`DELETE FROM slots WHERE session_id=$1 AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.slot_id=slots.id)`, [c.entity_id]);
            if (c.entity_type === 'invoice') await tx.query(`DELETE FROM invoice_lines WHERE invoice_id=$1`, [c.entity_id]);
            if (c.entity_type === 'payment') await tx.query(`DELETE FROM payment_allocations WHERE payment_id=$1`, [c.entity_id]);
            if (c.entity_type === 'invoice') await tx.query(`DELETE FROM payment_allocations WHERE invoice_id=$1 AND payment_id IN (SELECT entity_id FROM import_changes WHERE batch_id=$2 AND entity_type='payment')`, [c.entity_id, id]);
            if (c.entity_type === 'invoice' || c.entity_type === 'document') {
              const docs = await many(tx, `SELECT storage_key FROM documents WHERE (id=$1 OR (owner_id=$1 AND provenance->>'importBatch'=$2))`, [c.entity_id, id]);
              storageKeys.push(...docs.map((d) => d.storage_key));
              await tx.query(`DELETE FROM documents WHERE id=$1 OR (owner_id=$1 AND provenance->>'importBatch'=$2)`, [c.entity_id, id]);
            }
            await tx.query(`DELETE FROM ${table} WHERE id=$1`, [c.entity_id]);
            await tx.query('RELEASE SAVEPOINT rb');
          } catch (err: any) {
            await tx.query('ROLLBACK TO SAVEPOINT rb');
            conflicts.push({ entity: c.entity_type, id: c.entity_id, reason: err.code === '23503' ? 'utilisé par des données créées après l’import' : err.message });
          }
        }
        if (conflicts.length) throw conflict('rollback_blocked', 'Annulation bloquée : des objets du lot ont été modifiés ou utilisés depuis. Rapport d’intervention joint ; rien n’a été supprimé.', conflicts);
        await tx.query(`DELETE FROM external_identities WHERE batch_id=$1`, [id]);
        await tx.query(`UPDATE import_batches SET status='rolled_back' WHERE id=$1`, [id]);
        await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'import.rolled_back', entityType: 'import', entityId: id, data: { changes: changes.length } });
        return { rolledBack: true, changes: changes.length };
      });
    for (const k of storageKeys) await this.storage.remove(k);
    return result;
  }
}
