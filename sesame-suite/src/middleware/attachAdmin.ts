import { NextFunction, Request, Response } from "express";
import { verifyAdminToken } from "../lib/adminAuth";

/**
 * Fuite multi-tenant trouvée le 24/09/2026 : plusieurs routes (GET
 * /booking/list, /entityModuleConfig/list, /booking/accessQr,
 * /booking/openDoor, /booking/checkin, /booking/checkinStart,
 * /booking/passesPublic...) sont volontairement SANS requireAdmin — elles
 * servent aussi le parcours client non authentifié (checkin.html) via
 * ?entityCode= explicite. resolveEntity() (lib/entity.ts) fait pourtant
 * confiance à req.admin pour verrouiller un compte "hotel" sur son propre
 * établissement — or req.admin n'était JAMAIS renseigné sur ces routes
 * (seul requireAdmin le fait), même avec un Authorization: Bearer valide
 * envoyé par admin.html. resolveEntity retombait alors sur
 * config.defaultEntityCode (E00000001, premier établissement jamais créé)
 * pour CHAQUE compte hôtel consultant ces panneaux — d'où des réservations/
 * accès/modules d'un autre établissement (ex : Churchill) remontant chez un
 * établissement nouvellement créé (ex : Cabana) dont admin.html n'ajoute pas
 * non plus ?entityCode= pour un compte "hotel" non groupScoped (cf.
 * withEntityCode() dans admin.html, qui suppose à tort que "le serveur
 * l'impose de toute façon").
 *
 * Montée globalement sur "/wa" avant tous les routeurs (comme
 * housekeepingScope), purement additive : ne rejette jamais une requête
 * (contrairement à requireAdmin, qui reste la seule garde d'AUTHENTIFICATION
 * sur les routes qui l'exigent) — renseigne juste req.admin quand un token
 * valide est présent, pour que resolveEntity() puisse verrouiller
 * correctement le tenant même sur une route ouverte au parcours client.
 */
export function attachAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const admin = token ? verifyAdminToken(token) : null;
  if (admin) req.admin = admin;
  next();
}
