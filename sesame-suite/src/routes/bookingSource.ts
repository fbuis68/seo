import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { fetchExternalBookings, mapBookings, runImport, BookingSourceError, FieldMapping } from "../lib/bookingSource";

export const bookingSourceRouter = Router();

function shapeConfig(c: {
  enabled: boolean;
  sourceName: string | null;
  baseUrl: string | null;
  endpointPath: string | null;
  authType: string;
  authApiKeyHeader: string | null;
  authApiKeyValue: string | null;
  authBearerToken: string | null;
  authBasicUser: string | null;
  authBasicPassword: string | null;
  responseListPath: string | null;
  fieldMapping: unknown;
  syncIntervalMinutes: number | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  lastSyncCount: number | null;
}) {
  return {
    enabled: c.enabled,
    sourceName: c.sourceName || "",
    baseUrl: c.baseUrl || "",
    endpointPath: c.endpointPath || "",
    authType: c.authType,
    authApiKeyHeader: c.authApiKeyHeader || "",
    authApiKeyValue: c.authApiKeyValue || "",
    authBearerToken: c.authBearerToken || "",
    authBasicUser: c.authBasicUser || "",
    authBasicPassword: c.authBasicPassword || "",
    responseListPath: c.responseListPath || "",
    fieldMapping: c.fieldMapping || {},
    syncIntervalMinutes: c.syncIntervalMinutes,
    lastSyncAt: c.lastSyncAt,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncMessage: c.lastSyncMessage,
    lastSyncCount: c.lastSyncCount,
  };
}

/** GET /wa/bookingSource/config — réglages du connecteur de cet établissement (créés vides au besoin). */
bookingSourceRouter.get(
  "/bookingSource/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.bookingSourceConfig.upsert({
      where: { entityId: entity.id },
      update: {},
      create: { entityId: entity.id },
    });
    res.json(shapeConfig(config));
  })
);

interface ConfigBody {
  enabled?: boolean;
  sourceName?: string;
  baseUrl?: string;
  endpointPath?: string;
  authType?: string;
  authApiKeyHeader?: string;
  authApiKeyValue?: string;
  authBearerToken?: string;
  authBasicUser?: string;
  authBasicPassword?: string;
  responseListPath?: string;
  fieldMapping?: FieldMapping;
  syncIntervalMinutes?: number | null;
}

/** POST /wa/bookingSource/config/update */
bookingSourceRouter.post(
  "/bookingSource/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as ConfigBody;
    const data = {
      enabled: b.enabled,
      sourceName: b.sourceName,
      baseUrl: b.baseUrl,
      endpointPath: b.endpointPath,
      authType: b.authType,
      authApiKeyHeader: b.authApiKeyHeader,
      authApiKeyValue: b.authApiKeyValue,
      authBearerToken: b.authBearerToken,
      authBasicUser: b.authBasicUser,
      authBasicPassword: b.authBasicPassword,
      responseListPath: b.responseListPath,
      fieldMapping: b.fieldMapping as never,
      syncIntervalMinutes: b.syncIntervalMinutes ?? null,
    };
    const config = await prisma.bookingSourceConfig.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, ...data },
    });
    res.json(shapeConfig(config));
  })
);

/**
 * POST /wa/bookingSource/test — aperçu à blanc (aucune écriture) avec les
 * réglages du formulaire (pas forcément encore enregistrés — les champs
 * omis reprennent la valeur sauvegardée).
 */
bookingSourceRouter.post(
  "/bookingSource/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const saved = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    const b = req.body as ConfigBody;
    const draft = {
      id: saved?.id || "draft",
      entityId: entity.id,
      enabled: true,
      sourceName: b.sourceName ?? saved?.sourceName ?? null,
      baseUrl: b.baseUrl ?? saved?.baseUrl ?? null,
      endpointPath: b.endpointPath ?? saved?.endpointPath ?? null,
      authType: b.authType ?? saved?.authType ?? "none",
      authApiKeyHeader: b.authApiKeyHeader ?? saved?.authApiKeyHeader ?? null,
      authApiKeyValue: b.authApiKeyValue ?? saved?.authApiKeyValue ?? null,
      authBearerToken: b.authBearerToken ?? saved?.authBearerToken ?? null,
      authBasicUser: b.authBasicUser ?? saved?.authBasicUser ?? null,
      authBasicPassword: b.authBasicPassword ?? saved?.authBasicPassword ?? null,
      responseListPath: b.responseListPath ?? saved?.responseListPath ?? null,
      fieldMapping: (b.fieldMapping ?? saved?.fieldMapping ?? {}) as never,
      syncIntervalMinutes: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: null,
      lastSyncCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      const raw = await fetchExternalBookings(draft as never);
      const mapping = (draft.fieldMapping as FieldMapping) || {};
      const { mapped, errors } = mapBookings(raw, mapping);
      res.json({
        ok: true,
        totalReceived: raw.length,
        preview: mapped.slice(0, 10).map((m) => ({ ...m, startDate: m.startDate.toISOString().slice(0, 10), endDate: m.endDate.toISOString().slice(0, 10) })),
        validCount: mapped.length,
        errors: errors.slice(0, 10),
      });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** POST /wa/bookingSource/import — synchronisation réelle (upsert en base) à partir des réglages enregistrés. */
bookingSourceRouter.post(
  "/bookingSource/import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.baseUrl) throw new HttpError(400, "Connecteur non configuré — enregistrez d'abord les réglages");
    const result = await runImport(entity, config);
    if (!result.ok) throw new HttpError(400, result.message);
    res.json(result);
  })
);
