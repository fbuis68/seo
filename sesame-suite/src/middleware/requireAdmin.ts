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
