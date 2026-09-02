import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { fireTrigger } from "../lib/automation";
import { config } from "../config";

/**
 * CRM commercial interne de Sesame — pipeline prospects/clients (à ne pas
 * confondre avec /wa/crm/*, le module CRM de chaque hôtel qui gère SES
 * propres clients finaux). Réservé aux comptes "sesame". Remplace l'ancien
 * panneau "CRM Sesame" jamais branché de admin.html — nouvelle maquette,
 * nouvelle app dédiée (public/crm.html).
 */
export const crmProspectRouter = Router();

/** Nettoie la liste d'affiliations envoyée par le formulaire (texte libre côté
 * ajout d'une nouvelle option, cf. public/crm.html) — trim, retire les vides,
 * déduplique sans tenir compte de la casse (garde la première graphie vue). */
function normalizeAffiliations(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function shapeActivity(a: { id: string; type: string; text: string; authorName: string | null; activityDate: Date | null; done: boolean; createdAt: Date }) {
  return {
    id: a.id,
    type: a.type,
    text: a.text,
    authorName: a.authorName || "",
    activityDate: a.activityDate,
    done: a.done,
    createdAt: a.createdAt,
  };
}

function shapeProspect(p: {
  id: string;
  entityId: string | null;
  subscriptionId: string | null;
  nom: string;
  type: string;
  groupe: string | null;
  affiliations: string[];
  secteur: string | null;
  denominationSociale: string | null;
  siret: string | null;
  siren: string | null;
  formeJuridique: string | null;
  dateCreationEntreprise: Date | null;
  effectifSalarie: string | null;
  adresse: string | null;
  ville: string | null;
  pays: string | null;
  lat: number | null;
  lng: number | null;
  etoiles: string | null;
  danger: string;
  potentiel: number;
  contrat: string;
  modules: number;
  moduleSesame: boolean;
  moduleTtlock: boolean;
  moduleOneway: boolean;
  nbAcces: number;
  pms: string | null;
  priorite: number;
  appel: string | null;
  referent: string | null;
  email: string | null;
  tel: string | null;
  site: string | null;
  nfc: number;
  qr: number;
  mobile: number;
  code: number;
  webApp: boolean;
  mobileV2: boolean;
  checkin: boolean;
  livret: boolean;
  gestionDemande: boolean;
  offline: boolean;
  onbChoixChambres: boolean;
  onbOccupant: boolean;
  onbIdentite: boolean;
  onbMenage: boolean;
  espBoutique: boolean;
  espPoint: boolean;
  espEvenement: boolean;
  messagerie: string;
  note: string | null;
  mrr: number | null;
  signe: number | null;
  previsionnel: number | null;
  inboundReplyCount: number;
  lastInboundReplyAt: Date | null;
  commercialId: string | null;
  createdAt: Date;
  updatedAt: Date;
  entity?: { code: string; config: { lang: string; currency: string; timezone: string } | null } | null;
  commercial?: { id: string; name: string | null; email: string } | null;
  activities?: Parameters<typeof shapeActivity>[0][];
}) {
  return {
    id: p.id,
    entityId: p.entityId,
    entityCode: p.entity ? p.entity.code : null,
    // Langue/devise/fuseau proviennent en direct de EntityModuleConfig (via
    // l'entité liée) plutôt que d'une copie sur la fiche — pas de risque de
    // désynchronisation si l'hôtel change ces paramètres depuis son propre
    // panneau. null pour les fiches sans entité liée (contact/ticket/saisie
    // manuelle) : rien à retrouver tant qu'aucun compte n'existe derrière.
    lang: p.entity?.config?.lang ?? null,
    currency: p.entity?.config?.currency ?? null,
    timezone: p.entity?.config?.timezone ?? null,
    subscriptionId: p.subscriptionId,
    nom: p.nom,
    type: p.type,
    groupe: p.groupe || "",
    affiliations: p.affiliations || [],
    secteur: p.secteur || "",
    denominationSociale: p.denominationSociale || "",
    siret: p.siret || "",
    siren: p.siren || "",
    formeJuridique: p.formeJuridique || "",
    dateCreationEntreprise: p.dateCreationEntreprise,
    effectifSalarie: p.effectifSalarie || "",
    adresse: p.adresse || "",
    ville: p.ville || "",
    pays: p.pays || "",
    lat: p.lat,
    lng: p.lng,
    etoiles: p.etoiles || "",
    danger: p.danger,
    potentiel: p.potentiel,
    contrat: p.contrat,
    modules: p.modules,
    moduleSesame: p.moduleSesame,
    moduleTtlock: p.moduleTtlock,
    moduleOneway: p.moduleOneway,
    nbAcces: p.nbAcces,
    pms: p.pms || "",
    priorite: p.priorite,
    appel: p.appel || "",
    referent: p.referent || "",
    email: p.email || "",
    tel: p.tel || "",
    site: p.site || "",
    nfc: p.nfc,
    qr: p.qr,
    mobile: p.mobile,
    code: p.code,
    webApp: p.webApp,
    mobileV2: p.mobileV2,
    checkin: p.checkin,
    livret: p.livret,
    gestionDemande: p.gestionDemande,
    offline: p.offline,
    onbChoixChambres: p.onbChoixChambres,
    onbOccupant: p.onbOccupant,
    onbIdentite: p.onbIdentite,
    onbMenage: p.onbMenage,
    espBoutique: p.espBoutique,
    espPoint: p.espPoint,
    espEvenement: p.espEvenement,
    messagerie: p.messagerie,
    note: p.note || "",
    mrr: p.mrr,
    signe: p.signe,
    previsionnel: p.previsionnel,
    inboundReplyCount: p.inboundReplyCount,
    lastInboundReplyAt: p.lastInboundReplyAt,
    commercialId: p.commercialId,
    commercialName: p.commercial ? p.commercial.name || p.commercial.email : "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    journal: (p.activities || []).map(shapeActivity),
  };
}

const PROSPECT_INCLUDE = {
  entity: { select: { code: true, config: { select: { lang: true, currency: true, timezone: true } } } },
  activities: { orderBy: { createdAt: "asc" as const } },
  commercial: { select: { id: true, name: true, email: true } },
};

crmProspectRouter.get(
  "/crmProspect/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmProspect.findMany({ include: PROSPECT_INCLUDE, orderBy: { nom: "asc" } });
    res.json(rows.map(shapeProspect));
  })
);

interface ProspectBody {
  nom: string;
  type?: string;
  groupe?: string;
  affiliations?: string[];
  secteur?: string;
  denominationSociale?: string;
  siret?: string;
  siren?: string;
  formeJuridique?: string;
  dateCreationEntreprise?: string | null;
  effectifSalarie?: string;
  adresse?: string;
  ville?: string;
  pays?: string;
  lat?: number | null;
  lng?: number | null;
  etoiles?: string;
  danger?: string;
  potentiel?: number;
  contrat?: string;
  modules?: number;
  moduleSesame?: boolean;
  moduleTtlock?: boolean;
  moduleOneway?: boolean;
  nbAcces?: number;
  pms?: string;
  priorite?: number;
  appel?: string;
  referent?: string;
  email?: string;
  tel?: string;
  site?: string;
  nfc?: number;
  qr?: number;
  mobile?: number;
  code?: number;
  webApp?: boolean;
  mobileV2?: boolean;
  checkin?: boolean;
  livret?: boolean;
  gestionDemande?: boolean;
  offline?: boolean;
  onbChoixChambres?: boolean;
  onbOccupant?: boolean;
  onbIdentite?: boolean;
  onbMenage?: boolean;
  espBoutique?: boolean;
  espPoint?: boolean;
  espEvenement?: boolean;
  messagerie?: string;
  note?: string;
  mrr?: number | null;
  signe?: number | null;
  previsionnel?: number | null;
  commercialId?: string | null;
}

crmProspectRouter.post(
  "/crmProspect/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ProspectBody;
    if (!b.nom || !b.nom.trim()) throw new HttpError(400, "Nom requis");
    if (!b.adresse || !b.adresse.trim()) throw new HttpError(400, "Adresse requise");
    if (!b.ville || !b.ville.trim()) throw new HttpError(400, "Ville requise");
    const row = await prisma.crmProspect.create({
      data: {
        nom: b.nom.trim(),
        type: b.type || "Client",
        groupe: b.groupe,
        affiliations: normalizeAffiliations(b.affiliations),
        secteur: b.secteur,
        denominationSociale: b.denominationSociale,
        siret: b.siret,
        siren: b.siren,
        formeJuridique: b.formeJuridique,
        dateCreationEntreprise: b.dateCreationEntreprise ? new Date(b.dateCreationEntreprise) : undefined,
        effectifSalarie: b.effectifSalarie,
        adresse: b.adresse.trim(),
        ville: b.ville.trim(),
        pays: b.pays || undefined,
        lat: b.lat ?? undefined,
        lng: b.lng ?? undefined,
        etoiles: b.etoiles,
        danger: b.danger || "Modéré",
        potentiel: b.potentiel ?? 0,
        contrat: b.contrat || "non",
        modules: b.modules ?? 0,
        moduleSesame: !!b.moduleSesame,
        moduleTtlock: !!b.moduleTtlock,
        moduleOneway: !!b.moduleOneway,
        nbAcces: b.nbAcces ?? 0,
        pms: b.pms,
        priorite: b.priorite ?? 0,
        appel: b.appel,
        referent: b.referent,
        email: b.email,
        tel: b.tel,
        site: b.site,
        nfc: b.nfc ?? 0,
        qr: b.qr ?? 0,
        mobile: b.mobile ?? 0,
        code: b.code ?? 0,
        webApp: !!b.webApp,
        mobileV2: !!b.mobileV2,
        checkin: !!b.checkin,
        livret: !!b.livret,
        gestionDemande: !!b.gestionDemande,
        offline: !!b.offline,
        onbChoixChambres: !!b.onbChoixChambres,
        onbOccupant: !!b.onbOccupant,
        onbIdentite: !!b.onbIdentite,
        onbMenage: !!b.onbMenage,
        espBoutique: !!b.espBoutique,
        espPoint: !!b.espPoint,
        espEvenement: !!b.espEvenement,
        messagerie: b.messagerie || "Noreply",
        note: b.note,
        mrr: b.mrr ?? null,
        signe: b.signe ?? null,
        previsionnel: b.previsionnel ?? null,
        commercialId: b.commercialId || null,
      },
      include: PROSPECT_INCLUDE,
    });
    fireTrigger("crm.prospect_created", {
      entityId: null,
      targetType: "crmProspect",
      targetId: row.id,
      recipient: { email: row.email, phone: row.tel },
      variables: { nom: row.nom, secteur: row.secteur || "" },
    }).catch((e) => console.error("[automation] crm.prospect_created:", e));
    res.status(201).json(shapeProspect(row));
  })
);

crmProspectRouter.post(
  "/crmProspect/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...rest } = req.body as ProspectBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const b = rest;
    if (b.nom !== undefined && !b.nom.trim()) throw new HttpError(400, "Le nom ne peut pas être vide");
    // Adresse/ville sont requises à la création (cf. /crmProspect/create) mais
    // pas ici : le formulaire d'édition envoie toujours ces deux champs,
    // même quand l'utilisateur modifie un tout autre champ (ex : type de
    // module) — les bloquer aurait empêché toute modification des 42/72
    // fiches importées depuis l'audit sans adresse complète (confirmé le
    // 24/08/2026 : c'était la cause d'un blocage silencieux "le calcul ne se
    // fait pas" en pratique).
    const existing = await prisma.crmProspect.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Prospect introuvable");
    const row = await prisma.crmProspect.update({
      where: { id },
      data: {
        nom: b.nom?.trim(),
        type: b.type,
        groupe: b.groupe,
        affiliations: b.affiliations === undefined ? undefined : normalizeAffiliations(b.affiliations),
        secteur: b.secteur,
        denominationSociale: b.denominationSociale,
        siret: b.siret,
        siren: b.siren,
        formeJuridique: b.formeJuridique,
        dateCreationEntreprise: b.dateCreationEntreprise === undefined ? undefined : b.dateCreationEntreprise ? new Date(b.dateCreationEntreprise) : null,
        effectifSalarie: b.effectifSalarie,
        adresse: b.adresse?.trim(),
        ville: b.ville,
        pays: b.pays,
        lat: b.lat,
        lng: b.lng,
        etoiles: b.etoiles,
        danger: b.danger,
        potentiel: b.potentiel,
        contrat: b.contrat,
        modules: b.modules,
        moduleSesame: b.moduleSesame,
        moduleTtlock: b.moduleTtlock,
        moduleOneway: b.moduleOneway,
        nbAcces: b.nbAcces,
        pms: b.pms,
        priorite: b.priorite,
        appel: b.appel,
        referent: b.referent,
        email: b.email,
        tel: b.tel,
        site: b.site,
        nfc: b.nfc,
        qr: b.qr,
        mobile: b.mobile,
        code: b.code,
        webApp: b.webApp,
        mobileV2: b.mobileV2,
        checkin: b.checkin,
        livret: b.livret,
        gestionDemande: b.gestionDemande,
        offline: b.offline,
        onbChoixChambres: b.onbChoixChambres,
        onbOccupant: b.onbOccupant,
        onbIdentite: b.onbIdentite,
        onbMenage: b.onbMenage,
        espBoutique: b.espBoutique,
        espPoint: b.espPoint,
        espEvenement: b.espEvenement,
        messagerie: b.messagerie,
        note: b.note,
        mrr: b.mrr,
        signe: b.signe,
        previsionnel: b.previsionnel,
        commercialId: b.commercialId === undefined ? undefined : b.commercialId || null,
      },
      include: PROSPECT_INCLUDE,
    });
    if (b.contrat === "oui" && existing.contrat !== "oui") {
      fireTrigger("crm.contract_signed", {
        entityId: null,
        targetType: "crmProspect",
        targetId: row.id,
        recipient: { email: row.email, phone: row.tel },
        variables: { nom: row.nom, secteur: row.secteur || "" },
      }).catch((e) => console.error("[automation] crm.contract_signed:", e));
    }
    res.json(shapeProspect(row));
  })
);

crmProspectRouter.post(
  "/crmProspect/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmProspect.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Prospect introuvable");
    await prisma.crmProspect.delete({ where: { id } });
    res.json({ ok: true });
  })
);

// ── Journal d'activité ──

crmProspectRouter.post(
  "/crmProspect/activity/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { prospectId: string; type?: string; text: string; authorName?: string; activityDate?: string };
    if (!b.prospectId) throw new HttpError(400, "prospectId requis");
    if (!b.text || !b.text.trim()) throw new HttpError(400, "Description de l'activité requise");
    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId } });
    if (!prospect) throw new HttpError(404, "Prospect introuvable");
    const activity = await prisma.crmActivity.create({
      data: {
        prospectId: b.prospectId,
        type: b.type || "Note interne",
        text: b.text.trim(),
        authorName: b.authorName,
        activityDate: b.activityDate ? new Date(b.activityDate) : new Date(),
      },
    });
    res.status(201).json(shapeActivity(activity));
  })
);

crmProspectRouter.post(
  "/crmProspect/activity/markDone",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmActivity.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Activité introuvable");
    const activity = await prisma.crmActivity.update({ where: { id }, data: { done: true } });
    res.json(shapeActivity(activity));
  })
);

crmProspectRouter.post(
  "/crmProspect/activity/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmActivity.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Activité introuvable");
    await prisma.crmActivity.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/**
 * Signal d'engagement entrant — appelé par un flux Power Automate générique
 * sur les boîtes partagées Sesame (pas par contact, cf. discussion du
 * 18/08/2026) à chaque nouvel email reçu. Pas de session admin possible côté
 * Power Automate, donc auth par clé partagée (header) plutôt que JWT.
 * L'email de l'expéditeur ne matchant pas forcément une fiche CRM (spam,
 * échange interne, etc.), une absence de correspondance est une réponse
 * normale (matched:false), pas une erreur.
 */
crmProspectRouter.post(
  "/crmProspect/inboundSignal",
  asyncHandler(async (req, res) => {
    const secret = req.header("X-Inbound-Secret") || "";
    if (secret !== config.inboundEmailSecret) throw new HttpError(401, "Clé invalide");

    const email = ((req.body.email as string) || "").trim();
    if (!email) throw new HttpError(400, "email requis");
    const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt as string) : new Date();

    const prospect = await prisma.crmProspect.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
    if (!prospect) {
      res.json({ ok: true, matched: false });
      return;
    }
    const updated = await prisma.crmProspect.update({
      where: { id: prospect.id },
      data: { inboundReplyCount: { increment: 1 }, lastInboundReplyAt: receivedAt },
    });
    res.json({ ok: true, matched: true, prospectId: updated.id, inboundReplyCount: updated.inboundReplyCount });
  })
);
