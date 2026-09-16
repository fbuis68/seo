/**
 * Classification documentaire (§8) — la DIRECTION (achat/vente) est fournie
 * par l'appelant (l'utilisateur dépose explicitement dans "Achats" ou
 * "Ventes", cf. routes/accounting.ts POST /acc/documents/upload) plutôt que
 * devinée : un texte seul ne permet pas de savoir de façon fiable si
 * l'entreprise est l'émetteur ou le destinataire sans connaître son propre
 * SIRET. La classification ci-dessous affine seulement le TYPE de document
 * À L'INTÉRIEUR de cette direction (facture / avoir / acompte / reçu...) —
 * cf. §8 "detected_type + confidence".
 */

export interface ClassificationResult {
  documentType: string;
  confidence: number;
}

interface Rule {
  type: string;
  patterns: RegExp[];
  weight: number;
}

// Ordre = priorité en cas d'égalité de score — un avoir mentionne souvent
// aussi le mot "facture" quelque part, donc les motifs les plus SPÉCIFIQUES
// (avoir, acompte, reçu, relevé) sont testés avant le motif générique
// "facture".
const RULES: Rule[] = [
  { type: "credit_note", patterns: [/\bavoir\b/i, /\bnote de cr[ée]dit\b/i, /\bcredit note\b/i], weight: 3 },
  { type: "deposit_invoice", patterns: [/\bfacture d.acompte\b/i, /\bacompte\b/i, /\bdeposit invoice\b/i], weight: 2 },
  { type: "receipt", patterns: [/\bre[çc]u\b/i, /\breceipt\b/i, /\bticket de caisse\b/i], weight: 2 },
  { type: "statement", patterns: [/\brelev[ée] de compte\b/i, /\bstatement\b/i, /\bbilling statement\b/i], weight: 2 },
  { type: "invoice", patterns: [/\bfacture\b/i, /\binvoice\b/i], weight: 1 },
];

export function classifyDocument(text: string): ClassificationResult {
  if (!text || text.trim().length < 10) return { documentType: "non_accounting", confidence: 0 };

  let best: { type: string; weight: number } | null = null;
  for (const rule of RULES) {
    const matched = rule.patterns.some((p) => p.test(text));
    if (matched && (!best || rule.weight > best.weight)) {
      best = { type: rule.type, weight: rule.weight };
    }
  }

  if (!best) return { documentType: "non_accounting", confidence: 0.4 };
  // Score de confiance simple — plus le motif est spécifique (weight élevé),
  // plus la confiance retournée est haute. Jamais 1.0 : un mot-clé seul ne
  // garantit pas la nature exacte du document, cf. §51 (ne jamais affirmer
  // plus que ce qui est raisonnablement déterminable).
  const confidence = Math.min(0.95, 0.55 + best.weight * 0.13);
  return { documentType: best.type, confidence };
}
