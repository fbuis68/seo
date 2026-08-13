import { Request } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { HttpError } from "./asyncHandler";

/** Resolves the tenant Entity for a request.
 *
 * - Comptes admin "hotel" (un seul établissement) : toujours verrouillés sur
 *   leur propre entityCode, même si un autre entityCode est passé en
 *   paramètre — empêche un admin d'hôtel d'accéder aux données d'un autre
 *   établissement une fois la plateforme multi-tenant activée.
 * - Comptes admin "sesame" (Sesame Technology) : peuvent cibler n'importe
 *   quel établissement via entityCode (ex : contexte "hôtel actif" choisi
 *   dans le panneau Hôtels du back-office).
 * - Requêtes non authentifiées (parcours client) : comportement historique
 *   inchangé, entityCode optionnel avec repli sur le tenant par défaut —
 *   cette build reste mono-tenant en pratique pour le parcours client.
 */
export async function resolveEntity(req: Request) {
  const requestedCode = (req.query.entityCode as string) || (req.body && req.body.entityCode) || undefined;
  let code = requestedCode || config.defaultEntityCode;

  if (req.admin && req.admin.role !== "sesame") {
    code = req.admin.entityCode;
  }

  const entity = await prisma.entity.findUnique({ where: { code } });
  if (!entity) throw new HttpError(404, `Entity inconnue: ${code}`);
  return entity;
}
