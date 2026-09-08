import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  defaultEntityCode: process.env.DEFAULT_ENTITY_CODE || "E00000001",
  // Partagé avec le flux Power Automate externe qui appelle
  // POST /wa/crmProspect/inboundSignal (pas de session admin possible côté
  // Power Automate) — à définir en production, cf. .env.example.
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET || "change-me-in-production",
  // Base publique du site (ex: "https://app.sesame-technology.com"), sans
  // slash final — nécessaire pour construire des liens absolus (ex :
  // lien de questionnaire injecté par une règle d'automatisation, cf.
  // lib/questionnaire.ts) depuis un contexte SANS requête HTTP en cours
  // (balayage périodique automationScheduler.ts) où req.get('host') n'existe
  // pas. Les routes appelées depuis une vraie requête (ex :
  // crmQualification/prepareLinks) continuent d'utiliser req directement,
  // plus fiable quand disponible (reflète le domaine réellement utilisé).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
};
