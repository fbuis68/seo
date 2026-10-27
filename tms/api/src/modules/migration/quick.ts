import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { RequestContext } from '../../core/context';
import { Db, many } from '../../core/db';
import { AppError, badRequest } from '../../core/errors';
import { CANONICAL, EntityType } from './canonical';
import { MigrationService } from './migration.service';
import { CanonRow, buildRows, severityOf, validateRows } from './pipeline';
import { COMMON, normHeader } from './profiles';
import { Table, parseTableFile } from './tabular';

/**
 * Import rapide (parcours repris de Serv-Izy) : un fichier, correspondance colonne par colonne proposée puis
 * modifiable, aperçu recalculé à chaque changement, statut par ligne (OK, à vérifier, erreur, doublon), import en un clic.
 * La publication passe par un lot de reprise classique : journal, rapport et annulation restent disponibles.
 */
export type QuickEntity = 'client' | 'person';
export type QuickStatus = 'ok' | 'warning' | 'error' | 'duplicate';
interface QuickField { key: string; label: string; multiple?: boolean; required?: boolean; aliases: string[] }

const SOURCE = 'fichier-excel';
const PREVIEW_ROWS = 50;
const MAX_ISSUES = 300;
const MAX_ROWS = 20000;

const FIELDS: Record<QuickEntity, QuickField[]> = {
  client: [
    { key: 'external_id', label: 'Code client', aliases: ['code client', 'code', 'id client', 'identifiant', 'reference', 'ref'] },
    { key: 'name', label: 'Raison sociale / nom', required: true, aliases: ['raison sociale', 'nom', 'entreprise', 'societe', 'client', 'nom client', 'denomination', 'nom entreprise', 'organisme'] },
    { key: 'kind', label: 'Type (entreprise / particulier)', aliases: ['type', 'type client', 'forme', 'categorie'] },
    { key: 'siret', label: 'SIRET', aliases: ['siret', 'n siret', 'numero siret', 'siret siege'] },
    { key: 'vat_number', label: 'N° TVA intracommunautaire', aliases: ['tva intracommunautaire', 'n tva', 'numero tva', 'tva intra', 'n tva intra'] },
    { key: 'email', label: 'Email de facturation', aliases: ['email', 'e mail', 'mail', 'courriel', 'email facturation', 'adresse mail', 'adresse email'] },
    { key: 'phone', label: 'Téléphone', aliases: ['telephone', 'tel', 'telephone standard', 'standard', 'phone'] },
    { key: 'address', label: 'Adresse', multiple: true, aliases: ['adresse', 'rue', 'adresse 1', 'adresse 2', 'complement', 'complement adresse', 'adresse ligne 1', 'adresse ligne 2', 'voie'] },
    { key: 'postal_code', label: 'Code postal', aliases: ['code postal', 'cp', 'zip', 'postal code'] },
    { key: 'city', label: 'Ville', aliases: ['ville', 'commune', 'city', 'localite'] },
    { key: 'is_funder', label: 'Financeur (oui/non)', aliases: ['financeur', 'opco', 'est financeur'] },
    { key: 'is_customer', label: 'Client facturé (oui/non)', aliases: ['client facture', 'est client', 'client actif'] },
  ],
  person: [
    { key: 'external_id', label: 'Identifiant', aliases: ['identifiant', 'id', 'id apprenant', 'id stagiaire', 'matricule', 'code apprenant'] },
    { key: 'civility', label: 'Civilité', aliases: ['civilite', 'civ', 'titre', 'genre', 'sexe'] },
    { key: 'first_name', label: 'Prénom', aliases: ['prenom', 'prenoms', 'first name', 'firstname'] },
    { key: 'last_name', label: 'Nom', aliases: ['nom', 'nom de famille', 'last name', 'lastname', 'nom usage', 'nom d usage'] },
    { key: 'full_name', label: 'Nom complet (prénom + nom)', aliases: ['nom complet', 'nom prenom', 'prenom nom', 'stagiaire', 'apprenant', 'participant', 'identite', 'full name'] },
    { key: 'email', label: 'Email', aliases: ['email', 'e mail', 'mail', 'courriel', 'adresse mail', 'adresse email'] },
    { key: 'phone', label: 'Téléphone', aliases: ['telephone', 'tel', 'telephone fixe', 'tel fixe', 'phone'] },
    { key: 'mobile', label: 'Portable', aliases: ['portable', 'mobile', 'gsm', 'telephone portable', 'tel portable'] },
    { key: 'birth_date', label: 'Date de naissance', aliases: ['date de naissance', 'naissance', 'ne le', 'date naissance', 'ddn'] },
    { key: 'job_title', label: 'Fonction', aliases: ['fonction', 'poste', 'metier', 'emploi'] },
    { key: 'address', label: 'Adresse', multiple: true, aliases: ['adresse', 'rue', 'adresse 1', 'adresse 2', 'complement', 'complement adresse', 'adresse ligne 1', 'adresse ligne 2'] },
    { key: 'postal_code', label: 'Code postal', aliases: ['code postal', 'cp', 'zip'] },
    { key: 'city', label: 'Ville', aliases: ['ville', 'commune', 'localite'] },
    { key: 'client_ref', label: 'Code client (employeur)', aliases: ['code client', 'id client', 'id entreprise', 'code entreprise', 'id employeur'] },
    { key: 'role', label: 'Rôle (apprenant, formateur, contact)', aliases: ['role', 'profil', 'type'] },
  ],
};
const norm = (h: string) => normHeader(h).replace(/_/g, ' ');

/** Correspondance proposée : 1) alias exact, 2) alias contenu dans l'en-tête (le plus long d'abord). */
export function suggestMapping(entity: QuickEntity, headers: string[]): (string | null)[] {
  // Alias propres d'abord ; ceux de la reprise générale seulement s'ils ne désignent pas déjà un autre champ (« portable » → Portable).
  const own = new Map(FIELDS[entity].flatMap((f) => f.aliases.map((x) => [x, f.key] as const)));
  const fields = FIELDS[entity].map((f) => ({ ...f, aliases: [...new Set([...f.aliases, ...((COMMON[entity] as any)[f.key] ?? []).map((a: string) => a.replace(/_/g, ' ')).filter((a: string) => !own.has(a) || own.get(a) === f.key)])] }));
  const h = headers.map(norm);
  const out: (string | null)[] = headers.map(() => null);
  const used = new Set<string>();
  const assign = (col: number, f: QuickField) => { out[col] = f.key; if (!f.multiple) used.add(f.key); };
  h.forEach((x, col) => { const f = fields.find((f) => !used.has(f.key) && f.aliases.includes(x)); if (f) assign(col, f); });
  const cands = fields.flatMap((f) => f.aliases.map((a) => ({ f, a }))).sort((x, y) => y.a.length - x.a.length);
  h.forEach((x, col) => {
    if (out[col] || !x) return;
    const m = cands.find(({ f, a }) => !used.has(f.key) && a.length > 2 && ` ${x} `.includes(` ${a} `));
    if (m) assign(col, m.f);
  });
  // « Nom » seul sans prénom : probablement un nom complet.
  if (entity === 'person' && out.includes('last_name') && !out.includes('first_name') && !out.includes('full_name')) out[out.indexOf('last_name')] = 'full_name';
  return out;
}

const CIV = /^(mme|madame|mlle|mademoiselle|m\.?|mr\.?|monsieur)\s+/i;
/** « Mme MARTIN Jeanne » → Mme / Jeanne / MARTIN ; « Jeanne Martin » → Jeanne / Martin. */
export function splitFullName(raw: string): { civility?: string; first_name: string; last_name: string } {
  let v = raw.trim().replace(/\s+/g, ' ');
  let civility: string | undefined;
  const m = CIV.exec(v);
  if (m) { civility = /^m(me|adame)/i.test(m[1]) ? 'Mme' : /^m(lle|ademoiselle)/i.test(m[1]) ? 'Mlle' : 'M.'; v = v.slice(m[0].length); }
  const p = v.split(' ').filter(Boolean);
  if (p.length <= 1) return { civility, first_name: '', last_name: p[0] ?? '' };
  const up = (s: string) => s.length > 1 && s === s.toUpperCase() && /[A-Z]/i.test(s);
  if (up(p[0]) && !up(p[p.length - 1])) { const i = p.findIndex((x) => !up(x)); return { civility, last_name: p.slice(0, i).join(' '), first_name: p.slice(i).join(' ') }; }
  return { civility, first_name: p[0], last_name: p.slice(1).join(' ') };
}
/** Excel supprime les zéros initiaux : 612345678 → 0612345678, 7500 → 07500. */
const fixPhone = (v: string) => { const x = v.replace(/[\s.\-()/]/g, ''); return /^\d{9}$/.test(x) && /^[1-79]/.test(x) ? `0${x}` : v; };
const fixCp = (v: string) => (/^\d{4}$/.test(v.trim()) ? `0${v.trim()}` : v);

@Injectable()
export class QuickImportService {
  constructor(private db: Db, private m: MigrationService) {}

  private async readSheet(buf: Buffer, filename: string, entity: QuickEntity, sheet?: string) {
    if (!buf.length) throw badRequest('empty_file', 'Fichier vide.');
    if (buf.length > 10 * 1024 * 1024) throw new AppError(413, 'file_too_large', 'Fichier trop volumineux (10 Mo maximum) : utilisez la reprise avancée.');
    if (!/\.(csv|txt|xlsx|xlsm)$/i.test(filename)) throw badRequest('unsupported_file', 'Déposez un fichier Excel (.xlsx) ou CSV.');
    let tables: Table[];
    try { tables = await parseTableFile(filename, buf); } catch { throw badRequest('unreadable', 'Fichier illisible : enregistrez-le en .xlsx ou en CSV (UTF-8) puis réessayez.'); }
    tables = tables.filter((t) => t.columns.length);
    if (!tables.length) throw badRequest('no_table', 'Aucune donnée trouvée : la première ligne doit contenir les en-têtes de colonnes.');
    const want = entity === 'client' ? /client|entreprise|societe/i : /apprenant|stagiaire|personne|participant|formateur|contact/i;
    const t = (sheet && tables.find((x) => x.name === sheet)) || tables.find((x) => want.test(x.name.split('#').pop() ?? '')) || tables[0];
    if (t.rows.length > MAX_ROWS) throw badRequest('too_many_rows', `Plus de ${MAX_ROWS} lignes : utilisez la reprise avancée.`);
    return { table: t, sheets: tables.map((x) => x.name) };
  }

  /** Lignes du fichier → table canonique (nom complet découpé, adresses concaténées, zéros restaurés). */
  private canonTable(t: Table, entity: QuickEntity, mapping: (string | null)[], defaultRole: string): Table {
    const rows = t.rows.map((src) => {
      const vals: Record<string, string[]> = {};
      mapping.forEach((f, col) => { const v = String(src[t.columns[col]] ?? '').trim(); if (f && v) (vals[f] ??= []).push(v); });
      if (!Object.keys(vals).length) return {} as Record<string, string>;
      const d: Record<string, string> = {};
      for (const [k, v] of Object.entries(vals)) d[k] = FIELDS[entity].find((f) => f.key === k)?.multiple ? v.join(', ') : v[0];
      if (entity === 'person') {
        if (d.full_name && (!d.first_name || !d.last_name)) { const s = splitFullName(d.full_name); d.first_name ||= s.first_name; d.last_name ||= s.last_name; if (s.civility && !d.civility) d.civility = s.civility; }
        delete d.full_name;
        if (d.civility) d.civility = /^(mme|madame|f|femme)/i.test(d.civility) ? 'Mme' : /^(mlle|mademoiselle)/i.test(d.civility) ? 'Mlle' : /^(m|mr|monsieur|h|homme)\.?$/i.test(d.civility) ? 'M.' : d.civility;
        d.role ||= defaultRole;
        for (const k of ['phone', 'mobile']) if (d[k]) d[k] = fixPhone(d[k]);
      } else if (d.phone) d.phone = fixPhone(d.phone);
      if (d.postal_code) d.postal_code = fixCp(d.postal_code);
      return d;
    });
    return { name: t.name, columns: Object.keys(CANONICAL[entity]), rows };
  }

  private parseMapping(raw: string | undefined, entity: QuickEntity, width: number) {
    if (!raw) return null;
    let m: unknown;
    try { m = JSON.parse(raw); } catch { throw badRequest('bad_mapping', 'Correspondance des colonnes invalide.'); }
    if (!Array.isArray(m) || m.length !== width) throw badRequest('bad_mapping', 'Correspondance des colonnes invalide.');
    const keys = new Set(FIELDS[entity].map((f) => f.key));
    const out = m.map((v) => (typeof v === 'string' && keys.has(v) ? v : null));
    for (const f of FIELDS[entity].filter((x) => !x.multiple)) if (out.filter((x) => x === f.key).length > 1) throw badRequest('bad_mapping', `Le champ « ${f.label} » est associé à plusieurs colonnes.`);
    return out;
  }

  private async analyze(ctx: RequestContext, buf: Buffer, filename: string, entity: QuickEntity, o: { mapping?: string; sheet?: string; role?: string }) {
    const { table, sheets } = await this.readSheet(buf, filename, entity, o.sheet);
    const mapping = this.parseMapping(o.mapping, entity, table.columns.length) ?? suggestMapping(entity, table.columns);
    const canon = this.canonTable(table, entity, mapping, o.role ?? 'learner');
    const missing = entity === 'client' ? (!mapping.includes('name') ? ['Raison sociale / nom'] : [])
      : !mapping.includes('full_name') ? [!mapping.includes('first_name') && 'Prénom', !mapping.includes('last_name') && 'Nom'].filter(Boolean) as string[] : [];
    const tz = 'Europe/Paris';
    const fm = { path: canon.name, entity: entity as EntityType, columns: Object.fromEntries(Object.keys(CANONICAL[entity]).map((k) => [k, k])) };
    const rows = buildRows([canon], [fm], tz).filter((r, i) => Object.keys(canon.rows[i]).length);
    for (const r of rows) r.issues = r.issues.filter((i) => i.code !== 'column_missing' || CANONICAL[entity][i.field!]?.required);

    // Existant : identifiants déjà repris, fiches identiques (email, SIRET, nom).
    const known = await this.db.tenantTx(ctx.tenantId, async (tx) => {
      const ids = await many(tx, `SELECT entity_type, external_id FROM external_identities WHERE source_instance_id=$1`, [SOURCE]);
      const list = entity === 'client'
        ? await many(tx, `SELECT name, siret, billing_email email FROM clients WHERE deleted_at IS NULL AND merged_into_id IS NULL`)
        : await many(tx, `SELECT first_name, last_name, email, birth_date::text birth_date FROM persons`);
      const clientRefs = entity === 'person' ? await many(tx, `SELECT lower(code) code, lower(name) name FROM clients WHERE deleted_at IS NULL`) : [];
      return { ids: new Set(ids.map((x: any) => `${x.entity_type}:${x.external_id}`)), list, clientRefs };
    });
    validateRows(rows, (e, k) => known.ids.has(`${e}:${k}`));
    const keyOf = (d: any): string[] => entity === 'client'
      ? [d.siret && `s:${d.siret}`, d.name && `n:${String(d.name).toLowerCase().trim()}`].filter(Boolean) as string[]
      : [d.email && `e:${String(d.email).toLowerCase()}`, d.first_name && d.last_name && d.birth_date && `nb:${String(d.first_name).toLowerCase()}|${String(d.last_name).toLowerCase()}|${d.birth_date}`].filter(Boolean) as string[];
    const seen = new Map<string, string>();
    for (const x of known.list) for (const k of keyOf(x)) seen.set(k, `Déjà présent : ${entity === 'client' ? x.name : `${x.first_name} ${x.last_name}`}`);
    const homonyms = entity === 'person' ? new Set(known.list.map((x: any) => `${String(x.first_name).toLowerCase()}|${String(x.last_name).toLowerCase()}`)) : new Set<string>();

    const results = rows.map((r: CanonRow) => {
      const msgs: string[] = [];
      let status: QuickStatus = 'ok';
      const sev = severityOf(r.issues);
      for (const i of r.issues) {
        if (i.severity === 'info') continue;
        // Employeur : la référence est cherchée parmi les codes clients repris (message explicite).
        if (i.code === 'reference_missing' && i.field === 'client_ref') {
          const v = String(r.data.client_ref).toLowerCase();
          i.message = known.clientRefs.some((c: any) => c.code === v || c.name === v)
            ? `Code client « ${r.data.client_ref} » : client existant non issu d’un import Excel, rattachez l’apprenant depuis sa fiche (ou laissez la colonne vide).`
            : `Code client « ${r.data.client_ref} » introuvable : importez d’abord les clients, ou ne reprenez pas cette colonne.`;
        }
        msgs.push(i.message);
      }
      if (sev === 'blocking') status = 'error';
      else {
        if (r.key && known.ids.has(`${entity}:${r.key}`)) { status = 'duplicate'; msgs.unshift('Déjà importé (même identifiant)'); }
        const hit = keyOf(r.data).map((k) => seen.get(k)).find(Boolean);
        if (status !== 'duplicate' && hit) { status = 'duplicate'; msgs.unshift(hit); }
        if (status !== 'duplicate') {
          for (const k of keyOf(r.data)) seen.set(k, `Doublon de la ligne ${r.line} du fichier`);
          if (entity === 'person' && homonyms.has(`${String(r.data.first_name).toLowerCase()}|${String(r.data.last_name).toLowerCase()}`)) msgs.push('Homonyme existant : vérifiez qu’il ne s’agit pas de la même personne.');
          if (sev === 'warning' || sev === 'fix' || msgs.length) status = 'warning';
        }
      }
      const d = r.data;
      return { line: r.line, status, messages: msgs, data: entity === 'client'
        ? { name: d.name, siret: d.siret, email: d.email, phone: d.phone, address: d.address, postal_code: d.postal_code, city: d.city, kind: d.kind, external_id: d.external_id }
        : { civility: d.civility, first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.mobile ?? d.phone, birth_date: d.birth_date, job_title: d.job_title, city: d.city, client_ref: d.client_ref, external_id: d.external_id, role: d.role }, row: r };
    });
    return { table, sheets, mapping, missing, results, canon };
  }

  async preview(ctx: RequestContext, buf: Buffer, filename: string, entity: QuickEntity, o: { mapping?: string; sheet?: string; role?: string }) {
    const { table, sheets, mapping, missing, results } = await this.analyze(ctx, buf, filename, entity, o);
    const count = (s: QuickStatus) => results.filter((r) => r.status === s).length;
    const strip = ({ row: _r, ...x }: any) => x;
    return {
      fileName: filename, sheetName: table.name.split('#').pop(), sheet: table.name, sheets, headers: table.columns,
      samples: table.columns.map((c) => table.rows.find((r) => String(r[c] ?? '').trim())?.[c]?.toString().trim().slice(0, 60) ?? ''),
      mapping, missing, fields: FIELDS[entity].map(({ key, label, multiple, required }) => ({ key, label, multiple: !!multiple, required: !!required })),
      stats: { total: results.length, ok: count('ok'), warning: count('warning'), error: count('error'), duplicate: count('duplicate'), toImport: count('ok') + count('warning') },
      rows: results.slice(0, PREVIEW_ROWS).map(strip), issues: results.filter((r) => r.status !== 'ok').slice(0, MAX_ISSUES).map(strip),
    };
  }

  /** Import : lignes valides (doublons et erreurs écartés) publiées via un lot de reprise (journal, annulation). */
  async commit(ctx: RequestContext, buf: Buffer, filename: string, entity: QuickEntity, o: { mapping?: string; sheet?: string; role?: string }) {
    const { missing, results, canon } = await this.analyze(ctx, buf, filename, entity, o);
    if (missing.length) throw badRequest('bad_mapping', `Associez une colonne au champ : ${missing.join(', ')}.`);
    const keep = results.filter((r) => r.status === 'ok' || r.status === 'warning');
    if (!keep.length) throw badRequest('nothing_to_import', 'Aucune ligne à importer avec cette correspondance.');
    // Fichier canonique (CSV) déposé dans un lot classique : mêmes contrôles, publication et annulation que la reprise.
    const cols = canon.columns;
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const raw = keep.map((r) => canon.rows[r.line - 2]);
    const csv = '﻿' + [cols.join(';'), ...raw.map((d) => cols.map((c) => cell(d[c])).join(';'))].join('\r\n');
    const name = `${entity === 'client' ? 'clients' : 'apprenants'}-${filename.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60)}.csv`;
    // Un import rapide resté en suspens (échec réseau…) ne bloque pas le suivant.
    await this.db.tenantTx(ctx.tenantId, async (tx) => {
      const act = await many(tx, `SELECT id, options FROM import_batches WHERE status IN ('uploaded','detected','mapped','simulated')`);
      for (const b of act) {
        if (!b.options?.quick) throw new AppError(409, 'batch_active', 'Une reprise est en cours dans « Reprise de données » : terminez-la ou supprimez-la avant cet import.', undefined, { batchId: b.id });
        await tx.query(`DELETE FROM import_rows WHERE batch_id=$1`, [b.id]);
        await tx.query(`UPDATE import_batches SET status='cancelled' WHERE id=$1`, [b.id]);
      }
    });
    const b: any = await this.m.create(ctx, { sourceSoftware: 'generic', sourceInstanceId: SOURCE });
    await this.db.tenantTx(ctx.tenantId, (tx) => tx.query(`UPDATE import_batches SET options = options || '{"quick": true}'::jsonb WHERE id=$1`, [b.id]));
    const up: any = await this.m.upload(ctx, b.id, Readable.from(Buffer.from(csv, 'utf8')), name);
    if (up.status === 'rejected') throw badRequest('rejected', up.diagnostic?.rejections?.[0]?.message ?? 'Fichier refusé.');
    const det: any = await this.m.detect(ctx, b.id);
    await this.m.confirmProfile(ctx, b.id, { profile: 'generic', files: [{ path: det.tables[0].name, entity: entity as EntityType, columns: Object.fromEntries(cols.map((c) => [c, c])) }] });
    const sim: any = await this.m.simulate(ctx, b.id, { mode: 'create_update', partial: true });
    const report: any = await this.m.commit(ctx, b.id);
    const e = report.perEntity?.[entity] ?? {};
    return {
      batchId: b.id, created: e.created ?? 0, updated: e.updated ?? 0, rejected: e.rejected ?? 0,
      skippedDuplicates: results.filter((r) => r.status === 'duplicate').length, errors: results.filter((r) => r.status === 'error').length,
      total: results.length, warnings: sim.summary?.[entity]?.warnings ?? 0,
    };
  }
}
