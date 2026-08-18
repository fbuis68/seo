-- Signal d'engagement entrant : compteur d'emails reçus d'un contact CRM,
-- alimenté par un flux externe (Power Automate sur boîtes partagées) via
-- POST /wa/crmProspect/inboundSignal. Ne stocke jamais le contenu des
-- emails, uniquement un compteur + la date du dernier email reçu.
ALTER TABLE "CrmProspect" ADD COLUMN "inboundReplyCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrmProspect" ADD COLUMN "lastInboundReplyAt" TIMESTAMP(3);
