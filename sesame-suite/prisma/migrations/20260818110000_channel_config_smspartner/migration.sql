-- Intégration du partenaire SMS DocPartner (SMSPartner.fr) en tant que
-- second provider possible pour le canal "sms" de ChannelConfig, à côté de
-- Twilio. Ce partenaire ne couvre que le SMS (pas de WhatsApp) et
-- s'authentifie avec une clé API unique plutôt qu'un couple SID/Token.
ALTER TABLE "ChannelConfig" ADD COLUMN "apiKey" TEXT;
