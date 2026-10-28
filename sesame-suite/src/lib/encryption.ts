import crypto from "crypto";
import { config } from "../config";

/**
 * Chiffrement symétrique générique (AES-256-GCM) — introduit le 28/10/2026
 * pour garder temporairement des coordonnées bancaires le temps qu'un
 * mandat GoCardless soit créé (cf. routes/crmSignature.ts,
 * CrmSignatureRequest.pendingBankDataEncrypted), quand l'admin choisit de
 * ne pas créer le mandat tout de suite. Jamais destiné à un stockage long
 * terme : la donnée déchiffrée ici est effacée dès que le mandat réussit.
 */

function getKey(): Buffer {
  if (!config.bankDataEncryptionKey) throw new Error("BANK_DATA_ENCRYPTION_KEY non configuré côté serveur");
  // sha256 ramène n'importe quelle longueur de secret à exactement 32
  // octets, requis par aes-256-gcm.
  return crypto.createHash("sha256").update(config.bankDataEncryptionKey).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Format de donnée chiffrée invalide");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
