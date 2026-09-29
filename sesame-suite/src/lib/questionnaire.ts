import crypto from "node:crypto";
import { prisma } from "../db";
import { config } from "../config";

/**
 * Gestionnaire de questionnaires générique (08/09/2026) — cf.
 * prisma/schema.prisma (Questionnaire/QuestionnaireQuestion/
 * QuestionnaireSend/QuestionnaireAnswer). Ce module centralise la création
 * des liens publics, réutilisé à la fois par l'envoi manuel
 * (routes/questionnaire.ts, POST /prepareLinks) et par l'envoi automatique
 * déclenché par une règle d'automatisation (AutomationRule.questionnaireId,
 * cf. fireTrigger() dans lib/automation.ts).
 */

export type QuestionnaireTargetType = "crmProspect" | "booking";

/**
 * Récupère (ou crée) le lien public d'un questionnaire pour une cible
 * donnée — le token est généré une seule fois puis toujours réutilisé (même
 * principe que CrmQuote.signToken), pour qu'un contact relancé garde le même
 * lien et retrouve ses réponses précédentes.
 */
export async function getOrCreateQuestionnaireSend(
  questionnaireId: string,
  targetType: QuestionnaireTargetType,
  targetId: string
) {
  const existing = await prisma.questionnaireSend.findUnique({
    where: { questionnaireId_targetType_targetId: { questionnaireId, targetType, targetId } },
  });
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("hex");
  try {
    return await prisma.questionnaireSend.create({
      data: { questionnaireId, targetType, targetId, token },
    });
  } catch {
    // Course rare (deux requêtes concurrentes créent le même envoi) — la
    // contrainte @@unique([questionnaireId, targetType, targetId]) rejette
    // la seconde, qui relit alors la ligne créée par la première.
    const row = await prisma.questionnaireSend.findUnique({
      where: { questionnaireId_targetType_targetId: { questionnaireId, targetType, targetId } },
    });
    if (!row) throw new Error("Échec de création du lien de questionnaire");
    return row;
  }
}

/** URL publique absolue d'un envoi — cf. config.publicBaseUrl (background jobs, pas de req disponible). */
export function questionnaireLinkUrl(token: string, baseUrl?: string): string {
  const base = baseUrl || config.publicBaseUrl;
  return `${base}/questionnaire.html?token=${token}`;
}

const QUESTIONNAIRE_TARGET_TYPES = new Set(["crmProspect", "booking"]);

/**
 * Génère/réutilise le lien d'un questionnaire pour une cible et l'injecte
 * comme variable {{lienQuestionnaire}} — utilisé par fireTrigger()
 * (AutomationRule.questionnaireId, lib/automation.ts) pour un envoi
 * programmé, et par sendMessage() (MessageTemplate.questionnaireId,
 * lib/messaging.ts) pour tout envoi (manuel ou automatique) utilisant ce
 * modèle. Le modèle de message (subject/bodyHtml) doit alors contenir
 * cette variable pour que le lien apparaisse réellement dans l'envoi.
 * Cible non compatible → lève, pour que l'appelant décide (recordRuleError
 * côté automatisation, HttpError côté envoi manuel) plutôt que d'envoyer
 * silencieusement un message sans lien.
 */
export async function attachQuestionnaireLink(
  questionnaireId: string | null | undefined,
  targetType: string,
  targetId: string,
  variables: Record<string, string>
): Promise<Record<string, string>> {
  if (!questionnaireId) return variables;
  if (!QUESTIONNAIRE_TARGET_TYPES.has(targetType)) {
    throw new Error(`Questionnaire non applicable à ce déclencheur (cible "${targetType}" non prise en charge)`);
  }
  const send = await getOrCreateQuestionnaireSend(questionnaireId, targetType as QuestionnaireTargetType, targetId);
  if (!send.sentAt) {
    await prisma.questionnaireSend.update({ where: { id: send.id }, data: { sentAt: new Date() } });
  }
  return { ...variables, lienQuestionnaire: questionnaireLinkUrl(send.token) };
}
