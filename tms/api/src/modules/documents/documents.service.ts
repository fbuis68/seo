import { EXEMPTION_TEXT, currentProfile } from '../onboarding/billing-profile';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { loadDocBranding } from '../../core/branding';
import { Block, renderPdf } from '../../core/pdf';
import { StorageService } from '../../core/storage';
import { EntitlementsService } from '../billing/entitlements.service';
import { PARTS_SQL, SLOTS_SQL } from '../sessions/sessions.service';

export type TemplateKind = 'convention' | 'convocation' | 'attestation' | 'attendance_sheet' | 'invoice';

const fmtDate = (d: string | Date | null, tz = 'Europe/Paris') => d ? new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'long' }).format(new Date(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00Z` : d)) : '—';
const fmtDateTime = (d: string | Date, tz = 'Europe/Paris') => new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
const eur = (v: string | null) => v == null ? '—' : `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const hours = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
const MODALITY: Record<string, string> = { onsite: 'Présentiel', remote: 'Classe à distance', blended: 'Mixte' };

/**
 * Documents : originaux immuables (hash SHA-256, clé de stockage privée par organisme),
 * génération PDF à partir de modèles et des données exactes, quota de stockage appliqué.
 */
@Injectable()
export class DocumentsService {
  constructor(private db: Db, private storage: StorageService, private ent: EntitlementsService, private audit: AuditService) {}

  async store(tx: Tx, ctx: { tenantId: string; userId?: string }, d: { ownerType: string; ownerId?: string | null; kind: string; filename: string; mime: string; data: Buffer; provenance?: Record<string, unknown> }) {
    await this.ent.assertQuota(tx, ctx.tenantId, 'storageBytes', d.data.length);
    const id = randomUUID();
    const key = this.storage.key(ctx.tenantId, 'documents', id);
    const { sha256, size } = await this.storage.put(key, d.data);
    return one(tx, `INSERT INTO documents(id, tenant_id, owner_type, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, provenance, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, owner_type, owner_id, kind, filename, mime, size_bytes, sha256, created_at`,
      [id, ctx.tenantId, d.ownerType, d.ownerId ?? null, d.kind, d.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 150), d.mime, size, sha256, key, JSON.stringify(d.provenance ?? {}), ctx.userId ?? null]);
  }

  list(ctx: RequestContext, ownerType?: string, ownerId?: string) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT id, owner_type, owner_id, kind, filename, mime, size_bytes, sha256, created_at FROM documents
        WHERE ($1::text IS NULL OR owner_type=$1) AND ($2::uuid IS NULL OR owner_id=$2) AND kind <> 'export' ORDER BY created_at DESC LIMIT 500`, [ownerType ?? null, ownerId ?? null]));
  }

  /** Téléchargement : droits contrôlés au moment de la demande (formateur limité à ses sessions). */
  async read(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const d = await one(tx, `SELECT * FROM documents WHERE id=$1`, [id]);
      if (!d) throw notFound('Document');
      if (d.kind === 'export' && !ctx.permissions.has('exports.full')) throw notFound('Document');
      if (ctx.role === 'trainer') {
        const ok = await one(tx, `SELECT 1 FROM slots sl JOIN slot_trainers st ON st.slot_id=sl.id WHERE st.person_id=$2 AND (
            ($3='session' AND sl.session_id=$1) OR ($3='enrollment' AND sl.session_id=(SELECT session_id FROM enrollments WHERE id=$1)))`, [d.owner_id, ctx.personId, d.owner_type]);
        if (!ok) throw notFound('Document');
      }
      return { meta: d, data: await this.storage.get(d.storage_key) };
    });
  }

  upload(ctx: RequestContext, b: { ownerType: string; ownerId?: string; kind: string; filename: string; mime: string; base64: string }) {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
    if (!allowed.includes(b.mime)) throw badRequest('mime_not_allowed', 'Type de fichier non autorisé.', 'mime');
    const data = Buffer.from(b.base64, 'base64');
    if (b.mime === 'application/pdf' && data.subarray(0, 5).toString() !== '%PDF-') throw badRequest('invalid_pdf', 'Fichier PDF invalide.');
    return this.db.tenantTx(ctx.tenantId, (tx) => this.store(tx, ctx, { ...b, data, provenance: { uploaded: true } }));
  }

  // ─── Génération à partir de modèles ─────────────────────────────────────
  async generate(ctx: RequestContext, b: { template: TemplateKind; sessionId?: string; enrollmentId?: string; invoiceId?: string }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const t = await one(tx, `SELECT * FROM tenants WHERE id=$1`, [ctx.tenantId]);
      const org = `${t!.legal_name}${t!.siret ? ` — SIRET ${t!.siret}` : ''}${t!.nda ? ` — NDA ${t!.nda}` : ''}`;
      let blocks: Block[]; let ownerType: string; let ownerId: string; let filename: string;

      if (b.template === 'invoice') {
        const inv = await one(tx, `SELECT i.*, c.name client_name, c.siret client_siret FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=$1`, [b.invoiceId]);
        if (!inv) throw notFound('Facture');
        const lines = await many(tx, `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY position`, [inv.id]);
        const label = inv.kind === 'credit_note' ? 'Avoir' : inv.kind === 'deposit' ? "Facture d'acompte" : 'Facture';
        const prof = (await currentProfile(tx))?.data ?? {};
        const regime = prof.vatRegime ?? t!.vat_regime;
        blocks = [
          { type: 'title', text: `${label} ${inv.number ?? '— APERÇU (brouillon sans numéro ni valeur, non émis)'}` },
          { type: 'text', text: org },
          { type: 'text', text: `Client : ${inv.client_name}${inv.client_siret ? ` — SIRET ${inv.client_siret}` : ''}` },
          { type: 'text', text: `Date d'émission : ${fmtDate(inv.issue_date)} — Échéance : ${fmtDate(inv.due_date)}` },
          { type: 'spacer' },
          { type: 'table', columns: [{ label: 'Désignation', width: 50 }, { label: 'Qté', width: 10, align: 'right' }, { label: 'PU HT', width: 15, align: 'right' }, { label: 'TVA', width: 10, align: 'right' }, { label: 'Total HT', width: 15, align: 'right' }],
            rows: lines.map((l) => [l.label, String(Number(l.quantity)), eur(l.unit_price_ht), `${Number(l.vat_rate)} %`, eur(l.total_ht)]) },
          { type: 'text', text: `Total HT : ${eur(inv.total_ht)}   TVA : ${eur(inv.total_vat)}   Total TTC : ${eur(inv.total_ttc)}`, bold: true },
          ...(regime && regime !== 'subject' && regime !== 'to_confirm' ? [{ type: 'text' as const, text: prof.exemptionReason || EXEMPTION_TEXT[regime] || '' }] : []),
          ...(prof.vatNumber ? [{ type: 'text' as const, text: `N° TVA intracommunautaire : ${prof.vatNumber}`, size: 9 }] : []),
          { type: 'spacer' },
          { type: 'text', text: [
            prof.paymentTermsDays != null ? `Paiement à ${prof.paymentTermsDays} jours${prof.paymentMethods?.length ? ` par ${prof.paymentMethods.join(', ')}` : ''}.` : null,
            prof.latePenalty ? `Pénalités de retard : ${prof.latePenalty}.` : null,
            inv.kind !== 'credit_note' ? `Indemnité forfaitaire pour frais de recouvrement : ${prof.fixedIndemnity ?? 40} € (clients professionnels).` : null,
            prof.showBankDetails && prof.iban ? `Règlement par virement — IBAN ${prof.iban}${prof.bic ? ` — BIC ${prof.bic}` : ''}${prof.bankName ? ` (${prof.bankName})` : ''}.` : null,
            prof.footer || null,
          ].filter(Boolean).join('\n'), size: 9 },
        ];
        ownerType = 'invoice'; ownerId = inv.id; filename = `${(inv.number ?? 'brouillon')}.pdf`;
      } else {
        const s = await one(tx, `SELECT s.*, p.title program_title, v.* , s.id session_id, s.title session_title, c.name client_name
                                   FROM training_sessions s JOIN program_versions v ON v.id=s.program_version_id JOIN programs p ON p.id=v.program_id
                                   LEFT JOIN clients c ON c.id=s.client_id WHERE s.id=$1`, [b.sessionId]);
        if (!s) throw notFound('Session');
        const tz = s.timezone;
        // Créneaux avec partie, formateurs, lieu/salle et matériel.
        const slots = (await many(tx, SLOTS_SQL, [s.session_id])).filter((sl: any) => sl.status !== 'cancelled').map((sl: any) => ({
          ...sl,
          trainerNames: sl.trainers.map((t: any) => t.name).join(', '),
          place: sl.resources.filter((r: any) => r.kind !== 'equipment').map((r: any) => r.name).join(', '),
          equipment: sl.resources.filter((r: any) => r.kind === 'equipment').map((r: any) => r.name + (r.category ? ` (${r.category})` : '')).join(', '),
        }));
        const parts = await many(tx, PARTS_SQL, [s.session_id]);
        const partTitle = (id: string | null) => parts.find((p: any) => p.id === id)?.title ?? '';
        const planningRows = slots.map((sl: any) => [fmtDateTime(sl.starts_at, tz), fmtDateTime(sl.ends_at, tz), partTitle(sl.part_id) || '—', sl.trainerNames || '—', [sl.place || s.location, sl.equipment].filter(Boolean).join(' — ') || '—']);
        const planningCols = [{ label: 'Début', width: 18 }, { label: 'Fin', width: 18 }, { label: 'Partie', width: 18 }, { label: 'Formateur(s)', width: 20 }, { label: 'Lieu / matériel', width: 26 }];
        const dates = `du ${fmtDate(s.starts_on)} au ${fmtDate(s.ends_on ?? s.starts_on)}`;
        if (b.template === 'convention') {
          blocks = [
            { type: 'title', text: 'Convention de formation professionnelle' },
            { type: 'text', text: `Entre l'organisme de formation : ${org}` },
            { type: 'text', text: `Et le client : ${s.client_name ?? '(à compléter)'}` },
            { type: 'heading', text: 'Objet' },
            { type: 'text', text: `Action de formation « ${s.program_title} » (version ${s.version}), ${MODALITY[s.modality]}, durée ${hours(s.duration_minutes)}, ${dates}${s.location ? `, lieu : ${s.location}` : ''}.` },
            { type: 'heading', text: 'Objectifs' }, { type: 'text', text: s.objectives || '—' },
            { type: 'heading', text: 'Prérequis et public' }, { type: 'text', text: `${s.prerequisites || '—'}\n${s.audience || ''}` },
            { type: 'heading', text: "Modalités d'évaluation" }, { type: 'text', text: s.evaluation || '—' },
            ...(parts.length ? [{ type: 'heading' as const, text: 'Déroulé' }, { type: 'table' as const, columns: [{ label: 'Partie', width: 60 }, { label: 'Durée', width: 20, align: 'right' as const }, { label: 'Formateur(s)', width: 40 }],
              rows: parts.map((p: any) => [p.title, hours(p.planned_minutes), p.trainers.map((t: any) => t.name).join(', ') || '—']) }] : []),
            ...(slots.length ? [{ type: 'heading' as const, text: 'Planning' }, { type: 'table' as const, columns: planningCols, rows: planningRows }] : []),
            { type: 'heading', text: 'Prix' }, { type: 'text', text: s.price_ht ? `${eur(s.price_ht)} HT${s.vat_rate ? ` (TVA ${Number(s.vat_rate)} %)` : ''}` : 'Selon devis.' },
            { type: 'spacer', height: 20 },
            { type: 'signature', labels: ["Pour l'organisme de formation", 'Pour le client'] },
          ];
          ownerType = 'session'; ownerId = s.session_id; filename = `convention-${s.session_id.slice(0, 8)}.pdf`;
        } else if (b.template === 'attendance_sheet') {
          const learners = await many(tx, `SELECT p.first_name, p.last_name FROM enrollments e JOIN persons p ON p.id=e.person_id WHERE e.session_id=$1 AND e.status<>'cancelled' ORDER BY p.last_name`, [s.session_id]);
          blocks = [{ type: 'title', text: `Feuille d'émargement — ${s.session_title}` }, { type: 'text', text: org }];
          for (const sl of slots) {
            blocks.push({ type: 'heading', text: `${fmtDateTime(sl.starts_at, tz)} → ${fmtDateTime(sl.ends_at, tz)}${partTitle(sl.part_id) ? ` — ${partTitle(sl.part_id)}` : ''}` });
            blocks.push({ type: 'text', text: `Formateur(s) : ${sl.trainerNames || '—'}${sl.place ? ` · Lieu : ${sl.place}` : ''}${sl.equipment ? ` · Matériel : ${sl.equipment}` : ''}`, size: 9 });
            blocks.push({ type: 'table', columns: [{ label: 'Apprenant', width: 50 }, { label: 'Signature', width: 50 }], rows: learners.map((l) => [`${l.last_name} ${l.first_name}`, '']) });
          }
          ownerType = 'session'; ownerId = s.session_id; filename = `emargement-${s.session_id.slice(0, 8)}.pdf`;
        } else {
          const e = await one(tx, `SELECT e.*, p.first_name, p.last_name FROM enrollments e JOIN persons p ON p.id=e.person_id WHERE e.id=$1 AND e.session_id=$2`, [b.enrollmentId, s.session_id]);
          if (!e) throw notFound('Inscription');
          if (b.template === 'convocation') {
            blocks = [
              { type: 'title', text: 'Convocation' }, { type: 'text', text: org }, { type: 'spacer' },
              { type: 'text', text: `${e.first_name} ${e.last_name},` },
              { type: 'text', text: `Vous êtes convoqué(e) à la formation « ${s.program_title} » (${MODALITY[s.modality]}), ${dates}.` },
              { type: 'table', columns: planningCols, rows: planningRows },
              { type: 'text', text: `Prérequis : ${s.prerequisites || 'aucun'}` },
            ];
          } else {
            const done = await one(tx, `SELECT coalesce(sum(minutes),0) m FROM attendance WHERE enrollment_id=$1`, [e.id]);
            blocks = [
              { type: 'title', text: 'Attestation de fin de formation' }, { type: 'text', text: org }, { type: 'spacer' },
              { type: 'text', text: `Nous attestons que ${e.first_name} ${e.last_name} a suivi la formation « ${s.program_title} », ${dates}.` },
              { type: 'text', text: `Durée prévue : ${hours(s.duration_minutes)} — Durée effectivement suivie (émargements) : ${hours(Number(done!.m))}.` },
              { type: 'heading', text: 'Objectifs de la formation' }, { type: 'text', text: s.objectives || '—' },
              { type: 'spacer', height: 20 }, { type: 'signature', labels: ["Le responsable de l'organisme"] },
            ];
          }
          ownerType = 'enrollment'; ownerId = e.id; filename = `${b.template}-${e.last_name}-${s.session_id.slice(0, 8)}.pdf`;
        }
      }
      // Logo et couleur de l'organisme appliqués automatiquement à chaque document généré.
      const pdf = renderPdf(blocks, { title: filename, footer: t!.legal_name, ...(await loadDocBranding(tx)) });
      const doc = await this.store(tx, ctx, { ownerType, ownerId, kind: b.template, filename, mime: 'application/pdf', data: pdf, provenance: { template: b.template, version: 1 } });
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'document.generated', entityType: 'document', entityId: doc!.id, data: { template: b.template } });
      return doc;
    });
  }
}
