import { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Résolution d'audience de campagne — deux univers totalement différents
 * derrière une même interface {toEmail, name, variables} :
 *   - portée CRM (entityId=null) : base prospects/clients Sesame
 *     (CrmProspect), tous les champs de la fiche sont filtrables ;
 *   - portée hôtel (entityId défini) : base clients de l'établissement,
 *     dérivée des réservations (cf. routes/crm.ts GET /wa/crm/clients),
 *     pas de fiche contact dédiée donc un segment plus restreint (palier
 *     fidélité / inactivité / sélection manuelle).
 * Le filtre exclut toujours les destinataires opt-out et ceux sans email.
 */

export interface CampaignRecipient {
  toEmail: string;
  variables: Record<string, string>;
}

export interface CrmAudienceFilter {
  type?: string[];
  secteur?: string[];
  origine?: string[];
  contrat?: string[];
  danger?: string[];
  ville?: string[];
  groupe?: string[];
  commercialId?: string[];
  moduleSesame?: boolean;
  moduleTtlock?: boolean;
  moduleOneway?: boolean;
  onbChoixChambres?: boolean;
  onbOccupant?: boolean;
  onbIdentite?: boolean;
  onbMenage?: boolean;
  espBoutique?: boolean;
  espPoint?: boolean;
  espEvenement?: boolean;
  webApp?: boolean;
  mobileV2?: boolean;
  checkin?: boolean;
  livret?: boolean;
  gestionDemande?: boolean;
  offline?: boolean;
  scoreMin?: number;
  search?: string;
}

export interface HotelAudienceFilter {
  segment?: "all" | "Standard" | "Gold" | "Premium" | "inactive";
}

const BOOLEAN_FILTER_KEYS: (keyof CrmAudienceFilter)[] = [
  "moduleSesame",
  "moduleTtlock",
  "moduleOneway",
  "onbChoixChambres",
  "onbOccupant",
  "onbIdentite",
  "onbMenage",
  "espBoutique",
  "espPoint",
  "espEvenement",
  "webApp",
  "mobileV2",
  "checkin",
  "livret",
  "gestionDemande",
  "offline",
];

function buildCrmWhere(filter: CrmAudienceFilter | null | undefined): Prisma.CrmProspectWhereInput {
  const f = filter || {};
  const where: Prisma.CrmProspectWhereInput = {
    entityId: null,
    emailOptOut: false,
    email: { not: null },
  };
  if (f.type?.length) where.type = { in: f.type };
  if (f.secteur?.length) where.secteur = { in: f.secteur };
  if (f.origine?.length) where.origine = { in: f.origine };
  if (f.contrat?.length) where.contrat = { in: f.contrat };
  if (f.danger?.length) where.danger = { in: f.danger };
  if (f.ville?.length) where.ville = { in: f.ville };
  if (f.groupe?.length) where.groupe = { in: f.groupe };
  if (f.commercialId?.length) where.commercialId = { in: f.commercialId };
  if (typeof f.scoreMin === "number") where.score = { gte: f.scoreMin };
  if (f.search && f.search.trim()) {
    const s = f.search.trim();
    where.OR = [
      { nom: { contains: s, mode: "insensitive" } },
      { ville: { contains: s, mode: "insensitive" } },
      { groupe: { contains: s, mode: "insensitive" } },
      { referent: { contains: s, mode: "insensitive" } },
    ];
  }
  for (const key of BOOLEAN_FILTER_KEYS) {
    const v = f[key];
    if (typeof v === "boolean") (where as Record<string, unknown>)[key] = v;
  }
  return where;
}

export async function countCrmAudience(filter: CrmAudienceFilter | null | undefined): Promise<number> {
  return prisma.crmProspect.count({ where: buildCrmWhere(filter) });
}

export async function resolveCrmAudience(
  filter: CrmAudienceFilter | null | undefined,
  manualSelectionIds: string[] | null | undefined
): Promise<CampaignRecipient[]> {
  const where = manualSelectionIds?.length
    ? { id: { in: manualSelectionIds }, emailOptOut: false, email: { not: null } }
    : buildCrmWhere(filter);
  const rows = await prisma.crmProspect.findMany({ where });
  return rows
    .filter((r) => r.email && r.email.trim())
    .map((r) => ({
      toEmail: r.email!.trim(),
      variables: { nom: r.nom, secteur: r.secteur || "", referent: r.referent || "", ville: r.ville || "" },
    }));
}

interface HotelClient {
  email: string;
  firstname: string;
  lastname: string;
  points: number;
  tier: string;
  lastStay: string;
}

function computeTier(points: number, tiers: { gold: number; premium: number } | null) {
  const gold = tiers?.gold ?? 500;
  const premium = tiers?.premium ?? 1500;
  if (points >= premium) return "Premium";
  if (points >= gold) return "Gold";
  return "Standard";
}

/** Reconstruit la même liste de clients que GET /wa/crm/clients (routes/crm.ts), sans passer par une requête HTTP. */
async function hotelClients(entityId: string): Promise<HotelClient[]> {
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) return [];
  const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
  const groupAggregated = group?.loyaltyMode === "centralized";
  const entityIds = groupAggregated
    ? (await prisma.entity.findMany({ where: { groupId: group!.id }, select: { id: true } })).map((e) => e.id)
    : [entity.id];

  const [bookings, loyaltyAccounts, cfg] = await Promise.all([
    prisma.booking.findMany({ where: { entityId: { in: entityIds } }, orderBy: { startDate: "desc" } }),
    groupAggregated
      ? prisma.loyaltyAccount.findMany({ where: { groupId: group!.id } })
      : prisma.loyaltyAccount.findMany({ where: { entityId: entity.id } }),
    prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } }),
  ]);
  const pointsByEmail = new Map(loyaltyAccounts.map((a) => [a.email.toLowerCase(), a.totalPoints]));
  const tiers = (cfg?.loyaltyTiers as unknown as { gold: number; premium: number } | null) || null;

  const byEmail = new Map<string, HotelClient>();
  for (const b of bookings) {
    const key = b.personEmail.toLowerCase();
    const existing = byEmail.get(key);
    if (existing) {
      if (b.startDate.toISOString() > existing.lastStay) existing.lastStay = b.startDate.toISOString();
    } else {
      const points = pointsByEmail.get(key) || 0;
      byEmail.set(key, {
        email: b.personEmail,
        firstname: b.personFirstname,
        lastname: b.personLastname,
        points,
        tier: computeTier(points, tiers),
        lastStay: b.startDate.toISOString(),
      });
    }
  }
  return Array.from(byEmail.values());
}

function applyHotelSegment(clients: HotelClient[], segment: HotelAudienceFilter["segment"]): HotelClient[] {
  if (!segment || segment === "all") return clients;
  if (segment === "inactive") {
    const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    return clients.filter((c) => new Date(c.lastStay).getTime() < sixMonthsAgo);
  }
  return clients.filter((c) => c.tier === segment);
}

async function excludeHotelOptOut(entityId: string, clients: HotelClient[]): Promise<HotelClient[]> {
  if (!clients.length) return clients;
  const prefs = await prisma.clientPrefs.findMany({
    where: { entityId, email: { in: clients.map((c) => c.email) }, emailOptOut: true },
    select: { email: true },
  });
  const optedOut = new Set(prefs.map((p) => p.email.toLowerCase()));
  return clients.filter((c) => !optedOut.has(c.email.toLowerCase()));
}

export async function countHotelAudience(
  entityId: string,
  filter: HotelAudienceFilter | null | undefined,
  manualSelectionEmails: string[] | null | undefined
): Promise<number> {
  const recipients = await resolveHotelAudience(entityId, filter, manualSelectionEmails);
  return recipients.length;
}

export async function resolveHotelAudience(
  entityId: string,
  filter: HotelAudienceFilter | null | undefined,
  manualSelectionEmails: string[] | null | undefined
): Promise<CampaignRecipient[]> {
  let clients = await hotelClients(entityId);
  if (manualSelectionEmails?.length) {
    const selected = new Set(manualSelectionEmails.map((e) => e.toLowerCase()));
    clients = clients.filter((c) => selected.has(c.email.toLowerCase()));
  } else {
    clients = applyHotelSegment(clients, filter?.segment);
  }
  clients = await excludeHotelOptOut(entityId, clients);
  return clients
    .filter((c) => c.email && c.email.trim())
    .map((c) => ({
      toEmail: c.email.trim(),
      variables: { prenom: c.firstname || "", nom: c.lastname || "", tier: c.tier },
    }));
}
