import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  fetchExternalBookings,
  fetchExternalFacilities,
  mapBookings,
  mapFacilities,
  upsertMappedFacilities,
  runImport,
  BookingSourceError,
  FieldMapping,
  FacilityMapping,
} from "../lib/bookingSource";

export const bookingSourceRouter = Router();

function shapeConfig(c: {
  enabled: boolean;
  sourceName: string | null;
  presetId: string | null;
  baseUrl: string | null;
  endpointPath: string | null;
  endpointMethod: string | null;
  endpointBodyFormat: string | null;
  endpointBodyParams: unknown;
  authType: string;
  authApiKeyHeader: string | null;
  authApiKeyValue: string | null;
  authBearerToken: string | null;
  authBasicUser: string | null;
  authBasicPassword: string | null;
  loginPath: string | null;
  loginEmail: string | null;
  loginPassword: string | null;
  loginEmailField: string | null;
  loginPasswordField: string | null;
  loginEmailLocation: string | null;
  loginTokenPath: string | null;
  loginTokenHeaderName: string | null;
  loginTokenPrefix: string | null;
  loginExtraField: string | null;
  loginExtraValue: string | null;
  loginProfileListPath: string | null;
  loginProfileMatchField: string | null;
  loginProfileMatchValue: string | null;
  resultEntityField: string | null;
  resultEntityProfileField: string | null;
  skipEntityFilter: boolean;
  responseListPath: string | null;
  fieldMapping: unknown;
  facilityEndpointPath: string | null;
  facilityEndpointMethod: string | null;
  facilityEndpointBodyFormat: string | null;
  facilityEndpointBodyParams: unknown;
  facilityResponseListPath: string | null;
  facilityFieldMapping: unknown;
  nfcEndpointPath: string | null;
  nfcEndpointMethod: string | null;
  nfcEndpointBodyFormat: string | null;
  nfcEndpointBodyParams: unknown;
  nfcCodeParam: string | null;
  nfcResponseCountPath: string | null;
  qrEndpointPath: string | null;
  qrEndpointMethod: string | null;
  qrEndpointBodyFormat: string | null;
  qrEndpointBodyParams: unknown;
  qrCodeParam: string | null;
  qrEmailParam: string | null;
  qrImagePath: string | null;
  qrValuePath: string | null;
  qrAccessCodePath: string | null;
  qrValidUntilPath: string | null;
  qrPasscodeEndpointPath: string | null;
  qrPasscodeValuePath: string | null;
  doorEndpointPath: string | null;
  doorEndpointMethod: string | null;
  doorEndpointBodyFormat: string | null;
  doorEndpointBodyParams: unknown;
  doorCodeParam: string | null;
  doorEmailParam: string | null;
  doorLastnameParam: string | null;
  doorFirstnameParam: string | null;
  doorRoomParam: string | null;
  doorResponseSuccessPath: string | null;
  updateEndpointPath: string | null;
  updateEndpointMethod: string | null;
  updateEndpointBodyFormat: string | null;
  updateEndpointBodyParams: unknown;
  updateCodeParam: string | null;
  updateRoomParam: string | null;
  updateStatusParam: string | null;
  updateStatusValueMap: unknown;
  updateBookingTypeParam: string | null;
  updateStartDateParam: string | null;
  updateEndDateParam: string | null;
  syncIntervalMinutes: number | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  lastSyncCount: number | null;
}) {
  return {
    enabled: c.enabled,
    sourceName: c.sourceName || "",
    presetId: c.presetId || "none",
    baseUrl: c.baseUrl || "",
    endpointPath: c.endpointPath || "",
    endpointMethod: c.endpointMethod || "GET",
    endpointBodyFormat: c.endpointBodyFormat || "form",
    endpointBodyParams: c.endpointBodyParams || {},
    authType: c.authType,
    authApiKeyHeader: c.authApiKeyHeader || "",
    authApiKeyValue: c.authApiKeyValue || "",
    authBearerToken: c.authBearerToken || "",
    authBasicUser: c.authBasicUser || "",
    authBasicPassword: c.authBasicPassword || "",
    loginPath: c.loginPath || "",
    loginEmail: c.loginEmail || "",
    loginPassword: c.loginPassword || "",
    loginEmailField: c.loginEmailField || "login",
    loginPasswordField: c.loginPasswordField || "password",
    loginEmailLocation: c.loginEmailLocation || "body",
    loginTokenPath: c.loginTokenPath || "",
    loginTokenHeaderName: c.loginTokenHeaderName || "Authorization",
    loginTokenPrefix: c.loginTokenPrefix || "",
    loginExtraField: c.loginExtraField || "",
    loginExtraValue: c.loginExtraValue || "",
    loginProfileListPath: c.loginProfileListPath || "",
    loginProfileMatchField: c.loginProfileMatchField || "",
    loginProfileMatchValue: c.loginProfileMatchValue || "",
    resultEntityField: c.resultEntityField || "",
    resultEntityProfileField: c.resultEntityProfileField || "",
    skipEntityFilter: c.skipEntityFilter,
    responseListPath: c.responseListPath || "",
    fieldMapping: c.fieldMapping || {},
    facilityEndpointPath: c.facilityEndpointPath || "",
    facilityEndpointMethod: c.facilityEndpointMethod || "GET",
    facilityEndpointBodyFormat: c.facilityEndpointBodyFormat || "form",
    facilityEndpointBodyParams: c.facilityEndpointBodyParams || {},
    facilityResponseListPath: c.facilityResponseListPath || "",
    facilityFieldMapping: c.facilityFieldMapping || {},
    nfcEndpointPath: c.nfcEndpointPath || "",
    nfcEndpointMethod: c.nfcEndpointMethod || "POST",
    nfcEndpointBodyFormat: c.nfcEndpointBodyFormat || "json",
    nfcEndpointBodyParams: c.nfcEndpointBodyParams || {},
    nfcCodeParam: c.nfcCodeParam || "code",
    nfcResponseCountPath: c.nfcResponseCountPath || "",
    qrEndpointPath: c.qrEndpointPath || "",
    qrEndpointMethod: c.qrEndpointMethod || "GET",
    qrEndpointBodyFormat: c.qrEndpointBodyFormat || "json",
    qrEndpointBodyParams: c.qrEndpointBodyParams || {},
    qrCodeParam: c.qrCodeParam || "code",
    qrEmailParam: c.qrEmailParam || "",
    qrImagePath: c.qrImagePath || "",
    qrValuePath: c.qrValuePath || "",
    qrAccessCodePath: c.qrAccessCodePath || "",
    qrValidUntilPath: c.qrValidUntilPath || "",
    qrPasscodeEndpointPath: c.qrPasscodeEndpointPath || "",
    qrPasscodeValuePath: c.qrPasscodeValuePath || "",
    doorEndpointPath: c.doorEndpointPath || "",
    doorEndpointMethod: c.doorEndpointMethod || "POST",
    doorEndpointBodyFormat: c.doorEndpointBodyFormat || "json",
    doorEndpointBodyParams: c.doorEndpointBodyParams || {},
    doorCodeParam: c.doorCodeParam || "code",
    doorEmailParam: c.doorEmailParam || "",
    doorLastnameParam: c.doorLastnameParam || "",
    doorFirstnameParam: c.doorFirstnameParam || "",
    doorRoomParam: c.doorRoomParam || "",
    doorResponseSuccessPath: c.doorResponseSuccessPath || "",
    updateEndpointPath: c.updateEndpointPath || "",
    updateEndpointMethod: c.updateEndpointMethod || "POST",
    updateEndpointBodyFormat: c.updateEndpointBodyFormat || "json",
    updateEndpointBodyParams: c.updateEndpointBodyParams || {},
    updateCodeParam: c.updateCodeParam || "code",
    updateRoomParam: c.updateRoomParam || "",
    updateStatusParam: c.updateStatusParam || "",
    updateStatusValueMap: c.updateStatusValueMap || {},
    updateBookingTypeParam: c.updateBookingTypeParam || "",
    updateStartDateParam: c.updateStartDateParam || "",
    updateEndDateParam: c.updateEndDateParam || "",
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
  presetId?: string;
  baseUrl?: string;
  endpointPath?: string;
  endpointMethod?: string;
  endpointBodyFormat?: string;
  endpointBodyParams?: Record<string, string>;
  authType?: string;
  authApiKeyHeader?: string;
  authApiKeyValue?: string;
  authBearerToken?: string;
  authBasicUser?: string;
  authBasicPassword?: string;
  loginPath?: string;
  loginEmail?: string;
  loginPassword?: string;
  loginEmailField?: string;
  loginPasswordField?: string;
  loginEmailLocation?: string;
  loginTokenPath?: string;
  loginTokenHeaderName?: string;
  loginTokenPrefix?: string;
  loginExtraField?: string;
  loginExtraValue?: string;
  loginProfileListPath?: string;
  loginProfileMatchField?: string;
  loginProfileMatchValue?: string;
  resultEntityField?: string;
  resultEntityProfileField?: string;
  skipEntityFilter?: boolean;
  responseListPath?: string;
  fieldMapping?: FieldMapping;
  facilityEndpointPath?: string;
  facilityEndpointMethod?: string;
  facilityEndpointBodyFormat?: string;
  facilityEndpointBodyParams?: Record<string, string>;
  facilityResponseListPath?: string;
  facilityFieldMapping?: FacilityMapping;
  nfcEndpointPath?: string;
  nfcEndpointMethod?: string;
  nfcEndpointBodyFormat?: string;
  nfcEndpointBodyParams?: Record<string, string>;
  nfcCodeParam?: string;
  nfcResponseCountPath?: string;
  qrEndpointPath?: string;
  qrEndpointMethod?: string;
  qrEndpointBodyFormat?: string;
  qrEndpointBodyParams?: Record<string, string>;
  qrCodeParam?: string;
  qrEmailParam?: string;
  qrImagePath?: string;
  qrValuePath?: string;
  qrAccessCodePath?: string;
  qrValidUntilPath?: string;
  qrPasscodeEndpointPath?: string;
  qrPasscodeValuePath?: string;
  doorEndpointPath?: string;
  doorEndpointMethod?: string;
  doorEndpointBodyFormat?: string;
  doorEndpointBodyParams?: Record<string, string>;
  doorCodeParam?: string;
  doorEmailParam?: string;
  doorLastnameParam?: string;
  doorFirstnameParam?: string;
  doorRoomParam?: string;
  doorResponseSuccessPath?: string;
  updateEndpointPath?: string;
  updateEndpointMethod?: string;
  updateEndpointBodyFormat?: string;
  updateEndpointBodyParams?: Record<string, string>;
  updateCodeParam?: string;
  updateRoomParam?: string;
  updateStatusParam?: string;
  updateStatusValueMap?: Record<string, string>;
  updateBookingTypeParam?: string;
  updateStartDateParam?: string;
  updateEndDateParam?: string;
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
      presetId: b.presetId,
      baseUrl: b.baseUrl,
      endpointPath: b.endpointPath,
      endpointMethod: b.endpointMethod,
      endpointBodyFormat: b.endpointBodyFormat,
      endpointBodyParams: b.endpointBodyParams as never,
      authType: b.authType,
      authApiKeyHeader: b.authApiKeyHeader,
      authApiKeyValue: b.authApiKeyValue,
      authBearerToken: b.authBearerToken,
      authBasicUser: b.authBasicUser,
      authBasicPassword: b.authBasicPassword,
      loginPath: b.loginPath,
      loginEmail: b.loginEmail,
      loginPassword: b.loginPassword,
      loginEmailField: b.loginEmailField,
      loginPasswordField: b.loginPasswordField,
      loginEmailLocation: b.loginEmailLocation,
      loginTokenPath: b.loginTokenPath,
      loginTokenHeaderName: b.loginTokenHeaderName,
      loginTokenPrefix: b.loginTokenPrefix,
      loginExtraField: b.loginExtraField,
      loginExtraValue: b.loginExtraValue,
      loginProfileListPath: b.loginProfileListPath,
      loginProfileMatchField: b.loginProfileMatchField,
      loginProfileMatchValue: b.loginProfileMatchValue,
      resultEntityField: b.resultEntityField,
      resultEntityProfileField: b.resultEntityProfileField,
      skipEntityFilter: b.skipEntityFilter,
      responseListPath: b.responseListPath,
      fieldMapping: b.fieldMapping as never,
      facilityEndpointPath: b.facilityEndpointPath,
      facilityEndpointMethod: b.facilityEndpointMethod,
      facilityEndpointBodyFormat: b.facilityEndpointBodyFormat,
      facilityEndpointBodyParams: b.facilityEndpointBodyParams as never,
      facilityResponseListPath: b.facilityResponseListPath,
      facilityFieldMapping: b.facilityFieldMapping as never,
      nfcEndpointPath: b.nfcEndpointPath,
      nfcEndpointMethod: b.nfcEndpointMethod,
      nfcEndpointBodyFormat: b.nfcEndpointBodyFormat,
      nfcEndpointBodyParams: b.nfcEndpointBodyParams as never,
      nfcCodeParam: b.nfcCodeParam,
      nfcResponseCountPath: b.nfcResponseCountPath,
      qrEndpointPath: b.qrEndpointPath,
      qrEndpointMethod: b.qrEndpointMethod,
      qrEndpointBodyFormat: b.qrEndpointBodyFormat,
      qrEndpointBodyParams: b.qrEndpointBodyParams as never,
      qrCodeParam: b.qrCodeParam,
      qrEmailParam: b.qrEmailParam,
      qrImagePath: b.qrImagePath,
      qrValuePath: b.qrValuePath,
      qrAccessCodePath: b.qrAccessCodePath,
      qrValidUntilPath: b.qrValidUntilPath,
      qrPasscodeEndpointPath: b.qrPasscodeEndpointPath,
      qrPasscodeValuePath: b.qrPasscodeValuePath,
      doorEndpointPath: b.doorEndpointPath,
      doorEndpointMethod: b.doorEndpointMethod,
      doorEndpointBodyFormat: b.doorEndpointBodyFormat,
      doorEndpointBodyParams: b.doorEndpointBodyParams as never,
      doorCodeParam: b.doorCodeParam,
      doorEmailParam: b.doorEmailParam,
      doorLastnameParam: b.doorLastnameParam,
      doorFirstnameParam: b.doorFirstnameParam,
      doorRoomParam: b.doorRoomParam,
      doorResponseSuccessPath: b.doorResponseSuccessPath,
      updateEndpointPath: b.updateEndpointPath,
      updateEndpointMethod: b.updateEndpointMethod,
      updateEndpointBodyFormat: b.updateEndpointBodyFormat,
      updateEndpointBodyParams: b.updateEndpointBodyParams as never,
      updateCodeParam: b.updateCodeParam,
      updateRoomParam: b.updateRoomParam,
      updateStatusParam: b.updateStatusParam,
      updateStatusValueMap: b.updateStatusValueMap as never,
      updateBookingTypeParam: b.updateBookingTypeParam,
      updateStartDateParam: b.updateStartDateParam,
      updateEndDateParam: b.updateEndDateParam,
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
      endpointMethod: b.endpointMethod ?? saved?.endpointMethod ?? "GET",
      endpointBodyFormat: b.endpointBodyFormat ?? saved?.endpointBodyFormat ?? "form",
      endpointBodyParams: (b.endpointBodyParams ?? saved?.endpointBodyParams ?? {}) as never,
      authType: b.authType ?? saved?.authType ?? "none",
      authApiKeyHeader: b.authApiKeyHeader ?? saved?.authApiKeyHeader ?? null,
      authApiKeyValue: b.authApiKeyValue ?? saved?.authApiKeyValue ?? null,
      authBearerToken: b.authBearerToken ?? saved?.authBearerToken ?? null,
      authBasicUser: b.authBasicUser ?? saved?.authBasicUser ?? null,
      authBasicPassword: b.authBasicPassword ?? saved?.authBasicPassword ?? null,
      loginPath: b.loginPath ?? saved?.loginPath ?? null,
      loginEmail: b.loginEmail ?? saved?.loginEmail ?? null,
      loginPassword: b.loginPassword ?? saved?.loginPassword ?? null,
      loginEmailField: b.loginEmailField ?? saved?.loginEmailField ?? "login",
      loginPasswordField: b.loginPasswordField ?? saved?.loginPasswordField ?? "password",
      loginEmailLocation: b.loginEmailLocation ?? saved?.loginEmailLocation ?? "body",
      loginTokenPath: b.loginTokenPath ?? saved?.loginTokenPath ?? null,
      loginTokenHeaderName: b.loginTokenHeaderName ?? saved?.loginTokenHeaderName ?? "Authorization",
      loginTokenPrefix: b.loginTokenPrefix ?? saved?.loginTokenPrefix ?? null,
      loginExtraField: b.loginExtraField ?? saved?.loginExtraField ?? null,
      loginExtraValue: b.loginExtraValue ?? saved?.loginExtraValue ?? null,
      loginProfileListPath: b.loginProfileListPath ?? saved?.loginProfileListPath ?? null,
      loginProfileMatchField: b.loginProfileMatchField ?? saved?.loginProfileMatchField ?? null,
      loginProfileMatchValue: b.loginProfileMatchValue ?? saved?.loginProfileMatchValue ?? null,
      resultEntityField: b.resultEntityField ?? saved?.resultEntityField ?? null,
      resultEntityProfileField: b.resultEntityProfileField ?? saved?.resultEntityProfileField ?? null,
      skipEntityFilter: b.skipEntityFilter ?? saved?.skipEntityFilter ?? false,
      responseListPath: b.responseListPath ?? saved?.responseListPath ?? null,
      fieldMapping: (b.fieldMapping ?? saved?.fieldMapping ?? {}) as never,
      facilityEndpointPath: b.facilityEndpointPath ?? saved?.facilityEndpointPath ?? null,
      facilityEndpointMethod: b.facilityEndpointMethod ?? saved?.facilityEndpointMethod ?? "GET",
      facilityEndpointBodyFormat: b.facilityEndpointBodyFormat ?? saved?.facilityEndpointBodyFormat ?? "form",
      facilityEndpointBodyParams: (b.facilityEndpointBodyParams ?? saved?.facilityEndpointBodyParams ?? {}) as never,
      facilityResponseListPath: b.facilityResponseListPath ?? saved?.facilityResponseListPath ?? null,
      facilityFieldMapping: (b.facilityFieldMapping ?? saved?.facilityFieldMapping ?? {}) as never,
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

/**
 * POST /wa/bookingSource/testFacilities — aperçu à blanc des chambres
 * (aucune écriture), mêmes réglages de connexion que les réservations mais
 * endpoint/mapping dédiés (facilityEndpointPath, facilityFieldMapping).
 */
bookingSourceRouter.post(
  "/bookingSource/testFacilities",
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
      endpointPath: saved?.endpointPath ?? null,
      endpointMethod: saved?.endpointMethod ?? "GET",
      endpointBodyFormat: saved?.endpointBodyFormat ?? "form",
      endpointBodyParams: (saved?.endpointBodyParams ?? {}) as never,
      authType: b.authType ?? saved?.authType ?? "none",
      authApiKeyHeader: b.authApiKeyHeader ?? saved?.authApiKeyHeader ?? null,
      authApiKeyValue: b.authApiKeyValue ?? saved?.authApiKeyValue ?? null,
      authBearerToken: b.authBearerToken ?? saved?.authBearerToken ?? null,
      authBasicUser: b.authBasicUser ?? saved?.authBasicUser ?? null,
      authBasicPassword: b.authBasicPassword ?? saved?.authBasicPassword ?? null,
      loginPath: b.loginPath ?? saved?.loginPath ?? null,
      loginEmail: b.loginEmail ?? saved?.loginEmail ?? null,
      loginPassword: b.loginPassword ?? saved?.loginPassword ?? null,
      loginEmailField: b.loginEmailField ?? saved?.loginEmailField ?? "login",
      loginPasswordField: b.loginPasswordField ?? saved?.loginPasswordField ?? "password",
      loginEmailLocation: b.loginEmailLocation ?? saved?.loginEmailLocation ?? "body",
      loginTokenPath: b.loginTokenPath ?? saved?.loginTokenPath ?? null,
      loginTokenHeaderName: b.loginTokenHeaderName ?? saved?.loginTokenHeaderName ?? "Authorization",
      loginTokenPrefix: b.loginTokenPrefix ?? saved?.loginTokenPrefix ?? null,
      loginExtraField: b.loginExtraField ?? saved?.loginExtraField ?? null,
      loginExtraValue: b.loginExtraValue ?? saved?.loginExtraValue ?? null,
      loginProfileListPath: b.loginProfileListPath ?? saved?.loginProfileListPath ?? null,
      loginProfileMatchField: b.loginProfileMatchField ?? saved?.loginProfileMatchField ?? null,
      loginProfileMatchValue: b.loginProfileMatchValue ?? saved?.loginProfileMatchValue ?? null,
      resultEntityField: b.resultEntityField ?? saved?.resultEntityField ?? null,
      resultEntityProfileField: b.resultEntityProfileField ?? saved?.resultEntityProfileField ?? null,
      skipEntityFilter: b.skipEntityFilter ?? saved?.skipEntityFilter ?? false,
      responseListPath: saved?.responseListPath ?? null,
      fieldMapping: (saved?.fieldMapping ?? {}) as never,
      facilityEndpointPath: b.facilityEndpointPath ?? saved?.facilityEndpointPath ?? null,
      facilityEndpointMethod: b.facilityEndpointMethod ?? saved?.facilityEndpointMethod ?? "GET",
      facilityEndpointBodyFormat: b.facilityEndpointBodyFormat ?? saved?.facilityEndpointBodyFormat ?? "form",
      facilityEndpointBodyParams: (b.facilityEndpointBodyParams ?? saved?.facilityEndpointBodyParams ?? {}) as never,
      facilityResponseListPath: b.facilityResponseListPath ?? saved?.facilityResponseListPath ?? null,
      facilityFieldMapping: (b.facilityFieldMapping ?? saved?.facilityFieldMapping ?? {}) as never,
      syncIntervalMinutes: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncMessage: null,
      lastSyncCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      const raw = await fetchExternalFacilities(draft as never);
      const mapping = (draft.facilityFieldMapping as FacilityMapping) || {};
      const { mapped, errors } = mapFacilities(raw, mapping);
      res.json({
        ok: true,
        totalReceived: raw.length,
        preview: mapped.slice(0, 10),
        validCount: mapped.length,
        errors: errors.slice(0, 10),
      });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** POST /wa/bookingSource/importFacilities — synchronisation réelle des chambres (upsert en base), manuelle uniquement. */
bookingSourceRouter.post(
  "/bookingSource/importFacilities",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.bookingSourceConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.baseUrl) throw new HttpError(400, "Connecteur non configuré — enregistrez d'abord les réglages");
    try {
      const raw = await fetchExternalFacilities(config);
      const mapping = (config.facilityFieldMapping as FacilityMapping | null) || {};
      const { mapped, errors } = mapFacilities(raw, mapping);
      const { created, updated } = await upsertMappedFacilities(entity, mapped);
      res.json({ ok: true, created, updated, errors, total: raw.length });
    } catch (e) {
      if (e instanceof BookingSourceError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);
