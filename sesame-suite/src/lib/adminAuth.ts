import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AdminTokenPayload {
  entityId: string;
  adminId: string;
  email: string;
  role: "admin";
}

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AdminTokenPayload;
    if (decoded.role !== "admin") return null;
    return decoded;
  } catch {
    return null;
  }
}
