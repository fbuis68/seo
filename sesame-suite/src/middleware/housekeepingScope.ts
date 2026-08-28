import { NextFunction, Request, Response } from "express";
import { verifyAdminToken } from "../lib/adminAuth";

// Préfixes de route (relatifs au point de montage "/wa") accessibles à un
// compte role="housekeeping" — l'app tablette ménage/maintenance
// (menage.html) n'a besoin que de la liste des tâches, de la config
// hôtel/chambres pour l'affichage, et du login lui-même.
const HOUSEKEEPING_ALLOWED_PREFIXES = ["/housekeepingTask", "/housekeepingStaff", "/housekeepingStatus", "/entityModuleConfig", "/login"];

/**
 * Restreint un token role="housekeeping" à un allow-list de routes plutôt
 * que de dépendre d'ajouter une garde à chaque route sensible une par une —
 * un compte ménage/maintenance ne doit jamais pouvoir lire le CRM, la
 * facturation, les intégrations réservations, etc. même en appelant l'API
 * directement plutôt que via menage.html. Monté globalement sur "/wa" avant
 * les routeurs de ressources, donc req.path est déjà relatif à ce préfixe.
 */
export function housekeepingScope(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const admin = token ? verifyAdminToken(token) : null;

  if (admin && admin.role === "housekeeping") {
    const allowed = HOUSEKEEPING_ALLOWED_PREFIXES.some((p) => req.path.startsWith(p));
    if (!allowed) {
      res.status(403).json({ error: "Ce compte n'a accès qu'aux fonctions ménage/maintenance" });
      return;
    }
  }
  next();
}
