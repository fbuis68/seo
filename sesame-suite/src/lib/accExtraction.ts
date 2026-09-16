/**
 * Extraction structurée déterministe (§11-13) — délibérément PAS un appel à
 * un modèle de langage : un moteur de règles/regex est reproductible,
 * auditable et ne peut pas halluciner un champ absent, contrairement à une
 * IA générative (cf. §51 "n'invente jamais un numéro/une date/un SIRET/un
 * IBAN/un montant/un taux de TVA"). Chaque champ non trouvé avec une
 * confiance suffisante repart à `null` plutôt que d'être deviné — c'est le
 * comportement demandé, pas un défaut à corriger. Un moteur IA pourra être
 * branché plus tard en complément (cf. §50 "IA propose, moteur comptable
 * contrôle") pour les cas que ces règles ne couvrent pas, sans changer la
 * forme du résultat ci-dessous.
 */

export interface ExtractedVatLine {
  rate: number;
  baseAmount: number;
  vatAmount: number;
}

export interface ExtractedInvoiceData {
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  dueDate: Date | null;
  currency: string | null;
  issuerName: string | null;
  issuerSiren: string | null;
  issuerSiret: string | null;
  issuerVat: string | null;
  issuerIban: string | null;
  issuerBic: string | null;
  amountHt: number | null;
  amountVat: number | null;
  amountTtc: number | null;
  vatLines: ExtractedVatLine[];
  /** 0..1 par champ effectivement renseigné (absent du tout pour un champ à null — pas de "confiance 0" trompeuse). */
  confidence: Record<string, number>;
}

function parseFrenchNumber(raw: string): number | null {
  // "1 234,56" | "1234.56" | "1234,56" | "1234" — jamais de supposition sur
  // un séparateur ambigu à 3 chiffres après la virgule (ex : "1.234" pourrait
  // être un millier OU une décimale à 3 chiffres selon la source) : ces cas
  // ne sont volontairement PAS traités ici plutôt que de deviner faux.
  const cleaned = raw.replace(/[\s ]/g, "");
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    const n = Number(cleaned.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+,\d{1,2}$/.test(cleaned)) {
    const n = Number(cleaned.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseFrenchDate(raw: string): Date | null {
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejette les dates invalides silencieusement corrigées par le
  // constructeur Date (ex : 31/02 → 03/03) plutôt que de renvoyer une date
  // fausse.
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month - 1) return null;
  return d;
}

/**
 * Cherche une VALEUR immédiatement après un mot-clé — "immédiatement"
 * signifie : au plus quelques caractères de ponctuation/espace entre le
 * mot-clé et la valeur (jamais une valeur trouvée plus loin dans le texte,
 * qui appartiendrait probablement à un autre champ). Essaie CHAQUE
 * occurrence du mot-clé dans le document (un même mot peut apparaître dans
 * un en-tête de tableau sans valeur utile juste après, puis à nouveau dans
 * la ligne de total réelle) jusqu'à trouver une valeur immédiate valide.
 */
function findAfterKeyword(text: string, keywordPattern: RegExp, valuePattern: RegExp, maxGap = 20): { value: string; confidence: number } | null {
  const flags = keywordPattern.flags.includes("g") ? keywordPattern.flags : keywordPattern.flags + "g";
  const re = new RegExp(keywordPattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const afterStart = m.index + m[0].length;
    const afterText = text.slice(afterStart, afterStart + maxGap);
    const gapMatch = /^[ \t]*[:=\-–]?[ \t]*/.exec(afterText);
    const gapLen = gapMatch ? gapMatch[0].length : 0;
    const valueText = afterText.slice(gapLen);
    const vm = valuePattern.exec(valueText);
    if (vm && vm.index === 0) {
      return { value: vm[1] ?? vm[0], confidence: 0.9 };
    }
    if (m[0].length === 0) re.lastIndex++; // garde-fou anti-boucle infinie sur un motif à largeur nulle
  }
  return null;
}

// Fenêtre large plutôt qu'un groupement figé "3-3-3-5" — les factures
// réelles espacent un SIRET/SIREN de façons très variées (parfois pas du
// tout). Le nombre de chiffres est validé strictement après coup (14 pour
// un SIRET, 9 pour un SIREN) dans extractInvoiceData : un résultat qui n'a
// pas exactement le bon compte est rejeté plutôt que tronqué/deviné.
const SIRET_RE = /^([\d \t]{14,20})/;
const SIREN_RE = /^([\d \t]{9,15})/;
const VAT_FR_RE = /\b(FR[0-9A-Z]{2}\d{9})\b/;
const IBAN_RE = /^([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4})/;
const BIC_RE = /^([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/;
const DATE_RE = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/;
const AMOUNT_RE = /^(\d{1,3}(?:[\s.]\d{3})*(?:[,.]\d{2})?)/;
const INVOICE_NUMBER_RE = /^([A-Z0-9][A-Z0-9\-\/_.]{2,29})/;

// Espacement volontairement limité à [ \t]* (jamais \s* / \n) entre les
// mots d'un motif de mot-clé — un \s* aurait pu "sauter" un saut de ligne
// et faire correspondre, par exemple, le titre "FACTURE" isolé en haut de
// page avec le "N°" du libellé réel plus bas, glissant alors la fenêtre de
// recherche de valeur sur le mauvais passage du texte.
const INVOICE_NUMBER_KEYWORD = /(?:n[°o][ \t]*(?:de[ \t]*)?facture|num[ée]ro[ \t]*(?:de[ \t]*)?facture|facture[ \t]*n[°o]|invoice[ \t]*(?:number|#|no)\.?)/i;
const INVOICE_DATE_KEYWORD = /date[ \t]*(?:de[ \t]*)?facture|date[ \t]*d.[ée]mission|invoice[ \t]*date/i;
const DUE_DATE_KEYWORD = /date[ \t]*d.[ée]ch[ée]ance|[ée]ch[ée]ance[ \t]*(?:le|au)?|due[ \t]*date/i;
const SIRET_KEYWORD = /\bsiret\b[ \t]*:?[ \t]*n?[°o]?/i;
const SIREN_KEYWORD = /\bsiren\b[ \t]*:?[ \t]*n?[°o]?/i;
const VAT_KEYWORD = /tva[ \t]*intracommunautaire|n[°o][ \t]*tva|vat[ \t]*(?:number|id)/i;
const VAT_VALUE_RE = /^(FR[0-9A-Z]{2}\d{9})/;
const IBAN_KEYWORD = /\bIBAN\b/i;
const BIC_KEYWORD = /\bBIC\b|\bSWIFT\b/i;
const TTC_KEYWORD = /total[ \t]*ttc|montant[ \t]*ttc|net[ \t]*[àa][ \t]*payer|total[ \t]*due|amount[ \t]*due/i;
const HT_KEYWORD = /total[ \t]*ht|montant[ \t]*ht|sous-total|subtotal/i;
// Négation du taux juste après "tva" : "TVA 20% : ..." est une ligne de
// ventilation (cf. VAT_LINE_RE plus bas), pas le montant total de TVA.
const VAT_AMOUNT_KEYWORD = /(?:montant[ \t]*)?tva(?:[ \t]*totale)?(?![ \t]*\d{1,2}[ \t]*%)/i;
const VAT_LINE_RE = /tva[ \t]*(?:\(|à[ \t]*)?(\d{1,2}(?:[,.]\d)?)[ \t]*%\)?[^\d\n]{0,20}?(\d{1,3}(?:[\s.]\d{3})*(?:[,.]\d{2})?)/gi;

export function extractInvoiceData(text: string): ExtractedInvoiceData {
  const confidence: Record<string, number> = {};
  const result: ExtractedInvoiceData = {
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
    currency: /€|EUR/.test(text) ? "EUR" : /\bUSD\b|\$/.test(text) ? "USD" : null,
    issuerName: null,
    issuerSiren: null,
    issuerSiret: null,
    issuerVat: null,
    issuerIban: null,
    issuerBic: null,
    amountHt: null,
    amountVat: null,
    amountTtc: null,
    vatLines: [],
    confidence,
  };

  const num = findAfterKeyword(text, INVOICE_NUMBER_KEYWORD, INVOICE_NUMBER_RE);
  if (num) {
    result.invoiceNumber = num.value.trim();
    confidence.invoiceNumber = num.confidence;
  }

  const invDate = findAfterKeyword(text, INVOICE_DATE_KEYWORD, DATE_RE);
  if (invDate) {
    const d = parseFrenchDate(invDate.value);
    if (d) {
      result.invoiceDate = d;
      confidence.invoiceDate = 0.9;
    }
  }
  const due = findAfterKeyword(text, DUE_DATE_KEYWORD, DATE_RE);
  if (due) {
    const d = parseFrenchDate(due.value);
    if (d) {
      result.dueDate = d;
      confidence.dueDate = 0.85;
    }
  }

  // Ancré au mot-clé "SIRET"/"SIREN" (comme tous les autres champs, via
  // findAfterKeyword) — une recherche sans ancrage dans tout le document
  // matchait la première suite de 14 (ou 9) chiffres venue, y compris à
  // l'intérieur d'un IBAN ou d'un numéro de téléphone (cf. 16/09/2026, faux
  // positifs constatés en production).
  const siret = findAfterKeyword(text, SIRET_KEYWORD, SIRET_RE);
  const siretDigits = siret ? siret.value.replace(/[ \t]/g, "") : null;
  if (siretDigits && siretDigits.length === 14) {
    result.issuerSiret = siretDigits;
    result.issuerSiren = siretDigits.slice(0, 9);
    confidence.issuerSiret = 0.9;
    confidence.issuerSiren = 0.9;
  } else {
    const siren = findAfterKeyword(text, SIREN_KEYWORD, SIREN_RE);
    const sirenDigits = siren ? siren.value.replace(/[ \t]/g, "") : null;
    if (sirenDigits && sirenDigits.length === 9) {
      result.issuerSiren = sirenDigits;
      confidence.issuerSiren = 0.85;
    }
  }
  // Ancré en priorité au mot-clé "TVA intracommunautaire"/"n° TVA" — même
  // raison que SIRET/SIREN ci-dessus (un IBAN "FR76..." contient de quoi
  // matcher le format FR+2+9 chiffres par coïncidence). Repli sur une
  // recherche non ancrée à confiance réduite plutôt que de ne rien
  // extraire, le format restant assez spécifique pour rester utile même
  // sans mot-clé trouvé.
  const vat = findAfterKeyword(text, VAT_KEYWORD, VAT_VALUE_RE);
  if (vat) {
    result.issuerVat = vat.value;
    confidence.issuerVat = 0.9;
  } else {
    const vatMatch = VAT_FR_RE.exec(text);
    if (vatMatch) {
      result.issuerVat = vatMatch[1];
      confidence.issuerVat = 0.5;
    }
  }
  const iban = findAfterKeyword(text, IBAN_KEYWORD, IBAN_RE, 40); // IBAN peut dépasser 27 caractères espacés — au-delà du maxGap par défaut
  if (iban) {
    result.issuerIban = iban.value.replace(/\s/g, "");
    confidence.issuerIban = 0.9;
  }
  const bic = findAfterKeyword(text, BIC_KEYWORD, BIC_RE);
  if (bic) {
    result.issuerBic = bic.value;
    confidence.issuerBic = 0.8;
  }

  // Raison sociale émetteur — heuristique faible (première ligne non vide
  // qui n'est ni une date ni un montant) : volontairement une confiance
  // basse, à corriger prioritairement par le rapprochement fournisseur
  // (lib/accSupplierMatching.ts) plutôt qu'à ce stade.
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 2 && l.length < 80 && !/^\d/.test(l));
  if (firstLine) {
    result.issuerName = firstLine;
    confidence.issuerName = 0.3;
  }

  const ttc = findAfterKeyword(text, TTC_KEYWORD, AMOUNT_RE);
  if (ttc) {
    const n = parseFrenchNumber(ttc.value);
    if (n !== null) {
      result.amountTtc = n;
      confidence.amountTtc = 0.85;
    }
  }
  const ht = findAfterKeyword(text, HT_KEYWORD, AMOUNT_RE);
  if (ht) {
    const n = parseFrenchNumber(ht.value);
    if (n !== null) {
      result.amountHt = n;
      confidence.amountHt = 0.85;
    }
  }
  const vatAmt = findAfterKeyword(text, VAT_AMOUNT_KEYWORD, AMOUNT_RE);
  if (vatAmt) {
    const n = parseFrenchNumber(vatAmt.value);
    if (n !== null) {
      result.amountVat = n;
      confidence.amountVat = 0.75;
    }
  }

  // ── Ventilation TVA multi-taux (§12) — une ligne par occurrence "TVA
  // XX% ... montant" reconnue dans le texte, jamais dérivée par calcul
  // (une TVA calculée à partir d'un taux + une base serait une valeur
  // DÉDUITE, pas EXTRAITE — cf. §51). ──
  let vlm: RegExpExecArray | null;
  while ((vlm = VAT_LINE_RE.exec(text))) {
    const rate = Number(vlm[1].replace(",", "."));
    const amount = parseFrenchNumber(vlm[2]);
    if (Number.isFinite(rate) && amount !== null && rate > 0 && rate <= 25) {
      result.vatLines.push({ rate, baseAmount: 0, vatAmount: amount });
    }
  }

  return result;
}
