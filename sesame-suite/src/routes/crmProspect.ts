import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { fireTrigger } from "../lib/automation";
import { config } from "../config";
import { invoiceTotal } from "../lib/accReconciliation";

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
  origine: string | null;
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
  linkedinUrl: string | null;
  emailOptOut: boolean;
  emailOptOutAt: Date | null;
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
  score: number;
  hotLeadTaskCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  entity?: { code: string; config: { lang: string; currency: string; timezone: string } | null } | null;
  commercial?: { id: string; name: string | null; email: string } | null;
  activities?: Parameters<typeof shapeActivity>[0][];
  contacts?: { email: string | null; phone: string | null }[];
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
    origine: p.origine || "",
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
    linkedinUrl: p.linkedinUrl || "",
    emailOptOut: p.emailOptOut,
    emailOptOutAt: p.emailOptOutAt,
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
    score: p.score,
    hotLeadTaskCreatedAt: p.hotLeadTaskCreatedAt,
    commercialName: p.commercial ? p.commercial.name || p.commercial.email : "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    journal: (p.activities || []).map(shapeActivity),
    // Un contact additionnel (CrmContact) peut porter l'email/téléphone que
    // le référent principal n'a pas — les filtres "Sans email"/"Sans
    // téléphone" (cf. crm.html filtered()) doivent en tenir compte plutôt
    // que de ne regarder que p.email/p.tel, sous peine de classer comme
    // "sans email" une fiche parfaitement joignable via un CrmContact.
    hasContactEmail: (p.contacts || []).some((c) => !!c.email?.trim()),
    hasContactPhone: (p.contacts || []).some((c) => !!c.phone?.trim()),
  };
}

const PROSPECT_INCLUDE = {
  entity: { select: { code: true, config: { select: { lang: true, currency: true, timezone: true } } } },
  activities: { orderBy: { createdAt: "asc" as const } },
  commercial: { select: { id: true, name: true, email: true } },
  contacts: { select: { email: true, phone: true } },
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
  origine?: string;
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
  linkedinUrl?: string;
  emailOptOut?: boolean;
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
    // "Suspect" = contact non qualifié (ex : badge de salon) — l'adresse
    // postale n'est pas toujours connue à ce stade, contrairement à un
    // Prospect/Client qu'on a déjà qualifié.
    if (b.type !== "Suspect") {
      if (!b.adresse || !b.adresse.trim()) throw new HttpError(400, "Adresse requise");
      if (!b.ville || !b.ville.trim()) throw new HttpError(400, "Ville requise");
    }
    const row = await prisma.crmProspect.create({
      data: {
        nom: b.nom.trim(),
        type: b.type || "Client",
        origine: b.origine,
        groupe: b.groupe,
        affiliations: normalizeAffiliations(b.affiliations),
        secteur: b.secteur,
        denominationSociale: b.denominationSociale,
        siret: b.siret,
        siren: b.siren,
        formeJuridique: b.formeJuridique,
        dateCreationEntreprise: b.dateCreationEntreprise ? new Date(b.dateCreationEntreprise) : undefined,
        effectifSalarie: b.effectifSalarie,
        adresse: b.adresse?.trim(),
        ville: b.ville?.trim(),
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
        linkedinUrl: b.linkedinUrl,
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

interface ImportRow {
  nom: string;
  origine?: string;
  secteur?: string;
  adresse?: string;
  ville?: string;
  pays?: string;
  lat?: number | null;
  lng?: number | null;
  referent?: string;
  email?: string;
  tel?: string;
  note?: string;
}

/**
 * POST /wa/crmProspect/importBulk — import en masse (ex : badges scannés sur
 * un salon, cf. public/crm.html panneau "Importer des suspects"). Toujours
 * type="Suspect" (adresse/ville jamais exigées, cf. /crmProspect/create) —
 * ne déclenche PAS crm.prospect_created (contrairement à une création
 * unitaire) : un envoi automatique déclenché par une automatisation sur 50+
 * contacts non qualifiés d'un coup serait une mauvaise surprise, la relance
 * doit rester une action volontaire une fois les fiches triées.
 */
crmProspectRouter.post(
  "/crmProspect/importBulk",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const rows = (req.body.rows as ImportRow[]) || [];
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Aucune ligne à importer");
    let created = 0;
    const errors: { index: number; reason: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.nom || !r.nom.trim()) {
        errors.push({ index: i, reason: "nom manquant" });
        continue;
      }
      try {
        await prisma.crmProspect.create({
          data: {
            nom: r.nom.trim(),
            type: "Suspect",
            origine: r.origine || undefined,
            secteur: r.secteur || undefined,
            adresse: r.adresse || undefined,
            ville: r.ville || undefined,
            pays: r.pays || undefined,
            lat: r.lat ?? undefined,
            lng: r.lng ?? undefined,
            referent: r.referent || undefined,
            email: r.email || undefined,
            tel: r.tel || undefined,
            note: r.note || undefined,
          },
        });
        created++;
      } catch (e) {
        errors.push({ index: i, reason: e instanceof Error ? e.message : "erreur inconnue" });
      }
    }
    res.status(201).json({ created, errors });
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
        origine: b.origine,
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
        linkedinUrl: b.linkedinUrl,
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
        // Bascule manuelle depuis la fiche (en plus du clic sur le lien de
        // désabonnement signé, cf. routes/unsubscribe.ts) — emailOptOutAt
        // tracé uniquement au moment du changement réel, pas réécrit si la
        // case cochée est renvoyée telle quelle à chaque sauvegarde du reste
        // de la fiche.
        ...(b.emailOptOut === undefined || b.emailOptOut === existing.emailOptOut
          ? {}
          : { emailOptOut: b.emailOptOut, emailOptOutAt: b.emailOptOut ? new Date() : null }),
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

/** POST /wa/crmProspect/bulkDelete — suppression multiple depuis la liste (cases à cocher, cf. public/crm.html crmToggleSelect). Chaque id inexistant est simplement ignoré plutôt que de faire échouer tout le lot. */
crmProspectRouter.post(
  "/crmProspect/bulkDelete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const ids = (req.body.ids as string[]) || [];
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids requis");
    const result = await prisma.crmProspect.deleteMany({ where: { id: { in: ids } } });
    res.json({ ok: true, deleted: result.count });
  })
);

/** Insensible aux accents/casse/espaces multiples — "Frédéric Buis" et
 * "Frederic Buis" doivent matcher comme même nom pour la détection de
 * doublons ci-dessous (cas réel constaté le 29/09/2026). */
function normalizeForDupMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * GET /wa/crmProspect/duplicates — groupes de fiches probablement
 * doublons : même email (exact, insensible à la casse) OU même nom
 * (insensible aux accents/casse/espaces). Union transitive : si A partage
 * son email avec B et B son nom avec C, les trois forment un seul groupe.
 * Détection large par nom demandée explicitement (29/09/2026) — attrape le
 * cas "Frédéric Buis" / "Frederic Buis" (emails différents) qu'un
 * rapprochement par email seul aurait raté, au prix de faux positifs
 * possibles (page de revue manuelle côté client, jamais de fusion
 * automatique sans confirmation).
 */
crmProspectRouter.get(
  "/crmProspect/duplicates",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmProspect.findMany({
      select: {
        id: true,
        nom: true,
        email: true,
        tel: true,
        ville: true,
        createdAt: true,
        subscriptionId: true,
        _count: { select: { activities: true, deals: true, contacts: true, tickets: true, scoreEvents: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // Union-Find sur l'index dans `rows`.
    const parent = rows.map((_, i) => i);
    function find(i: number): number {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a: number, b: number) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    const byEmail = new Map<string, number>();
    const byName = new Map<string, number>();
    rows.forEach((r, i) => {
      const emailKey = (r.email || "").trim().toLowerCase();
      if (emailKey) {
        const prev = byEmail.get(emailKey);
        if (prev !== undefined) union(prev, i); else byEmail.set(emailKey, i);
      }
      const nameKey = normalizeForDupMatch(r.nom);
      if (nameKey) {
        const prev = byName.get(nameKey);
        if (prev !== undefined) union(prev, i); else byName.set(nameKey, i);
      }
    });

    const groupsByRoot = new Map<number, number[]>();
    rows.forEach((_, i) => {
      const root = find(i);
      const arr = groupsByRoot.get(root) || [];
      arr.push(i);
      groupsByRoot.set(root, arr);
    });

    const groups = Array.from(groupsByRoot.values())
      .filter((idxs) => idxs.length > 1)
      .map((idxs) =>
        idxs
          .map((i) => {
            const r = rows[i];
            return {
              id: r.id,
              nom: r.nom,
              email: r.email,
              tel: r.tel,
              ville: r.ville,
              createdAt: r.createdAt,
              hasSubscription: !!r.subscriptionId,
              counts: {
                activities: r._count.activities,
                deals: r._count.deals,
                contacts: r._count.contacts,
                tickets: r._count.tickets,
                scoreEvents: r._count.scoreEvents,
              },
            };
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      );

    res.json({ groups });
  })
);

/**
 * POST /wa/crmProspect/merge — fusionne mergeIds dans keepId : réattache
 * tout ce qui pointe vers les fiches fusionnées (contacts, affaires
 * [entraîne leurs devis], activités, événements de score, tickets [entraîne
 * leurs messages]) puis les supprime. Cas particuliers gérés sans jamais
 * perdre de données silencieusement :
 *   - AccCustomer (compta) : réattaché seulement si keepId n'en a pas déjà
 *     un (crmProspectId est unique) — sinon laissé tel quel, à traiter à la
 *     main (rare : suppose deux comptes clients comptables distincts).
 *   - QuestionnaireSend : réattaché sauf si keepId a déjà répondu au MÊME
 *     questionnaire (contrainte unique questionnaireId+targetType+targetId)
 *     — dans ce cas l'envoi du doublon (et ses réponses) est supprimé
 *     plutôt que de faire échouer toute la fusion.
 *   - Abonnement (subscriptionId, 1:1) : repris par keepId seulement s'il
 *     n'en a pas déjà un.
 */
crmProspectRouter.post(
  "/crmProspect/merge",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { keepId?: string; mergeIds?: string[] };
    const keepId = (b.keepId || "").trim();
    const mergeIds = Array.isArray(b.mergeIds) ? b.mergeIds.filter((id) => id && id !== keepId) : [];
    if (!keepId) throw new HttpError(400, "keepId requis");
    if (!mergeIds.length) throw new HttpError(400, "mergeIds requis (au moins une fiche à fusionner)");

    const keep = await prisma.crmProspect.findUnique({ where: { id: keepId } });
    if (!keep) throw new HttpError(404, "Fiche à conserver introuvable");
    const toMerge = await prisma.crmProspect.findMany({ where: { id: { in: mergeIds } } });
    if (toMerge.length !== mergeIds.length) throw new HttpError(404, "Une ou plusieurs fiches à fusionner sont introuvables");

    const summary = { contacts: 0, deals: 0, activities: 0, scoreEvents: 0, tickets: 0, accCustomers: 0, questionnaireSends: 0, subscription: false };

    await prisma.$transaction(async (tx) => {
      let keepSubscriptionId = keep.subscriptionId;

      for (const dup of toMerge) {
        const [contacts, deals, activities, scoreEvents, tickets] = await Promise.all([
          tx.crmContact.updateMany({ where: { prospectId: dup.id }, data: { prospectId: keepId } }),
          tx.crmDeal.updateMany({ where: { prospectId: dup.id }, data: { prospectId: keepId } }),
          tx.crmActivity.updateMany({ where: { prospectId: dup.id }, data: { prospectId: keepId } }),
          tx.crmScoreEvent.updateMany({ where: { prospectId: dup.id }, data: { prospectId: keepId } }),
          tx.crmTicket.updateMany({ where: { prospectId: dup.id }, data: { prospectId: keepId } }),
        ]);
        summary.contacts += contacts.count;
        summary.deals += deals.count;
        summary.activities += activities.count;
        summary.scoreEvents += scoreEvents.count;
        summary.tickets += tickets.count;

        const dupAccCustomer = await tx.accCustomer.findUnique({ where: { crmProspectId: dup.id } });
        if (dupAccCustomer) {
          const keepAlreadyHas = await tx.accCustomer.findUnique({ where: { crmProspectId: keepId } });
          if (!keepAlreadyHas) {
            await tx.accCustomer.update({ where: { id: dupAccCustomer.id }, data: { crmProspectId: keepId } });
            summary.accCustomers += 1;
          }
        }

        const dupSends = await tx.questionnaireSend.findMany({ where: { targetType: "crmProspect", targetId: dup.id } });
        for (const send of dupSends) {
          const keepAlreadyHas = await tx.questionnaireSend.findUnique({
            where: { questionnaireId_targetType_targetId: { questionnaireId: send.questionnaireId, targetType: "crmProspect", targetId: keepId } },
          });
          if (keepAlreadyHas) {
            await tx.questionnaireSend.delete({ where: { id: send.id } });
          } else {
            await tx.questionnaireSend.update({ where: { id: send.id }, data: { targetId: keepId } });
            summary.questionnaireSends += 1;
          }
        }

        if (dup.subscriptionId && !keepSubscriptionId) {
          keepSubscriptionId = dup.subscriptionId;
          summary.subscription = true;
        }
      }

      if (keepSubscriptionId !== keep.subscriptionId) {
        await tx.crmProspect.update({ where: { id: keepId }, data: { subscriptionId: keepSubscriptionId } });
      }

      await tx.crmProspect.deleteMany({ where: { id: { in: mergeIds } } });
    });

    res.json({ ok: true, keepId, mergedIds: mergeIds, summary });
  })
);

// Statuts considérés "terminés" pour un ticket — ceux qui n'ont plus besoin
// d'aucun suivi actif. Distinct de TICKET_STATUSES (crm.html) mais reflète
// les mêmes libellés.
const RESOLVED_TICKET_STATUSES = ["Résolu", "Fermé"];

/**
 * POST /wa/crmProspect/requalifyAsContact — corrige une fiche créée par
 * erreur en tant que fiche "Client" complète alors qu'il s'agit en réalité
 * d'un simple interlocuteur d'un client déjà existant (ex : recherche par
 * nom de personne, qui crée une fiche société au lieu d'ajouter un contact
 * sur la bonne fiche). Convertit (nom/email/tel → CrmContact rattaché au
 * client cible) puis supprime la fiche d'origine.
 *
 * Refuse si la fiche d'origine porte déjà des données propres (activités,
 * affaires, contacts additionnels, abonnement, ou tickets encore OUVERTS)
 * — la supprimer perdrait cet historique sans recours, alors qu'une fiche
 * tout juste créée par erreur n'en a par construction aucun. Les tickets
 * déjà résolus/fermés ne bloquent PAS la requalification (22/09/2026) :
 * plus rien à suivre dessus, mais leur historique reste utile — ils sont
 * donc réaffectés à la fiche cible plutôt que perdus (jamais supprimés en
 * silence, contrairement au reste qui bloque tant qu'il n'a pas été traité
 * à la main).
 */
crmProspectRouter.post(
  "/crmProspect/requalifyAsContact",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { id?: string; targetProspectId?: string; fonction?: string };
    const id = (b.id || "").trim();
    const targetProspectId = (b.targetProspectId || "").trim();
    if (!id || !targetProspectId) throw new HttpError(400, "id et targetProspectId requis");
    if (id === targetProspectId) throw new HttpError(400, "Impossible de requalifier une fiche vers elle-même");

    const source = await prisma.crmProspect.findUnique({
      where: { id },
      include: {
        _count: { select: { activities: true, deals: true, contacts: true } },
        tickets: { select: { id: true, status: true } },
      },
    });
    if (!source) throw new HttpError(404, "Fiche à requalifier introuvable");
    const target = await prisma.crmProspect.findUnique({ where: { id: targetProspectId } });
    if (!target) throw new HttpError(404, "Client cible introuvable");

    const openTickets = source.tickets.filter((t) => !RESOLVED_TICKET_STATUSES.includes(t.status));
    const resolvedTickets = source.tickets.filter((t) => RESOLVED_TICKET_STATUSES.includes(t.status));

    const blockers: string[] = [];
    if (source._count.activities > 0) blockers.push(`${source._count.activities} activité(s)`);
    if (openTickets.length > 0) blockers.push(`${openTickets.length} ticket(s) encore ouvert(s)`);
    if (source._count.deals > 0) blockers.push(`${source._count.deals} affaire(s)`);
    if (source._count.contacts > 0) blockers.push(`${source._count.contacts} contact(s) additionnel(s)`);
    if (source.subscriptionId) blockers.push("un abonnement lié");
    if (blockers.length) {
      throw new HttpError(400, `Cette fiche porte déjà ${blockers.join(", ")} — traitez-les d'abord (déplacez ou supprimez), sinon la requalification les perdrait définitivement.`);
    }

    const contact = await prisma.$transaction(async (tx) => {
      if (resolvedTickets.length) {
        await tx.crmTicket.updateMany({
          where: { id: { in: resolvedTickets.map((t) => t.id) } },
          data: { prospectId: targetProspectId },
        });
      }
      const created = await tx.crmContact.create({
        data: {
          prospectId: targetProspectId,
          name: source.nom,
          fonction: (b.fonction || "").trim() || null,
          email: source.email || null,
          phone: source.tel || null,
        },
      });
      await tx.crmProspect.delete({ where: { id } });
      return created;
    });

    res.json({ ok: true, contact, targetProspectId, reassignedTickets: resolvedTickets.length });
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

/**
 * GET /wa/crmProspect/:id/accounting — détail comptable (factures,
 * règlements, prélèvements GoCardless) affiché sur la fiche client CRM.
 * AccCustomer (module compta) et CrmProspect (module CRM) sont deux
 * modèles historiquement indépendants sans lien entre eux — sans cette
 * route, la fiche client n'avait AUCUN moyen d'afficher ces données même
 * quand elles existent côté compta (constaté 22/09/2026). Rapproche
 * AccCustomer.crmProspectId au premier accès — SIRET > SIREN > email
 * (insensible à la casse), même ordre que lib/accCustomerMatching.ts —
 * et le fige ensuite, même convention que gocardlessCustomerId (cf.
 * lib/gocardless.ts matchOrCreateCustomer). Couvre aussi bien une fiche
 * AccCustomer créée après ce rapprochement automatique (30/09/2026, SIRET
 * absent ou différemment formaté à l'extraction, cf. POST
 * /crmProspect/:id/accounting/link pour un rattachement manuel quand
 * cette recherche échoue) qu'une fiche plus ancienne jamais retentée
 * depuis. Ne crée jamais de fiche AccCustomer : sans correspondance,
 * retourne simplement linked:false plutôt que de polluer le module
 * compta avec une fiche vide.
 */
crmProspectRouter.get(
  "/crmProspect/:id/accounting",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospect = await prisma.crmProspect.findUnique({ where: { id: req.params.id } });
    if (!prospect) throw new HttpError(404, "Fiche introuvable");

    let customer = await prisma.accCustomer.findUnique({ where: { crmProspectId: prospect.id } });
    if (!customer) {
      const wheres = [
        prospect.siret ? { entityId: prospect.entityId, crmProspectId: null, siret: prospect.siret } : null,
        prospect.siren ? { entityId: prospect.entityId, crmProspectId: null, siren: prospect.siren } : null,
        prospect.email ? { entityId: prospect.entityId, crmProspectId: null, email: { equals: prospect.email, mode: "insensitive" as const } } : null,
      ].filter((w): w is NonNullable<typeof w> => w !== null);
      for (const where of wheres) {
        const candidate = await prisma.accCustomer.findFirst({ where });
        if (candidate) {
          customer = await prisma.accCustomer.update({ where: { id: candidate.id }, data: { crmProspectId: prospect.id } });
          break;
        }
      }
    }
    if (!customer) {
      res.json({ linked: false });
      return;
    }

    const invoices = await prisma.accInvoice.findMany({
      where: { customerId: customer.id },
      orderBy: { invoiceDate: "desc" },
      select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, status: true, amountHt: true, amountVat: true, amountTtc: true, amountPaid: true, currency: true },
    });
    const payments = await prisma.accBankMatch.findMany({
      where: { invoice: { customerId: customer.id } },
      include: { bankTransaction: { select: { operationDate: true, rawLabel: true } }, invoice: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: "desc" },
    });
    const gocardlessPayments = await prisma.accGoCardlessPayment.findMany({
      where: { customerId: customer.id },
      include: { payout: { select: { id: true, status: true, arrivalDate: true, bankTransactionId: true } } },
      orderBy: { chargeDate: "desc" },
    });

    let totalHt = 0, totalTtc = 0, totalPaid = 0;
    for (const inv of invoices) {
      totalHt += inv.amountHt || 0;
      totalTtc += invoiceTotal(inv);
      totalPaid += inv.amountPaid || 0;
    }

    res.json({
      linked: true,
      customerId: customer.id,
      customerName: customer.name,
      customerCountry: customer.country,
      position: { totalHt, totalTtc, totalPaid, balanceDue: Math.max(0, totalTtc - totalPaid) },
      invoices,
      payments,
      gocardlessPayments,
    });
  })
);

/**
 * POST /wa/crmProspect/:id/accounting/link — rattachement manuel à une
 * fiche AccCustomer existante (30/09/2026, demande client : le
 * rapprochement automatique par SIRET/SIREN/email échoue parfois — SIRET
 * absent du document, formaté différemment, fiche compta créée avant
 * qu'un identifiant fort n'ait été saisi... — sans bloquer la mise à jour
 * manuelle par un compte "sesame" qui sait, lui, quelle fiche compta
 * correspond). Refuse un AccCustomer déjà lié à une AUTRE fiche CRM
 * (crmProspectId unique) plutôt que de lui voler discrètement son lien.
 */
crmProspectRouter.post(
  "/crmProspect/:id/accounting/link",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospect = await prisma.crmProspect.findUnique({ where: { id: req.params.id } });
    if (!prospect) throw new HttpError(404, "Fiche introuvable");
    const accCustomerId = req.body?.accCustomerId as string | undefined;
    if (!accCustomerId) throw new HttpError(400, "accCustomerId requis");
    const customer = await prisma.accCustomer.findUnique({ where: { id: accCustomerId } });
    if (!customer) throw new HttpError(404, "Compte client introuvable");
    if (customer.crmProspectId && customer.crmProspectId !== prospect.id) {
      throw new HttpError(400, "Ce compte client est déjà rattaché à une autre fiche CRM");
    }
    const updated = await prisma.accCustomer.update({ where: { id: customer.id }, data: { crmProspectId: prospect.id } });
    res.json({ ok: true, customerId: updated.id, customerName: updated.name });
  })
);

/** POST /wa/crmProspect/:id/accounting/unlink — détache le compte client rattaché (rapprochement automatique ou manuel erroné). */
crmProspectRouter.post(
  "/crmProspect/:id/accounting/unlink",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospect = await prisma.crmProspect.findUnique({ where: { id: req.params.id } });
    if (!prospect) throw new HttpError(404, "Fiche introuvable");
    const customer = await prisma.accCustomer.findUnique({ where: { crmProspectId: prospect.id } });
    if (customer) await prisma.accCustomer.update({ where: { id: customer.id }, data: { crmProspectId: null } });
    res.json({ ok: true });
  })
);
