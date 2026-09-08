import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { fireTrigger } from "../lib/automation";
import { getOrCreateQuestionnaireSend, questionnaireLinkUrl } from "../lib/questionnaire";
import { recordScoreEvent } from "../lib/crmScoring";

/**
 * Gestionnaire de questionnaires générique (08/09/2026) — cf.
 * prisma/schema.prisma. Portée identique à AutomationRule (resolveScope) :
 * ?scope=crm cible les questionnaires Sesame (envoyés à des CrmProspect),
 * la portée par défaut cible les questionnaires de l'hôtel courant (envoyés
 * à des Booking). Un questionnaire d'une portée ne peut jamais être envoyé à
 * une cible de l'autre — cf. targetTypeForScope().
 */
export const questionnaireRouter = Router();

const QUESTION_TYPES = new Set(["single", "multi", "boolean", "text", "rating"]);

function targetTypeForScope(entityId: string | null): "crmProspect" | "booking" {
  return entityId === null ? "crmProspect" : "booking";
}

function shapeQuestion(q: {
  id: string;
  order: number;
  type: string;
  label: string;
  required: boolean;
  options: unknown;
  linkUrl: string | null;
  linkLabel: string | null;
}) {
  return {
    id: q.id,
    order: q.order,
    type: q.type,
    label: q.label,
    required: q.required,
    options: q.options ?? null,
    linkUrl: q.linkUrl || "",
    linkLabel: q.linkLabel || "",
  };
}

function shapeQuestionnaire(q: {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  questions?: Parameters<typeof shapeQuestion>[0][];
  _count?: { sends: number };
}) {
  return {
    id: q.id,
    name: q.name,
    description: q.description || "",
    active: q.active,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    questionCount: q.questions ? q.questions.length : undefined,
    sendCount: q._count ? q._count.sends : undefined,
    questions: q.questions ? q.questions.map(shapeQuestion) : undefined,
  };
}

/** GET /wa/questionnaire/list?scope=crm — questionnaires de la portée (résumé, sans les questions). */
questionnaireRouter.get(
  "/questionnaire/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.questionnaire.findMany({
      where: { entityId },
      orderBy: { createdAt: "asc" },
      include: { questions: { select: { id: true, order: true, type: true, label: true, required: true, options: true, linkUrl: true, linkLabel: true } }, _count: { select: { sends: true } } },
    });
    res.json(rows.map(shapeQuestionnaire));
  })
);

/** GET /wa/questionnaire/get?id=... — détail complet (questions ordonnées) pour le constructeur. */
questionnaireRouter.get(
  "/questionnaire/get",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.query.id as string) || "";
    const row = await prisma.questionnaire.findFirst({
      where: { id, entityId },
      include: { questions: { orderBy: { order: "asc" } }, _count: { select: { sends: true } } },
    });
    if (!row) throw new HttpError(404, "Questionnaire introuvable");
    res.json(shapeQuestionnaire(row));
  })
);

interface CreateBody {
  name: string;
  description?: string;
}

questionnaireRouter.post(
  "/questionnaire/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as CreateBody;
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
    const row = await prisma.questionnaire.create({
      data: { entityId, name: b.name.trim(), description: b.description?.trim() || null },
    });
    res.status(201).json(shapeQuestionnaire({ ...row, questions: [] }));
  })
);

interface UpdateBody {
  id: string;
  name?: string;
  description?: string;
  active?: boolean;
}

questionnaireRouter.post(
  "/questionnaire/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as UpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.questionnaire.findFirst({ where: { id: b.id, entityId } });
    if (!existing) throw new HttpError(404, "Questionnaire introuvable");
    if (b.name !== undefined && !b.name.trim()) throw new HttpError(400, "Nom requis");
    const row = await prisma.questionnaire.update({
      where: { id: b.id },
      data: {
        name: b.name !== undefined ? b.name.trim() : undefined,
        description: b.description !== undefined ? b.description.trim() || null : undefined,
        active: b.active,
      },
    });
    res.json(shapeQuestionnaire(row));
  })
);

questionnaireRouter.post(
  "/questionnaire/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const existing = await prisma.questionnaire.findFirst({ where: { id, entityId } });
    if (!existing) throw new HttpError(404, "Questionnaire introuvable");
    await prisma.questionnaire.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/** POST /wa/questionnaire/duplicate — copie le questionnaire et ses questions (jamais les envois/réponses). */
questionnaireRouter.post(
  "/questionnaire/duplicate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const existing = await prisma.questionnaire.findFirst({ where: { id, entityId }, include: { questions: { orderBy: { order: "asc" } } } });
    if (!existing) throw new HttpError(404, "Questionnaire introuvable");
    const copy = await prisma.questionnaire.create({
      data: {
        entityId,
        name: `${existing.name} (copie)`,
        description: existing.description,
        questions: {
          create: existing.questions.map((q) => ({ order: q.order, type: q.type, label: q.label, required: q.required, options: q.options ?? undefined })),
        },
      },
      include: { questions: { orderBy: { order: "asc" } } },
    });
    res.status(201).json(shapeQuestionnaire(copy));
  })
);

// ── Questions ──

interface QuestionBody {
  questionnaireId: string;
  type: string;
  label: string;
  required?: boolean;
  options?: unknown;
  linkUrl?: string;
  linkLabel?: string;
}

function validateLink(linkUrl?: string): string | null {
  const url = (linkUrl || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Le lien doit commencer par http:// ou https://");
  return url;
}

async function ownedQuestionnaire(entityId: string | null, id: string) {
  const q = await prisma.questionnaire.findFirst({ where: { id, entityId } });
  if (!q) throw new HttpError(404, "Questionnaire introuvable");
  return q;
}

questionnaireRouter.post(
  "/questionnaire/question/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as QuestionBody;
    if (!b.questionnaireId) throw new HttpError(400, "questionnaireId requis");
    await ownedQuestionnaire(entityId, b.questionnaireId);
    if (!QUESTION_TYPES.has(b.type)) throw new HttpError(400, "Type de question invalide");
    if (!b.label || !b.label.trim()) throw new HttpError(400, "Intitulé requis");
    const linkUrl = validateLink(b.linkUrl);
    const agg = await prisma.questionnaireQuestion.aggregate({ where: { questionnaireId: b.questionnaireId }, _max: { order: true } });
    const row = await prisma.questionnaireQuestion.create({
      data: {
        questionnaireId: b.questionnaireId,
        order: (agg._max.order ?? -1) + 1,
        type: b.type,
        label: b.label.trim(),
        required: !!b.required,
        options: (b.options as never) ?? undefined,
        linkUrl,
        linkLabel: linkUrl ? (b.linkLabel || "").trim() || null : null,
      },
    });
    res.status(201).json(shapeQuestion(row));
  })
);

interface QuestionUpdateBody {
  id: string;
  type?: string;
  label?: string;
  required?: boolean;
  options?: unknown;
  linkUrl?: string;
  linkLabel?: string;
}

questionnaireRouter.post(
  "/questionnaire/question/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as QuestionUpdateBody;
    if (!b.id) throw new HttpError(400, "id requis");
    const existing = await prisma.questionnaireQuestion.findUnique({ where: { id: b.id }, include: { questionnaire: true } });
    if (!existing || existing.questionnaire.entityId !== entityId) throw new HttpError(404, "Question introuvable");
    if (b.type !== undefined && !QUESTION_TYPES.has(b.type)) throw new HttpError(400, "Type de question invalide");
    if (b.label !== undefined && !b.label.trim()) throw new HttpError(400, "Intitulé requis");
    const linkUrl = b.linkUrl !== undefined ? validateLink(b.linkUrl) : undefined;
    const row = await prisma.questionnaireQuestion.update({
      where: { id: b.id },
      data: {
        type: b.type,
        label: b.label !== undefined ? b.label.trim() : undefined,
        required: b.required,
        options: (b.options as never) ?? undefined,
        linkUrl,
        linkLabel: linkUrl !== undefined ? (linkUrl ? (b.linkLabel || "").trim() || null : null) : undefined,
      },
    });
    res.json(shapeQuestion(row));
  })
);

questionnaireRouter.post(
  "/questionnaire/question/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const id = (req.body.id as string) || "";
    const existing = await prisma.questionnaireQuestion.findUnique({ where: { id }, include: { questionnaire: true } });
    if (!existing || existing.questionnaire.entityId !== entityId) throw new HttpError(404, "Question introuvable");
    await prisma.questionnaireQuestion.delete({ where: { id } });
    res.json({ ok: true });
  })
);

/** POST /wa/questionnaire/question/reorder — body: {questionnaireId, orderedIds:[...]}. */
questionnaireRouter.post(
  "/questionnaire/question/reorder",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const questionnaireId = (req.body.questionnaireId as string) || "";
    const orderedIds = Array.isArray(req.body.orderedIds) ? (req.body.orderedIds as string[]) : [];
    await ownedQuestionnaire(entityId, questionnaireId);
    const owned = await prisma.questionnaireQuestion.findMany({ where: { questionnaireId }, select: { id: true } });
    const ownedIds = new Set(owned.map((q) => q.id));
    if (orderedIds.length !== ownedIds.size || orderedIds.some((id) => !ownedIds.has(id))) {
      throw new HttpError(400, "Liste d'ordre invalide");
    }
    await prisma.$transaction(orderedIds.map((id, order) => prisma.questionnaireQuestion.update({ where: { id }, data: { order } })));
    res.json({ ok: true });
  })
);

// ── Diffusion (envoi manuel groupé) ──

interface PrepareLinksBody {
  questionnaireId: string;
  targetIds: string[];
}

/**
 * POST /wa/questionnaire/prepareLinks — génère (ou réutilise) le lien de
 * chaque cible sélectionnée ; ne marque PAS l'envoi comme fait (cf.
 * /markSent, appelé après l'envoi effectif du message) — même séquence que
 * l'ancien crmQualification.ts.
 */
questionnaireRouter.post(
  "/questionnaire/prepareLinks",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as PrepareLinksBody;
    if (!b.questionnaireId) throw new HttpError(400, "questionnaireId requis");
    if (!Array.isArray(b.targetIds) || !b.targetIds.length) throw new HttpError(400, "Aucune cible sélectionnée");
    await ownedQuestionnaire(entityId, b.questionnaireId);
    const targetType = targetTypeForScope(entityId);

    // Vérifie que chaque cible appartient bien à cette portée avant de lui
    // générer un lien — empêche de fabriquer un lien vers la réservation
    // d'un autre établissement (ou un prospect quelconque côté hôtel).
    let validIds: Set<string>;
    if (targetType === "crmProspect") {
      const rows = await prisma.crmProspect.findMany({ where: { id: { in: b.targetIds } }, select: { id: true } });
      validIds = new Set(rows.map((r) => r.id));
    } else {
      const rows = await prisma.booking.findMany({ where: { id: { in: b.targetIds }, entityId: entityId! }, select: { id: true } });
      validIds = new Set(rows.map((r) => r.id));
    }

    const links: Record<string, string> = {};
    for (const targetId of b.targetIds) {
      if (!validIds.has(targetId)) continue;
      const send = await getOrCreateQuestionnaireSend(b.questionnaireId, targetType, targetId);
      links[targetId] = questionnaireLinkUrl(send.token, `${req.protocol}://${req.get("host")}`);
    }
    res.json({ links });
  })
);

questionnaireRouter.post(
  "/questionnaire/markSent",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const questionnaireId = (req.body.questionnaireId as string) || "";
    const targetIds = Array.isArray(req.body.targetIds) ? (req.body.targetIds as string[]) : [];
    if (!targetIds.length) throw new HttpError(400, "Aucune cible sélectionnée");
    await ownedQuestionnaire(entityId, questionnaireId);
    const targetType = targetTypeForScope(entityId);
    await prisma.questionnaireSend.updateMany({
      where: { questionnaireId, targetType, targetId: { in: targetIds } },
      data: { sentAt: new Date() },
    });
    res.json({ ok: true });
  })
);

/** GET /wa/questionnaire/results?questionnaireId=... — envois + réponses, pour le panneau admin. */
questionnaireRouter.get(
  "/questionnaire/results",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const questionnaireId = (req.query.questionnaireId as string) || "";
    await ownedQuestionnaire(entityId, questionnaireId);
    const sends = await prisma.questionnaireSend.findMany({
      where: { questionnaireId },
      include: { answers: true },
      orderBy: { createdAt: "desc" },
    });
    const targetType = targetTypeForScope(entityId);
    const targetIds = sends.map((s) => s.targetId);
    const names: Record<string, string> = {};
    if (targetType === "crmProspect") {
      const rows = await prisma.crmProspect.findMany({ where: { id: { in: targetIds } }, select: { id: true, nom: true } });
      rows.forEach((r) => (names[r.id] = r.nom));
    } else {
      const rows = await prisma.booking.findMany({ where: { id: { in: targetIds } }, select: { id: true, code: true, personFirstname: true, personLastname: true } });
      rows.forEach((r) => (names[r.id] = `${r.personFirstname} ${r.personLastname} (${r.code})`.trim()));
    }
    res.json(
      sends.map((s) => ({
        id: s.id,
        targetId: s.targetId,
        targetName: names[s.targetId] || s.targetId,
        sentAt: s.sentAt,
        completedAt: s.completedAt,
        answers: s.answers.map((a) => ({ questionId: a.questionId, value: a.value })),
      }))
    );
  })
);

/**
 * GET /wa/questionnaire/sendsForTarget?targetId=... — tous les envois (tous
 * questionnaires confondus, de cette portée) reçus par une cible donnée —
 * utilisé par la carte "Questionnaires" de la fiche client CRM / réservation.
 */
questionnaireRouter.get(
  "/questionnaire/sendsForTarget",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const targetId = (req.query.targetId as string) || "";
    if (!targetId) throw new HttpError(400, "targetId requis");
    const targetType = targetTypeForScope(entityId);
    const sends = await prisma.questionnaireSend.findMany({
      where: { targetType, targetId, questionnaire: { entityId } },
      include: { answers: true, questionnaire: { include: { questions: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      sends.map((s) => {
        const labelById = new Map(s.questionnaire.questions.map((q) => [q.id, q.label]));
        return {
          id: s.id,
          questionnaireName: s.questionnaire.name,
          sentAt: s.sentAt,
          completedAt: s.completedAt,
          answers: s.answers.map((a) => ({ questionId: a.questionId, questionLabel: labelById.get(a.questionId) || "", value: a.value })),
        };
      })
    );
  })
);

// ── Réponse publique (sans authentification — le token fait office de jeton) ──

questionnaireRouter.get(
  "/questionnaire/public",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    if (!token) throw new HttpError(400, "Lien invalide");
    const send = await prisma.questionnaireSend.findUnique({
      where: { token },
      include: {
        questionnaire: { include: { questions: { orderBy: { order: "asc" } } } },
        answers: true,
      },
    });
    if (!send || !send.questionnaire.active) throw new HttpError(404, "Lien invalide ou expiré");
    res.json({
      name: send.questionnaire.name,
      description: send.questionnaire.description || "",
      questions: send.questionnaire.questions.map(shapeQuestion),
      answers: send.answers.map((a) => ({ questionId: a.questionId, value: a.value })),
      completed: !!send.completedAt,
    });
  })
);

/**
 * GET /wa/questionnaire/linkClick?token=...&questionId=... — jamais l'URL
 * brute (QuestionnaireQuestion.linkUrl) n'est utilisée directement côté
 * public/questionnaire.html : ce détour journalise le clic (score CRM +5
 * "module_click", cf. lib/crmScoring.ts) avant de rediriger, uniquement
 * quand la cible de l'envoi est un CrmProspect — un envoi côté hôtel
 * (cible Booking) redirige quand même, simplement sans scoring.
 */
questionnaireRouter.get(
  "/questionnaire/linkClick",
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string) || "";
    const questionId = (req.query.questionId as string) || "";
    if (!token || !questionId) throw new HttpError(400, "Lien invalide");
    const send = await prisma.questionnaireSend.findUnique({ where: { token } });
    if (!send) throw new HttpError(404, "Lien invalide ou expiré");
    const question = await prisma.questionnaireQuestion.findFirst({ where: { id: questionId, questionnaireId: send.questionnaireId } });
    if (!question || !question.linkUrl) throw new HttpError(404, "Lien introuvable");

    if (send.targetType === "crmProspect") {
      await recordScoreEvent(send.targetId, "module_click", question.linkLabel || question.label, "internal").catch((e) =>
        console.error("[crmScoring] linkClick:", e)
      );
    }
    res.redirect(302, question.linkUrl);
  })
);

interface AnswerInput {
  questionId: string;
  value: unknown;
}

interface SubmitBody {
  token: string;
  answers: AnswerInput[];
}

function isNonEmptyAnswer(type: string, value: Record<string, unknown>): boolean {
  if (type === "single") return typeof value.choice === "string" && value.choice.length > 0;
  if (type === "multi") return Array.isArray(value.choices) && value.choices.length > 0;
  if (type === "boolean") return typeof value.value === "boolean";
  if (type === "text") return typeof value.text === "string" && value.text.trim().length > 0;
  if (type === "rating") return typeof value.rating === "number";
  return false;
}

/** Valide/nettoie une réponse selon le type de la question — lève si incohérente (ex: choix hors liste). */
function cleanAnswerValue(question: { type: string; options: unknown }, raw: unknown): Record<string, unknown> {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const optionKeys = Array.isArray(question.options) ? (question.options as { key: string }[]).map((o) => o.key) : null;
  const note = typeof v.note === "string" && v.note.trim() ? v.note.trim() : undefined;

  if (question.type === "single") {
    const choice = typeof v.choice === "string" ? v.choice : undefined;
    if (choice && optionKeys && !optionKeys.includes(choice)) throw new HttpError(400, "Réponse invalide (choix hors liste)");
    return choice ? { choice, ...(note ? { note } : {}) } : {};
  }
  if (question.type === "multi") {
    const choices = Array.isArray(v.choices) ? v.choices.filter((c): c is string => typeof c === "string") : [];
    if (optionKeys && choices.some((c) => !optionKeys.includes(c))) throw new HttpError(400, "Réponse invalide (choix hors liste)");
    return choices.length ? { choices, ...(note ? { note } : {}) } : {};
  }
  if (question.type === "boolean") {
    return typeof v.value === "boolean" ? { value: v.value } : {};
  }
  if (question.type === "text") {
    const text = typeof v.text === "string" ? v.text.trim().slice(0, 5000) : "";
    return text ? { text } : {};
  }
  if (question.type === "rating") {
    const opts = (question.options || {}) as { min?: number; max?: number };
    const min = opts.min ?? 1;
    const max = opts.max ?? 5;
    const rating = typeof v.rating === "number" ? Math.round(v.rating) : NaN;
    if (Number.isNaN(rating)) return {};
    if (rating < min || rating > max) throw new HttpError(400, `Note hors plage (${min}-${max})`);
    return { rating };
  }
  return {};
}

/**
 * POST /wa/questionnaire/submit — enregistre (upsert) les réponses, marque
 * l'envoi complété au premier passage, puis déclenche
 * "questionnaire.completed" (portée hôtel) ou "crm.questionnaire_completed"
 * (portée CRM) pour que les règles d'automatisation configurées sur cet
 * événement s'exécutent (ex: email de remerciement, notification interne).
 */
questionnaireRouter.post(
  "/questionnaire/submit",
  asyncHandler(async (req, res) => {
    const b = req.body as SubmitBody;
    if (!b.token) throw new HttpError(400, "Lien invalide");
    if (!Array.isArray(b.answers)) throw new HttpError(400, "Aucune réponse reçue");

    const send = await prisma.questionnaireSend.findUnique({
      where: { token: b.token },
      include: { questionnaire: { include: { questions: true } } },
    });
    if (!send || !send.questionnaire.active) throw new HttpError(404, "Lien invalide ou expiré");

    const questionsById = new Map(send.questionnaire.questions.map((q) => [q.id, q]));
    const clean = b.answers
      .filter((a) => questionsById.has(a.questionId))
      .map((a) => ({ questionId: a.questionId, value: cleanAnswerValue(questionsById.get(a.questionId)!, a.value) }))
      .filter((a) => Object.keys(a.value).length > 0);

    const missingRequired = send.questionnaire.questions.some(
      (q) => q.required && !clean.some((a) => a.questionId === q.id && isNonEmptyAnswer(q.type, a.value))
    );
    if (missingRequired) throw new HttpError(400, "Merci de répondre à toutes les questions obligatoires");
    if (!clean.length) throw new HttpError(400, "Aucune réponse valide");

    await prisma.$transaction(
      clean.map((a) =>
        prisma.questionnaireAnswer.upsert({
          where: { sendId_questionId: { sendId: send.id, questionId: a.questionId } },
          update: { value: a.value as never },
          create: { sendId: send.id, questionId: a.questionId, value: a.value as never },
        })
      )
    );

    const wasCompleted = !!send.completedAt;
    if (!wasCompleted) {
      await prisma.questionnaireSend.update({ where: { id: send.id }, data: { completedAt: new Date() } });

      const isHotelScope = send.targetType === "booking";
      let recipient: { email?: string | null; phone?: string | null } = {};
      let variables: Record<string, string> = {};
      let entityId: string | null = null;
      if (isHotelScope) {
        const booking = await prisma.booking.findUnique({ where: { id: send.targetId } });
        if (booking) {
          entityId = booking.entityId;
          recipient = { email: booking.personEmail, phone: booking.personPhone };
          variables = { prenom: booking.personFirstname, nom: booking.personLastname, code: booking.code };
        }
      } else {
        const prospect = await prisma.crmProspect.findUnique({ where: { id: send.targetId } });
        if (prospect) {
          recipient = { email: prospect.email, phone: prospect.tel };
          variables = { nom: prospect.nom, secteur: prospect.secteur || "" };
        }
      }
      fireTrigger(isHotelScope ? "questionnaire.completed" : "crm.questionnaire_completed", {
        entityId,
        targetType: send.targetType,
        targetId: send.targetId,
        recipient,
        variables,
      }).catch((e) => console.error("[automation] questionnaire.completed:", e));
    }

    res.json({ ok: true });
  })
);
