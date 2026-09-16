import { createHash } from "crypto";
import { prisma } from "../db";
import { AccDocument } from "@prisma/client";

/**
 * Formats acceptés en entrée (§2/§3/§4 du cahier des charges) — PDF natif/
 * scanné, images courantes, XML de facturation structurée (Factur-X/UBL/
 * CII, cf. §10, non encore parsé en phase 1 mais accepté pour ne pas
 * bloquer l'ingestion). HEIC volontairement absent : aucune bibliothèque de
 * décodage HEIC disponible dans cet environnement — à ajouter avec une
 * dépendance dédiée plutôt que de prétendre le supporter sans pouvoir le
 * lire.
 */
export const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/xml",
  "text/xml",
]);

const MAX_SIZE_BYTES = 15 * 1024 * 1024; // aligné sur la limite express.json({limit:"15mb"}) de app.ts

export class DocumentIngestionError extends Error {}

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export interface IngestResult {
  document: AccDocument;
  isDuplicate: boolean;
  /** Document déjà existant portant le même hash, quand isDuplicate=true. */
  existingDocument?: AccDocument;
}

/**
 * Point d'entrée unique de tout document entrant, quelle que soit sa
 * source (§2 : upload manuel, API, à terme email/Drive/SFTP) — cf. §7
 * "contrôle fichier → hash SHA-256 → détection doublon" du pipeline. Ne
 * crée JAMAIS deux fois le même contenu binaire pour une même société
 * (§6) : un nouvel appel avec un hash déjà connu renvoie le document
 * existant plutôt que d'en recréer un, à charge de l'appelant de décider
 * s'il s'agit d'un vrai doublon fonctionnel (cf. lib/accDuplicates.ts pour
 * la détection plus fine par numéro/montant/fournisseur, qui peut lever un
 * AccDuplicateCandidate même sur un hash différent).
 */
export async function ingestDocument(
  entityId: string | null,
  input: { filename: string; mimeType: string; base64: string; source: string }
): Promise<IngestResult> {
  if (!ACCEPTED_MIME_TYPES.has(input.mimeType)) {
    throw new DocumentIngestionError(`Type de fichier non supporté : "${input.mimeType}". Formats acceptés : PDF, JPEG, PNG, TIFF, XML.`);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.base64, "base64");
  } catch {
    throw new DocumentIngestionError("Contenu du fichier invalide (base64 attendu)");
  }
  if (!buffer.length) throw new DocumentIngestionError("Fichier vide");
  if (buffer.length > MAX_SIZE_BYTES) {
    throw new DocumentIngestionError(`Fichier trop volumineux (${Math.round(buffer.length / 1024 / 1024)} Mo, limite ${MAX_SIZE_BYTES / 1024 / 1024} Mo)`);
  }

  const sha256 = computeSha256(buffer);

  const existingDocument = await prisma.accDocument.findFirst({ where: { entityId, sha256 } });
  if (existingDocument) {
    return { document: existingDocument, isDuplicate: true, existingDocument };
  }

  const document = await prisma.accDocument.create({
    data: {
      entityId,
      sha256,
      originalFilename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: buffer.length,
      contentBase64: input.base64,
      source: input.source,
    },
  });
  return { document, isDuplicate: false };
}
