import { prisma } from "../db";
import type { BookingSourceConfig, Entity } from "@prisma/client";

/** Champs Booking que le mapping peut renseigner — valeur = dot-path dans
 * chaque élément du tableau JSON retourné par la source externe. */
export interface FieldMapping {
  code?: string;
  personEmail?: string;
  personFirstname?: string;
  personLastname?: string;
  personPhone?: string;
  startDate?: string;
  endDate?: string;
  facilityCode?: string;
  status?: string;
}

export interface MappedBooking {
  code: string;
  personEmail: string;
  personFirstname: string;
  personLastname: string;
  personPhone: string;
  startDate: Date;
  endDate: Date;
  facilityCode: string;
  status: string;
}

export interface MapError {
  index: number;
  reason: string;
}

/** Lecture d'un chemin "a.b.c" (ou "a.0.b" pour un index de tableau) dans un objet. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined) return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

export class BookingSourceError extends Error {}

function buildAuthHeaders(config: BookingSourceConfig): Record<string, string> {
  switch (config.authType) {
    case "apiKey":
      if (!config.authApiKeyHeader || !config.authApiKeyValue) return {};
      return { [config.authApiKeyHeader]: config.authApiKeyValue };
    case "bearer":
      return config.authBearerToken ? { Authorization: `Bearer ${config.authBearerToken}` } : {};
    case "basic":
      if (!config.authBasicUser) return {};
      return { Authorization: "Basic " + Buffer.from(`${config.authBasicUser}:${config.authBasicPassword || ""}`).toString("base64") };
    default:
      return {};
  }
}

/** Appelle la source externe et renvoie le tableau brut de réservations (pas encore mappé). */
export async function fetchExternalBookings(config: BookingSourceConfig): Promise<unknown[]> {
  if (!config.baseUrl) throw new BookingSourceError("URL de base non configurée");
  const url = config.baseUrl.replace(/\/$/, "") + (config.endpointPath || "");
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...buildAuthHeaders(config) } });
  } catch (e) {
    throw new BookingSourceError(`Connexion impossible : ${e instanceof Error ? e.message : "erreur réseau"}`);
  }
  if (!res.ok) throw new BookingSourceError(`Le serveur distant a répondu ${res.status} ${res.statusText}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BookingSourceError("La réponse n'est pas un JSON valide");
  }

  const list = config.responseListPath ? getPath(body, config.responseListPath) : body;
  if (!Array.isArray(list)) {
    throw new BookingSourceError(
      config.responseListPath
        ? `Le chemin "${config.responseListPath}" ne pointe pas vers un tableau`
        : "La réponse n'est pas un tableau — précisez le chemin vers la liste des réservations"
    );
  }
  return list;
}

/** Applique le mapping de champs à la liste brute — sépare éléments valides et en erreur. */
export function mapBookings(items: unknown[], mapping: FieldMapping): { mapped: MappedBooking[]; errors: MapError[] } {
  const mapped: MappedBooking[] = [];
  const errors: MapError[] = [];

  items.forEach((item, index) => {
    const code = mapping.code ? String(getPath(item, mapping.code) ?? "").trim() : "";
    const personEmail = mapping.personEmail ? String(getPath(item, mapping.personEmail) ?? "").trim() : "";
    const startRaw = mapping.startDate ? getPath(item, mapping.startDate) : undefined;
    const endRaw = mapping.endDate ? getPath(item, mapping.endDate) : undefined;

    if (!code) { errors.push({ index, reason: "code de réservation manquant" }); return; }
    if (!personEmail) { errors.push({ index, reason: "email client manquant" }); return; }
    const startDate = startRaw ? new Date(String(startRaw)) : null;
    const endDate = endRaw ? new Date(String(endRaw)) : null;
    if (!startDate || isNaN(startDate.getTime())) { errors.push({ index, reason: "date d'arrivée invalide ou manquante" }); return; }
    if (!endDate || isNaN(endDate.getTime())) { errors.push({ index, reason: "date de départ invalide ou manquante" }); return; }

    mapped.push({
      code,
      personEmail,
      personFirstname: mapping.personFirstname ? String(getPath(item, mapping.personFirstname) ?? "").trim() : "",
      personLastname: mapping.personLastname ? String(getPath(item, mapping.personLastname) ?? "").trim() : "",
      personPhone: mapping.personPhone ? String(getPath(item, mapping.personPhone) ?? "").trim() : "",
      startDate,
      endDate,
      facilityCode: mapping.facilityCode ? String(getPath(item, mapping.facilityCode) ?? "").trim() : "",
      status: (mapping.status ? String(getPath(item, mapping.status) ?? "").trim() : "") || "confirmed",
    });
  });

  return { mapped, errors };
}

/** Crée/met à jour les réservations mappées (upsert par entityId+code). */
export async function upsertMappedBookings(entity: Entity, mapped: MappedBooking[], sourceName: string) {
  let created = 0;
  let updated = 0;
  for (const b of mapped) {
    const room = b.facilityCode
      ? await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.facilityCode } } })
      : null;
    const existing = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.code } } });
    const data = {
      personEmail: b.personEmail,
      personFirstname: b.personFirstname || existing?.personFirstname || "",
      personLastname: b.personLastname || existing?.personLastname || "",
      personPhone: b.personPhone || undefined,
      startDate: b.startDate,
      endDate: b.endDate,
      facilityCode: b.facilityCode || undefined,
      facilityName: room?.name || undefined,
      roomId: room?.id,
      status: b.status,
      importedFrom: sourceName,
    };
    if (existing) {
      await prisma.booking.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.booking.create({ data: { entityId: entity.id, code: b.code, ...data } });
      created++;
    }
  }
  return { created, updated };
}

/** Exécute une synchronisation complète pour un établissement — utilisé par
 * l'import manuel (POST /wa/bookingSource/import) et le planificateur. */
export async function runImport(entity: Entity, config: BookingSourceConfig) {
  const mapping = (config.fieldMapping as FieldMapping | null) || {};
  const sourceName = config.sourceName || "Connecteur externe";
  try {
    const raw = await fetchExternalBookings(config);
    const { mapped, errors } = mapBookings(raw, mapping);
    const { created, updated } = await upsertMappedBookings(entity, mapped, sourceName);
    const message = `${created} créée(s), ${updated} mise(s) à jour${errors.length ? `, ${errors.length} ignorée(s)` : ""}`;
    await prisma.bookingSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "success", lastSyncMessage: message, lastSyncCount: created + updated },
    });
    return { ok: true as const, created, updated, errors, total: raw.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur inconnue";
    await prisma.bookingSourceConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "error", lastSyncMessage: message, lastSyncCount: null },
    });
    return { ok: false as const, message };
  }
}
