import { Request } from "express";
import { resolveEntity } from "./entity";
import { HttpError } from "./asyncHandler";

/**
 * Résolution de portée partagée par tous les endpoints "génériques" (email,
 * canaux SMS/WhatsApp, modèles, règles d'automatisation) : ?scope=crm cible
 * la portée globale Sesame (entityId=null, réservée aux comptes sesame),
 * sinon repli sur resolveEntity() — comportement par défaut identique à
 * tous les autres endpoints par établissement.
 */
export async function resolveScope(req: Request): Promise<string | null> {
  const scope = (req.query.scope as string) || (req.body && req.body.scope) || undefined;
  if (scope === "crm") {
    if (!req.admin || req.admin.role !== "sesame") throw new HttpError(403, "Réservé aux comptes Sesame");
    return null;
  }
  const entity = await resolveEntity(req);
  return entity.id;
}
