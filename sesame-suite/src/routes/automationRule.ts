import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { getTrigger } from "../lib/automation";
import { sendMessage } from "../lib/messaging";
import { Channel } from "../lib/messageTemplate";

/**
 * CRUD des règles d'automatisation — mêmes endpoints partagés par le CRM
 * (?scope=crm, déclencheurs "crm.*") et le back-office de chaque hôtel
 * (portée par défaut, déclencheurs "booking.*"/"checkin.*"/"order.*"/"stay.*").
 */
export const automationRuleRouter = Router();

function shapeRule(r: {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
  timingMode: string;
  offsetValue: number | null;
  offsetUnit: string | null;
  recurrence: string | null;
  atTime: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  channel: string;
  templateKey: string;
  recipientMode: string;
  recipientOverride: string | null;
  senderName: string | null;
  audienceFilter: unknown;
  questionnaireId: string | null;
  repeatEnabled: boolean;
  repeatMaxCount: number | null;
  repeatIntervalValue: number | null;
  repeatIntervalUnit: string | null;
  repeatStopCondition: string | null;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    enabled: r.enabled,
    timingMode: r.timingMode,
    offsetValue: r.offsetValue,
    offsetUnit: r.offsetUnit,
    recurrence: r.recurrence,
    atTime: r.atTime,
    dayOfWeek: r.dayOfWeek,
    dayOfMonth: r.dayOfMonth,
    channel: r.channel,
    templateKey: r.templateKey,
    recipientMode: r.recipientMode,
    recipientOverride: r.recipientOverride || "",
    senderName: r.senderName || "",
    audienceFilter: r.audienceFilter || null,
    questionnaireId: r.questionnaireId,
    repeatEnabled: r.repeatEnabled,
    repeatMaxCount: r.repeatMaxCount,
    repeatIntervalValue: r.repeatIntervalValue,
    repeatIntervalUnit: r.repeatIntervalUnit,
    repeatStopCondition: r.repeatStopCondition,
    lastRunAt: r.lastRunAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    updatedAt: r.updatedAt,
  };
}

automationRuleRouter.get(
  "/automationRule/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.automationRule.findMany({ where: { entityId }, orderBy: { name: "asc" } });
    res.json(rows.map(shapeRule));
  })
);

interface RuleBody {
  name: string;
  trigger: string;
  enabled?: boolean;
  timingMode: string;
  offsetValue?: number | null;
  offsetUnit?: string | null;
  recurrence?: string | null;
  atTime?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  channel: string;
  templateKey: string;
  recipientMode?: string;
  recipientOverride?: string | null;
  senderName?: string | null;
  audienceFilter?: unknown;
  questionnaireId?: string | null;
  repeatEnabled?: boolean;
  repeatMaxCount?: number | null;
  repeatIntervalValue?: number | null;
  repeatIntervalUnit?: string | null;
  repeatStopCondition?: string | null;
}

const TIMING_MODES = ["immediate", "offset", "delay", "recurring"];
const OFFSET_UNITS = ["minutes", "hours", "days", "months"];
const REPEAT_INTERVAL_UNITS = ["minutes", "hours", "days"];
const REPEAT_STOP_CONDITIONS = ["checkin_done"];
const CHANNELS = ["email", "sms", "whatsapp"];
const RECIPIENT_MODES = ["event", "custom"];

function validateRuleBody(b: RuleBody) {
  if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
  const trigger = getTrigger(b.trigger);
  if (!trigger) throw new HttpError(400, "Déclencheur inconnu");
  if (!TIMING_MODES.includes(b.timingMode)) throw new HttpError(400, "Mode de déclenchement invalide");
  if (!trigger.timingModes.includes(b.timingMode as (typeof trigger.timingModes)[number])) {
    throw new HttpError(400, `Le déclencheur "${trigger.label}" ne supporte pas le mode "${b.timingMode}"`);
  }
  if (b.timingMode === "offset" || b.timingMode === "delay") {
    // Le signe porte le sens avant/après (ex. "J-5" = -5, "M+1" = +1) —
    // seule une valeur non nulle a un sens ici.
    if (!b.offsetValue) throw new HttpError(400, "Une durée non nulle est requise pour ce mode (ex. J-5, H-10, M+1)");
    if (b.offsetUnit && !OFFSET_UNITS.includes(b.offsetUnit)) throw new HttpError(400, "Unité de durée invalide");
  }
  const af = (b.audienceFilter || {}) as { sourceMode?: string; source?: string };
  if (af.sourceMode) {
    if (!["equals", "not_equals"].includes(af.sourceMode)) throw new HttpError(400, "Mode de critère Source invalide");
    if (!af.source || !af.source.trim()) throw new HttpError(400, "Valeur du critère Source requise");
  }
  if (b.timingMode === "recurring" && !b.recurrence) {
    throw new HttpError(400, "Une récurrence (daily/weekly/monthly) est requise pour ce mode");
  }
  if (b.repeatEnabled) {
    if (b.timingMode !== "offset") throw new HttpError(400, "La relance répétée n'est disponible que pour le mode \"Décalage (date précise)\"");
    if (!b.repeatMaxCount || b.repeatMaxCount < 1) throw new HttpError(400, "Nombre d'envois invalide pour la relance répétée");
    if (!b.repeatIntervalValue || b.repeatIntervalValue < 1) throw new HttpError(400, "Intervalle de relance invalide");
    if (!b.repeatIntervalUnit || !REPEAT_INTERVAL_UNITS.includes(b.repeatIntervalUnit)) throw new HttpError(400, "Unité d'intervalle de relance invalide");
    if (!b.repeatStopCondition || !REPEAT_STOP_CONDITIONS.includes(b.repeatStopCondition)) throw new HttpError(400, "Condition d'arrêt de la relance invalide");
  }
  if (!CHANNELS.includes(b.channel)) throw new HttpError(400, "Canal invalide");
  if (!b.templateKey) throw new HttpError(400, "Modèle requis");

  const recipientMode = b.recipientMode || "event";
  if (!RECIPIENT_MODES.includes(recipientMode)) throw new HttpError(400, "Mode de destinataire invalide");
  if (recipientMode === "custom") {
    const override = (b.recipientOverride || "").trim();
    if (!override) throw new HttpError(400, "Destinataire personnalisé requis pour ce mode");
    if (b.channel === "email" && !override.includes("@")) {
      throw new HttpError(400, "Adresse email invalide pour le destinataire personnalisé");
    }
    if (b.channel !== "email" && override.includes("@")) {
      throw new HttpError(400, "Un numéro de mobile est attendu pour ce canal (SMS/WhatsApp), pas une adresse email");
    }
  }
}

/** Un questionnaire attaché doit appartenir à la même portée que la règle
 * (jamais un questionnaire CRM sur une règle hôtel, ni l'inverse). */
async function validateQuestionnaireId(entityId: string | null, questionnaireId: string | null | undefined) {
  if (!questionnaireId) return;
  const q = await prisma.questionnaire.findFirst({ where: { id: questionnaireId, entityId } });
  if (!q) throw new HttpError(400, "Questionnaire introuvable pour cette portée");
}

automationRuleRouter.post(
  "/automationRule/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as RuleBody;
    validateRuleBody(b);
    await validateQuestionnaireId(entityId, b.questionnaireId);
    const row = await prisma.automationRule.create({
      data: {
        entityId,
        name: b.name.trim(),
        trigger: b.trigger,
        enabled: b.enabled ?? true,
        timingMode: b.timingMode,
        offsetValue: b.offsetValue ?? null,
        offsetUnit: b.offsetUnit ?? null,
        recurrence: b.recurrence ?? null,
        atTime: b.atTime ?? null,
        dayOfWeek: b.dayOfWeek ?? null,
        dayOfMonth: b.dayOfMonth ?? null,
        channel: b.channel,
        templateKey: b.templateKey,
        recipientMode: b.recipientMode || "event",
        recipientOverride: b.recipientMode === "custom" ? (b.recipientOverride || "").trim() : null,
        senderName: b.senderName?.trim() || null,
        audienceFilter: b.audienceFilter ?? undefined,
        questionnaireId: b.questionnaireId || null,
        repeatEnabled: !!b.repeatEnabled,
        repeatMaxCount: b.repeatEnabled ? b.repeatMaxCount ?? null : null,
        repeatIntervalValue: b.repeatEnabled ? b.repeatIntervalValue ?? null : null,
        repeatIntervalUnit: b.repeatEnabled ? b.repeatIntervalUnit ?? null : null,
        repeatStopCondition: b.repeatEnabled ? b.repeatStopCondition ?? null : null,
      },
    });
    res.status(201).json(shapeRule(row));
  })
);

automationRuleRouter.post(
  "/automationRule/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const { id, ...rest } = req.body as RuleBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const existing = await prisma.automationRule.findFirst({ where: { id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    const b = rest;
    validateRuleBody(b);
    await validateQuestionnaireId(entityId, b.questionnaireId);
    const row = await prisma.automationRule.update({
      where: { id },
      data: {
        name: b.name.trim(),
        trigger: b.trigger,
        enabled: b.enabled ?? true,
        timingMode: b.timingMode,
        offsetValue: b.offsetValue ?? null,
        offsetUnit: b.offsetUnit ?? null,
        recurrence: b.recurrence ?? null,
        atTime: b.atTime ?? null,
        dayOfWeek: b.dayOfWeek ?? null,
        dayOfMonth: b.dayOfMonth ?? null,
        channel: b.channel,
        templateKey: b.templateKey,
        recipientMode: b.recipientMode || "event",
        recipientOverride: b.recipientMode === "custom" ? (b.recipientOverride || "").trim() : null,
        senderName: b.senderName?.trim() || null,
        questionnaireId: b.questionnaireId || null,
        audienceFilter: b.audienceFilter ?? undefined,
        repeatEnabled: !!b.repeatEnabled,
        repeatMaxCount: b.repeatEnabled ? b.repeatMaxCount ?? null : null,
        repeatIntervalValue: b.repeatEnabled ? b.repeatIntervalValue ?? null : null,
        repeatIntervalUnit: b.repeatEnabled ? b.repeatIntervalUnit ?? null : null,
        repeatStopCondition: b.repeatEnabled ? b.repeatStopCondition ?? null : null,
      },
    });
    res.json(shapeRule(row));
  })
);

/**
 * Envoi de test synchrone — contrairement à fireTrigger() (fire-and-forget,
 * pensé pour ne jamais bloquer/faire échouer la requête métier appelante),
 * ce endpoint attend l'envoi et propage l'erreur réelle telle quelle (via
 * sendMessage(), qui lève déjà une HttpError explicite) : c'est le moyen le
 * plus rapide de diagnostiquer une règle "qui ne fonctionne pas" sans
 * attendre un vrai événement (nouveau prospect, réservation…).
 */
automationRuleRouter.post(
  "/automationRule/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const rule = await prisma.automationRule.findFirst({ where: { id, entityId } });
    if (!rule) throw new HttpError(404, "Règle introuvable");
    const to = ((req.body.to as string) || (rule.recipientMode === "custom" ? rule.recipientOverride : "") || "").trim();
    if (!to) throw new HttpError(400, "Indiquez un destinataire de test");
    const sent = await sendMessage({
      entityId,
      channel: rule.channel as Channel,
      templateKey: rule.templateKey,
      to,
      variables: { nom: "Test", prenom: "Test", secteur: "Test", code: "TEST-0001", ville: "Test" },
      fromNameOverride: rule.senderName || undefined,
    });
    res.json({ ok: true, ...sent });
  })
);

automationRuleRouter.post(
  "/automationRule/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const existing = await prisma.automationRule.findFirst({ where: { id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    await prisma.automationRule.delete({ where: { id } });
    res.json({ ok: true });
  })
);
