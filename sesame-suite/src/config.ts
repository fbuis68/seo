import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  defaultEntityCode: process.env.DEFAULT_ENTITY_CODE || "E00000001",
  // Partagé avec le flux Power Automate externe qui appelle
  // POST /wa/crmProspect/inboundSignal (pas de session admin possible côté
  // Power Automate) — à définir en production, cf. .env.example.
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET || "change-me-in-production",
  // Identifiants de l'app Azure AD (client credentials) utilisée pour lire
  // la boîte support via Microsoft Graph et gérer l'abonnement webhook —
  // cf. lib/graph.ts et docs/microsoft-graph-inbound-tickets.md pour la
  // procédure de création côté Azure. Absents ⇒ le panneau "Canaux" (CRM)
  // affiche l'intégration comme non configurée plutôt que d'échouer au
  // premier appel.
  graphTenantId: process.env.GRAPH_TENANT_ID || "",
  graphClientId: process.env.GRAPH_CLIENT_ID || "",
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET || "",
  // Base publique du site (ex: "https://app.sesame-technology.com"), sans
  // slash final — nécessaire pour construire des liens absolus (ex :
  // lien de questionnaire injecté par une règle d'automatisation, cf.
  // lib/questionnaire.ts) depuis un contexte SANS requête HTTP en cours
  // (balayage périodique automationScheduler.ts) où req.get('host') n'existe
  // pas. Les routes appelées depuis une vraie requête (ex :
  // crmQualification/prepareLinks) continuent d'utiliser req directement,
  // plus fiable quand disponible (reflète le domaine réellement utilisé).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  // Base de l'app CLIENT (checkin.html, booking.html...) — distincte de
  // publicBaseUrl ci-dessus (admin/CRM) : deux sous-domaines séparés en
  // production (cf. README "Exposition publique admin.sesame.technology /
  // guest.sesame.technology"). Sert à construire {{lienAutologin}} (cf.
  // lib/templateVars.ts) depuis un contexte sans requête HTTP en cours
  // (balayage périodique), même principe que publicBaseUrl.
  guestBaseUrl: (process.env.GUEST_BASE_URL || "https://guest.sesame.technology").replace(/\/$/, ""),
  // Assistant support IA (§ LOT 1 — recherche de cas similaires, réponse
  // suggérée, génération de FAQ, cf. lib/aiEmbeddings.ts et lib/aiClaude.ts).
  // Deux fournisseurs distincts : Claude n'a pas d'API d'embeddings, donc
  // OpenAI text-embedding-3-small reste utilisé uniquement pour vectoriser
  // (recherche sémantique) pendant que Claude génère tout le texte (réponse
  // suggérée, FAQ). Absents ⇒ les routes IA répondent 503 plutôt que
  // d'échouer silencieusement (mêmes conventions que graphTenantId etc.).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
};
