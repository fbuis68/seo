import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { fetchModules, runCatalogImport, LockerSourceError } from "../lib/lockerSource";

export const lockerSourceRouter = Router();

function shapeConfig(c: {
  enabled: boolean;
  baseUrl: string | null;
  apiToken: string | null;
  sellerGroupId: string | null;
  moduleId: string | null;
  defaultCategory: string | null;
  syncIntervalMinutes: number | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  lastSyncCount: number | null;
}) {
  return {
    enabled: c.enabled,
    baseUrl: c.baseUrl || "https://api.moncasierfrais.fr/v1",
    apiToken: c.apiToken || "",
    sellerGroupId: c.sellerGroupId || "",
    moduleId: c.moduleId || "",
    defaultCategory: c.defaultCategory || "Mon Casier Frais",
    syncIntervalMinutes: c.syncIntervalMinutes,
    lastSyncAt: c.lastSyncAt,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncMessage: c.lastSyncMessage,
    lastSyncCount: c.lastSyncCount,
  };
}

/** GET /wa/lockerSource/config — réglages du connecteur Mon Casier Frais de cet établissement (créés vides au besoin). */
lockerSourceRouter.get(
  "/lockerSource/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.lockerSourceConfig.upsert({
      where: { entityId: entity.id },
      update: {},
      create: { entityId: entity.id },
    });
    res.json(shapeConfig(config));
  })
);

interface ConfigBody {
  enabled?: boolean;
  baseUrl?: string;
  apiToken?: string;
  sellerGroupId?: string;
  moduleId?: string;
  defaultCategory?: string;
  syncIntervalMinutes?: number | null;
}

/** POST /wa/lockerSource/config/update */
lockerSourceRouter.post(
  "/lockerSource/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as ConfigBody;
    const data = {
      enabled: b.enabled,
      baseUrl: b.baseUrl,
      apiToken: b.apiToken,
      sellerGroupId: b.sellerGroupId,
      moduleId: b.moduleId,
      defaultCategory: b.defaultCategory,
      syncIntervalMinutes: b.syncIntervalMinutes ?? null,
    };
    const config = await prisma.lockerSourceConfig.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, ...data },
    });
    res.json(shapeConfig(config));
  })
);

/**
 * POST /wa/lockerSource/modules — liste des modules (installations de
 * casiers) accessibles avec ce jeton, pour aider l'admin à trouver le bon
 * moduleId sans avoir à le chercher côté portail Mon Casier Frais. Utilise
 * apiToken/sellerGroupId du formulaire s'ils sont fournis (pas forcément
 * encore enregistrés), sinon retombe sur les réglages sauvegardés.
 */
lockerSourceRouter.post(
  "/lockerSource/modules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const saved = await prisma.lockerSourceConfig.findUnique({ where: { entityId: entity.id } });
    const b = req.body as ConfigBody;
    const draft = {
      id: saved?.id || "draft",
      entityId: entity.id,
      enabled: true,
      baseUrl: b.baseUrl ?? saved?.baseUrl ?? "https://api.moncasierfrais.fr/v1",
      apiToken: b.apiToken ?? saved?.apiToken ?? null,
      sellerGroupId: b.sellerGroupId ?? saved?.sellerGroupId ?? null,
      moduleId: null,
      defaultCategory: null,
      syncIntervalMinutes: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: null,
      lastSyncCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    try {
      const modules = await fetchModules(draft as never);
      res.json({ ok: true, modules });
    } catch (e) {
      if (e instanceof LockerSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** POST /wa/lockerSource/import — synchronisation réelle du catalogue (upsert en base) à partir des réglages enregistrés. */
lockerSourceRouter.post(
  "/lockerSource/import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.lockerSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.apiToken || !config.moduleId) {
      throw new HttpError(400, "Connecteur non configuré — renseignez le jeton API et le module, puis enregistrez");
    }
    const result = await runCatalogImport(entity, config);
    if (!result.ok) throw new HttpError(400, result.message);
    res.json(result);
  })
);
