import { Request } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { HttpError } from "./asyncHandler";

/** Resolves the tenant Entity for a request — falls back to the single demo
 * hotel (Hôtel Churchill) when no entityCode is supplied, since this build
 * is single-tenant in practice but keeps entityId isolation throughout the
 * schema for forward compatibility (cf. fmk principe 4). */
export async function resolveEntity(req: Request) {
  const code = (req.query.entityCode as string) || (req.body && req.body.entityCode) || config.defaultEntityCode;
  const entity = await prisma.entity.findUnique({ where: { code } });
  if (!entity) throw new HttpError(404, `Entity inconnue: ${code}`);
  return entity;
}
