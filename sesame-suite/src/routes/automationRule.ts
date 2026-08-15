import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { getTrigger } from "../lib/automation";

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
  audienceFilter: unknown;
  lastRunAt: Date | null;
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
    audienceFilter: r.audienceFilter || null,
    lastRunAt: r.lastRunAt,
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
  audienceFilter?: unknown;
}

const TIMING_MODES = ["immediate", "before", "after", "recurring"];
const CHANNELS = ["email", "sms", "whatsapp"];

function validateRuleBody(b: RuleBody) {
  if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
  const trigger = getTrigger(b.trigger);
  if (!trigger) throw new HttpError(400, "Déclencheur inconnu");
  if (!TIMING_MODES.includes(b.timingMode)) throw new HttpError(400, "Mode de déclenchement invalide");
  if (!trigger.timingModes.includes(b.timingMode as (typeof trigger.timingModes)[number])) {
    throw new HttpError(400, `Le déclencheur "${trigger.label}" ne supporte pas le mode "${b.timingMode}"`);
  }
  if ((b.timingMode === "before" || b.timingMode === "after") && (!b.offsetValue || b.offsetValue <= 0)) {
    throw new HttpError(400, "Une durée (offsetValue) positive est requise pour ce mode");
  }
  if (b.timingMode === "recurring" && !b.recurrence) {
    throw new HttpError(400, "Une récurrence (daily/weekly/monthly) est requise pour ce mode");
  }
  if (!CHANNELS.includes(b.channel)) throw new HttpError(400, "Canal invalide");
  if (!b.templateKey) throw new HttpError(400, "Modèle requis");
}

automationRuleRouter.post(
  "/automationRule/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as RuleBody;
    validateRuleBody(b);
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
        audienceFilter: b.audienceFilter ?? undefined,
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
        audienceFilter: b.audienceFilter ?? undefined,
      },
    });
    res.json(shapeRule(row));
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
