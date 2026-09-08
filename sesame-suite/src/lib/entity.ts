import { Request } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { HttpError } from "./asyncHandler";

/** Resolves the tenant Entity for a request.
 *
 * - Comptes admin "hotel"/"housekeeping" non groupScoped (un seul
 *   établissement) : toujours verrouillés sur leur propre entityCode, même
 *   si un autre entityCode est passé en paramètre — empêche un admin
 *   d'hôtel d'accéder aux données d'un autre établissement.
 * - Comptes admin "hotel"/"housekeeping" avec groupScoped=true (cf.
 *   AdminUser.groupScoped, panneau "Utilisateurs") : peuvent cibler tout
 *   entityCode appartenant au MÊME groupe que leur établissement d'origine
 *   (bascule multi-établissements restreinte au groupe) — sinon repli sur
 *   leur propre entityCode, comme un compte non groupScoped.
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
    if (req.admin.groupScoped && req.admin.groupId && requestedCode && requestedCode !== req.admin.entityCode) {
      const target = await prisma.entity.findUnique({ where: { code: requestedCode } });
      code = target && target.groupId === req.admin.groupId ? requestedCode : req.admin.entityCode;
    } else {
      code = req.admin.entityCode;
    }
  }

  const entity = await prisma.entity.findUnique({ where: { code } });
  if (!entity) throw new HttpError(404, `Entity inconnue: ${code}`);
  return entity;
}
