import jwt from "jsonwebtoken";
import { config } from "../config";

export type AdminRole = "sesame" | "hotel";

export interface AdminTokenPayload {
  entityId: string;
  entityCode: string;
  adminId: string;
  email: string;
  role: AdminRole;
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AdminTokenPayload;
    if (decoded.role !== "sesame" && decoded.role !== "hotel") return null;
    if (!decoded.adminId || !decoded.entityCode) return null;
    return decoded;
  } catch {
    return null;
  }
}
