import crypto from "crypto";
import { config } from "../config";

/**
 * Lien de désabonnement signé — pas de session/authentification possible
 * depuis un client mail, donc le jeton porte lui-même la preuve qu'il n'a
 * pas été forgé (HMAC-SHA256 sur "scope:target", clé = JWT_SECRET, même
 * frontière de confiance que les tokens d'accès admin). Réutilisé tel quel
 * par lib/campaignScheduler.ts (génération, un par destinataire/envoi) et
 * routes/unsubscribe.ts (vérification, sur le clic).
 */

export interface UnsubscribeTarget {
  /** null = portée CRM ; sinon id d'établissement (portée hôtel) */
  entityId: string | null;
  /** Toujours une adresse email — clé naturelle côté CrmProspect (portée CRM) comme ClientPrefs (portée hôtel) */
  target: string;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.jwtSecret).update(payload).digest("hex").slice(0, 32);
}

export function createUnsubscribeToken(t: UnsubscribeTarget): string {
  const scope = t.entityId || "crm";
  const payload = `${scope}:${t.target}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastColon = decoded.lastIndexOf(":");
    if (lastColon <= 0) return null;
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    if (sign(payload) !== sig) return null;
    const sep = payload.indexOf(":");
    if (sep <= 0) return null;
    const scope = payload.slice(0, sep);
    const target = payload.slice(sep + 1);
    if (!target) return null;
    return { entityId: scope === "crm" ? null : scope, target };
  } catch {
    return null;
  }
}
