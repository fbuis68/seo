/**
 * Branchement conditionnel des questionnaires (22/10/2026) — logique
 * d'évaluation PARTAGÉE en intention avec public/questionnaireFlow.js (même
 * algorithme, porté en JS côté navigateur pour l'affichage progressif et le
 * schéma, ici en TS côté serveur pour valider les champs obligatoires sur
 * le VRAI chemin suivi, pas sur la liste brute des questions). Pas de build
 * step JS partagé dans ce projet (public/*.html sont statiques) — les deux
 * copies doivent être tenues synchrones à la main si la logique change.
 */

export interface BranchingQuestion {
  id: string;
  order: number;
  type: string;
  options: unknown;
}

export interface BranchRule {
  id: string;
  label?: string;
  operator: string; // equals | not_equals | includes | not_includes | gt | lt | gte | lte | contains
  value: unknown;
  targetQuestionId: string | null; // id de question, ou "END"
}

export interface BranchingConfig {
  branches: BranchRule[];
  elseTargetQuestionId: string | null; // id de question, "END", ou null = suite normale
}

/** Valeur "brute" comparable extraite d'une réponse selon le type de question. */
function extractComparable(type: string, value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  switch (type) {
    case "single":
    case "select":
      return value.choice;
    case "multi":
      return value.choices;
    case "boolean":
      return value.value;
    case "checkbox":
      return value.checked;
    case "text":
    case "shorttext":
      return value.text;
    case "number":
      return value.number;
    case "rating":
      return value.rating;
    default:
      return undefined;
  }
}

function evalCondition(rule: BranchRule, question: BranchingQuestion, answerValue: Record<string, unknown> | undefined): boolean {
  const actual = extractComparable(question.type, answerValue);
  if (actual === undefined) return false;
  switch (rule.operator) {
    case "equals":
      return actual === rule.value;
    case "not_equals":
      return actual !== rule.value;
    case "includes":
      return Array.isArray(actual) && actual.includes(rule.value);
    case "not_includes":
      return Array.isArray(actual) && !actual.includes(rule.value);
    case "gt":
      return typeof actual === "number" && actual > Number(rule.value);
    case "lt":
      return typeof actual === "number" && actual < Number(rule.value);
    case "gte":
      return typeof actual === "number" && actual >= Number(rule.value);
    case "lte":
      return typeof actual === "number" && actual <= Number(rule.value);
    case "contains":
      return typeof actual === "string" && actual.toLowerCase().includes(String(rule.value).toLowerCase());
    default:
      return false;
  }
}

/**
 * Chemin RÉELLEMENT suivi compte tenu des réponses déjà données — s'arrête
 * (sans ajouter la suite) dès qu'une question avec branchement n'a pas
 * encore de réponse, puisqu'on ne peut alors pas savoir quelle branche
 * prendre. Les questions "sautées" par un branchement n'apparaissent jamais
 * dans le résultat — donc jamais exigées même si `required`.
 */
export function walkQuestionnairePath(
  questions: BranchingQuestion[],
  answersByQuestionId: Map<string, Record<string, unknown>>
): string[] {
  const sorted = [...questions].sort((a, b) => a.order - b.order);
  const byId = new Map(sorted.map((q) => [q.id, q]));
  const path: string[] = [];
  const visited = new Set<string>(); // garde-fou anti-boucle (branchement mal formé)

  let current: BranchingQuestion | undefined = sorted[0];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current.id);

    const branching = (current as { branching?: unknown }).branching as BranchingConfig | null | undefined;
    if (!branching) {
      const idx = sorted.findIndex((q) => q.id === current!.id);
      current = sorted[idx + 1];
      continue;
    }

    const answer = answersByQuestionId.get(current.id);
    if (!answer) break; // pas encore répondu — on ne peut pas choisir la branche

    const matched = (branching.branches || []).find((b) => evalCondition(b, current!, answer));
    const nextId = matched ? matched.targetQuestionId : branching.elseTargetQuestionId;

    if (nextId === "END") break;
    if (nextId === null || nextId === undefined) {
      const idx = sorted.findIndex((q) => q.id === current!.id);
      current = sorted[idx + 1];
      continue;
    }
    current = byId.get(nextId);
  }
  return path;
}
