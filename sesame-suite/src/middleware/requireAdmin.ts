import { NextFunction, Request, Response } from "express";
import { verifyAdminToken, AdminTokenPayload } from "../lib/adminAuth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload;
    }
  }
}

/** Protège les endpoints d'écriture du back-office — Bearer token admin requis. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const admin = token ? verifyAdminToken(token) : null;
  if (!admin) {
    res.status(401).json({ error: "Authentification admin requise" });
    return;
  }
  req.admin = admin;
  next();
}

/** À enchaîner après requireAdmin — réserve l'accès aux comptes Sesame
 * (role="sesame"), ex : création/gestion des établissements, souscriptions. */
export function requireSesame(req: Request, res: Response, next: NextFunction) {
  if (!req.admin) {
    res.status(401).json({ error: "Authentification admin requise" });
    return;
  }
  if (req.admin.role !== "sesame") {
    res.status(403).json({ error: "Réservé aux comptes Sesame" });
    return;
  }
  next();
}

/** À enchaîner après requireSesame — réserve l'accès aux comptes Sesame
 * ayant le rôle CRM "admin" (gestion des utilisateurs CRM eux-mêmes). */
export function requireCrmAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.admin) {
    res.status(401).json({ error: "Authentification admin requise" });
    return;
  }
  if (req.admin.crmRole !== "admin") {
    res.status(403).json({ error: "Réservé aux administrateurs CRM" });
    return;
  }
  next();
}
