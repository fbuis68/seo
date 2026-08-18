import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  defaultEntityCode: process.env.DEFAULT_ENTITY_CODE || "E00000001",
  // Partagé avec le flux Power Automate externe qui appelle
  // POST /wa/crmProspect/inboundSignal (pas de session admin possible côté
  // Power Automate) — à définir en production, cf. .env.example.
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET || "change-me-in-production",
};
