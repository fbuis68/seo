import jwt from "jsonwebtoken";
import { config } from "../config";

// "housekeeping" : compte restreint à l'app tablette ménage/maintenance
// (menage.html) — cf. middleware/housekeepingScope.ts pour la restriction
// des routes API accessibles à ce rôle.
export type AdminRole = "sesame" | "hotel" | "housekeeping";

export interface AdminTokenPayload {
  entityId: string;
  entityCode: string;
  adminId: string;
  email: string;
  role: AdminRole;
  crmRole?: string; // "admin" | "commercial" — uniquement significatif pour role="sesame"
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AdminTokenPayload;
    if (decoded.role !== "sesame" && decoded.role !== "hotel" && decoded.role !== "housekeeping") return null;
    if (!decoded.adminId || !decoded.entityCode) return null;
    return decoded;
  } catch {
    return null;
  }
}
