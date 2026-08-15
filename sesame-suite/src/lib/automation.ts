import { prisma } from "../db";
import { sendMessage } from "./messaging";
import { Channel } from "./messageTemplate";

/**
 * Catalogue fixe des déclencheurs métier — c'est la seule source de vérité
 * (le front-end CRM/admin lit cette même liste, dupliquée côté client pour
 * peupler les menus déroulants ; toute évolution doit être répercutée aux
 * deux endroits). "immediate" est déclenché en synchrone depuis la route
 * concernée via fireTrigger() ; "before"/"after"/"recurring" sont balayés
 * périodiquement par automationScheduler.ts.
 */
export interface TriggerDef {
  key: string;
  label: string;
  scope: "hotel" | "crm";
  timingModes: Array<"immediate" | "before" | "after" | "recurring">;
  dateField?: "startDate" | "endDate"; // Booking — requis pour before/after
}

export const TRIGGERS: TriggerDef[] = [
  { key: "booking.created", label: "Réservation créée", scope: "hotel", timingModes: ["immediate"] },
  { key: "checkin.completed", label: "Check-in effectué", scope: "hotel", timingModes: ["immediate"] },
  { key: "order.created", label: "Commande créée (room service / boutique)", scope: "hotel", timingModes: ["immediate"] },
  { key: "order.delivered", label: "Commande livrée", scope: "hotel", timingModes: ["immediate"] },
  { key: "stay.before_checkin", label: "Avant l'arrivée", scope: "hotel", timingModes: ["before"], dateField: "startDate" },
  { key: "stay.before_checkout", label: "Avant le départ", scope: "hotel", timingModes: ["before"], dateField: "endDate" },
  { key: "stay.after_checkout", label: "Après le départ", scope: "hotel", timingModes: ["after"], dateField: "endDate" },
  { key: "crm.prospect_created", label: "Nouveau prospect CRM", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.contract_signed", label: "Contrat signé", scope: "crm", timingModes: ["immediate"] },
  { key: "crm.newsletter", label: "Newsletter récurrente", scope: "crm", timingModes: ["recurring"] },
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
    if (!to) continue; // pas de coordonnée pour ce canal sur cette cible — ignoré silencieusement
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
      await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
    } catch (err) {
      console.error(`[automation] échec de la règle "${rule.name}" (${triggerKey}):`, err);
    }
  }
}

// ── Balayage périodique — before/after (dates de séjour) + recurring (newsletter) ──

const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
const LOOKBACK_MS = 7 * MS.days; // fenêtre de sécurité : on ne rebalaye jamais tout l'historique

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
  const offsetMs = (rule.offsetValue ?? 0) * (MS[(rule.offsetUnit as keyof typeof MS) || "days"] ?? MS.days);
  const now = Date.now();

  const range =
    rule.timingMode === "before"
      ? { lte: new Date(now + offsetMs), gte: new Date(now - LOOKBACK_MS) }
      : { lte: new Date(now - offsetMs), gte: new Date(now - offsetMs - LOOKBACK_MS) };

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
      await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
    } catch (err) {
      console.error(`[automation] échec de la règle "${rule.name}" pour la réservation ${b.code}:`, err);
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
      } catch (err) {
        console.error(`[automation] échec d'envoi (destinataire personnalisé) pour la règle "${rule.name}":`, err);
      }
    }
    await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "period", targetId: periodKey } });
    await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: now } });
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
    } catch (err) {
      console.error(`[automation] échec d'envoi newsletter à ${p.nom} (règle "${rule.name}"):`, err);
    }
  }

  await prisma.automationRuleLog.create({ data: { ruleId: rule.id, targetType: "period", targetId: periodKey } });
  await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: now } });
}

/** Appelé périodiquement par automationScheduler.ts. */
export async function runAutomationSweep() {
  let rules;
  try {
    rules = await prisma.automationRule.findMany({ where: { enabled: true, timingMode: { in: ["before", "after", "recurring"] } } });
  } catch (err) {
    console.error("[automation] lecture des règles échouée pendant le balayage:", err);
    return;
  }
  for (const rule of rules) {
    if (rule.timingMode === "recurring") await sweepRecurringRule(rule);
    else await sweepDateRule(rule);
  }
}
