import { PDFParse } from "pdf-parse";

/**
 * Interface OCR (§9) — jamais de dépendance directe à un fournisseur
 * précis dans le reste du module (lib/accExtraction.ts, routes) : tout
 * passe par cette interface, comme lib/bookingSource.ts le fait déjà pour
 * les connecteurs PMS de cette app. Implémentations prévues au-delà de
 * NativeTextProvider (texte natif PDF, phase 1) : Azure Document
 * Intelligence, Google Document AI, AWS Textract, un moteur multimodal —
 * aucune n'est branchée pour l'instant (aucun compte fournisseur
 * disponible), le champ reste donc "OCR image" en statut requis mais
 * inerte plutôt que de simuler un résultat.
 */
export interface OcrBlock {
  text: string;
  page: number;
  /** [x0, y0, x1, y1] normalisé 0..1 quand le fournisseur le fournit — absent pour le texte natif PDF (pas de coordonnées géométriques dans la couche texte). */
  bbox?: [number, number, number, number];
  confidence?: number;
}

export interface OcrResult {
  text: string;
  blocks: OcrBlock[];
  pageCount: number;
  /** Confiance globale 0..1 — 1.0 pour une couche texte native (fiable par construction), variable pour un vrai OCR. */
  confidence: number;
  method: "native_text" | "ocr" | "structured_xml";
}

export interface OcrProvider {
  name: string;
  /** true si ce provider peut traiter ce type MIME (ex : un provider OCR image ne gère pas le XML structuré). */
  supports(mimeType: string): boolean;
  extract(buffer: Buffer, mimeType: string): Promise<OcrResult>;
}

/**
 * Seuil sous lequel un PDF est considéré comme "sans couche texte
 * exploitable" (scan pur) — cf. §9 : "utiliser l'OCR uniquement lorsque le
 * document ne contient pas suffisamment de texte exploitable". En dessous,
 * needsImageOcr() renvoie true côté appelant plutôt que de faire semblant
 * d'avoir extrait quelque chose d'utilisable.
 */
const MIN_NATIVE_TEXT_CHARS = 40;

/** Nettoie les marqueurs de page internes à pdf-parse ("-- N of M --"), qui n'ont aucun sens dans le texte stocké/analysé ensuite. */
function stripPageMarkers(text: string): string {
  return text.replace(/\n*--\s*\d+\s+of\s+\d+\s*--\n*/g, "\n").trim();
}

/**
 * Couche texte native d'un PDF (§9/§10 : à tenter EN PREMIER, avant tout
 * recours à l'OCR — un PDF "natif" généré par un logiciel de facturation
 * contient déjà son texte, le lire est fiable et gratuit contrairement à
 * l'OCR). Ne gère PAS les images (JPEG/PNG/TIFF) ni les PDF scannés sans
 * couche texte — cf. isTextSufficient() côté appelant pour détecter ce cas
 * et signaler qu'un OCR image serait nécessaire.
 */
export class NativeTextProvider implements OcrProvider {
  name = "native_text";

  supports(mimeType: string): boolean {
    return mimeType === "application/pdf";
  }

  async extract(buffer: Buffer): Promise<OcrResult> {
    const parser = new PDFParse({ data: buffer });
    try {
      const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo().catch(() => null)]);
      const text = stripPageMarkers(textResult.text || "");
      return {
        text,
        blocks: [{ text, page: 1 }],
        pageCount: infoResult?.total || 1,
        confidence: 1.0,
        method: "native_text",
      };
    } finally {
      await parser.destroy();
    }
  }
}

export function isTextSufficient(text: string): boolean {
  return text.trim().length >= MIN_NATIVE_TEXT_CHARS;
}

const PROVIDERS: OcrProvider[] = [new NativeTextProvider()];

/**
 * Point d'entrée du pipeline documentaire (§7 : "extraction texte natif →
 * OCR si nécessaire"). Renvoie needsImageOcr=true plutôt que d'échouer
 * silencieusement quand aucun provider disponible ne peut produire de
 * texte exploitable (image seule, PDF scanné) — c'est alors le statut
 * CHECK_REQUIRED côté AccInvoice qui porte l'information, en attendant
 * qu'un vrai provider d'OCR image soit configuré (cf. OcrProvider
 * ci-dessus).
 */
export async function extractDocumentText(buffer: Buffer, mimeType: string): Promise<{ result: OcrResult | null; needsImageOcr: boolean }> {
  const provider = PROVIDERS.find((p) => p.supports(mimeType));
  if (!provider) {
    // Image seule (JPEG/PNG/TIFF) — aucun provider de texte natif ne
    // s'applique, un OCR image serait nécessaire.
    return { result: null, needsImageOcr: true };
  }
  const result = await provider.extract(buffer, mimeType);
  if (!isTextSufficient(result.text)) {
    // PDF scanné (image intégrée, pas de couche texte) — même conclusion.
    return { result, needsImageOcr: true };
  }
  return { result, needsImageOcr: false };
}
