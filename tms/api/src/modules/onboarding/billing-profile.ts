import { Tx, one } from '../../core/db';

/** Profil de facturation (FAC 01, 02, 05). Toute valeur suggérée reste « à confirmer » jusqu'à validation. */
export interface BillingProfileData {
  vatRegime?: 'subject' | 'exempt_261_4_4' | 'franchise_293b';
  exemptionReason?: string | null;            // mention imposée en cas d'exonération
  vatNumber?: string | null;                  // n° de TVA intracommunautaire de l'émetteur
  pricesBasis?: 'ht';                         // prix saisis HT (TTC calculé)
  rounding?: 'line';                          // arrondi au centime par ligne, total = somme des lignes
  paymentTermsDays?: number;                  // délai de paiement
  paymentMethods?: string[];                  // virement, chèque, CB…
  latePenalty?: string | null;                // taux des pénalités de retard
  fixedIndemnity?: number;                    // indemnité forfaitaire de recouvrement (B2B)
  showBankDetails?: boolean;
  iban?: string | null; bic?: string | null; bankName?: string | null;
  contactEmail?: string | null; contactPhone?: string | null;
  footer?: string | null;
  einvoiceRequired?: boolean;                 // circuit de facturation électronique exigé par le profil
}

/** Champs dont la modification invalide la validation (règles fiscales, calcul, paiement affiché). */
const CRITICAL: (keyof BillingProfileData)[] = ['vatRegime', 'exemptionReason', 'vatNumber', 'pricesBasis', 'rounding', 'paymentTermsDays',
  'latePenalty', 'fixedIndemnity', 'showBankDetails', 'iban', 'bic', 'einvoiceRequired'];

export const EXEMPTION_TEXT: Record<string, string> = {
  exempt_261_4_4: 'Exonération de TVA — article 261-4-4° du CGI (formation professionnelle continue).',
  franchise_293b: 'TVA non applicable — article 293 B du CGI.',
};

export async function currentProfile(tx: Tx) {
  return one(tx, `SELECT * FROM billing_profile_versions ORDER BY version DESC LIMIT 1`);
}

/** Valide l'IBAN (clé ISO 13616, modulo 97). */
export function validIban(iban: string) {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
}

export function profileProblems(d: BillingProfileData): string[] {
  const p: string[] = [];
  if (!d.vatRegime) p.push('Régime de TVA non choisi.');
  if (d.vatRegime && d.vatRegime !== 'subject' && !(d.exemptionReason ?? EXEMPTION_TEXT[d.vatRegime])) p.push("Motif d'exonération manquant.");
  if (d.paymentTermsDays == null || d.paymentTermsDays < 0 || d.paymentTermsDays > 120) p.push('Délai de paiement à définir (0 à 120 jours).');
  if (d.showBankDetails && (!d.iban || !validIban(d.iban))) p.push('IBAN invalide alors que les coordonnées bancaires sont affichées.');
  return p;
}

/** Enregistre une nouvelle version ; reste confirmée seulement si aucun champ critique n'a changé. */
export async function saveProfile(tx: Tx, tenantId: string, userId: string, patch: BillingProfileData) {
  const cur = await currentProfile(tx);
  const data: BillingProfileData = { pricesBasis: 'ht', rounding: 'line', fixedIndemnity: 40, ...(cur?.data ?? {}), ...patch };
  const criticalChanged = !cur || CRITICAL.some((k) => JSON.stringify(cur.data?.[k] ?? null) !== JSON.stringify(data[k] ?? null));
  const keepConfirmed = !!cur?.confirmed_at && !criticalChanged;
  const row = await one(tx, `INSERT INTO billing_profile_versions(tenant_id, version, data, created_by, confirmed_by, confirmed_at)
                             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantId, (cur?.version ?? 0) + 1, JSON.stringify(data), userId, keepConfirmed ? cur!.confirmed_by : null, keepConfirmed ? cur!.confirmed_at : null]);
  // Le régime choisi est reporté sur l'organisme (documents existants : mentions d'exonération).
  if (data.vatRegime) await tx.query(`UPDATE tenants SET vat_regime=$2 WHERE id=$1`, [tenantId, data.vatRegime]);
  return { ...row, criticalChanged };
}
