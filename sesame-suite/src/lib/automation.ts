import { prisma } from "../db";
import { sendMessage } from "./messaging";
import { Channel } from "./messageTemplate";
import { todayInTz } from "./timezone";

/**
 * Catalogue fixe des déclencheurs métier — c'est la seule source de vérité
 * (le front-end CRM/admin lit cette même liste, dupliquée côté client pour
 * peupler les menus déroulants ; toute évolution doit être répercutée aux
 * deux endroits). "immediate" est déclenché en synchrone depuis la route
 * concernée via fireTrigger() ; "offset"/"recurring" sont balayés
 * périodiquement par automationScheduler.ts.
 *
 * "offset" remplace les anciens modes séparés "before"/"after" : un seul
 * déclencheur par date pivot (ex. "Début de séjour"), le sens
 * avant/après étant porté par le SIGNE d'AutomationRule.offsetValue
 * (négatif = avant, positif = après — ex. "J-5", "H-10", "M+1") plutôt que
 * fixé dans le catalogue. C'est ce qui permet d'harmoniser la
 * paramétrisation temporelle entre hôtel et CRM alors que les déclencheurs
 * eux-mêmes restent différents (dates de séjour vs fin d'essai).
 */
export interface TriggerDef {
  key: string;
  label: string;
  scope: "hotel" | "crm";
  timingModes: Array<"immediate" | "offset" | "recurring">;
  dateField?: "startDate" | "endDate" | "trialEnd"; // requis pour "offset"
  targetModel?: "booking" | "subscription"; // source balayée pour "offset" — défaut "booking"
}

export const TRIGGERS: TriggerDef[] = [
  { key: "booking.created", label: "Réservation créée", scope: "hotel", timingModes: ["immediate"] },
  { key: "checkin.completed", label: "Check-in effectué", scope: "hotel", timingModes: ["immediate"] },
  { key: "order.created", label: "Commande créée (room service / boutique)", scope: "hotel", timingModes: ["immediate"] },
  { key: "order.delivered", label: "Commande livrée", scope: "hotel", timingModes: ["immediate"] },
  { key: "order.cancelled", label: "Commande annulée", scope: "hotel", timingModes: ["immediate"] },
  { key: "stay.start", label: "Début de séjour", scope: "hotel", timingModes: ["offset"], dateField: "startDate" },
  { key: "stay.end", label: "Fin de séjour", scope: "hotel", timingModes: ["offset"], dateField: "endDate" },
  { key: "crm.prospect_created", label: "Nouveau prospect CRM", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.contract_signed", label: "Contrat signé", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.subscription_activated", label: "Souscription activée", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.subscription_cancelled", label: "Souscription annulée", scope: "crm", timingModes: ["immediate"] },
  {
    key: "crm.subscription_trial_ending",
    label: "Fin d'essai souscription",
    scope: "crm",
    timingModes: ["offset"],
    dateField: "trialEnd",
    targetModel: "subscription",
  },
  { key: "crm.newsletter", label: "Newsletter récurrente", scope: "crm", timingModes: ["recurring"] },
  { key: "crm.ticket_created", label: "Nouveau ticket support", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.ticket_client_replied", label: "Client a répondu à un ticket", scope: "crm", timingModes: ["immediate"] },
];

export function getTrigger(key: string) {
  return TRIGGERS.find((t) => t.key === key);
}

interface FireContext {
  entityId: string | null;
  targetType: string;
  targetId: string;
  recipient: { email?: string | null; phone?: string | null };
  variables: Record<string, string>;
}

/**
 * Destinataire réel d'un envoi : par défaut celui de l'événement (client de
 * la réservation, prospect du CRM…) ; "custom" cible une adresse/numéro fixe
 * saisi sur la règle — utile pour notifier l'équipe (ex: réception) plutôt
 * que le client sur un déclencheur comme "order.created".
 */
function resolveRecipient(
  rule: { channel: string; recipientMode: string; recipientOverride: string | null },
  eventEmail?: string | null,
  eventPhone?: string | null
): string | null {
  if (rule.recipientMode === "custom") return rule.recipientOverride || null;
  return rule.channel === "email" ? eventEmail || null : eventPhone || null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sans ça, un échec d'envoi (SMTP mal configuré, modèle introuvable…)
 * n'était visible que dans les logs serveur — la règle semblait "ne rien
 * faire" côté utilisateur, sans aucun moyen de savoir pourquoi. Appelé dans
 * chaque catch ; recordRuleSuccess efface l'erreur à la prochaine réussite
 * pour ne jamais afficher un échec périmé.
 */
async function recordRuleError(ruleId: string, err: unknown) {
  try {
    await prisma.automationRule.update({ where: { id: ruleId }, data: { lastError: errMessage(err), lastErrorAt: new Date() } });
  } catch (e) {
    console.error(`[automation] échec de l'enregistrement de l'erreur pour la règle ${ruleId}:`, e);
  }
}

async function recordRuleSuccess(ruleId: string) {
  await prisma.automationRule.update({ where: { id: ruleId }, data: { lastRunAt: new Date(), lastError: null, lastErrorAt: null } });
}

/**
 * Déclenchement immédiat — appelé depuis les routes métier (booking.ts,
 * roomservice.ts, crmProspect.ts…). Ne doit JAMAIS faire échouer l'appelant :
 * chaque règle est traitée dans son propre try/catch, une erreur d'envoi est
 * journalisée mais n'interrompt ni les autres règles ni le flux appelant.
 * Les appelants utilisent donc fireTrigger(...).catch(...) sans bloquer sur
 * l'envoi (latence SMTP/Twilio hors du chemin critique de la requête).
 */
export async function fireTrigger(triggerKey: string, ctx: FireContext): Promise<void> {
  let rules;
  try {
    rules = await prisma.automationRule.findMany({
      where: { entityId: ctx.entityId, trigger: triggerKey, enabled: true, timingMode: "immediate" },
    });
  } catch (err) {
    console.error(`[automation] lecture des règles échouée pour "${triggerKey}":`, err);
    return;
  }

  for (const rule of rules) {
    const to = resolveRecipient(rule, ctx.recipient.email, ctx.recipient.phone);
    if (!to) {
      // Cas fréquent et jusqu'ici invisible : la fiche à l'origine de l'événement
      // n'a pas d'email/téléphone renseigné pour le canal choisi — la règle
      // "ne fait rien" sans qu'aucune erreur d'envoi ne se produise. On le
      // signale quand même via lastError pour que ça reste diagnosticable.
      await recordRuleError(
        rule.id,
        new Error(
          rule.channel === "email"
            ? "Aucun envoi : l'adresse email est vide sur la fiche à l'origine de l'événement."
            : "Aucun envoi : le numéro de mobile est vide sur la fiche à l'origine de l'événement."
        )
      );
      continue;
    }
    try {
      const already = await prisma.automationRuleLog.findUnique({
        where: { ruleId_targetType_targetId: { ruleId: rule.id, targetType: ctx.targetType, targetId: ctx.targetId } },
      });
      if (already) continue;
      await sendMessage({
        entityId: ctx.entityId,
        channel: rule.channel as Channel,
        templateKey: rule.templateKey,
        to,
        variables: ctx.variables,
        fromNameOverride: rule.senderName || undefined,
      });
      await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: ctx.targetType, targetId: ctx.targetId } });
      await recordRuleSuccess(rule.id);
    } catch (err) {
      console.error(`[automation] échec de la règle "${rule.name}" (${triggerKey}):`, err);
      await recordRuleError(rule.id, err);
    }
  }
}

// ── Balayage périodique — offset (dates pivot) + recurring (newsletter) ──

const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
const LOOKBACK_MS = 7 * MS.days; // fenêtre de sécurité : on ne rebalaye jamais tout l'historique

/**
 * Décale une date d'une valeur signée dans l'unité donnée — "months" utilise
 * l'arithmétique calendaire (durée variable selon le mois), les autres
 * unités des millisecondes fixes.
 */
/**
 * Fuseau horaire de l'établissement pour une règle donnée — "Europe/Paris"
 * par défaut si la règle est de portée CRM (entityId null) ou si la
 * configuration est introuvable.
 */
async function entityTimezone(entityId: string | null): Promise<string> {
  if (!entityId) return "Europe/Paris";
  const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId }, select: { timezone: true } });
  return cfg?.timezone || "Europe/Paris";
}

function applyOffset(date: Date, value: number, unit: string | null): Date {
  if (unit === "months") {
    const d = new Date(date);
    d.setMonth(d.getMonth() + value);
    return d;
  }
  const ms = MS[(unit as keyof typeof MS) || "days"] ?? MS.days;
  return new Date(date.getTime() + value * ms);
}

/**
 * Offset signé de la règle — négatif = avant la date pivot, positif =
 * après (ex. "J-5" → -5, "M+1" → +1). Rétro-compatibilité : d'anciennes
 * règles peuvent encore porter timingMode "before"/"after" (ancien système
 * à deux modes séparés, remplacé par "offset" au signe porté par
 * offsetValue) — on les ramène ici à un offset signé équivalent sans avoir
 * à les migrer en base.
 */
function signedOffset(rule: { timingMode: string; offsetValue: number | null }): number {
  const v = rule.offsetValue ?? 0;
  if (rule.timingMode === "before") return -Math.abs(v);
  if (rule.timingMode === "after") return Math.abs(v);
  return v;
}

async function sweepDateRule(rule: {
  id: string;
  name: string;
  entityId: string | null;
  trigger: string;
  timingMode: string;
  offsetValue: number | null;
  offsetUnit: string | null;
  channel: string;
  templateKey: string;
  recipientMode: string;
  recipientOverride: string | null;
  senderName: string | null;
}) {
  const trigger = getTrigger(rule.trigger);
  if (!trigger?.dateField) return;
  // Pour un offset en jours/mois ("J-1 avant arrivée"…), on ancre le calcul
  // sur le jour calendaire actuel à l'hôtel plutôt que sur l'heure serveur —
  // sinon un serveur en UTC peut faire glisser la cible d'un jour selon le
  // fuseau de l'établissement. Les offsets en heures/minutes restent
  // calculés sur l'instant précis (une notion sans ambiguïté de fuseau).
  const unit = rule.offsetUnit || "days";
  const now =
    unit === "days" || unit === "months"
      ? new Date(`${todayInTz(await entityTimezone(rule.entityId))}T12:00:00Z`)
      : new Date();
  // La règle se déclenche dès que la date pivot atteint "target" — cible
  // unique quel que soit le signe de l'offset (avant/après unifiés).
  const target = applyOffset(now, -signedOffset(rule), rule.offsetUnit);
  const range = { lte: target, gte: new Date(target.getTime() - LOOKBACK_MS) };

  let bookings;
  try {
    bookings = await prisma.booking.findMany({ where: { entityId: rule.entityId!, [trigger.dateField]: range } });
  } catch (err) {
    console.error(`[automation] lecture des réservations échouée pour la règle "${rule.name}":`, err);
    return;
  }

  for (const b of bookings) {
    const to = resolveRecipient(rule, b.personEmail, b.personPhone);
    if (!to) continue;
    try {
      const already = await prisma.automationRuleLog.findUnique({
        where: { ruleId_targetType_targetId: { ruleId: rule.id, targetType: "booking", targetId: b.id } },
      });
      if (already) continue;
      await sendMessage({
        entityId: rule.entityId,
        channel: rule.channel as Channel,
        templateKey: rule.templateKey,
        to,
        variables: { prenom: b.personFirstname, nom: b.personLastname, code: b.code },
        fromNameOverride: rule.senderName || undefined,
      });
      await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "booking", targetId: b.id } });
      await recordRuleSuccess(rule.id);
    } catch (err) {
      console.error(`[automation] échec de la règle "${rule.name}" pour la réservation ${b.code}:`, err);
      await recordRuleError(rule.id, err);
    }
  }
}

/**
 * Variante de sweepDateRule() pour les règles CRM portant sur la date de fin
 * d'essai d'une souscription (ex: relance 1 jour avant la fin d'essai) —
 * modèle Subscription, pas Booking, donc mapping de champs différent
 * (contactEmail/contactPhone) et filtré sur les essais encore en cours.
 */
async function sweepSubscriptionTrialRule(rule: {
  id: string;
  name: string;
  timingMode: string;
  offsetValue: number | null;
  offsetUnit: string | null;
  channel: string;
  templateKey: string;
  recipientMode: string;
  recipientOverride: string | null;
  senderName: string | null;
}) {
  const now = new Date();
  const target = applyOffset(now, -signedOffset(rule), rule.offsetUnit);
  const range = { lte: target, gte: new Date(target.getTime() - LOOKBACK_MS) };

  let subs;
  try {
    subs = await prisma.subscription.findMany({ where: { status: "trial", trialEnd: range } });
  } catch (err) {
    console.error(`[automation] lecture des souscriptions échouée pour la règle "${rule.name}":`, err);
    return;
  }

  for (const s of subs) {
    const to = resolveRecipient(rule, s.contactEmail, s.contactPhone);
    if (!to) continue;
    try {
      const already = await prisma.automationRuleLog.findUnique({
        where: { ruleId_targetType_targetId: { ruleId: rule.id, targetType: "subscription", targetId: s.id } },
      });
      if (already) continue;
      await sendMessage({
        entityId: null,
        channel: rule.channel as Channel,
        templateKey: rule.templateKey,
        to,
        variables: { nom: s.hotelName, secteur: "" },
        fromNameOverride: rule.senderName || undefined,
      });
      await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "subscription", targetId: s.id } });
      await recordRuleSuccess(rule.id);
    } catch (err) {
      console.error(`[automation] échec de la règle "${rule.name}" pour la souscription ${s.hotelName}:`, err);
      await recordRuleError(rule.id, err);
    }
  }
}

function isRecurringDueThisHour(rule: { recurrence: string | null; atTime: string | null; dayOfWeek: number | null; dayOfMonth: number | null }, now: Date): boolean {
  const [h] = (rule.atTime || "09:00").split(":").map(Number);
  if (now.getHours() !== h) return false;
  if (rule.recurrence === "daily") return true;
  if (rule.recurrence === "weekly") return now.getDay() === (rule.dayOfWeek ?? 1);
  if (rule.recurrence === "monthly") return now.getDate() === (rule.dayOfMonth ?? 1);
  return false;
}

function periodBucketKey(now: Date): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

interface AudienceFilter {
  type?: "Prospect" | "Client" | "all";
  secteur?: string;
}

async function sweepRecurringRule(rule: {
  id: string;
  name: string;
  recurrence: string | null;
  atTime: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  channel: string;
  templateKey: string;
  audienceFilter: unknown;
  recipientMode: string;
  recipientOverride: string | null;
  senderName: string | null;
}) {
  const now = new Date();
  if (!isRecurringDueThisHour(rule, now)) return;

  const periodKey = periodBucketKey(now);
  const already = await prisma.automationRuleLog.findUnique({
    where: { ruleId_targetType_targetId: { ruleId: rule.id, targetType: "period", targetId: periodKey } },
  });
  if (already) return;

  // "custom" ici = envoi de test à une adresse/numéro fixe plutôt qu'à toute
  // l'audience — pratique pour vérifier une newsletter avant de l'ouvrir au
  // segment réel.
  if (rule.recipientMode === "custom") {
    const to = rule.recipientOverride;
    if (to) {
      try {
        await sendMessage({
          entityId: null,
          channel: rule.channel as Channel,
          templateKey: rule.templateKey,
          to,
          variables: { nom: "", secteur: "" },
          fromNameOverride: rule.senderName || undefined,
        });
        await recordRuleSuccess(rule.id);
      } catch (err) {
        console.error(`[automation] échec d'envoi (destinataire personnalisé) pour la règle "${rule.name}":`, err);
        await recordRuleError(rule.id, err);
      }
    }
    await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "period", targetId: periodKey } });
    return;
  }

  const filter = (rule.audienceFilter || {}) as AudienceFilter;
  const where: Record<string, unknown> = rule.channel === "email" ? { email: { not: null } } : { tel: { not: null } };
  if (filter.type && filter.type !== "all") where.type = filter.type;
  if (filter.secteur) where.secteur = filter.secteur;

  let prospects;
  try {
    prospects = await prisma.crmProspect.findMany({ where });
  } catch (err) {
    console.error(`[automation] lecture de l'audience échouée pour la règle "${rule.name}":`, err);
    return;
  }

  let anySent = false;
  let lastErr: unknown = null;
  for (const p of prospects) {
    const to = rule.channel === "email" ? p.email : p.tel;
    if (!to) continue;
    try {
      await sendMessage({
        entityId: null,
        channel: rule.channel as Channel,
        templateKey: rule.templateKey,
        to,
        variables: { nom: p.nom, secteur: p.secteur || "" },
        fromNameOverride: rule.senderName || undefined,
      });
      anySent = true;
    } catch (err) {
      console.error(`[automation] échec d'envoi newsletter à ${p.nom} (règle "${rule.name}"):`, err);
      lastErr = err;
    }
  }

  // Newsletter = plusieurs envois individuels : on ne fait pas remonter
  // l'échec d'un seul destinataire (adresse invalide isolée), seulement si
  // AUCUN envoi n'a abouti alors qu'il y avait une audience à contacter —
  // sinon "lastError" masquerait une campagne qui a globalement réussi (ou
  // une audience simplement vide, qui n'est pas un échec).
  if (lastErr && !anySent && prospects.length > 0) await recordRuleError(rule.id, lastErr);
  else await recordRuleSuccess(rule.id);

  await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "period", targetId: periodKey } });
}

/** Appelé périodiquement par automationScheduler.ts. */
export async function runAutomationSweep() {
  let rules;
  try {
    // "before"/"after" restent listés pour rester compatibles avec d'éventuelles
    // règles déjà enregistrées sous l'ancien système à deux modes séparés.
    rules = await prisma.automationRule.findMany({ where: { enabled: true, timingMode: { in: ["before", "after", "offset", "recurring"] } } });
  } catch (err) {
    console.error("[automation] lecture des règles échouée pendant le balayage:", err);
    return;
  }
  for (const rule of rules) {
    if (rule.timingMode === "recurring") await sweepRecurringRule(rule);
    else if (getTrigger(rule.trigger)?.targetModel === "subscription") await sweepSubscriptionTrialRule(rule);
    else await sweepDateRule(rule);
  }
}
