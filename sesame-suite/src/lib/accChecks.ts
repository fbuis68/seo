/**
 * Moteur de contrôles de cohérence (§14) — jamais de blocage silencieux :
 * chaque anomalie détectée devient une entrée `checks` sur AccInvoice
 * (visible dans l'inbox de validation, cf. §37/§38), avec un niveau
 * OK/WARNING/ERROR/BLOCKING. BLOCKING interdit toute validation
 * automatique (cf. lib/accEntryService.ts) mais n'empêche jamais une
 * validation humaine explicite.
 */

export type CheckLevel = "OK" | "WARNING" | "ERROR" | "BLOCKING";

export interface CheckResult {
  code: string;
  level: CheckLevel;
  message: string;
}

const AMOUNT_TOLERANCE = 0.02; // arrondi centime — cf. §21 "arrondis"

function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const arr = digits.split("").map(Number).reverse();
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    let d = arr[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function isValidSiren(siren: string): boolean {
  const s = siren.replace(/\s/g, "");
  return /^\d{9}$/.test(s) && luhnValid(s);
}

export function isValidSiret(siret: string): boolean {
  const s = siret.replace(/\s/g, "");
  return /^\d{14}$/.test(s) && luhnValid(s);
}

export function isValidFrenchVat(vat: string): boolean {
  const v = vat.replace(/\s/g, "").toUpperCase();
  if (!/^FR[0-9A-Z]{2}\d{9}$/.test(v)) return false;
  return isValidSiren(v.slice(4));
}

/** Algorithme mod-97 standard (ISO 7064) — valide n'importe quel IBAN, pas seulement français. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  try {
    return BigInt(numeric) % 97n === 1n;
  } catch {
    return false;
  }
}

export interface InvoiceForChecks {
  invoiceDate: Date | null;
  dueDate: Date | null;
  amountHt: number | null;
  amountVat: number | null;
  amountTtc: number | null;
  lines: { amountHt: number | null }[];
  vatLines: { rate: number; vatAmount: number }[];
  issuerSiren: string | null;
  issuerSiret: string | null;
  issuerVat: string | null;
  issuerIban: string | null;
}

/**
 * `priorSupplierIbans` : IBAN déjà vus sur les factures précédentes de ce
 * MÊME fournisseur rapproché (cf. lib/accSupplierMatching.ts + routes/
 * accounting.ts, qui charge cet historique avant d'appeler runInvoiceChecks)
 * — absent tant qu'aucun fournisseur n'a encore été rapproché, auquel cas
 * ce contrôle est simplement sauté plutôt que de comparer à rien.
 */
export function runInvoiceChecks(invoice: InvoiceForChecks, priorSupplierIbans?: string[]): CheckResult[] {
  const checks: CheckResult[] = [];

  // ── HT + TVA = TTC ──
  if (invoice.amountHt !== null && invoice.amountVat !== null && invoice.amountTtc !== null) {
    const expected = invoice.amountHt + invoice.amountVat;
    if (Math.abs(expected - invoice.amountTtc) > AMOUNT_TOLERANCE) {
      checks.push({ code: "AMOUNT_HT_VAT_TTC_MISMATCH", level: "ERROR", message: `HT (${invoice.amountHt}) + TVA (${invoice.amountVat}) = ${expected.toFixed(2)}, différent du TTC extrait (${invoice.amountTtc})` });
    }
  } else if (invoice.amountHt !== null && invoice.amountTtc !== null && invoice.amountVat === null && invoice.vatLines.length) {
    // TVA totale non extraite explicitement mais dérivable de la
    // ventilation par taux déjà extraite (somme de valeurs réelles, pas une
    // invention — cf. §51) : vérifiée ici plutôt que d'ignorer le contrôle.
    const derivedVat = invoice.vatLines.reduce((s, l) => s + l.vatAmount, 0);
    if (Math.abs(invoice.amountHt + derivedVat - invoice.amountTtc) > AMOUNT_TOLERANCE) {
      checks.push({ code: "AMOUNT_HT_VAT_TTC_MISMATCH", level: "WARNING", message: `HT + TVA (calculée depuis la ventilation par taux) ne correspond pas au TTC extrait` });
    }
  }

  // ── Somme des lignes = HT ──
  if (invoice.lines.length && invoice.amountHt !== null) {
    const knownLines = invoice.lines.filter((l) => l.amountHt !== null);
    if (knownLines.length === invoice.lines.length && knownLines.length > 0) {
      const sumLines = knownLines.reduce((s, l) => s + (l.amountHt || 0), 0);
      if (Math.abs(sumLines - invoice.amountHt) > AMOUNT_TOLERANCE) {
        checks.push({ code: "LINES_SUM_MISMATCH", level: "WARNING", message: `Somme des lignes (${sumLines.toFixed(2)}) différente du total HT (${invoice.amountHt})` });
      }
    }
  }

  // ── Somme TVA lignes = TVA totale ──
  if (invoice.vatLines.length && invoice.amountVat !== null) {
    const sumVat = invoice.vatLines.reduce((s, l) => s + l.vatAmount, 0);
    if (Math.abs(sumVat - invoice.amountVat) > AMOUNT_TOLERANCE) {
      checks.push({ code: "VAT_LINES_SUM_MISMATCH", level: "WARNING", message: `Somme de la ventilation TVA (${sumVat.toFixed(2)}) différente de la TVA totale (${invoice.amountVat})` });
    }
  }

  // ── Échéance >= date facture ──
  if (invoice.invoiceDate && invoice.dueDate && invoice.dueDate.getTime() < invoice.invoiceDate.getTime()) {
    checks.push({ code: "DUE_DATE_BEFORE_INVOICE_DATE", level: "ERROR", message: "La date d'échéance est antérieure à la date de facture" });
  }

  // ── Identifiants ──
  if (invoice.issuerSiren && !isValidSiren(invoice.issuerSiren)) {
    checks.push({ code: "INVALID_SIREN", level: "WARNING", message: `SIREN "${invoice.issuerSiren}" invalide (échec de la clé de contrôle)` });
  }
  if (invoice.issuerSiret && !isValidSiret(invoice.issuerSiret)) {
    checks.push({ code: "INVALID_SIRET", level: "WARNING", message: `SIRET "${invoice.issuerSiret}" invalide (échec de la clé de contrôle)` });
  }
  if (invoice.issuerVat && !isValidFrenchVat(invoice.issuerVat)) {
    checks.push({ code: "INVALID_VAT_NUMBER", level: "WARNING", message: `Numéro de TVA "${invoice.issuerVat}" invalide` });
  }
  if (invoice.issuerIban && !isValidIban(invoice.issuerIban)) {
    checks.push({ code: "INVALID_IBAN", level: "WARNING", message: `IBAN "${invoice.issuerIban}" invalide (échec de la clé de contrôle)` });
  }

  // ── Changement d'IBAN fournisseur (§14/§42 — sécurité anti-fraude) ──
  if (invoice.issuerIban && priorSupplierIbans && priorSupplierIbans.length) {
    const known = new Set(priorSupplierIbans.map((i) => i.replace(/\s/g, "").toUpperCase()));
    if (!known.has(invoice.issuerIban.replace(/\s/g, "").toUpperCase())) {
      checks.push({
        code: "SUPPLIER_IBAN_CHANGED",
        level: "BLOCKING",
        message: `ATTENTION : l'IBAN de cette facture est différent de celui utilisé sur les factures précédentes de ce fournisseur — validation manuelle obligatoire`,
      });
    }
  }

  if (!checks.length) checks.push({ code: "NO_ISSUE", level: "OK", message: "Aucune anomalie détectée" });
  return checks;
}

export function worstLevel(checks: CheckResult[]): CheckLevel {
  const order: CheckLevel[] = ["OK", "WARNING", "ERROR", "BLOCKING"];
  return checks.reduce((worst, c) => (order.indexOf(c.level) > order.indexOf(worst) ? c.level : worst), "OK" as CheckLevel);
}
